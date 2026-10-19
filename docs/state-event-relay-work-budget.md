# Relay remote-work budget

Latency roadmap step 3 bounds a relay invocation by complete application request
paths, in addition to its existing time, attempt and lease limits. This is
containment while the request chains are flattened in step 4. It does not
establish Cloudflare's numeric depth threshold or guarantee production latency.
Step 4 [flattens normal request chains](state-event-request-chains.md). The
weights below remain conservative for legacy fallback; normal carried snapshots
avoid the listed source callbacks. Structural tests now enforce depth two.

## Invocation and owner limits

| Limit | Behavior |
| --- | --- |
| Remote-call reservation | At most 20 conservatively weighted binding calls per relay invocation, including nested protocol calls. |
| Claimed records | At most 2 per invocation; records execute serially. |
| New publications | At most 1 pending/parked/gap-pending record per invocation, including a failed attempt or receipt recovery. |
| Owner-wide leases | Still at most 4 live records across concurrent alarm/manual handlers, with the existing ordered append and separate cleanup lanes. |
| Expiry/claim maintenance | Existing combined ceiling of 20 examined expiry markers/claimed records remains an additional bound. |
| Time and attempts | Existing five-second work-start/RPC bounds, 30-second leases and 12 automatic/20 total attempts remain. |
| Continuation | Persist remaining already-due, unleased work for 25 ms later in the existing shared alarm. This is a scheduling selection, not a dispatch-time guarantee. |

The budget covers the relay and its awaited descendants. It excludes command
ingress/authentication and the separate, already bounded grant/read-notification
drains that follow the relay in the owner's alarm. It is not a billable-request
counter or a bound on all work in the Worker invocation.

## Complete-path reservations

`src/state-events/relay-work-budget.js` owns the weights. A row must fit its
complete worst-case path before the claim transaction creates a lease or charges
an attempt. Reservations are not refunded when a cheaper path succeeds.
Each direct RPC also charges its record's allowance before issuing the request;
unknown stages or an exhausted allowance are refused before transmission.

| Direct relay call | Weight | Descendants included |
| --- | --- | --- |
| Interest registration | 2 | Destination request and source proof. |
| Local append | 2 | Destination request and source proof. |
| Shared authority append | 8 | Owner → registry, registry proof, up to two old-barrier recovery calls, append plus proof, and rejection fencing plus proof. |
| Destination confirmation | 2 | Destination request and source proof. |
| Outcome lookup | 2 | Destination request and possible source proof; stored receipts can be cheaper. |
| Shared origin retirement | 4 | Origin request and conservative allowance for owner lookup/fencing/confirmation. |
| Interest release | 1 | Destination epoch check, without source callback. |

A pending local/shared record reserves 7/17 calls, including possible terminal
cleanup. An appended row reserves 7/11. A recorded-gap cleanup reserves 3/7; a
retiring/reset-discarded row reserves 1/5. These deliberately include stages
that can already be complete. Changing authority, destination or origin paths
requires updating both these weights and the enforced-call tests.

## Yield and recovery

Budget rejection during selection creates no lease, consumes no attempt and
changes no state value. The end-of-pass transaction moves only already-due work
without a live lease to the continuation time and recomputes the shared alarm.
Future deadlines, parked/null wakeups and live uncertainty leases are preserved;
earlier notification/watcher/invalidation deadlines still participate in the
minimum. No queue-wide timer runs when there is no eligible continuation.

A defensive mid-record allowance rejection occurs before the next call. Known
completed stages stay durable and the record resumes later. A real transport
failure/timeout follows ordinary unknown-outcome handling, retaining its lease;
budget exhaustion is never used to declare a remote append absent. Registry
barriers, destination deduplication, ordering, original expiry and source replay
identity are unchanged. No schema migration or feature API change is required.

Only a later alarm or explicit request creates another invocation budget.
Continuing through a promise, microtask or `waitUntil` does not create more
budget. An explicit request still passes the same owner-wide lease gate.
Opt-in `relay.yield` records expose the reason, reserved-call total and limit.

## Evidence and limits

`test/state-event-work-budget.spec.js` uses native SQL/protocol implementations
with injected binding wrappers and controlled alarm dispatch. An independent
guard counts every application binding call, including registry/proof callbacks,
and enforces a synthetic awaited-nesting ceiling. Ordered local/shared bursts
advance through actual persisted deadlines without forcing due dates. Other
cases cover lost replies before/after append, the eight-call authority recovery
path, ACK retirement/release, refused transmission and native alarm persistence
across eviction. The four-live-lease test uses competing explicit handlers.

The synthetic nesting limit is deliberately separate from the production depth
counter. A deliberately too-small test limit fails and retains recovery authority;
it does not identify a Cloudflare threshold. The raw-binding installed-health
tests remain the check without per-hop test injection, and still do not reproduce
the production depth failure. A smaller batch does not prove that the deepest
individual request path is safe. See [the investigation](state-event-latency-investigation.md).

The cost suite now measures a six-stream burst over six relay invocations,
including their scheduling passes. This bounds work per invocation at the cost
of additional alarm/SQL scheduling work under backlog. Full report/pricing
refresh remains latency roadmap step 10; CI exports current measurements.
