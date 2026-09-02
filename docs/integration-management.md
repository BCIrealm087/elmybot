# Cross-platform integration management

This is the canonical operator and maintainer reference for active integration
inspection, directional defaults, routes, audit history, dead letters, and
recovery. The authenticated Discord interaction surface does not turn Durable
Object service endpoints into public HTTP APIs. Discord remains the first
management adapter: signature verification and the `integration.manage`
capability protect every command, while the registry independently checks that
the requesting guild belongs to the named integration.

## Responsibilities

| Component | Owns |
| --- | --- |
| Discord adapter | Command parsing, capability enforcement, safe bounded rendering |
| `IntegrationRegistry` | Membership authorization, default selection, route configuration, lifecycle state, audit history |
| `IntegrationCoordinator` | Execution/effect aggregates, dead-letter inspection, explicit effect retry |

Keeping these interfaces platform-neutral allows a future control panel or
another authenticated platform adapter to reuse the same operations. It does
not force Twitch-native and Discord-native commands into a shared presentation
or authorization model.

## Default-link model and invariants

The staged
[`shareable feature-state lifecycle contract`](shareable-state-lifecycle.md)
adds standalone and integration state realms around this model. It does not
change the directional-default invariants: pending links own no default, later
active links do not replace established choices, and switching a default
selects an existing realm without copying it.

A default is directional. Its key and selected value are:

```text
(source group, target platform) -> (integration, target group)
```

Consequently, a Discord guild's default Twitch channel and a Twitch channel's
default Discord guild are separate choices. Changing one does not change the
other, even when both initially select the same two-member integration.

The registry preserves these invariants:

1. There is at most one row for a source group and target platform.
2. A stored selection names an active integration containing the exact source
   and target groups.
3. The target belongs to the requested target platform and differs from the
   source platform.
4. The first qualifying link fills an absent direction; later links do not
   silently replace it.
5. A direction cannot be explicitly unset while an eligible link remains.
6. Revoking the selected integration promotes the oldest eligible active edge,
   with stable integration and target-group keys breaking timestamp ties.
7. The row disappears only when no active link remains for that direction. A
   later new link assigns it again normally.

Upgrade backfill uses the same deterministic oldest-edge ordering for active
links that existed before the table. Backfill is schema repair rather than a
user action and does not synthesize historical audit entries.

### Lifecycle reference

| Situation | Result | Audit event |
| --- | --- | --- |
| First qualifying link for a direction | Assign that link | `integration.default.assigned.v1` |
| Later qualifying link | Keep the established choice | None for the unchanged direction |
| Manager selects another eligible link | Replace atomically | `integration.default.updated.v1` |
| Manager selects the current link | No-op; preserve timestamps | None |
| Selected link is revoked and another is eligible | Promote the oldest eligible link | `integration.default.fallback.v1` |
| Selected last link is revoked | Remove the unavailable direction | `integration.default.unavailable.v1` |
| A link is created after unavailability | Assign it as the new first link | `integration.default.assigned.v1` |

The lifecycle applies to single-link revocation and bounded group-wide
revocation. Each affected direction is repaired in the same registry
transaction that marks the integration revoked.

### Many-link example

Suppose Discord guilds `A` and `B` and Twitch channels `X` and `Y` have active
links `A–X`, `A–Y`, `B–X`, and `B–Y`. If `A–X` was created first for every
involved source, the initial choices can be:

| Direction | Initial target | After `A` selects `Y` | After `X` selects `B` |
| --- | --- | --- | --- |
| `A -> Twitch` | `X` | `Y` | `Y` |
| `B -> Twitch` | `X` | `X` | `X` |
| `X -> Discord` | `A` | `A` | `B` |
| `Y -> Discord` | `A` | `A` | `A` |

Only the addressed directional key changes. This is also why a Discord manager
cannot choose a Twitch channel's outgoing Discord default.

### Concurrency guarantees

The singleton registry Durable Object serializes requests, the SQLite primary
key enforces one row per direction, and explicit updates and revocation repair
run in synchronous transactions. If two first links activate concurrently,
either valid link may win; callers must read the selected default rather than
assuming their request won. The losing activation cannot overwrite the winner
or create a duplicate assignment audit for that direction.

If revocation races activation of a replacement, the operations may serialize
in either order. The stable postcondition is one active replacement default and
no stored edge referencing the revoked integration. These are invariant
guarantees, not a promise about JavaScript promise completion order.

## Default-link management surface

Discord currently exposes the following operations:

| Command | Behavior | Mutation |
| --- | --- | --- |
| `/integration_list` | Lists this guild's active integrations and marks its default Twitch link | None |
| `/integration_default_set integration_id:<id>` | Selects that active member integration as this guild's Twitch default | One directional update or no-op |
| `/integration_unlink integration_id:<id>` | Revokes one relationship and repairs every direction that selected it | Integration revocation plus fallback/unavailability |

All three require `integration.manage`. The Discord adapter enforces the local
server owner/Administrator/Manage Server policy. Ordinary moderators and
configured announcement roles do not receive this capability. The registry
then verifies that the guild belongs to the selected integration, the Twitch
target is an authenticated member, the relationship is active, and the actor
belongs to the source platform. Supplying a valid integration owned by another
guild or mixing a target from another integration fails without changing the
current default.

There is no unset command or registry operation. Selecting the current link is
a successful no-op. The Twitch-to-Discord direction follows the same automatic
assignment and revocation rules, but no Twitch-native management command exists
yet. A future authenticated Twitch adapter may expose selection for its own
channel; Discord must not manage that direction on Twitch's behalf.

### Defaults, routes, and feature state are separate

| Need | Correct surface |
| --- | --- |
| Identify the one selected relationship from a feature action | Declare `links` and call `ctx.links.default(targetPlatform)` |
| Send through enabled relationships selected by a route kind | Declare and resolve a route; route resolution may fan out |
| Enable, disable, or retarget an integration route | `/integration_route_set` |
| Change the Discord guild's selected Twitch relationship | `/integration_default_set` |
| Store data owned independently by the invoking guild or channel | `ctx.state` or `ctx.config` |
| Store one authoritative value owned by the selected integration | Declare `links` and `integrationState`, resolve the default, then call `ctx.integrationState.for(link)` |

A default does not enable, disable, retarget, or filter route definitions.
Likewise, changing a route does not change the default. The read-only feature
resolver returns identity only; it does not grant management authority, expose
the registry, or merge the source and target groups' `ctx.state` namespaces.
Passing the exact resolver snapshot to the separately declared
`integrationState` service selects an integration-owned feature ledger; it
does not change route or default management authority.

## Status and route management

`/integration_status` reports the integration state, Twitch member, every route
(including disabled routes), execution counts, and effect counts. It does not
return effect payloads or platform credentials.

`/integration_route_set` addresses a stable, versioned route kind. Each update
sets the enabled state and may replace a Discord destination channel. A
Discord-to-Twitch route has no separate destination because its authenticated
Twitch member is the destination. Updates to revoked integrations are rejected.

Route updates are atomic with the corresponding
`integration.route.updated.v1` audit event. They affect new routing decisions;
effects already accepted into an outbox keep their immutable target.

## Audit history

`/integration_audit` returns at most ten recent entries, while the internal
registry API accepts a bounded limit up to 25. Entries contain the stable event
kind, timestamp, actor identity when available, and acting group. Invitation
secrets, OAuth tokens, effect payloads, and platform credentials are never part
of the audit schema.

Revocation preserves the integration members and history so an authorized
member can still understand what happened. Revoked links remain excluded from
active route resolution and the ordinary active-integration list.

## Dead letters and retry

`/integration_dead_letters` exposes a bounded list containing effect kind,
attempt count, failure code, and stable idempotency key. The command deliberately
omits the original message payload and verbose external response metadata.

`/integration_retry_effect` rearms exactly one dead-lettered effect. The
coordinator preserves its original envelope and idempotency key, resets its
attempt counter, and schedules the outbox alarm. Non-dead-letter effects cannot
be manually retried. A retry is operational recovery, not route re-resolution,
so later route changes do not redirect old work.

## Adding another management adapter

A future adapter should:

1. Authenticate the platform request and enforce its local management policy.
2. Pass its canonical platform group to registry status, route, or audit calls.
3. For a default update, pass the exact target group and an actor from the
   source platform; never offer a separate unset operation.
4. Let the registry independently verify integration membership.
5. Only after that check, access coordinator diagnostics or retry helpers.
6. Render bounded, platform-appropriate output without exposing stored payloads.

This keeps authorization defense-in-depth while allowing each platform to have
its own commands and user experience.
