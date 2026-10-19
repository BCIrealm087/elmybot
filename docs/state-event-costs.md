# State/event cost measurements and operation budgets

Original combined-operation roadmap step 11, measured on 2026-10-18. New combined acceptance remains false
in checked-in environments. No deployment or live billing experiment is part of
this work.

The tables and checked-in JSON below are the historical baseline, before the
latency repair roadmap. Step 2 adds overdue-alarm repair and handler-completion
recomputation. Its focused installed-health warm-cycle measurement retains 117
SQL row writes and 19 binding requests, with alarm sets increasing from 12 to 16,
alarm reads from 12 to 14 and SQL rows read from 3,938 to 4,189. The meter now
includes completion recomputation around its isolated relay drain; notification
delivery remains a separate profile. That step's CI artifacts record those counters.
The latency roadmap's step 10 will refresh the complete report and billing model
after the remaining repairs; the historical prices below are not a measurement
of the repaired implementation.
Step 3's [remote-work limit](state-event-relay-work-budget.md) further splits
backlog across invocations; the six-stream profile now includes six relay
handlers and their scheduling work rather than one batch.
The step-3 installed-health warm cycle still uses 117 SQL writes, 19 binding
requests and 16 alarm sets; it records 16 alarm reads and 4,444 SQL rows read.
The six-stream local/shared drain records 363/417 SQL writes (30 more in each
case than step 2), 42 alarm sets and six handlers, with the same 36/48 binding
requests. These controlled scheduling counters quantify the backlog tradeoff;
they are not production duration or billing measurements.
Step 4's [flattened requests](state-event-request-chains.md) reduce the measured
warm local/shared binding requests from 11/19 to 8/14. Installed health retains
117 SQL writes and 16 alarm sets, with SQL reads reduced from 4,444 to 4,256.
Snapshots add bounded transient request bytes, with no registry snapshot/payload
storage or new durable phase. Current CI artifacts contain these measurements;
the historical billing scenarios below still await the step-10 refresh.

The design has finite offline maintenance and a measurable write premium for
atomicity/recovery. The installed health command uses 117 native SQL row writes
for a warmed online cycle. Including alarm calls and a conservative allowance
for later receipt pruning gives **138 modeled row writes per command**. The
corresponding legacy event-only reference is 30. Adding the ordinary bounded
state mutation accounts for four of the 108 additional writes; the remaining
104 cover combined acceptance, recovery, outbox delivery, confirmation and
retirement, including their alarm/receipt overhead. These are infrastructure
comparisons, not permission to combine independent services in a feature action.

At the illustrative paid-plan assumptions below, 100,000 monthly health commands
model at $5.30 total; one million model at $96.30. Existing account usage, active
object time and connected readable-state observers change those amounts. This
is suitable for modest command traffic, with a meaningful storage-write premium
at sustained high volume. It is not a fixed invoice ceiling.

## Reproduce and inspect

```sh
npm ci
npm run measure:state-events
# Optional destination, also supported on Windows:
npm run measure:state-events -- --output cost-measurements.json
npm test -- --run
npm run lint
```

The measurement command runs the actual workerd integration suite and updates
[`state-event-cost-measurements.json`](state-event-cost-measurements.json).
The full CI test run also exports a `state-event-cost-measurements` Actions
artifact. The [reporter](../scripts/state-event-cost-reporter.js) receives test
metadata, so production code gains no measurement wrappers or logging.
The [calculator](../scripts/lib/state-event-cost-model.js) exposes usage, total
paid-plan bills and incremental bills given existing account usage.

The twenty integration cases in
[`state-event-cost.spec.js`](../test/state-event-cost.spec.js) exercise production
handlers, SQLite transactions, service calls, actual registered hibernating
WebSockets and ACK handlers. They include local/shared owners, the installed
health package, clamped no-ops, six concurrent action sources, duplicate recovery,
destination failures, retained-capacity pressure, reconnect, 30-day simulated
outages, 10,000 historical receipts, twelve independent groups and delayed
receipt deletion. Synthetic capacity/history rows are labeled in the raw report.

## Measurement boundaries

| Metric | Meaning and limit |
| --- | --- |
| SQL rows read/written | Native `SqlStorageCursor` counters after consuming queries, including index/trigger work. The calibration observes three writes for an indexed insert with a trigger, one for its delete. |
| SQL batches | A native batch cursor reports only its final statement. The test meter splits top-level statements synchronously, preserving quoted text, comments, trigger bodies and `CASE`; its two-insert calibration records six writes instead of the final cursor's three. No production SQL is rewritten. |
| Deletes | `deleteRowsWritten` is the native write count for DELETE statements, already included in total writes. Trigger/index amplification is not added a second time. |
| Alarm scheduling | A test clock records get/set/delete and dispatches only due alarms. Scheduling is virtual to prevent background races; real alarm and crash behavior is covered by the relay/health suites. SQL cursor counts exclude hidden alarm storage. The model adds one read per get and one write per set/delete conservatively. |
| Requests | Actual application binding fetches, counted separately from alarm invocations and incoming ACK messages. Test `runInDurableObject` control calls are excluded. |
| Local handler spans | Wall-clock sums include instrumentation, test transport and overlapping activity on an object. They are diagnostic proxies; they are not Cloudflare CPU or billed duration and are not used as timing inputs to the calculator. |
| Physical SQLite size | `databaseBytes` samples native allocated database size, including indexes. It includes the fixture's existing schemas; do not multiply its whole isolated registry database by a production group count. Hidden platform metadata/backups and fleet storage are not measured. |
| First use | Existing Durable Object constructors and grant/session setup are outside the command profiles. Lazy combined schema creation during a first acceptance/append is included. The separate reconnect case includes grant/registration work. Cold object creation and deployments are not measured invoices. |

Request paths and SQL text are aggregated without bindings, row values, raw group
identities or credentials. The pricing profile assumes reused event connections
and excludes ordinary bot ingress/authentication, outbound Discord/Twitch APIs,
grant/session renewal, initial widget snapshots and observer re-evaluation.
Observability/log export, taxes and unrelated Cloudflare products are outside
the calculator's dimensions.
Those existing paths must be added through account usage or separate workload
measurements. The state-only and event-only references omit feature action code
and generic cooldown handling; their deltas describe infrastructure, not an
alternative authoring contract.

## Observed core work

Counts below precede the separately modeled alarm-storage and delayed-pruning
allowances. RPC means an application HTTP binding call.

| Scenario | SQL reads | SQL writes | RPCs | Alarm handlers |
| --- | ---: | ---: | ---: | ---: |
| First local acceptance | 1,188 | 84 | 2 | 0 |
| First shared acceptance | 1,097 | 107 | 6 | 0 |
| Local duplicate, before preparing again | 38 | 0 | 1 | 0 |
| Shared duplicate | 27 | 0 | 1 | 0 |
| First local offline append | 1,733 | 58 | 6 | 1 |
| First shared offline append | 1,558 | 67 | 8 | 1 |
| Warm local online cycle, through ACK/cleanup | 4,226 | 104 | 11 | 3 |
| Warm shared/installed-health online cycle | 3,938 | 117 | 19 | 3 |
| Installed-health clamped no-op cycle | 3,946 | 116 | 19 | 3 |
| Existing health v1 publication plus ACK | 416 | 23 | 5 | 0 |
| Existing bounded health-state mutation | 19 | 4 | 1 | 0 |
| Six-stream local burst: acceptance / relay | 4,183 / 6,943 | 289 / 333 | 12 / 36 | 0 / 1 |
| Six-stream shared burst: acceptance / relay | 3,882 / 6,549 | 342 / 387 | 36 / 48 | 0 / 1 |
| Twelve scheduled destination failures | 9,855 | 84 | 14 | 12 |
| Failed final expiry reconciliation | 1,198 | 9 | 1 | 1 |

The health cycle has twelve set-alarm calls, one delete-alarm call and one ACK.
Its modeled immediate usage is therefore 130 writes and 22.05 Durable Object
request units (19 RPCs + three alarms + one ACK/20). Ten-operation retention
fixtures measure another 7.2–7.3 writes per accepted operation, including
destination alarm scheduling; the model reserves eight. It also reserves 64
read rows and 0.1 alarm request per command for that tail. The event-only
reference reserves three writes, 32 reads and the same 0.1 request; its measured
tail is 2.0–2.1 writes. These are amortized ten-operation batch assumptions,
not a promise that every sparse receipt expires in that batch size.

With one readable-state watcher, acceptance adds four SQL writes. Delivering its
existing coalesced invalidation adds eight SQL writes and one observer RPC in
the fixture. These costs are reported separately and are not intrinsic outbox
costs. Observer reads, connections and renewals remain additional work.

## Fixes established by the measurements

New admission previously woke already appended events. In the 25-event
reproduction, the oldest event reached thirteen attempts despite a known append.
Admission now wakes only pending, parked or gap-pending work. Both scopes retain
one append attempt for every confirmed event as new commands arrive. ACK/
capacity notifications still provide useful wakeups for terminal cleanup.

Combined delivery also creates both a combined authority receipt and an existing
stream receipt. The latter previously used the ordinary unbatched expiry delete.
Combined-stream maintenance now deletes at most twenty from each ledger per
pass, including their accounting triggers. A 1,000-pair fixture observes 61 SQL
row writes in one pass, removes exactly twenty pairs and preserves the shared
budget. Existing event-only cleanup behavior is unchanged.

One earlier lease alarm can remain scheduled when the shared scheduler retains
an already earlier wakeup. The offline fixtures measure that finite read-only
wakeup explicitly. They then observe zero SQL, RPCs or alarms until an actual
deadline, followed by finite expiry/receipt cleanup and zero further work over
another thirty days. No consumer polling or inactive-owner scan is introduced.

## Enforced operation budgets

These regression limits allow modest implementation variation above measured
work. A breach requires review of the implementation and this report, rather
than silently widening an allowance.

| Boundary | Automated ceiling |
| --- | --- |
| First local/shared acceptance | 95 / 120 SQL writes. |
| First local/shared deferred append | 70 / 80 SQL writes. |
| Warm local/shared complete cycle | 120 / 135 SQL writes, 12 / 20 RPCs, 5,000 SQL reads, at most sixteen set-alarm calls. Installed bounded health allows 140 writes. |
| Duplicate recovery | Zero writes or alarm scheduling, one RPC, at most 64 read rows. |
| Six-stream burst acceptance and relay | Each phase at most 380 local / 440 shared writes; six relay invocations total at most 36 / 48 RPCs, with one physical append call at a time in this profile. |
| Receipt pruning | Twenty rows per physical combined destination ledger per pass; 1,000-pair cleanup at most eighty SQL writes. Source pruning remains twenty terminal rows per pass. |
| History growth | Adding 10,000 synthetic terminal receipts changes duplicate reads by zero; new admission permits at most 100 additional read rows and twenty writes. It does not scan the receipt history. |
| Idle/offline | No work after finite lease/deadline cleanup; thirty-day simulation capped at four expiry-phase handlers. |
| Retry outage | Twelve scheduled attempts, one reserved expiry attempt in the measured case, then charged gap-pending metadata with no payload or scheduled loop. Relay tests enforce twenty total attempts plus the tighter per-invocation remote-work/claim/publication limits. |

These bounds protect the combined path. They do not establish a new bound for
all pre-existing event-only source-ledger queries or unrelated registry work.

The cleanup-lane correction on 2026-10-18 was also checked against all twenty
native measurement cases. SQL calls/rows, writes/deletes, binding requests,
incoming messages and peak append concurrency match the checked-in baseline;
no budget or pricing-model allowance was increased. The new local/shared relay
regressions separately hold a terminal cleanup lease through six further impacts
and then recover all retained obligations. See [latency evidence](state-event-relay.md#delayed-cleanup-and-publication-latency).

## Pricing assumptions and worked scenarios

Checked against official
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[SQLite counters](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
on 2026-10-18:

| Paid-plan dimension | Included monthly | Overage |
| --- | ---: | ---: |
| Durable Object requests | 1 million | $0.15/million |
| Durable Object duration | 400,000 GB-s | $12.50/million GB-s |
| SQLite reads / writes | 25 billion / 50 million | $0.001 / $1 per million |
| SQLite storage | 5 GB-month | $0.20/GB-month |
| Worker requests / CPU | 10 million / 30 million ms | $0.30 / $0.02 per million |

Subscription: $5. DO units use ceiling rounding after allowances; storage
rounding is conservative. ACKs use 20:1 request weighting; outgoing messages are
unmetered requests. Allowances are account-wide for the relevant product,
not new allocations per feature. `incrementalBill(added, existing)` subtracts
the existing account bill and avoids allocating another subscription.

The following calculator scenarios use 138 modeled writes per health command,
50 ms aggregate object-active time, five Worker CPU ms and one Worker ingress
request per command. Duration/CPU are explicit assumptions. Storage stays within
its remaining allowance; watcher/setup costs are excluded.

| Commands/month | Event-only reference | Combined health | Difference |
| ---: | ---: | ---: | ---: |
| 10,000 | $5.00 | $5.00 | $0.00 |
| 100,000 | $5.00 | $5.30 | $0.30 |
| 1,000,000 | $5.75 | $96.30 | $90.55 |
| 10,000,000 | $263.05 | $1,383.69 | $1,120.64 |

Totals include the one $5 plan, with allowances otherwise unused. At one million
health commands the combined model is $88 writes + $3.30 DO requests + $5 plan.
If the write and DO-request allowances were already spent, the same added usage
costs $141.45 incrementally instead. Unused allowances are not a per-command
discount that can be claimed again by each feature.

Free-plan write capacity is 100,000 rows/day. At the conservative 138-write
profile that is about 724 commands/day before other bot work; Free-plan limits
fail closed when exhausted. This is not a claim that the complete bot fits Free.

## Duration and storage limits of the estimate

The five-second application timeout bounds recovery decisions. It does not
cancel every losing fetch or prove a five-second billed-duration limit. Pending
I/O can retain an object; actual billable activity depends on hibernation,
overlap and platform behavior. For one million commands, assumed aggregate
object activity of 0.05 / 1 / 5 / 900 seconds produces duration charges of
$0 / $0 / $12.50 / $1,437.50 under the current rounded model. The 900-second case
is a sensitivity example, not a measured outage duration or a maximum across
multiple waiting objects. A production duration forecast needs actual aggregate
active time; local callback spans cannot supply it.

Application byte caps exclude database/index/platform overhead. In the installed
health fixture, first acceptance allocates another 98,304 SQLite bytes after
grant setup, and a subsequent warmed cycle can reuse existing pages. Freed
records need not shrink the database file. Source/stream schemas, retained
receipts, abandoned authority and internal metadata contribute to fleet storage;
add measured GB-month to the calculator rather than treating the source's
512-KiB pending-payload cap as total storage.

The measured implementation satisfies the bounded-work gate after the two
amplification fixes. It preserves hibernating transport and acceptance remains
disabled. [Final author/operator guidance and release review](state-event-release.md)
complete step 12; deployment remains with the operator.

Private [latency diagnostics](state-event-diagnostics.md) default off. Enabled
tracing adds bounded logs and relay inspection reads, but no diagnostic writes,
RPCs or polling. The ordinary cost profile keeps this switch disabled.
