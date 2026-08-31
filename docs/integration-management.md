# Cross-platform integration management

Step 8 adds an authenticated operational surface without turning Durable Object
service endpoints into public HTTP APIs. Discord interactions remain the first
management adapter: the existing signature verification and
`integration.manage` capability protect every command, while the registry also
checks that the requesting guild belongs to the named integration.

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

## Default-link management

`/integration_list` marks the Discord guild's current default Twitch link.
`/integration_default_set integration_id:<id>` changes that directional choice
to another active relationship containing the guild and selected Twitch
channel. Both commands require `integration.manage`.

The Discord adapter enforces the local owner/Administrator/Manage Server policy.
The registry then verifies that the guild belongs to the selected integration,
that its target is an authenticated member, that the relationship is active,
and that the supplied actor belongs to the source platform. This defense in
depth is reusable by another authenticated platform adapter.

No API or command unsets a default while an eligible relationship exists.
Selecting the current relationship is a no-op. Revoking the selected link
atomically chooses the oldest remaining active edge, or removes the record only
when no link to that target platform remains. Automatic assignment, explicit
updates, fallback, and last-link unavailability use distinct audit events.

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
