# Effective-state binding lifecycle for live queries

Status: implemented foundation for state-querying roadmap step 7 on 2026-09-13.
Live dependency attachment remains step 8 and public SSE remains step 9.

## Boundary

An effective-shareable query observes one directional group view, such as a
Discord guild selecting Twitch state or a Twitch channel selecting Discord
state. The integration registry now owns a durable, monotonically increasing
binding revision for each `(source group, target platform)` direction.

The binding revision is distinct from a feature value's mutation revision. It
advances whenever the effective owner enters a transition or hands off to a new
ready source, even when both sources contain identical values. Returning from
integration A to B and later to A therefore produces three different binding
identities instead of reusing the first A identity.

This is internal state-query infrastructure. It does not expose integration or
realm identities publicly, alter Framework API v1, redirect a command that has
already resolved its invocation scope, or add the browser subscription route.

## Lifecycle authority

The registry records ordered binding authority for these events:

| Event | Recorded state |
| --- | --- |
| First selected link activates | `ready`, selected integration realm |
| Additional nondefault link activates | No change |
| Directional default changes | `ready`, replacement integration realm |
| Selected integration begins revocation | `transitioning`, no fresh source |
| Revocation chooses an active fallback | `ready`, fallback integration realm |
| Revocation needs a standalone successor | `transitioning`, no fresh source |
| Lazy standalone successor becomes ready | `ready`, successor realm |
| Pending invitation cancels or expires | No change |
| Unselected integration revokes | No change for that direction |

Activation changes only directions that previously had no default. Defaults
remain directional, so Discord and Twitch revisions advance independently when
their selected integrations differ. Routes remain unrelated to state
selection.

Registry initialization now preserves a default that points at a `revoking`
integration. Removing it during a restart would incorrectly make old standalone
or fallback state appear ready before the revocation saga had finished. The
ordinary saga remains the sole authority that replaces that selection.

## Race-free observation and recoverable invalidation

A binding watcher registers its observed revision and a 30–300 second lease.
Registration and revision comparison occur in one registry transaction:

1. a lifecycle change committed before registration returns
   `revisionMatched: false`;
2. a lifecycle change committed after registration atomically updates the
   revision and a coalesced outbox row; and
3. reconnecting or renewing never turns an old physical source into authority.

The registry alarm delivers at most 20 binding invalidations per pass, four at
a time. Failed delivery retains the outbox row and retries with bounded
exponential delay. The alarm scheduler also includes watcher expiry and pending
binding work. Production mutation routes pre-arm recovery when binding interest
exists, and registry construction repairs alarm scheduling after a restart.

Each invalidation contains only logical watcher/observer routing, the ordered
revision, ready/transitioning status, an internal source key when ready, a safe
reason code, and commit time. It contains no query, grant, credential, feature
value, OAuth data, or command payload.

The group-local `StateQueryObserver` coalesces pending binding events by logical
direction and keeps a bounded high-water authority after acknowledgement.
Consequently a delayed revision from an earlier A or B binding is rejected even
after the newer notification has been consumed. Authority and inbox records
remain bounded to 2,000 edges and seven days; source outboxes cannot legitimately
retry beyond their five-minute watcher lease.

## Evaluation handoff rule

Effective-shareable source keys now include the registry binding revision in
addition to the physical realm and feature namespace. A ready result's opaque
`bindingRevision` digest therefore changes on every source handoff, including a
same-value handoff and A-to-B-to-A.

Before completing an evaluation attempt, the evaluator re-reads registry
authority and checks all three properties:

- the direction is still `ready`;
- its durable binding revision is unchanged; and
- its physical source is still the selected source.

A ready-to-ready race retries the complete bounded query against the new owner.
An active transition returns the existing explicit `query_transitioning`
envelope instead of presenting the old value as fresh. Step 8 will perform the
corresponding attach-new-before-detach-old dependency handoff; Step 9 will send
the replacement envelope over SSE.

## Initial limits

| Limit | Value |
| --- | ---: |
| Binding watcher lease | 30–300 seconds; default 120 |
| Watchers per directional binding | 2,000 |
| Watchers in the integration registry | 20,000 |
| Outbox rows per watcher/binding | 1 latest revision |
| Delivery claim | 20 records |
| Delivery concurrency | 4 |
| Attempt lease | 30 seconds |
| Retry delay | 1–30 seconds |
| Observer binding authority | 2,000 edges |
| Observer authority retention | 7 days |

## Verification

`test/state-query-bindings.spec.js` covers:

- the snapshot/register race through the internal registry API;
- first activation and no invalidation for an additional nondefault link;
- ordered A-to-B-to-A revisions and coalesced delivery;
- permanent rejection of a delayed earlier binding after acknowledgement;
- explicit interrupted-revocation status followed by a ready fallback;
- failed lazy successor materialization remaining transitioning until recovery;
- a ready standalone successor advancing authority; and
- an unselected integration revoking without retargeting the observed direction.

`test/state-query-evaluator.spec.js` additionally verifies a lifecycle race
causes a bounded retry with authorization checked again, an active transition
returns a transitioning envelope, and an invalid current source returns an
unavailable envelope.
Existing integration lifecycle tests continue to cover cancellation, expiration,
same-value materialization, asymmetric defaults, revocation recovery, and pinned
command invocation scopes.
