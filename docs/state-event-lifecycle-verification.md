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
zero source rows/bytes, inactive producer interest and no outbound binding calls
during a further controlled idle minute. Faults are deterministic application
models; only the native boundaries/storage/handlers they surround are real.

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
30-second lease is correct. The test retains the original deadline assertions.

## Automated gate

```sh
npm test -- --run
npm run lint
npm run test:browser
```

CI additionally checks JavaScript syntax and performs the non-deploying Wrangler
build. No deployment, grant regeneration, data cleanup or schema migration is
required by this verification step. Cost remeasurement and final release review
remain latency roadmap steps 10 and 11 respectively.
