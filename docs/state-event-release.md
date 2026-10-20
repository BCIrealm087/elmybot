# State/event release review and operations

Status: original implementation roadmap steps 1–12 completed on 2026-10-18;
latency-repair roadmap steps 1–11 completed on 2026-10-20 on
`codex-state-ironing`. The final review covers atomic command acceptance, health
v2 and the subsequent latency repairs. Both checked-in Wrangler environments retain
`STATE_EVENT_OPERATIONS_ENABLED: "false"`. Deployment, live enablement and
operator grant changes remain separate operator decisions.

The review found no new architectural blocker within the supported one-owner,
one-stream scope. Automated evidence supports code review and operator rollout;
it does not establish production latency or prove that the observed Cloudflare
delays are eliminated. The reviewed implementation and cost baseline is
`b6bc593f5636723747271ec66a8f41dfd8e5b552`, compared with pre-repair
`45c8ed9be7c37299868c06d215e90b382cf7d19d`.

## Behavior to review

One declared command operation atomically commits one local or effective-shared
state mutation, readable revision/watermark, immutable result receipt and durable
event intent inside the state owner's SQLite transaction. Source routing and
destination append recover across separate owners. No distributed transaction or
arbitrary feature callback runs inside the commit.

| Surface | Success/admission meaning |
| --- | --- |
| Ordinary state-only action | Existing atomic state methods and coalescing current-state queries. |
| Ordinary `eventStreams.publish()` | Existing destination append; a ready authorized consumer is required. |
| Explicit `stateEvents.commit()` | State saved and event durably queued at source; no consumer or grant is required for bounded offline acceptance. |
| Widget | Current state comes from a separately authorized snapshot/watch; events animate individual live impacts and never apply another state delta. |

Framework API v1 remains stable. Independent state plus event calls remain
rejected. The installed health action becomes `fun.health.impact.v2`; unchanged
command syntax, authorization, input range/default and cooldown now lead to
bot-owned health. The old v1 event stream and legacy widget remain available for
backlog drain. Disabling v2 acceptance makes fresh health commands unavailable;
it does **not** restore the retired v1 action. See the
[health migration](health-state-event-migration.md) before deployment.

## Review map and automated evidence

| Concern | Reference/evidence |
| --- | --- |
| API and public outcomes | [Contract](state-event-contract.md), [authoring and errors](state-event-authoring.md), [API v1](framework-api.md), generated [catalog](feature-catalog.md). |
| Atomicity, identity and lost replies | [Recovery](state-event-recovery.md), [local](state-event-local-storage.md) and [shared](state-event-shareable-storage.md) commit guides; native command/health tests. |
| Ordering, grants, gaps, reset and lifecycle | [Delivery](state-event-delivery.md), [relay](state-event-relay.md), [failure matrix](state-event-verification.md); actual SQLite/binding/eviction tests. |
| Browser and installed product | [Correlation](state-event-browser.md), [health migration](health-state-event-migration.md), [health cosmetic policy](health-widget-effects.md); readable/browser tests and four shipped-client/UI Chromium smoke suites. |
| Latency repair and recovery boundaries | [Lifecycle verification](state-event-lifecycle-verification.md); native installed-health pacing, reconnect, eviction, lost-reply and fault tests, plus strict call/nesting guards. |
| Cost and bounded work | [Measured report](state-event-costs.md), [raw measurements](state-event-cost-measurements.json), native cost tests and pure calculator tests; CI cost artifact. |

The reviewed implementation has **877 tests in 81 files**. It includes
ordinary state-only/event-only behavior, grant separation, authorization,
source conflicts, capacity rollback, clamped no-ops, shared lifecycle fences,
crashes/lost responses, gap/reset recovery and bounded idle work. The contributor
simulator is a convenience; it is not the native atomicity or billing proof.

The implementation baseline passed the full local suite and
[CI run 39511128665](https://github.com/BCIrealm087/elmybot/actions/runs/39511128665):
877/877 tests, all four Chromium smoke suites, lint/API/workspace/catalog checks,
tracked JavaScript syntax and the non-deploying Wrangler build. Its actual job
logs were inspected. Later commits still require their own CI run and log review.

## Latency-repair review findings

| Boundary | Result and retained limit |
| --- | --- |
| Shared alarm scheduling | Source, notification, invalidation and watcher deadlines participate in one durable minimum. Failure recovery recomputes it; abrupt termination still depends on persisted work and lease recovery. |
| Remote work and request chains | [Complete-path reservations](state-event-relay-work-budget.md) cap each relay pass at 20 weighted application calls, two claimed records and one publication. [Owner-validated snapshots](state-event-request-chains.md) remove normal nested source callbacks. The tested owner-rooted nesting depth of two is not a measured Cloudflare platform threshold or a bound on command ingress ancestry. |
| Immediate publication | [One background pass](state-event-immediate-delivery.md) starts after durable commit without awaiting delivery. Suppression, overlap, eviction or failure retain the persisted alarm/lease fallback. `waitUntil` neither resets the incoming request context nor creates another work budget. |
| Lost append replies | [One finite receipt probe](state-event-receipt-probes.md) can reconcile positive evidence at the original destination. Missing, malformed or failed proof preserves uncertainty and its original lease; it cannot authorize a fresh append or mutation. |
| Publication versus cleanup | [Persisted fair selection](state-event-cleanup-fairness.md) bounds eligible claim order across streams, with a three-publication preference and shared four-lease ceiling. Split terminal housekeeping stays charged. Neither fairness nor a 25 ms continuation promises a dispatch deadline. |
| Widget acceptance | A valid health v2 event enters a queue with at most one running/eight pending cosmetic effects before its handler returns for ACK. Overflow, hiding, reload or cancellation may lose effects after ACK. Authorized snapshots alone set health. Generic and legacy clients retain awaited-handler ACK semantics. |
| Privacy and compatibility | New snapshot/probe endpoints remain private Durable Object protocol routes; internal markers are not public credentials. Tests reject public routing and malformed proofs. Framework API v1, command declarations, bindings and Wrangler migration history are unchanged by the latency repairs. |

Native workerd tests exercise standalone and linked Discord/Twitch health,
including eight sequential commands with fallback alarms withheld. Additional
fault, reconnect, lifecycle/reset and old-schema/eviction cases retain ordering,
deduplication, capacity charges and terminal proof before retirement. Chromium
tests exercise the shipped clients and widget against protocol fixtures. Neither
environment reproduces production placement, minute-spaced alarm dispatch,
Cloudflare's observed request-depth failure, or browser suspension timing.

Earlier local runs also exposed fixture-clock races and whole-test resource
contention. Clock separation and bounded test concurrency now retain the strict
latency/work guards, and subsequent full local and CI runs pass. The unusually
slow historical run has no proven complete attribution; do not treat successful
local timings as a production p99 or failed runs as cost baselines. No universal
sub-two-second delivery, ACK or animation guarantee is introduced.

## Reproducing the review

Run these from the repository root with locked dependencies:

```sh
npm ci
npm run feature:check -- fun-health
npm run feature:workspaces
npm test -- --run
npm run lint
npm run test:browser
git ls-files -z '*.js' '*.mjs' | xargs -0 -n1 node --check
```

`npm run feature:docs` regenerates the catalog; lint rejects stale output. To
reproduce cost samples without replacing the checked-in report, use
`npm run measure:state-events -- --output cost-measurements.json`.

[CI](../.github/workflows/ci.yml) is the authoritative clean-run gate: Node 22,
locked install, full suite with measurement reporter, cost artifact, ESLint/API
boundary/workspace/catalog checks, Chromium and all four browser smokes, tracked
JavaScript syntax, and `wrangler deploy --dry-run` without deployment. Inspect
the run and job logs for the exact pushed commit. Work Mode's local dry-run
restriction is covered by the CI dry-run. Browser smokes require Chromium.
A live billing experiment or routine manual test is not a milestone gate.

## Environment controls and enablement

| Combined acceptance switch | Event master switch | Behavior |
| --- | --- | --- |
| `"false"` | `"true"` | Reject fresh combined commands; recover existing receipts and drain accepted work. Ordinary event-only commands retain their own admission rules. |
| `"true"` | `"true"` | Permit fresh combined acceptance within all source/authority limits; relay and socket delivery operate. |
| Any value | false/missing/malformed | Reject fresh combined acceptance and new appends/sockets; preserve receipts, original deadlines and gap/reset authority. |

The switches are `STATE_EVENT_OPERATIONS_ENABLED` and
`DURABLE_EVENT_STREAMS_ENABLED`; only the literal string `"true"` enables either.
They do not authorize a public reader. Current-health read and impact event
grants remain independently scoped, signed and revocable.

Immediate activation is enabled by default. The optional private variable
`STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED: "false"` suppresses background
activations while retaining normal alarm recovery and explicit reconciliation.
Use it to isolate the immediate path without changing acceptance, stream
identities or credentials; alarm-only operation can still incur dispatch delay.
It is a separate control from disabling combined acceptance or the event master.

Server tracing requires `STATE_EVENT_DIAGNOSTICS: "true"`; it remains `"false"`
in both checked-in environments. The health widget's `?diagnostics=1` opt-in
records bounded stage/correlation traces without grants, payloads or health
values. Compare acceptance, append, socket/ACK and animation stages separately;
logical timeout or animation timing alone does not identify provider delay.

For an operator-selected rollout:

1. Review the target commit's successful CI/logs, cost assumptions and explicit
   health v1/v2 transition. Select the intended environment and preserve matching
   deployment identities, bindings, secrets and existing migration history.
2. Deploy recovery-capable code with fresh combined acceptance disabled. Retain
   the event master for legacy backlog drain. New health commands now target v2,
   so schedule the disabled interval with that availability impact in mind.
3. Prepare separate `fun.health:current:v1` read and `fun.health:impacts:v2` event
   grants for the same group and the v2 widget. Drain/reset the original v1
   backlog through its original grants/legacy view; do not reinterpret cursors.
4. Enable both switches explicitly in that environment when ready. Health starts
   at 100 under its absence policy; no browser number is imported. Existing
   authoritative values remain authoritative. Follow the ordinary operator
   deployment checklist for platform setup that actually changed.

Deployment propagation is not instantaneous. An actual disabled-to-enabled
master transition is observed by an addressed owner through a source request,
existing alarm, grant check or consumer registration. There is no fleet scan;
changing a setting alone cannot wake an otherwise untouched owner. Re-enabling
never extends an event's original thirty-minute deadline.

## Disable, drain, expire and recover

Set combined acceptance to `"false"` first and keep the event master `"true"`
for normal drain. Original receipts recover before fresh acceptance/configuration
checks, so a retry reports the original result without repeating the mutation.
Keep existing grants/sessions and consumers available while they acknowledge
retained work on the original stream. Moving a default does not move its backlog.

Thirty minutes after the original commit, undelivered payloads expire. Expiry
records explicit retention/lifecycle gap authority; it never undoes committed
state or claims successful animation. An empty event table, elapsed deadline or
an accepted receipt is **not** proof of clean drain. Unconfirmed append outcomes,
missing source proof, unresolved gap work and interrupted retirement remain
charged within finite capacity until recovery is proven. Known terminal outcomes
must be cached/confirmed before source proof is retired.

If delivery or cleanup exhausts its bounded attempts, it parks without recurring
polling. A useful reconnect/ACK/capacity/lifecycle wakeup can resume eligible work
within its remaining budget. Unresolved work may need maintainer recovery through
the existing private protocol or an authorized coordinated backlog reset; there
is no new public sweep/force-success endpoint. Do not delete SQL rows, change
source IDs, resend a new command as a recovery substitute or reset attempt counts.
A timeout is an unknown outcome until the original authority proves it.

For a blocking retention/lifecycle gap, use the existing
[operator grant/reset flow](durable-event-http.md#retention-gap-reset) with explicit
backlog-loss acknowledgement. Combined reset fences/checkpoints the source,
discards covered event obligations, then releases source/destination fences.
It preserves feature state and sequence/identity domains. An interrupted reset
resumes the same grant/reset checkpoint. Ordinary grant replacement or a state
read cannot clear a gap. Reset is a discard decision, never successful delivery.

Turning off the event master is a broader stop of publication/sockets, not a
drain operation. Receipts and expiry/gap/reset bookkeeping remain. Preserve the
recovery implementation even during an outage; avoid disabled-service retry
loops. Source receipts have a two-hour minimum retention and unresolved authority
can outlive it. Retirement needs terminal evidence, not merely waiting two hours.

## Storage compatibility and rollback

This implementation lazily adds tables/indexes to existing `GroupConfig`,
`ShareableStateRealm`, `IntegrationRegistry` and `DurableEventStream` storage.
It adds no Durable Object class or binding. Wrangler migrations through `v16`
remain unchanged and append-only; no new tag is needed for these additive tables.
Never edit prior deployed migration tags.

The latency repairs lazily add probe fields/indexes, queue tickets and one
constant-size relay schedule row. Upgrade tests preserve old pending records,
live leases and unknown outcomes. No manual SQL cleanup, state reset or grant
regeneration is required solely for this upgrade. Existing grant scope and the
original v1-to-v2 transition rules still apply.

Operational rollback disables fresh acceptance and retains compatible receipt,
outbox, relay, gap/reset and health semantic handlers. Do not roll back to a
pre-feature binary that ignores accepted obligations, drop additive tables,
remove v1/v2 schemas still referenced by grants/backlogs, or clone recovery
records into a successor realm. A later removal requires evidence that all
referenced obligations are terminal plus a separate reviewed retirement change.

## Cost findings and remaining limits

Latency-roadmap step 10 refreshed these findings on 2026-10-20. The installed
warmed health cycle with immediate activation measures 118 native SQL writes,
14 application binding requests and one destination alarm through ACK/cleanup.
Alarm storage and amortized delayed receipt cleanup bring the illustrative model
to **140 row writes / 15.15 Durable Object request units per command**. The
alarm-only equivalent models 143 writes / 17.15 request units. The legacy
event-only reference is 30 writes; four more model the ordinary state mutation.
The remaining 106-write premium covers atomic acceptance and recovery.

Using the report's prices checked on 2026-10-20 and explicit timing assumptions,
unused shared allowances and no active query watchers, 100,000 commands/month
model at $5.15 total and one million at $97.25. These are scenarios, not observed
invoices or ceilings. Active duration, watch re-evaluation, account usage, grant
setup and fleet storage can change them. Logical five-second RPC deadlines do
not cancel all losing fetches or cap billed object-active time. Reprice and
supply realistic aggregate duration/storage before projecting production volume.

The tests enforce finite retries/leases/batches and no periodic idle consumer
polling. They cover twenty-row receipt pruning, four shared live relay leases,
the [per-invocation remote-work limits](state-event-relay-work-budget.md),
large receipt history and long virtual outages. Source capacity remains 100
pending rows / 512 KiB per owner, with independent receipt/authority budgets;
SQL/index/platform storage overhead is additional. Full numeric limits are in
the [contract](state-event-contract.md#9-initial-resource-and-recovery-limits).

Supported scope remains one command, one mutation target/owner and one associated
stream. Cross-owner transactions, arbitrary callbacks, multiple streams, routed
effects in the same operation, unlimited offline history and exactly-once browser
animation remain deferred. Delivery may produce explicit retention/lifecycle
gaps. Health snapshots recover the current value without replaying lost deltas.
