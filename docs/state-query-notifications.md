# Recoverable state-query change notifications

Status: implemented foundation for state-querying roadmap step 6 on 2026-09-12.
Effective-state lifecycle handoffs were added in step 7 and live dependency
coordination in step 8; public delivery now uses direct hibernating WebSockets.

## Boundary

State-query sources now emit durable invalidation hints when committed readable
state changes. A hint contains source identity, feature/namespace identity, a
monotonic source revision, watcher identity, and commit time. It contains no
state value, query document, grant, credential, platform OAuth data, or command
payload.

Notifications are internal framework infrastructure, not a Framework API v1
feature-author surface or public HTTP endpoint. Step 8 attaches the evaluator's
exact dependency graph to these source watchers and consumes their invalidations
inside the observer. Logical-group binding revisions and realm handoff
notifications are described in
[`state-query-bindings.md`](state-query-bindings.md); coordinator behavior is
described in
[`state-query-live-observation.md`](state-query-live-observation.md).

## State owners and observer placement

| Source | Revision and mutation owner | Notification partition |
| --- | --- | --- |
| Group-local state | The selected group's `GroupConfig` object | Feature ID |
| Effective-shareable state | The currently selected `ShareableStateRealm` object | Feature ID plus namespace ID |

Each watcher points to the `StateQueryObserver` object for one deployment
environment and logical Discord guild or Twitch channel. Shared realms can
therefore notify both platform perspectives without becoming the public
connection owner. The observer is group-local as selected in the step-2
transport decision.

## Atomic mutation and outbox rule

The existing local feature and shareable namespace revision rows remain the
authority. SQLite triggers run in the same transaction that advances those
rows. For every unexpired watcher of the changed partition, the trigger upserts
one outbox record containing the newest committed revision.

This gives the state change and durable notification intent one commit outcome:
both persist or neither does. A failing observer never rolls back an already
committed command mutation. Repeated changes while delivery is pending replace
the pending revision for that watcher instead of appending history. The public
product is current state, so this coalescing is safe and bounds outbox rows by
active watcher edges.

The local storage implementation now treats setting an already equal JSON value
and incrementing by zero as revision-preserving no-ops. A bounded-counter value
that is unchanged still advances its revision when new subject metadata is
attached. Shareable bounded counters already follow the same rule. Creating or
removing a materialized counter subject advances the owning revision and thus
invalidates collection readers.

## Race-free watcher attachment

Registration accepts the revision observed by the caller and, in one source
transaction:

1. removes expired leases;
2. creates or renews the watcher lease; and
3. reads the current source revision.

The response contains `currentRevision` and `revisionMatched`. If a mutation
committed before registration, the mismatch requires a new snapshot. If it
commits after registration, the same transaction's revision trigger sees the
watcher and creates its outbox record. The watcher remains attached during a
mismatch so another mutation cannot fall into a detach/resnapshot gap.

This is the storage half of the version-checked snapshot-and-attach handshake.
Step 8 coordinates the complete query snapshot and all of its source
registrations before persisting a live result; step 9 will expose that result.

## Delivery, retry, and restart recovery

An active watcher keeps a source alarm scheduled for lease cleanup. Before a
potential mutation with active interest, the source durably moves that alarm to
one second in the future. This occurs before the synchronous state transaction:

- interruption before commit leaves a harmless maintenance alarm;
- interruption after commit leaves both the outbox row and its already durable
  recovery alarm; and
- source construction also repairs the next alarm from stored watcher/outbox
  state.

An alarm claims at most 20 due records with a 30-second attempt lease and sends
four observer requests concurrently. Failures use exponential retry from one to
30 seconds. A new mutation supersedes a claimed older revision safely: success
or failure of the old request cannot delete or postpone the replacement row
because it has a new notification ID.

Watcher leases last 30–300 seconds and default to 120 seconds. Expired watchers
and their pending records are deleted together. Explicit unregistration also
removes pending work. With no active interest, a state mutation creates no
outbox row, observer request, evaluation, or notification alarm.

Watcher and outbox tables are created lazily on first registration. A state
owner that has never been watched continues to advance its authoritative
revisions without allocating notification tables or running recovery work.

## Observer inbox behavior

`StateQueryObserver` stores invalidations in SQLite. Delivery IDs make retries
idempotent. The inbox keeps only the highest revision for each watcher/source
pair, so a delayed older notification is harmless and repeated changes cannot
grow one edge's pending work. Consumers may list up to 100 invalidations and
acknowledge up to 100 IDs at once.

The inbox is limited to 2,000 source edges, matching the initial active-edge
budget. Old acknowledged work is deleted explicitly; unacknowledged records
older than seven days are pruned opportunistically. If the hard cap is reached,
the oldest invalidation is replaced by the new one. A later query evaluation
always reads current source state rather than treating this inbox as mutation
history.

## Initial limits

| Limit | Value |
| --- | ---: |
| Watcher lease | 30–300 seconds; default 120 |
| Watchers per source partition | 2,000 |
| Watchers per source Durable Object | 5,000 |
| Outbox rows per watcher/source | 1 latest revision |
| Delivery claim | 20 records |
| Delivery concurrency | 4 |
| Attempt lease | 30 seconds |
| Retry delay | 1–30 seconds |
| Observer inbox | 2,000 source edges |
| List/ack batch | 100 records |
| Inbox retention | 7 days |

## Verification

`test/state-query-notifications.spec.js` covers:

- a mutation before attachment producing a revision mismatch, followed by a
  mutation after attachment producing a durable notification;
- revision and outbox intent committed together;
- no notification or revision advance for equal local writes;
- metadata-only local counter changes;
- shareable collection member insertion and removal;
- mutation success while observer delivery fails;
- retry recovery from a durable coalesced outbox after simulated source restart;
- duplicate and delayed older delivery at the observer;
- watcher and pending-work expiry; and
- zero notification work without interest.

Wrangler migration `v15` adds the SQLite-backed `StateQueryObserver` class. The
existing `GroupConfig` and `ShareableStateRealm` classes create their additive
watcher, outbox, index, and trigger tables idempotently on first watcher
registration, then recover them on later object construction; no deployed
migration tag is changed.
