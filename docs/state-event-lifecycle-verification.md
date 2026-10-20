# Combined health lifecycle and latency verification

Latency repair roadmap step 9 joins the earlier boundary regressions with the
installed `fun.health` declarations, command/action runtime, native SQLite
owners, registry, event stream, consumer WebSocket and authoritative readable
snapshot. This is automated regression evidence, not a production p99 claim.

## Native runtime observations

`test/health-state-event-lifecycle.spec.js` uses four real-clock cases:

| Health route | Initial origin | Command spacing | Readable delivery to coordinator |
| --- | --- | --- | --- |
| Standalone realm | Discord | 5 seconds | Before event handling |
| Standalone realm | Twitch | 15 seconds | After event handling |
| Linked realm | Discord, then Twitch | 15 seconds | After event handling |
| Linked realm | Twitch, then Discord | 5 seconds | Before event handling |

Each case executes two distinct commands, evicts the owner and reconnects the
consumer between them, retries the original source after ACK, and checks the
same snapshot and continuous destination sequence. Normal pacing does not
forward bindings, alter declarations or timestamps, force SQL deadlines, or
manually drain alarms. Permission authorization is supplied at the action
boundary; Discord/Twitch HTTP signature validation is outside this fixture.
The installed health owner is a shareable realm even when standalone. The
existing `state-event-latency.spec.js` separately covers group-local `CONFIG`
and shareable owners at both five- and fifteen-second spacing, three commands
per case, using its explicitly injected declaration/binding fixture. Group-local
cases explicitly evict the owner before the second command. Fixture setup
restores its injected bindings/declarations before direct commits after eviction;
production constructors already install the real feature registry.

The shipped coordinator and health effect queue handle native event frames.
Animation completion never resolves: both events still ACK, reconnect cancels
the obsolete effect, and the fresh session starts its own effect. Duplicate
handling adds no effect. In the event-first case,
the displayed value remains unchanged until the readable snapshot is delivered.
In both orders, health comes exclusively from readable state. The native socket
registration, event delivery and ACK handlers are real; chosen snapshot delivery
order is a test control rather than a claim about network ordering.

The 4.5-second local delivery guard detects a lease-length regression under the
test runtime. It neither establishes Cloudflare placement behavior nor promises
that deployed updates always meet that deadline.

## Explicit fault models over native handlers

`test/helpers/installed-health-faults.js` is installed only for fault cases.
It wraps binding fetches to inject loss/delay, and drives actual handlers using
persisted native alarm deadlines. The application clock is ahead of the real
dispatcher so automatic alarms cannot race the model. It never zeroes lease
deadlines or resets attempt counters to obtain recovery.

Each sequence runs against standalone and linked installed health, with Discord
and Twitch origins represented:

| Combined fault sequence | Required evidence |
| --- | --- |
| Missed immediate activation, three-command burst, owner eviction, late alarm, missing consumer, idle, reconnect and ACK | Pending attempts remain zero before dispatch. Offline publication preserves three ordered identities/snapshots, performs no repeated polling, then reconnect delivers all three. Duplicate sources do not mutate again. |
| Synthetic pre-append depth failure, absent receipt probe, delayed original append, successor command, owner eviction and lease recovery | An absent probe cannot clear uncertainty. The late original appends once; its successor stays behind the original lease. Recovery yields exactly two events and two mutations in sequence. This injected exception is not an observation of Cloudflare's depth counter. |
| Destination capacity, idle, reconnect, lost confirmation reply, ACK, owner eviction, lost interest-release reply and another eviction | Capacity preserves accepted health and charged work. The confirmed destination event is not appended again. Cleanup retains its charged retiring row through uncertainty, then releases rows/bytes and interest after its persisted lease. |

Every fault sequence ends by checking authoritative health and watermark,
unique destination receipts, no retained event after ACK, terminal owner receipts,
zero source rows/bytes, inactive producer interest and neither alarm dispatches
nor outbound binding calls during a further controlled idle minute. Offline and
capacity-parked idle periods also check both counters. The final readable check
resolves its shared binding, which deliberately schedules one registry safety
wake after one second while an event-grant watcher is active. The test requires
that exact wake with no outgoing call, settles it, then begins the idle minute.
It does not count deferred work from its own final read as idle polling. Faults are deterministic application
models; only the native boundaries/storage/handlers they surround are real.

## Harness validity

The fault dispatcher restores its injected bindings when waking objects to read
or dispatch an alarm. Its own regression evicts an owner without reinstalling
controls, then requires the owner-to-registry append fault to fire. This prevents an evicted
object's production constructor from silently bypassing fault injection or
request counters. Cleanup checks scope registry barriers to the fixture owner:
the native registry singleton can also retain unrelated fixtures' obligations.
The helper records dispatches and rejects backward clock
movement. Healthy native pacing still uses native bindings without this helper.

Installed event frames are checked against the complete readable watermark and
health payload. Burst checks require the expected row count before testing every
row, so an empty result cannot satisfy an `every` assertion.

The sustained-failure fairness cases still run eighteen traffic rounds, keep
three old cleanup obligations charged, assert per-pass call/depth limits and
retain the original twenty-second test timeout. Assertions that inspect one
unchanged state now share a single database snapshot, reducing control RPCs
without removing traffic, failure injection or recovery assertions.

A test audit also ran three temporary negative controls against the actual
assertions: changing oldest-pending overflow to newest-pending, disabling event
deduplication, and removing fault-binding restoration after eviction. Each was
rejected by an assertion in its targeted existing/new test; the fault regression
observed zero intercepted calls instead of one. All temporary mutations were
restored byte for byte. These representative checks establish sensitivity to
those regressions, not exhaustive mutation coverage.

## Complementary regressions

Step 9 combines rather than duplicates the existing focused evidence:

- `state-event-failure-models.spec.js`: explicit delayed alarm dispatch,
  overdue rearming, interruption, synthetic depth failure and lost replies.
- `state-event-work-budget.spec.js` and `state-event-delivery-snapshot.spec.js`:
  bounded call/nesting models, normal callback-free publication, trusted snapshot
  validation and revocation. No assertion equates JS nesting with platform depth.
- `state-event-activation.spec.js`, `state-event-receipt-probe.spec.js`,
  `state-event-relay.spec.js` and `state-event-fairness.spec.js`: missed activation,
  positive/absent probes, delayed original calls, both owner kinds, retention and
  retry limits, confirmation/cleanup outages, competing publication and cleanup.
- `state-event-readable.spec.js` and `state-event-browser.spec.js`: snapshot
  coherence, both arrival orders, scope movement, baseline/history suppression,
  startup buffering, duplicates and terminal subscription behavior.
- `health-widget-effects.spec.js` and the actual Chromium
  `scripts/smoke-health-widget-browser.js`: never-settling animations, eight
  pending plus one running, oldest-pending overflow, invalid-event rejection
  without ACK, hidden/resume, reconnect, reload and terminal cancellation.

The Chromium smoke loads shipped browser modules through an HTTP/WebSocket test
server. Its server is a protocol fixture, not a deployed Worker. Visibility is
controlled to verify policy, not to emulate vendor suspension. Native Durable
Object tests and Chromium tests provide complementary boundary evidence.

The immediate ACK-coalescing regression waits for the preceding producer wake
to finish before asserting its idle coalescing deadline. An attempt counter is
not completion evidence: while a wake RPC is still in flight, retaining its
30-second lease is correct. The test retains the original deadline assertions. The older manually driven
ACK/interest-release fault cases also move application time ahead of the native
dispatcher, preventing registration alarms from racing their controlled drain.
Their charged-retirement and eventual-cleanup assertions remain unchanged.
The shared capacity-rollback test likewise holds application time fixed in the
native dispatcher's future, so a seed publication alarm cannot change its
before/after snapshots independently of the rejected transaction.

The manually driven local-commit, shareable-commit, delivery and delivery-snapshot
suites use the same clock separation for every case, and clear fixture alarms
before restoring the clock. Admission-window checks also hold application time
fixed. Previously, a native alarm could publish the ordered head between capture
and validation, or claim the operation before an explicit reconciliation call.
A temporary 1.5-second pause reproduced the ordered-head assertion failure; the
same pause passed after clock separation. The diagnostic pause is not retained
in the suite. Real-clock latency and installed-health pacing tests are unchanged.

The test runner caps concurrent files at two Worker runtimes. Each pool worker
starts a full workerd process; CPU-count defaults started seven in the local
investigation and produced widespread deadline failures, followed by interference
from unfinished timed-out tests. Both two-runtime and serial diagnostics still
exceeded the default five-second whole-test deadline in multistep integration
cases. The default harness timeout is therefore fifteen seconds; explicit
per-test timeouts and internal latency, lease, retry and SQL/RPC/alarm assertions
remain unchanged. This gives fixture setup and complete delivery/ACK/cleanup
cycles additional headroom without treating the entire scenario as a single
delivery-latency measurement. File isolation and concurrent operations
inside tests remain enabled. Run one full suite at a time when diagnosing timings.
The producer-wakeup coalescing test also holds application
time fixed while queuing its two hundred notifications, then checks that the
second wake is blocked at 999 milliseconds and permitted at 1000 milliseconds.
Its correctness no longer depends on storage transactions finishing in under a
wall-clock second.

The earlier 2026-10-20 investigation observed local whole-test timeouts and two
group-local generic-fixture delivery deadline failures with these runner limits.
The installed-health native pacing/reconnect and fault cases passed locally;
the complete suite passed in CI. Subsequent full local runs passed, including
877/877 tests in 81 files at the step-10 baseline, and its final CI run passed
the same suite and all four Chromium smokes. Local Node 24 and CI Node 22 differ;
the unusually slow historical run remains incompletely attributed. Profiling
under matched environments would be needed to assign its remaining delay a
cause. Keep the latency and work-budget guards intact, and do not use a failed
or interrupted run as a cost-measurement baseline.

## Automated gate

```sh
npm test -- --run
npm run lint
npm run test:browser
```

CI additionally checks JavaScript syntax and performs the non-deploying Wrangler
build. No deployment, grant regeneration, data cleanup or schema migration is
required by this verification step. [Cost remeasurement](state-event-costs.md)
completed latency roadmap step 10 on 2026-10-20. The
[final release review](state-event-release.md) completes step 11 on the same date,
recording compatibility, recovery controls, evidence and production uncertainties.
