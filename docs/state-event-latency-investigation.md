# State/event latency investigation: step 1

Step 1 of the latency repair roadmap established reproducible failure models and
an installed-feature harness, without production changes. Step 2 repairs shared
source alarm scheduling as described below. Step 3 adds a conservative
[relay remote-work budget](state-event-relay-work-budget.md) and durable
continuations. Step 4 [flattens normal publication and retirement requests](state-event-request-chains.md)
with private owner-validated snapshots. Leases and widget ACK policy remain unchanged.
The captured production baseline
is `45c8ed9be7c37299868c06d215e90b382cf7d19d`.

## Captured evidence

`test/fixtures/state-event-latency/production-2026-10-19.json` contains an
allowlisted timing summary of the supplied Worker and browser captures. Raw
captures are deliberately excluded. The fixture contains relative Worker times,
operation/event sequence numbers, fixed RPC labels, counts and browser-local
intervals. It excludes credentials, headers, payloads, account/group/route IDs,
raw errors and private URLs. `uncertainAttempts` counts unknown outcomes across
all stages, including confirmation/cleanup, not just append.

| Observation | Same-side timing | Implication |
| --- | --- | --- |
| Operation 43 | Commit to first claim 22,584 ms; claim to append 108 ms | Its initial delay precedes an append attempt. |
| Operation 47 | Commit to first claim 45,413 ms; claim to append 111 ms | A second independent example of initial scheduling wait. |
| Operation 50 | First claim after 6,323 ms; unknown append outcome in 22 ms; eventual acceptance after 65,999 ms | Initial dispatch delay and uncertain-outcome recovery are separate intervals. |
| Six source alarm entries | Selected timestamp to handler entry 29,233–58,688 ms | The observed selections are overdue; this does not identify why the platform dispatched late. |
| Six normalized unknown RPC failures | 22–57 ms across append, confirm and origin retirement | These failures did not wait for the five-second application timeout. |
| Seven runtime depth-error records | Explicit runtime errors in the supplied capture | A real production depth failure exists; neither its numeric threshold nor its full causal lineage is captured. |
| Browser event 43 | Effect handler interval 6,424 ms | The current ACK waits for effect completion. Other effects also exceeded their configured duration. |

Worker intervals use the Worker timestamp domain. Browser effect intervals use
browser timestamps only. No browser/server clock calibration or one-way transit
estimate is inferred. Missing or sampled records are not proof that a call did
not happen.

## Request boundaries and reentry

These are application call paths, not a claim about the runtime's depth counter.
Each arrow below is an awaited native Durable Object request unless described
as a later alarm or socket message. Local SQL and local function calls do not
introduce a request boundary.

| Stage | Path and work |
| --- | --- |
| Shared acceptance | Action runtime → origin GroupConfig → IntegrationRegistry → ShareableStateRealm. The owner atomically saves state and the event outbox; origin finalization/owner confirmation also have their own request boundaries. |
| Interest registration | Owner → destination DurableEventStream → owner delivery proof. |
| Shared append | Owner → registry → owner proof, then registry → destination → owner proof. The registry's authority check and the destination receipt transaction surround separate proof requests. The receipt returns through registry to owner caching. |
| Confirmation | Owner → destination → owner proof, allowing destination receipt pruning after source caching. |
| Outcome reconciliation | Owner → destination outcome lookup. A stored receipt supplies the fast path without a new append; absence has different authority requirements. |
| Origin retirement | Owner → origin → owner operation lookup; origin recovery may also confirm owner state if its cached outcome was not confirmed. |
| Interest release | Owner → destination with the producer epoch before final source outbox deletion. |
| ACK and producer wake | Browser socket ACK → destination. A later destination alarm → owner wake request; the owner persists the wake and schedules work rather than running the relay inline. |
| Readable notification | After the event relay in the owner's alarm: owner → state-query observer notification. A later observer alarm reevaluates state and sends a snapshot. |

Owner proof requests reenter the same object while its outgoing call is waiting.
The relay can then start further records and housekeeping calls in the same alarm
handler. That is a reason to measure request lineage, but counting sequential RPCs
does **not** establish accumulated nesting. The capture does not include the
runtime depth counter or a complete parent-span tree. Physical request totals
cannot substitute for either.

Upstream workerd also associates outgoing channels with the currently selected
incoming request in an actor's shared I/O context; selection can change when a
new request arrives. See the pinned primary source:
[I/O context selection and channel factory](https://github.com/cloudflare/workerd/blob/900cbea9f44f2e5711e7dd4b130011b82e086f6b/src/workerd/io/io-context.h).
This makes extra test-control requests a meaningful potential perturbation.
It does not prove how the production depth counter was charged: upstream source
is not a verified match for the deployed runtime, and this review has not located
the exact counter transition responsible for the captured failure.

## Verification layers

| Layer | Coverage | Limit |
| --- | --- | --- |
| `test/health-native-boundaries.spec.js` | Installed health declarations/actions, unchanged native bindings and registry singleton, standalone and linked Discord/Twitch routes, real alarm dispatch, socket delivery/ACK, four paced commands, eviction and idempotent retry. | Local workerd passes both cases; production placement and depth exhaustion remain un-reproduced. Platform HTTP authentication is outside this action-boundary test. |
| `test/state-event-failure-models.spec.js` alarm cases | Actual scheduler and native SQLite with a deliberately controlled clock/dispatcher: overdue selection, handler rearming, admission during a running handler, and interruption after durable work is saved. | Synthetic dispatch does not emulate Cloudflare placement, retry machinery or timing. |
| The same file's RPC fault cases | Explicit pre-append depth-shaped rejection versus lost reply after a real append. Both retain uncertainty and lease fencing, then recover one event with the original identity and one state mutation. | Uses forwarding/injected fixtures. It neither enforces nor measures native request depth. |
| `scripts/smoke-health-widget-browser.js` | Chromium deliberately holds animation completion, observes a readable snapshot still update, and verifies ACK remains held until release. | Synthetic completion delay does not establish background-tab throttling as the production cause. |

The native fixture counts its `runInDurableObject` control calls and asserts that
none are added throughout the measured command/relay/ACK interval. Setup may
seed integration membership and issue real default-link/grant requests; SQL
inspection, eviction, retry checks and cleanup occur outside that interval.
There are no forwarding bindings, per-hop environment injection, forced due
dates or manual relay drains in that measured path. Existing injected pacing
tests remain useful scheduling regressions but cannot establish native depth
behavior.

## Scheduler repair in step 2

The source relay observes mode and maintains the outbox before claiming work.
Those operations can schedule work that is already due. Claim then advances the
durable wakeup to the lease deadline. Before step 2, the shared alarm helper only
replaced an alarm if the new selection was earlier, retaining the old past
timestamp despite a future durable deadline. A new admission could likewise
leave an overdue alarm untouched.

The shared helper now replaces an expired selection with the earliest remaining
durable deadline, clamped to the current time. Ordinary admission still preserves
an earlier future alarm. GroupConfig and ShareableStateRealm also recompute their
alarm in a `finally` block after draining, using all four durable sources:
state-event outbox, grant invalidation, readable notification and watcher expiry.
That final transaction can replace a provisional future selection if its work
has completed or moved; a valid earlier deadline remains included in the minimum.
Empty queues clear stale alarms. Lease-only queues sleep until their durable
deadline; the repair never clears a lease or starts a new relay inline.

The two step-1 scheduler characterizations are now repair regressions.
`test/storage-alarm.spec.js` adds controlled dispatch/admission/interruption cases
over native SQL, all-source deadline preservation, idle behavior and native
SQL/alarm rollback before and after a failed alarm write. Native owner eviction
tests cover constructor repair for both owner types while retaining an uncertain
lease. The existing pre-append rejection/post-append reply-loss cases also check
that the selected alarm respects the retained lease. No production minute-spaced
dispatch behavior is attributed to these controlled models.

Acceptance/claim transitions still save SQL and alarms together. Final scheduling
also runs when a handler throws, and the failure continues to the runtime. Abrupt
termination cannot run JavaScript cleanup; existing durable transitions,
constructor recovery and platform retries remain necessary. There is one extra
bounded all-source scheduling read/transaction at handler completion, and expired
selections now cause actual alarm writes. No RPC, durable table, polling loop or
new timer is added. Cost profiles must account for those scheduling changes.
The focused 20-profile run keeps installed-health warm SQL writes and binding
requests unchanged, with four additional alarm sets and two additional alarm
reads per measured online cycle. See the dated note in
[the cost report](state-event-costs.md); the new 16-set bound includes the final
source scheduling pass, and the long-offline tests still require finite work
with no polling.

The browser ACK-after-effect assertion is another baseline, to be replaced by
step 8's bounded visual queue regression. Fault-recovery assertions remain safety
requirements: no second state mutation, no duplicate event, and no premature
lease release.

## Immediate delivery in step 5

[Immediate bounded activation](state-event-immediate-delivery.md) now requests
one background pass after owner commit and eligible consumer/capacity wakeups.
First publication can precede the one-second recovery deadline. Durable alarms,
leases, retry/coalescing windows and all authority checks remain. Commands never
await publication through the registry's still-held commit queue. No self-RPC,
polling timer, new schema or coordinator is needed. `waitUntil` retains request
context and does not enlarge the relay budget or prove production depth safety.

## Remaining uncertainty

This work does not establish a numeric production request-depth budget, the
precise reentrant context transition causing exhaustion, why overdue alarms
started near minute boundaries, or why particular browser effects completed
late. Local native successes must not be presented as a fix for those failures.
The following steps address the reproduced application scheduling and request
topology problems while retaining durable recovery for platform failures.
