# Bounded state/event relay and producer wakeups

See [latency diagnostics](state-event-diagnostics.md) for bounded opt-in traces and paced native regressions.

Step 11's [cost measurements and regression budgets](state-event-costs.md)
verify the relay's work under bursts, history growth and long outages. New
admission wakes unresolved work without rescheduling confirmed appended rows;
consumer/capacity wakeups still allow their terminal cleanup.

Roadmap step 7 automatically reconciles accepted private local/shared intents.
[Step 9](health-state-event-migration.md) adds command execution behind explicit
new-acceptance switches, disabled in checked-in Wrangler environments.
No feature, stream version or credential is migrated. [Browser correlation](state-event-browser.md)
is implemented in step 8; measured cost/load evidence is step 11.

## Durable scheduling and ordering

Acceptance schedules the first recovery alarm one second after commit in the
same transaction as state, revision, receipt and intent. Latency roadmap step 5
also requests an immediate bounded background pass after commit: a new first
publication need not wait for that alarm. See
[immediate delivery and fallback](state-event-immediate-delivery.md). `GroupConfig` and
`ShareableStateRealm` share their existing alarm with notifications, watcher
maintenance and grant work. Eviction recovers the durable due index.

The relay claims work transactionally before outbound I/O. A token and 30-second
lease protect each row; at most four records have live leases across concurrent
alarm and explicit recovery handlers. Each physical stream has one ordered
append head. Verified `appended` outcomes and terminal retirement use a separate
cleanup lane: a delayed cleanup lease cannot hold a new append behind it. Claims
within each lane still serialize, and both lanes share the same four-record
owner limit. Independent streams use a persisted last-served marker for fair
selection. A busy owner defers waiting work until a lease can recover; finishing
work releases those deferred rows promptly instead of spinning immediate alarms.

Each invocation reserves at most twenty complete-path binding calls, claims at
most two records and starts at most one publication. Remaining already-due work
gets a durable 25-ms continuation selection. The existing combined ceiling of
twenty expiry markers/claimed records also remains. See the
[remote-work budget](state-event-relay-work-budget.md) for nested-call weights,
scope and verification. The relay starts new attempts for at most five seconds.
Already started calls have a five-second
request deadline. A lost/unknown response retains the lease until recovery; a
retry recovers the original destination receipt rather than replaying a mutation.
A timeout is never proof of non-append. An uncertain `pending`, `parked` or
`gap_pending` head still blocks later appends until its lease/outcome recovers;
only a verified append or terminal outcome can move to cleanup scheduling. Explicit private reconciliation uses the
same lease, ordering and attempt counters.

| Boundary | Behavior |
| --- | --- |
| Scheduled delivery | At most 12 automatic attempts, including the initial attempt. |
| Total delivery/recovery | At most 20; the final attempt is reserved for original expiry when needed. |
| Transient backoff | 1, 2, 4, 8, 16, 32, 60, 120, 240, then 300 seconds. |
| Retained capacity/reset/disabled service | Park for a useful wakeup or original expiry. |
| Destination ingress rate pressure | Retry after the existing one-second admission window. |
| Successful append | Retain a compact source outcome; next deadline is original expiry, with earlier useful ACK/reconnect wakeups. |
| Exhausted total budget with unknown outcome | Keep bounded charged authority, remove retry timer, and block false readiness/drain. |

Useful wakeups cannot reset counters, extend the original thirty-minute event
lifetime, bypass a lease/ordered head or create a fresh event identity. No
periodic acknowledgement or consumer-presence checks run after append. The
source retains its charged outbox slot until terminal evidence arrives; sustained
unacknowledged traffic can therefore reach the existing 100-row admission cap.

## Reconnect and capacity notification

Before append or capacity rejection, a physical stream verifies the source and
persists one producer interest. New accepted work advances the source interest
epoch. Releasing an interest uses an epoch comparison so delayed cleanup cannot
erase newer work; a released epoch cannot be reactivated by an old registration.

Successful socket registration, an ACK that actually releases retained capacity,
and coordinated reset completion enqueue a durable notification on that stream.
A monotonic notification version survives eviction and deduplicates a lost reply
at the source. Coalescing allows at most one notification attempt per second per
stream. The destination claims a thirty-second notification lease and uses a
five-second request timeout, with at most twelve attempts per useful event. A new
useful event can resume exhausted notification work. Scheduling and the durable
notification marker share a transaction, so alarm failure cannot lose a wakeup.

Observing a real disabled-to-enabled master-switch transition is also a useful
wakeup on the addressed owner. A source request, existing alarm or consumer
registration/grant check can observe it. There is no fleet scan to discover
inactive owners, and enablement alone cannot awaken an otherwise untouched
object. A normal bounded expiry alarm still preserves unresolved authority.

## Terminal cleanup and finite storage

Source caching and destination confirmation precede payload release. ACK,
retention/lifecycle gap or coordinated reset provides terminal evidence. Cleanup
then retires the owner receipt, finalizes the original origin cache and releases
the last producer interest before deleting the outbox row and decrementing its
transactional counters. Shared origin retirement verifies the saved origin and
original owner; frozen realms can perform this infrastructure bookkeeping.
Cached terminal outcomes keep explicit recovery idempotent after row deletion.

Origin/interest cleanup has its own bounded control budget: twelve automatic
attempts, twenty total with useful wakeups/explicit recovery. These calls cannot
append events. If an origin is unavailable, a compact `retiring` row survives
restart and remains charged to source capacity. Even after the event deadline,
exhausted automatic cleanup parks without a recurring timer. Reset release
restores lease recovery for interrupted discarded rows.

Admission reserves 512 serialized bytes per pending intent and pending owner
receipt within the existing 512-KiB outbox and 16-MiB receipt budgets. Pending
receipt records also reserve room within the existing 8-KiB per-record ceiling.
This permits bounded terminal metadata to be written at capacity. Transactional
counters and indexed due/expiry queries avoid a receipt-history scan per relay.
SQL/index overhead is additional and will be measured in step 11.

Unconfirmed destination receipts and unresolved gap authority remain durable;
expiry never guesses delivery or discards proof. Retired source receipts become
eligible for ordinary lazy pruning after their two-hour minimum window. When no
combined retry, lease or expiry work remains, the source contributes no alarm.
Destination event retention, receipt pruning and grant alarms retain their own
existing purposes. No interval, global producer enumeration, permanent relay or
unbounded `waitUntil` is used.

## Automated evidence

`test/state-event-relay.spec.js` covers native local/shared owner alarms, durable
producer registration and reconnect/ACK wakeups, fair bounded draining, four
concurrent stream domains, work-start timeout and lease recovery, lost append
and notification replies, duplicate/coalesced wakeups, notification-alarm
rollback, disabled-to-enabled observation, original expiry and receipt cleanup,
capacity reserves, terminal-origin outages, cleanup retry caps and reset recovery.
A simulated long-offline period verifies no periodic outbound consumer probes.
Two controller budget tests inject transport completion while retaining real
SQLite leases; delivery/restart/notification tests use actual binding forwarding.
The existing state-only, event-only, lifecycle and socket suites remain required.

## Delayed cleanup and publication latency

A live report on 2026-10-18 showed commit-to-append delays of 1.148, 1.143,
20.244, 10.805, 1.140 and 7.776 seconds. These are inferred directly from the
frames: source commit is `expiresAt - 30 minutes`, and destination append is
`acceptedAt`. They establish backend queue/delivery lag, not its precise cause
or browser receive latency.

A native local/shared regression reproduced one blocking mechanism: lose an
interest-release response after ACK, retain the terminal cleanup lease, then
accept another impact. The original single stream lease gate delayed that new
append until the old thirty-second cleanup lease expired. Separate lanes now
allow six further ordered/acknowledged impacts while preserving that old lease,
its charged metadata and retry budget. Recovering cleanup later drains all
seven obligations without reappending or mutating state again. A companion
lost-append-response test proves uncertain publication still blocks its
successor and recovers the original sequence before proceeding.

This correction adds no polling, RPC, table, alarm interval or larger work
budget. It removes a reproduced cleanup dependency; network/authority outages,
full owner concurrency and delayed platform alarms can still add latency. The
production frames alone do not prove that every reported delay had this cause.
