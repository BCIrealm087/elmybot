# State/event release review and operations

Status: roadmap steps 1–12 complete on 2026-10-18, prepared for review on
`codex-state-ironing`. This milestone implements atomic command acceptance and
health v2. Both checked-in Wrangler environments retain
`STATE_EVENT_OPERATIONS_ENABLED: "false"`. Deployment, live enablement and
operator grant changes remain separate operator decisions.

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
| Browser and installed product | [Correlation](state-event-browser.md), [health migration](health-state-event-migration.md); readable/browser tests and four shipped-client/UI Chromium smoke suites. |
| Cost and bounded work | [Measured report](state-event-costs.md), [raw measurements](state-event-cost-measurements.json), native cost tests and pure calculator tests; CI cost artifact. |

The complete suite has **723 tests in 69 files** at this milestone. It includes
ordinary state-only/event-only behavior, grant separation, authorization,
source conflicts, capacity rollback, clamped no-ops, shared lifecycle fences,
crashes/lost responses, gap/reset recovery and bounded idle work. The contributor
simulator is a convenience; it is not the native atomicity or billing proof.

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

Operational rollback disables fresh acceptance and retains compatible receipt,
outbox, relay, gap/reset and health semantic handlers. Do not roll back to a
pre-feature binary that ignores accepted obligations, drop additive tables,
remove v1/v2 schemas still referenced by grants/backlogs, or clone recovery
records into a successor realm. A later removal requires evidence that all
referenced obligations are terminal plus a separate reviewed retirement change.

## Cost findings and remaining limits

The installed warmed health cycle measures 117 native SQL writes, 19 application
binding RPCs and three alarm handlers. Alarm storage and amortized delayed
receipt cleanup bring the illustrative model to **138 row writes / 22.15 Durable
Object request units per command**. The modeled legacy event-only reference is
30 writes; four more model the ordinary state mutation. The remaining 104-write
premium pays for atomic acceptance, recovery, relay, confirmation and retirement.

Using the report's 2026-10-18 paid-plan prices and explicit timing assumptions,
unused shared allowances and no active query watchers, 100,000 commands/month
model at $5.30 total and one million at $96.30. These are scenarios, not observed
invoices or ceilings. Active duration, watch re-evaluation, account usage, grant
setup and fleet storage can change them. Logical five-second RPC deadlines do
not cancel all losing fetches or cap billed object-active time. Reprice and
supply realistic aggregate duration/storage before projecting production volume.

The tests enforce finite retries/leases/batches and no periodic idle consumer
polling. They cover twenty-record cleanup, four independent relay streams,
large receipt history and long virtual outages. Source capacity remains 100
pending rows / 512 KiB per owner, with independent receipt/authority budgets;
SQL/index/platform storage overhead is additional. Full numeric limits are in
the [contract](state-event-contract.md#9-initial-resource-and-recovery-limits).

Supported scope remains one command, one mutation target/owner and one associated
stream. Cross-owner transactions, arbitrary callbacks, multiple streams, routed
effects in the same operation, unlimited offline history and exactly-once browser
animation remain deferred. Delivery may produce explicit retention/lifecycle
gaps. Health snapshots recover the current value without replaying lost deltas.
