# State/event operation recovery

Roadmap step 3 implements an internal persistence protocol. Production combined
commands still return `state_event_not_implemented`. The group-local
state/revision/outbox adapter and scheduling are now implemented in step 4; shared
acceptance and lifecycle checks belong to step 5; relay and destination admission come later.
None of the modules under `src/state-events/` are feature API exports.

## Identity and immutable input

`createStateEventIdentity` implements the reserved `seo1` operation tuple in
[state-event-authoring.md](state-event-authoring.md). The owner and binding
revision are deliberately absent. A separate `sesrc1` source key omits the action
kind so using the same feature/source for another action conflicts at the origin.
Environment, feature and origin group remain part of both identities.

The caller fingerprint includes normalized arguments, actor identity/claims,
authenticated source creation time and the versioned declaration snapshot.
The framework caller must include operation, namespace and payload declarations
in that snapshot. It excludes live configuration. A separate prepared fingerprint
covers the complete frozen request, including selected configuration. These
fingerprints use canonical JSON and SHA-256 with their own format discriminator.
They are conflict detectors, not credentials.

The recovery coordinator looks up the origin record before invoking its lazy
preparation function. A retry does not reread configuration or recompute an event
from new state. Concurrent preparations recheck after hashing; the first durable
preparation wins. A different caller fingerprint or action produces
`state_event_source_conflict`.

Command invocations now optionally retain `sourceCreatedAtMs`. Discord derives
it from the signed interaction's snowflake. Twitch carries the first verified
EventSub timestamp already persisted by the inbox through chat/action dispatch;
duplicate ingress does not replace that timestamp. Existing ordinary invocations
without timing remain compatible. Combined identity creation requires timing,
and owner admission checks the two-hour source deadline inside the transaction.
Neither retry wall-clock time nor a new HTTP signature extends it.

## Origin and owner protocol

`createStateEventRecovery` runs at the origin `GroupConfig` object with a private
owner transport. No public route or feature service invokes it yet.

| Stage | Durable evidence and behavior |
| --- | --- |
| Prepare | Save the immutable request, owner/stream route, prepared fingerprint, attempt epoch and random token before contacting the owner. Claim the existing group cooldown in that same transaction. |
| Recover | Ask the pinned owner for the receipt. A missing receipt means only “absent”; a timeout yields `state_event_outcome_unknown`. Neither permits consulting new defaults. |
| Commit | The owner transaction checks an existing receipt and fences before invoking a trusted synchronous framework storage adapter. A duplicate returns the original result. |
| Confirm | Cache the verified owner receipt at the origin, release the request buffer, then acknowledge the durable cache to the owner. Cache or acknowledgement failure cannot change a proven committed outcome. |
| Repin | The old owner atomically returns its committed receipt or persists a fence through the old attempt epoch. Only after a fence may the origin resolve another route and compare-and-swap its locator. |
| Retire | Pending delivery and uncertain outcomes keep their records. Terminal delivery plus durable origin confirmation permits owner receipt cleanup after retention. An expired, uncommitted origin releases its request only after an authoritative owner fence. |

The owner keeps its highest fenced epoch. Revisiting an earlier owner with a
higher epoch does not un-fence delayed earlier requests. Commit and fence use
synchronous transactions, so their race has one winner. Concurrent repins compare
the original attempt before changing the origin. There are at most eight pinned
attempts per logical operation, including the initial attempt; reaching that
limit does not fence the last still-valid attempt.

`commitStateEventAtOwner` is a private transaction primitive for the forthcoming
storage adapters. Its callback is trusted framework code using the same local
SQLite transaction, never a contributor callback. Protocol tests use a SQL
mutation witness; this does **not** implement the production state/outbox adapter
or claim an event has been queued. Step 4 puts local mutation,
revision, notification and outbox writes inside it; step 5 must do the same for
shareable owners and revalidate lifecycle authority at acceptance. Invalid results, request conflicts and receipt capacity
failures roll back the witness writes in the tests.

The binding-only local owner endpoints expose `lookup`, `fence` and an origin
`confirm` acknowledgement, never receipt creation. They verify that the addressed `GroupConfig` object's ID matches the
pinned group key. Shareable realm endpoints bind the realm identity, check the
feature/namespace and physical route, and perform recovery before namespace
initialization, legacy adoption or write/seal checks. Frozen owners can therefore
answer receipt/fence requests without changing feature state. Ordinary writes
remain subject to the existing freeze rules. These records are outside the
feature snapshot/clone tables.

## Bounded storage and costs

The lazy `state_event_records` and singleton budget tables are shared by origin
and owner bookkeeping within each object. They are allocated on first prepare,
fence or commit; an absent lookup allocates nothing. Counters and indexed pruning
avoid scanning receipt history for each command. Existing cooldown validation and
its bounded pruning are reused.

- At most 100,000 records and 16 MiB of serialized metadata per object.
- At most 100 pending origin requests and 512 KiB of their serialized bytes.
- Prepared requests: 16 KiB; each metadata record: 8 KiB; original result: 4 KiB.
- Admission prunes at most 20 eligible records using the expiry index.
- Source admission: two hours; origin retention: at least two hours from first
  preparation; owner retention: at least two hours from commit or fencing.
- No uncertain origin, unconfirmed owner receipt or pending-delivery owner receipt
  is eligible for pruning.
  Full budgets reject new admission. Cleared tombstones cannot be recreated by
  an old source because the mutation deadline is checked independently.

Step 3 introduces no alarms, polling or background requests; step 4 adds durable
local outbox wakeups. Fresh preparation
uses an origin transaction; recovery contacts only the pinned owner. Successful
origin caching sends one owner acknowledgement before its cached-confirmation
flag is set; a lost acknowledgement is retried without another mutation. Repinning
adds an old-owner fence and a conditional origin update before any new-owner
attempt. Later outbox scheduling must coordinate with existing alarms.

`test/state-event-recovery.spec.js` exercises real Durable Object SQLite storage,
eviction, concurrent preparation/commit/repinning, changed input, lost responses,
owner movement, fences, deadline expiry, terminal retirement, capacity and rollback.
The Twitch inbox suite also checks that duplicate ingress preserves source time.
