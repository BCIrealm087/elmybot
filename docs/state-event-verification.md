# State/event failure, compatibility and resource verification

Roadmap step 10 verifies the implementation through step 9 against the
[combined-operation contract](state-event-contract.md). Checked-in environments
still disable new acceptance. This work authorizes no deployment.

## Failure matrix

The evidence uses actual Cloudflare test-runtime SQLite transactions, Durable
Object handlers, alarms, eviction, trusted binding calls and WebSockets. Tests
inject failures before forwarding a request and after the receiving owner has
committed. They use controlled relay handlers where necessary to avoid racing
native alarms. Long outages and retention boundaries advance the clock; lease
recovery advances persisted lease deadlines without resetting retry counters.

| Boundary / fault | Required outcome and automated evidence |
| --- | --- |
| Before mutation: invalid schema, payload or projected result | No value, revision, watermark, receipt or event write survives. Local tests `rolls back value, notification, sequence, outbox, receipt and alarm when the resulting payload is invalid` and `rejects an oversized projected payload and oversized saved result without changing state`; shared test `rolls back shared state, revision, notification, receipt, intent and alarm on invalid payload`. |
| Inside owner commit: receipt/outbox full, alarm installation fails | The transaction rolls back the real mutation and notification. Local fault/capacity tests and shared test `rolls back state and sequence when the shared outbox or receipt budget is full` compare complete before/after storage. |
| Concurrent commands, repeated source and changed arguments | A duplicate returns the original result; distinct commands serialize; conflicting input never becomes another mutation. Recovery tests `returns the original receipt/result on concurrent commits and retries after state changes` and `rejects changed arguments, declaration, timestamp or action for the same feature/source`. |
| After commit, before origin acknowledgement or command reply | Eviction/lost replies recover the original owner receipt, without another mutation or cooldown/configuration read. Recovery, shareable-commit, command-runtime and installed-health tests exercise this boundary, including disabled acceptance switches. |
| Malformed successful lookup/invoke reply | Missing/null receipts, wrong operation/event identity, invalid correlation, changed deadline and oversized results produce `state_event_outcome_unknown`. Command-runtime tests recover the original receipt on retry and assert one prepared input and sequence. |
| Binding changes before invoke or after a committed reply is lost | The command runtime fences/repins only an uncommitted attempt, or recovers the original committed owner. `keeps one authoritative mutation when defaults move` checks real values across both realms. |
| Binding change during commit, revocation, relink, fallback or schema change | Lifecycle transitions resolve/fence uncertain calls first; successors contain feature values without historical receipts/outboxes. Shareable-commit tests include an in-flight commit, lost replies, registry eviction, unreachable peers, seals, fallback, compatible upgrades and incompatible repins. |
| Before append: disconnected widget, full/rate-limited destination | Accepted state and its charged source intent remain durable. Deferred-admission and relay tests cover offline append, retained count/byte/receipt pressure, rate limits, ordered heads and independent-stream fairness. |
| After append, before source records the reply | Lost-response/eviction tests recover the same destination event ID, sequence and original expiry; no second append or state mutation occurs. |
| Shared append races a binding change | Destination receipt or call fence resolves the registry's uncertainty. Delivery tests cover movement before append and after acceptance; appended work stays on its original stream. |
| Gap cached, before destination confirmation | Local/shared tests `confirms a recorded gap before retiring its proof after restart` interrupt confirmation before forwarding and after receipt, then restart the owner. The proof and source budget remain until confirmation succeeds. |
| Confirmation reply lost, destination receipt later pruned | The same local/shared gap tests advance beyond two hours, run destination pruning, then recover from the verified durable source outcome. No receipt is recreated; both source and destination budgets return to zero. |
| After consumer ACK, before cleanup/release finishes | `recovers interrupted interest release after ACK without replay or uncharged work` covers local/shared owners and lost request/reply. Retiring work stays charged, eviction/retry releases interest, the event stays removed, and the source alarm clears. |
| Shared origin retirement unavailable | Relay test `keeps terminal-origin cleanup recoverable across an outage and restart` retains the retiring row until origin acknowledgement; automatic control retries and total attempts remain capped. |
| Original event deadline passes or final expiry attempt fails | Payload is removed at its original deadline. Gap-pending metadata and unresolved authority remain charged if the destination is unknown. Relay tests `retains unresolved gap authority when its reserved final attempt cannot reach the stream` and `reserves the final delivery attempt for expiry and does not reset budgets on wakeup`. |
| Receipt/source retention expires | Recovery tests reject fresh sources after two hours, recover existing accepted results, keep uncertain/pending records, and prune at most twenty proven terminal receipts. Source retry lifetime never restarts. |
| Reset interrupted between owner phases | Delivery/reset tests retain fences, resume the same checkpoint, reject stale append proofs and preserve operation sequence. Relay tests recover reset-discarded leased rows without reopening feature mutation. |
| Binding transport throws or sends invalid JSON/error bodies | `state-event-transport.spec.js` asserts stable code/message/status for command requests, producer proof/status and registry-to-stream delivery, preserving validated cooldown guidance and rejecting malformed retry hints. Raw transport messages, arbitrary exception codes and private payload/grant text do not escape those boundaries, including into the registry logger. Producer-status/reset transport outages now return a redacted unknown outcome (503), replacing an unclassified 500. |
| Browser snapshots/events arrive in either order, duplicate, reconnect or change scope | Browser/readable suites preserve authoritative state, suppress historical animations, bound buffering/deduplication, retry concurrent reads and stop both subscriptions on gap, denied read or mismatched owner. ACK follows successful validated handling. |

Primary suites:

- [Local commit](../test/state-event-local-commit.spec.js),
  [shareable commit](../test/state-event-shareable-commit.spec.js),
  [recovery](../test/state-event-recovery.spec.js).
- [Delivery and reset](../test/state-event-delivery.spec.js),
  [relay and cleanup](../test/state-event-relay.spec.js),
  [command runtime](../test/state-event-command-runtime.spec.js),
  [transport diagnostics](../test/state-event-transport.spec.js).
- [Installed health](../test/health-state-event.spec.js),
  [readable correlation](../test/state-event-readable.spec.js),
  [browser correlation](../test/state-event-browser.spec.js).

## Security and compatibility

The [authoring suite](../test/state-event-authoring.spec.js) rejects undeclared,
cross-feature and wrong-scope handles, injected runtime services, repeated
commits, accessors and unsupported declarations. Authorization and input parsing
run before combined acceptance; installed-health tests retain Discord/Twitch
permission, amount and cooldown behavior. Nothing adds public binding access.

The complete suite also runs existing independent state-only and event-only
tests. The [grant suite](../test/durable-event-grants.spec.js) retains separate
state/event sessions, digest-only secret storage, signed target/environment
isolation, expiry/revocation and explicit operator acknowledgement of reset
loss. Combined registration still fails closed if the producer is unavailable.
Correlation and public command receipts contain opaque identities, never owner
routes. Health v1 backlog/legacy widgets and the explicit v2 transition remain
covered by feature and browser checks.

`npm run lint` includes the stable Framework API v1 import boundary, private
workspace/peer-metadata validation and generated-catalog freshness. No supported
framework export, feature package or ordinary event-frame shape changes here.

## Resource invariants

| Bound | Evidence |
| --- | --- |
| Source pending work: 100 rows / 512 KiB; payload 4 KiB | Local/shared/recovery capacity tests reject before mutation, preserve cached duplicate recovery and expire payloads at the original 30-minute deadline. Interrupted ACK cleanup compares the charged budget to actual retained UTF-8 intent bytes. |
| Receipts: 100,000 rows / 16 MiB per owner/destination; terminal reserve | Local/shared/delivery receipt-capacity tests, recovery pending-origin limits and relay `reserves metadata space so terminal cleanup can complete at receipt capacity`. Unknown outcomes remain charged rather than being silently evicted. |
| Handler work: 20 records / 4 concurrent relay streams / 5-second work and RPC bounds / 30-second leases | Relay batch, fairness, concurrency, busy-owner and real request-timeout tests. Shared authority recovery has its own twenty-record/five-second bound. |
| Retry budgets: 12 scheduled, 20 total, final delivery attempt reserved for expiry | Persistent delivery/control counters survive eviction and useful wakeups; tests cover exhaustion, backoff, reconnect coalescing, duplicate notification versions and failed final expiry reconciliation. |
| Idle/offline work | Relay tests advance a long disconnected interval, assert zero repeated consumer polling and no retries after a confirmed offline append. Work resumes through useful addressed wakeups or the original deadline; no fleet scan is introduced. |
| Cleanup and client memory | Receipt pruning is twenty per pass; acknowledged obligations release source bytes/rows/interest. Browser tests bound one startup event, timeout, and recent-ID storage (at most 1,000 IDs). |

## Reproduce and interpret

```sh
npm ci
npm test -- --run
npm run lint
npm run test:browser
```

CI additionally checks all tracked JavaScript syntax and runs the non-deploying
Wrangler build. Browser ChatGPT Work mode uses that CI dry run because its local
approval layer classifies the command as deployment. The four Chromium smokes
cover readable state, ordinary durable events, combined correlation and health.

These checks are executable evidence for specified fault boundaries and bounded
work, not an exhaustive proof of every platform failure. Unknown authority can
retain bounded metadata and block admission until explicit recovery/reset.
Consumer effects remain at-least-once; a crash between visual effects and durable
deduplication is not exactly-once animation. No deployed load or billing trial is
claimed. Step 11 still owns SQL/RPC/alarm/active-time measurements and current
price scenarios; step 12 owns final contributor guidance and review preparation.
