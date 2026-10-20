# State/event cost measurements and operation budgets

Latency repair roadmap step 10, remeasured on **2026-10-20** after steps 1–9.
The [raw report](state-event-cost-measurements.json) contains 29 profiles and
reproducible billing scenarios. Checked-in environments still disable new
combined acceptance; this work authorizes no deployment or live billing test.

A warmed installed-health v2 cycle using immediate delivery records **118 SQL
row writes, 14 application binding requests, thirteen alarm sets, one alarm
delete, one destination alarm and one incoming ACK**. Adding alarm storage and
the measured-batch receipt-cleanup allowance gives **140 modeled writes and
15.15 Durable Object request units per command**. The alarm-only equivalent
uses the same SQL writes/requests, but sixteen alarm sets and three alarm
invocations: 143 modeled writes and 17.15 request units.

The original 2026-10-18 health baseline was 138 modeled writes and 22.15 request
units. Immediate delivery therefore saves seven request units while adding two
modeled writes relative to that baseline. The legacy event-only reference is
30 writes; adding an ordinary bounded state mutation makes 34. The remaining
106-write premium covers atomic acceptance, recovery, publication and retirement.
These independent primitives are infrastructure references, not permission to
combine independent services in a feature action.

At the explicit assumptions below, 100,000 monthly health commands model at
**$5.15 total** and one million at **$97.25**, including the one $5 subscription.
The old one-million-command scenario was $96.30. Storage writes remain the
dominant marginal cost; the latency repairs do not add an idle polling loop.
These scenarios exclude existing bot traffic and observers, and are not invoice
ceilings. The historical inputs remain available in
[the pre-refresh report](https://github.com/BCIrealm087/elmybot/blob/9d18a93fca55b929603768c04791576ec792bf08/docs/state-event-cost-measurements.json).

## Reproduce and inspect

```sh
npm ci
npm run measure:state-events
# Optional destination, also supported on Windows:
npm run measure:state-events -- --output cost-measurements.json
npm test -- --run
npm run lint
```

The command runs the cost, activation, receipt-probe and calculator suites:
71 native cases export 29 measurement profiles, and six pure cases check pricing
and profile selection. It replaces the destination only after every
case passes and all required complete-cycle profiles are present. Failed or
incomplete runs leave the previous baseline intact. Metadata records collection
time, the source commit, Node, Vitest, workerd and the pricing check date. The
source commit identifies the runtime base; test/instrumentation changes made
in the measuring worktree are part of this step's reviewed changes.

The full CI suite exports the same raw profiles in its
`state-event-cost-measurements` artifact. The CLI also adds scenario tables
using [the calculator](../scripts/lib/state-event-cost-model.js) and
[profile summary](../scripts/lib/state-event-cost-summary.js). Profile order is
stable; local handler timings are diagnostic and vary between runs.

## Measurement boundaries

| Metric | Meaning and limit |
| --- | --- |
| SQL rows read/written | Native `SqlStorageCursor` counters after query execution, including index/trigger work. The indexed-insert/trigger calibration observes three writes; its delete observes one. |
| SQL batches | Native batch counters report only the last statement. The test meter splits top-level statements synchronously, preserving quotes, comments, trigger bodies and `CASE`; two indexed inserts therefore measure six writes. Production SQL is not rewritten. |
| Deletes | Native DELETE write counters are already included in total SQL writes. Index/trigger amplification is not added again. |
| Alarms | Test-only virtual get/set/delete and due-alarm dispatch prevent background races. SQL counters exclude hidden alarm storage. The model adds one write per set/delete and one read per get conservatively; Cloudflare explicitly bills each set as one written row. |
| Background activation | Phase accounting waits for tracked `waitUntil` tasks and their completion scheduling before closing. An append-only profile stops before ACK; complete-cycle profiles include ACK, producer wake and retirement. |
| Requests | Application binding fetches, alarm invocations and incoming ACKs are counted separately. Test control requests and inspection SQL through the raw fixture state are excluded. |
| Local handler spans | Include instrumentation, test transport and overlapping object activity. They are neither Cloudflare CPU time nor billed object duration, and do not supply timing inputs to the calculator. |
| SQLite size | Allocated native database bytes include indexes and existing fixture schemas. Hidden platform metadata/backups and fleet storage are not measured. Do not multiply an isolated registry fixture's whole database by a production group count. |
| First use | Constructors and grant/session setup are excluded. Lazy schema initialization during acceptance/publication is included. Reconnect work has its own profile. Cold online and cold offline-append fixtures have different setup boundaries. |

The immediate complete-cycle model deliberately coalesces the ACK wake through
one destination alarm. Source publication and cleanup use background activation;
no source alarm or manually forced source drain is used in that profile. Other
notification timing and fallback recovery can change the number of handlers.
Native real-clock alarm/eviction/latency behavior is checked separately by the
[lifecycle suite](state-event-lifecycle-verification.md).

Profiles omit ordinary ingress authentication, outbound Discord/Twitch APIs,
grant/session renewal, initial widget snapshots, readable observer evaluation,
log export, taxes and unrelated Cloudflare products. Requests and SQL text are
aggregated without bindings, row values, group identities or credentials.
State-only/event-only references also omit generic action/cooldown work.

## Observed core work

These are native SQL counters from the checked-in run, before alarm-storage and
delayed-cleanup allowances. Repeated runs differed by one burst SQL read and a
few alarm sets in scheduling profiles; the warm billing counters matched.
Regression ceilings allow reviewed headroom for that variation.

| Scenario | SQL reads | SQL writes | Binding requests | Alarm invocations |
| --- | ---: | ---: | ---: | ---: |
| First local acceptance | 1,228 | 89 | 2 | 0 |
| First shared acceptance | 1,131 | 112 | 6 | 0 |
| Local / shared duplicate | 40 / 27 | 0 / 0 | 1 / 1 | 0 / 0 |
| First local offline append | 2,018 | 58 | 3 | 1 |
| First shared offline append | 1,737 | 67 | 4 | 1 |
| Warm local complete cycle, alarm-only | 4,979 | 105 | 8 | 3 |
| Warm local complete cycle, immediate | 4,689 | 105 | 8 | 1 |
| Warm shared/health complete cycle, alarm-only | 4,440 | 118 | 14 | 3 |
| Warm shared/health complete cycle, immediate | 4,208 | 118 | 14 | 1 |
| Installed-health immediate clamped no-op | 4,225 | 117 | 14 | 1 |
| First immediate local / shared complete cycle | 5,412 / 4,807 | 160 / 190 | 8 / 14 | 1 / 1 |
| Warm immediate local / shared acceptance plus offline append | 2,366 / 2,143 | 77 / 90 | 5 / 10 | 0 / 0 |
| Legacy health v1 publication plus ACK | 416 | 23 | 5 | 0 |
| Existing bounded health-state mutation | 19 | 4 | 1 | 0 |
| Six-stream local burst: acceptance / six relay passes | 4,383 / 11,602 | 299 / 363 | 12 / 18 | 0 / 6 |
| Six-stream shared burst: acceptance / six relay passes | 4,006 / 10,062 | 352 / 417 | 36 / 24 | 0 / 6 |
| Twelve scheduled destination failures | 14,891 | 84 | 13 | 12 |
| Failed final expiry reconciliation | 1,643 | 9 | 1 | 1 |

The six-pass burst spends more scheduler reads/writes than the original
single-invocation relay, while flattened publication halves its binding calls
from 36/48 to 18/24. This buys bounded work and request lineage per invocation.
The scheduler's queue-ticket write and finite receipt probe are included.

An isolated absent/positive destination probe reads 22/38 SQL rows, writes none,
performs one binding request and touches no alarm. A full lost-append-reply
recovery uses 65/74 SQL writes and 4/6 requests for local/shared owners. Relative
to matching healthy cold offline relay, that adds seven writes, 1/2 requests,
two alarm reads and one alarm set. The probe is capped once per operation.

Ten-operation retention fixtures measure another 7.2/7.3 written rows per local/
shared accepted operation, including destination alarm scheduling. The scenario
reserves eight writes, 64 reads and 0.1 alarm request per command. The event-only
reference reserves three writes, 32 reads and the same 0.1 request; its measured
tail is 2.0/2.1 writes. These are ten-operation batching assumptions, not sparse
traffic or per-command ceilings. Smaller pruning batches amortize fixed work
over fewer commands; a storage allowance can be raised explicitly through
`measurementUsage` when modeling that workload.

One readable watcher adds four SQL writes at acceptance. Its coalesced
notification adds eight SQL writes, one alarm set and one observer request in
the fixture. Observer reads, connections, registration and renewals remain
additional work outside the core scenario.

## Bounded idle and failure work

The thirty-day offline profile records zero SQL, requests or alarms before the
real retention deadline, then finite expiry/receipt cleanup (27 SQL writes, two
requests and two alarms). A further simulated month records zero work. Capacity
pressure likewise performs no periodic destination probe before reconnect.

The outage fixture makes twelve scheduled append attempts and one reserved
expiry attempt. If the dependency remains unavailable it retains charged
`gap_pending` metadata without a payload or scheduled retry loop. It does not
discard uncertainty to obtain a zero balance. Other suites enforce twenty total
attempts, leases, authority, useful-wakeup recovery and eventual cleanup.

In the 25-event admission profile, every confirmed append retains one attempt
while more commands arrive. A synthetic 1,000-pair destination-history fixture
removes twenty receipts from each ledger in one pass using 61 SQL row writes.
Adding 10,000 source receipts leaves duplicate reads unchanged (41), zero
duplicate writes and a one-row increase in new-admission reads. Twelve independent
groups incur traffic-related work without discovering or polling idle owners.

## Enforced operation budgets

Budgets allow reviewed headroom above the measurements. No existing allowance
is increased in this step; burst-request limits are tightened for flattened calls.

| Boundary | Automated ceiling |
| --- | --- |
| First local/shared acceptance | 95 / 120 SQL writes. |
| First local/shared deferred append | 70 / 80 SQL writes. |
| Alarm-only warm local/shared cycle | 120 / 135 SQL writes, 12 / 20 binding requests, 5,000 SQL reads, sixteen alarm sets. Installed bounded health allows 140 SQL writes. |
| Immediate warm local/shared cycle, including installed health | 112 / 125 SQL writes, 9 / 15 binding requests, 5,000 SQL reads, fourteen alarm sets, one destination alarm and one ACK. |
| Immediate first local/shared complete cycle | 180 / 210 SQL writes, excluding setup. |
| Immediate local/shared append-only profile | Cold 160 / 190 and warm 85 / 100 SQL writes, 5 / 10 warm requests, five alarm sets, zero alarm invocations. |
| Duplicate recovery | Zero writes/alarm scheduling, one request, at most 64 read rows. |
| Six-stream burst | Each phase at most 380 local / 440 shared writes; six relay passes at most 24 / 32 requests and one physical append at a time in this profile. |
| Receipt pruning | Twenty from each physical combined destination ledger per pass; 1,000-pair cleanup at most eighty writes. Source pruning remains twenty terminal rows per pass. |
| History growth | At most 100 extra admission reads and twenty writes after 10,000 synthetic receipts; duplicate reads unchanged. |
| Idle/offline | Zero work outside finite deadline maintenance; thirty-day simulation at most four expiry-phase alarms. |

These are regression bounds for the measured paths, not new bounds on every
existing event-only ledger query, observer or unrelated registry workload.

## Pricing assumptions and scenarios

Checked against official [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[SQLite counters](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
on **2026-10-20**. Rates are unchanged from the historical report.

| Paid-plan dimension | Included monthly | Overage |
| --- | ---: | ---: |
| Durable Object requests | 1 million | $0.15/million |
| Durable Object duration | 400,000 GB-s | $12.50/million GB-s |
| SQLite reads / writes | 25 billion / 50 million | $0.001 / $1 per million |
| SQLite storage | 5 GB-month | $0.20/GB-month |
| Worker requests / CPU | 10 million / 30 million ms | $0.30 / $0.02 per million |

The subscription is $5. DO compute overage rounds upward to billing units; the
calculator also conservatively rounds SQLite/storage units upward. Incoming
ACKs use 20:1 request weighting; outgoing WebSocket messages incur no request
charge. Included usage is shared account-wide for the relevant product.
`incrementalBill(added, existing)` subtracts the existing account bill instead
of assigning a second subscription or another set of allowances.

The following uses 50 ms **aggregate object-active time**, five Worker CPU ms
and one Worker ingress per command, reused event connections and no readable
watchers. Duration/CPU are assumptions. Storage is inside the remaining allowance.
The independent state+event column sums infrastructure counters; both references
use the same illustrative aggregate timing assumption.

| Commands/month | Legacy event-only | Independent state + event | Health v2 immediate | Health v2 alarm-only |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | $5.00 | $5.00 | $5.00 | $5.00 |
| 100,000 | $5.00 | $5.00 | $5.15 | $5.15 |
| 1,000,000 | $5.75 | $5.90 | $97.25 | $100.55 |
| 10,000,000 | $263.05 | $304.55 | $1,395.90 | $1,431.25 |

The one-million immediate-health total is $90 writes + $2.25 DO requests + $5
plan. If write and DO-request allowances are already spent, adding that workload
costs **$142.40 incrementally**, while the other allowances remain unused.
Free-plan write capacity is 100,000 rows/day: at the 140-write batch assumption,
about **714 commands/day** before other bot work. This does not establish that
the complete bot fits Free or that sparse traffic has the same cleanup cost.

## Duration and storage sensitivity

An application's five-second timeout bounds recovery decisions; it does not
cancel every losing fetch or cap billed duration. Pending I/O, overlapping
requests and hibernation eligibility determine actual provider-active time.
Aggregate activity sums non-overlapping active intervals per object across all
involved objects; a single request's local elapsed time is not that quantity.

For one million immediate-health commands, keeping other assumptions fixed:

| Assumed aggregate active seconds/command | Duration charge | Total scenario |
| ---: | ---: | ---: |
| 0.05 | $0.00 | $97.25 |
| 1 | $0.00 | $97.25 |
| 5 | $12.50 | $109.75 |
| 900 | $1,437.50 | $1,534.75 |

The 900-second case is a sensitivity example, not a measured delay or a bound
on multiple waiting objects. Production duration forecasts require provider
telemetry; local metered callback spans cannot supply it. Extra retained SQLite
storage of 6 / 10 / 100 GB-month would add $0.20 / $1 / $19 respectively with
the five-GB allowance otherwise unused, using conservative unit rounding.

First installed-health acceptance allocates 106,496 additional native SQLite
bytes after grant setup in the alarm-only fixture; warm cycles can reuse pages.
Deleting records need not shrink the database file. Schemas, indexes, receipts,
authority and hidden metadata contribute to fleet storage, beyond the source's
512-KiB payload budget. Supply actual GB-month to the calculator.

The measured implementation retains finite failure work and hibernating idle
transport, with a substantial write premium for atomicity and recovery. There
is no newly demonstrated cost blocker at modest traffic; high command volume
and provider-active duration still require explicit budgeting. The
[final release review](state-event-release.md) completes latency-roadmap step 11
on 2026-10-20 and carries these costs and their limits into the operator guidance.
