# Shareable feature-state lifecycle contract

Status: staged design contract. The behavior in this document is the normative
target for the shareable-state initiative, but it is not part of Framework API
v1 and is not implemented merely because it is documented. Until the staged
implementation reaches a feature, that feature continues to follow the current
[`integrationState` contract](feature-state.md).

This contract lets a feature keep working independently in a Discord guild or
Twitch channel and then share one authoritative state when those groups become
linked. It defines state ownership, linking collision resolution, concurrency,
defaults, cancellation, revocation, recovery, and compatibility. Later steps
may choose concrete API names and storage layouts, but must preserve these
observable rules.

## Scope and terminology

The first implementation supports the existing Discord–Twitch integration
model.

- A **group** is one Discord guild or Twitch channel. Standalone state is
  group-local, not global to every group on one platform.
- A **shareable namespace** is a feature-declared collection of state that may
  move between standalone and integration ownership. The stable resolution
  unit is `(feature ID, namespace ID, schema version)`.
- A **realm** is the opaque owner of one or more shareable namespaces. A realm
  is either standalone for one group or shared by one integration.
- A **standalone realm** is the realm selected when a group has no active
  default relationship to the other supported platform.
- An **integration realm** is the realm owned by one active integration.
- An **effective realm** is the realm selected for one action invocation.
- A **snapshot** is an immutable, versioned representation of one shareable
  namespace in one realm.
- A **collision** exists when both link candidates have nonempty, unequal
  snapshots for the same compatible shareable namespace.
- A **successor realm** is a new standalone realm forked from the last effective
  integration state after the final qualifying link is revoked.

Ordinary `ctx.state`, configuration, cooldowns, routes, effects, schedules,
OAuth credentials, and integration-management data are outside shareable
namespaces. For example, `fun.deaths` may eventually declare its per-game death
counters shareable while keeping each group's remembered game in ordinary
group-local state.

## Required invariants

Every implementation must preserve these invariants:

1. One action invocation uses exactly one effective realm for each shareable
   namespace it accesses.
2. Without an active default link, the effective realm is standalone and the
   feature remains usable.
3. With an active default link, the effective realm is owned by the selected
   integration. Both directions observe the same state only when their
   directional defaults select that same integration.
4. Completing another link does not replace an established directional
   default. It initializes the new integration realm but does not silently
   redirect existing commands.
5. Switching a default changes the effective realm for later invocations. It
   does not copy, merge, or reset either integration realm.
6. Linking, choosing one side, resetting the new shared state, cancellation,
   revocation, and relinking never overwrite or delete a source realm as part
   of that transition. Separate bounded-retention cleanup remains explicit.
7. A pending integration is not active. It cannot own a default, resolve a
   route, receive feature mutations, or appear as an active relationship.
8. A link becomes active only after every declared namespace has a complete
   resolution and the new integration realm has been materialized.
9. Concurrent mutations cannot be silently omitted from the selected shared
   state. A stale resolution must be rejected and rediscovered.
10. Feature code cannot enumerate realms, snapshots, integration IDs, other
    groups, or migration records. Selection and migration remain framework and
    integration responsibilities.
11. Routes and default links remain separate. Shareable-state selection does
    not enable, disable, retarget, or fan out a route.
12. Recovery is idempotent. Retrying a transition may finish the same result,
    but cannot create a second integration, realm, resolution, or audit event.

## Effective-realm resolution

An action will eventually declare a shareable-state service and request the
current scope for the other supported platform. The final API name is deferred,
but its semantic operation is:

```js
const state = await ctx.shareableState.current(otherPlatform);
```

The runtime fixes the source group to the authenticated invocation and resolves
the realm as follows:

| Default-link state at invocation | Effective realm |
| --- | --- |
| No active default link | The group's current standalone realm |
| Active default link | That integration's realm |
| Link activation or revocation transition is sealing state | Retryable transition result; no fallback write |

The returned scope is a frozen, invocation-local capability. A default change
affects later invocations. An invocation already pinned to an integration may
finish only while that integration remains active and the realm remains
writable; revocation or sealing fails closed rather than redirecting the
operation to a different owner.

There is no feature-level fallback from a failed integration operation to a
standalone realm. Realm selection happens once before state access so one
logical command cannot partially mutate two owners.

## Link lifecycle

The link flow becomes a staged lifecycle:

```text
invited
  -> twitch_verified
  -> discovering_state
  -> awaiting_resolution (only when collisions exist)
  -> finalizing
  -> active
```

`cancelled` and `expired` are terminal outcomes before activation. `revoking`
and `revoked` apply after activation.

Twitch verification proves control of the invited channel but does not by
itself activate the integration. The reservation remains bound to the original
Discord group, destination, authenticated Twitch group, environment, and
single-use secret. Refreshing the browser or retrying a callback returns the
same pending lifecycle record.

Only `active` relationships participate in default assignment, active lists,
route resolution, integration-owned feature access, or group-wide revocation
counts. Existing first-link default assignment happens after activation.

## Candidate selection for a new integration

State discovery captures one candidate snapshot from each member group for
every compatible shareable namespace:

1. If the group currently has an active default to the other platform, its
   candidate is that default integration's effective snapshot.
2. Otherwise, its candidate is its current standalone snapshot.
3. A nondefault active integration is never chosen implicitly.
4. Candidate identity, realm generation, namespace version, content fingerprint,
   and mutation version are recorded in the pending link.

This rule makes additional links predictable. A new integration receives a
copy of what each group currently experiences, while established defaults and
their realms remain unchanged. The new integration may remain dormant for one
direction until an authorized manager selects it as that direction's default.

Discovery never locks a realm while a user is reading the resolution page.
Commands may continue normally; finalization detects intervening changes.

## Empty, identical, incompatible, and colliding state

A namespace is **empty** when its canonical snapshot contains no persisted
feature entries. The initial implementation does not ask feature code to run an
arbitrary emptiness predicate. A persisted `0`, `false`, empty string, empty
array, or empty object is data unless the storage operation canonicalizes it by
removing the entry.

Snapshots are **identical** only when namespace ID, schema version, canonical
content, and relevant storage semantics match. Equality uses a stable framework
fingerprint, not display summaries or object insertion order.

Discovery resolves each namespace according to this table:

| Discord candidate | Twitch candidate | Result |
| --- | --- | --- |
| Empty | Empty | Initialize the integration namespace empty |
| Nonempty | Empty | Automatically select Discord |
| Empty | Nonempty | Automatically select Twitch |
| Identical nonempty snapshots | Identical nonempty snapshots | Automatically select either equivalent snapshot |
| Different compatible snapshots | Different compatible snapshots | Require user resolution |
| Different or unsupported schema versions | Any nonempty state | Block activation until a declared migration can produce comparable snapshots |

A collision is resolved at shareable-namespace granularity. The UI may group
namespaces by feature and offer an “apply to all” convenience, but persistence
records one explicit outcome for every colliding namespace.

The first version supports exactly these outcomes:

- **Use Discord:** copy the discovered Discord snapshot.
- **Use Twitch:** copy the discovered Twitch snapshot.
- **Reset:** create an empty namespace in the new integration realm.
- **Cancel linking:** cancel the entire pending integration.

There is no generic sum, maximum, union, last-write-wins, or feature-authored
merge hook in the first version. Those policies are not universally safe for
counters, collections, queues, schedules, or moderation data.

Reset applies only to the new integration namespace. Choosing either platform
or reset preserves both candidate realms and their immutable discovery
snapshots for bounded recovery and audit purposes.

## Concurrency-safe finalization

Optimistic version checking alone leaves a race between the final comparison
and activation. Finalization therefore uses an idempotent sealing protocol:

1. Bind one finalization operation to the pending integration ID and reservation
   idempotency key.
2. Acquire a transition seal on every selected candidate realm and namespace.
   A seal does not expose storage to the integration registry.
3. While sealed, reads may return the sealed snapshot, but mutations receive a
   bounded retryable transition result. They must not write to another realm.
4. Compare the sealed mutation versions and fingerprints with discovery.
5. If any candidate changed, release every seal, discard the submitted choices,
   rediscover state, and return to `awaiting_resolution` when necessary.
6. Materialize a fresh integration realm from the selected snapshots. Partial
   copies remain unreachable and may be retried with the same idempotency key.
7. Verify the complete realm manifest and fingerprints.
8. Mark the integration active and perform ordinary first-link default
   assignment only after the realm is complete.
9. Archive the discovery snapshots and release the candidate seals.

Cloudflare Durable Objects do not provide a transaction across every realm and
the registry. This is an idempotent saga with an externally visible activation
barrier, not a distributed SQL transaction. A crash may leave a pending realm
or temporary seal, but recovery either resumes the same finalization or releases
it after the bounded lease expires. It never exposes a partially copied realm
as active.

## Directional defaults and many-link behavior

The existing directional-default invariants remain unchanged:

```text
(source group, target platform) -> active integration -> integration realm
```

- The first qualifying active link fills an absent direction.
- A later link initializes its own realm without replacing the direction.
- An authorized default switch selects the target integration's existing realm
  for subsequent invocations.
- Switching back reveals that integration's later state; no migration occurs on
  default changes.
- Opposite directions may select different integrations and therefore observe
  different shareable state.
- Route fan-out remains independent of the one effective state realm.

The link-resolution page chooses the initial contents of the new integration,
not whether that integration becomes every member's default.

## Revocation, fallback, and standalone successors

Revocation distinguishes selected and nonselected integrations for each
direction:

| Revoked relationship | Default repair | Shareable-state result |
| --- | --- | --- |
| Not selected by the direction | No change | Current effective realm is unchanged |
| Selected, another eligible link exists | Promote the existing fallback integration | Later invocations use the fallback's existing realm; no copy or merge |
| Selected, no eligible link remains | Direction becomes unlinked | Create a standalone successor from the revoked realm's final snapshot |

For the final case, revocation uses another idempotent transition:

1. Mark the integration `revoking` and seal its realm against new mutations.
2. Capture and freeze its final namespace snapshots.
3. Repair directional defaults using the existing deterministic rules.
4. For each direction that becomes unavailable, create a new standalone
   successor for that source group from the final snapshots.
5. Atomically publish each standalone pointer only after its successor is
   complete.
6. Mark the integration revoked and retain its frozen realm and history.

Successor creation may be lazy if the group has no immediate command traffic,
but the pointer and source snapshot must be durably recorded during revocation.
The first standalone access may finish the idempotent copy. It must never expose
the group's older pre-link standalone realm as though it contained the final
shared state.

When both former members become unlinked, both successor realms begin from the
same final shared snapshot and then diverge independently. Neither platform
continues sharing after revocation.

## Cancellation, expiry, and relinking

Cancelling or expiring a pending integration:

- releases any transition seals owned by that pending operation;
- leaves all candidate realms, defaults, routes, and active integrations
  unchanged;
- makes its partially materialized integration realm unreachable and eligible
  for bounded cleanup;
- preserves a bounded audit record without storing invitation secrets; and
- does not revoke otherwise valid Twitch bot authorization.

Relinking always creates a new integration ID and a fresh integration realm.
Discovery uses each group's then-current effective realm, including any
standalone successor created after an earlier revocation. A revoked realm never
silently becomes writable or active again.

## Namespace declarations and versioning requirements

The next design step must add validated feature metadata sufficient to identify
shareable namespaces without loading feature code into migration infrastructure.
At minimum, each declaration must provide:

- stable feature and namespace IDs;
- a positive schema version;
- a bounded user-facing label;
- compatibility and migration information for supported prior versions;
- a bounded, nonsecret collision-summary policy; and
- storage limits no weaker than current feature-state limits.

The framework may copy an opaque canonical snapshot, but it must enumerate only
declared shareable namespaces. It must never infer shareability from ordinary
group state or copy an entire feature namespace that also contains local
preferences.

Schema migration happens before equality and collision decisions. If either
candidate cannot be migrated deterministically to the installed declaration,
link activation stops with an actionable, retryable maintenance error. Reset is
not an automatic escape from an unreadable schema because the original state
must remain recoverable and understandable.

## Authorization, privacy, and audit

The Discord manager who creates the invitation authorizes that guild to enter
the proposed relationship. The authenticated Twitch broadcaster who completes
the invitation may choose collision outcomes because the choices affect only
the new integration realm and all candidate snapshots remain preserved. A
future destructive cleanup operation would require its own explicit authority
and is outside this contract.

Resolution submissions require the pending integration's same-origin,
single-use browser capability and CSRF protection. They are bound to the
verified Twitch identity and cannot substitute another group, integration,
namespace, schema version, fingerprint, or default target.

The UI and audit log may contain only feature-approved bounded summaries.
Arbitrary JSON values, collection contents, user text, OAuth credentials,
invitation secrets, storage keys, and raw snapshot payloads are not rendered or
stored in registry audit metadata.

The lifecycle records stable events for discovery, submitted resolutions,
stale-resolution rediscovery, activation, cancellation or expiry, revocation,
and standalone-successor publication. Automatic empty, one-sided, or identical
outcomes are recorded as framework decisions rather than attributed to a user.

## Failure and recovery guarantees

- Temporary registry, realm, or coordinator failure leaves the relationship
  pending or revoking and schedules bounded retry with the same idempotency key.
- A transition seal has a durable owner and bounded lease. Recovery renews it or
  safely releases it; an abandoned browser cannot freeze commands forever.
- User-facing mutation attempts during a seal receive a retryable response. They
  are not reported as successful and are not redirected silently.
- Permanent validation, authorization, incompatible-schema, size-limit, or
  membership failures do not activate the integration.
- Cleanup may remove unreachable partial realms and expired discovery snapshots
  only after their retention window. It cannot remove active, standalone,
  successor, or frozen revoked realms.
- Integration status distinguishes pending resolution, finalization recovery,
  active, revoking, revoked, cancelled, and expired states without exposing
  state payloads.

## Compatibility and staged rollout

This contract does not change current production behavior by itself.

1. Existing group `ctx.state` remains group-owned and is never reclassified
   automatically.
2. Existing active `integrationState` ledgers remain authoritative for their
   integrations and should be adopted in place as integration realms where the
   declared namespace is unambiguous.
3. A feature opts into shareable state only in its explicit migration step.
4. Before that migration, an unlinked invocation continues following the
   feature's current behavior, including any default-link-required response.
5. Framework API v1 remains stable. Exposing shareable state requires the
   compatibility decision and documentation specified by the later API step.
6. Rollout must not reactivate revoked integration data, overwrite established
   defaults, or copy ordinary local state into a shareable namespace.

For `fun.deaths`, the intended later migration adopts existing integration-owned
death counters as integration realms, creates standalone counter realms for
unlinked groups, and leaves `last_game` in ordinary group state. The command
changes only after the generic lifecycle and migration tests pass.

## Rejected shortcuts

The contract deliberately rejects several simpler-looking implementations:

- Falling back from `integrationState` to ordinary `ctx.state` would mix local
  preferences with migratable data and make ownership depend on feature code.
- Keeping two local copies synchronized through routed effects would permit
  retries, outages, many-link fan-out, and revocation to create divergence.
- Moving one candidate realm into the integration would make cancellation,
  relinking, recovery, and a mistaken user choice destructive.
- Activating the link before resolution would expose routes and defaults while
  its authoritative feature state was still undecided.
- Comparing versions without sealing would still allow a mutation after the
  final comparison and before activation.
- A generic merge rule would silently invent feature semantics. Reset or an
  explicit platform choice is safer until a later contract defines reviewed,
  schema-specific merge behavior.

## Acceptance scenarios for later implementation

The completed system must demonstrate at least these observable scenarios:

1. Two unlinked groups use the same feature independently.
2. Linking empty groups activates without a resolution page.
3. Linking one used and one empty group adopts the used state automatically.
4. Identical used states activate automatically.
5. Different states offer Discord, Twitch, reset, and cancel outcomes per
   namespace.
6. A mutation during user deliberation invalidates the stale resolution.
7. A mutation racing finalization is either included before sealing or receives
   a retryable transition response.
8. Refreshing or resubmitting finalization produces one integration and realm.
9. Creating a later link preserves established defaults and initializes a
   separate realm from the current effective candidates.
10. Switching defaults selects existing realms without copying them.
11. Revoking a nondefault link leaves effective state unchanged.
12. Revoking a selected link promotes an eligible fallback without merging.
13. Revoking the final link gives each side an independent successor beginning
    at the last shared snapshot.
14. Relinking reconciles the then-current standalone successors and does not
    resurrect the revoked realm.
15. Cancelling, expiry, incompatible schemas, or partial infrastructure failure
    never expose a partial integration or erase candidate data.
