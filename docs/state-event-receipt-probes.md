# Finite early receipt reconciliation

Latency roadmap step 6 allows an ambiguous append to recover from positive
original-destination evidence before its thirty-second source lease expires.
It does not retry the mutation or append. Absence never proves non-append.

## One opportunity per operation

Only an unknown publication response while the source is still pending, parked
or gap-pending can schedule a probe. Interest registration, confirmation and
cleanup failures do not schedule probes. A successful append needs no probe.
Each operation has one opportunity for its entire outbox lifetime, not one per
retry or consumer wakeup. Duplicate source invocation still returns the original
commit receipt.

The source persists a probe marker and saves the original recovery deadline in
the same transaction that retains the uncertain lease. If the original bounded
invocation has time left, it spends the marker and probes immediately. It does
not obtain another budget or extend that invocation's five-second deadline.
If time is exhausted, a one-shot continuation is selected for 25 ms later in the
existing alarm. This is a durable scheduling choice, not a dispatch-time SLA.
A later request/alarm can service it. No promise chain or local timer starts
another pass.

Before issuing I/O, the source durably spends the marker and restores the exact
saved recovery deadline, including a null deadline at an exhausted retry budget.
A crash before transmission, failure, absent receipt, invalid response or lost
probe reply therefore cannot restart probing or shorten/renew the original
lease. Concurrent handlers coalesce through that durable marker; background
runner suppression remains an optimization. Publication still uses its existing
12 automatic/20 total attempt ceilings, and probes do not increment those
counters. They have their separate one-opportunity ceiling.

## Read-only destination boundary

The private `combined/probe` operation validates the physical stream, owner,
operation ID, event ID and immutable receipt fingerprint. It reads the exact
operation receipt and, when present, its ACK/reset/retention outcome. A fence or
missing receipt is inconclusive. It does not initialize combined tables, prune
receipts/events, publish, fence, modify producer interest, schedule alarms or
call back to the source. It returns no payload or consumer credentials.

Local probes go directly to the pinned destination. Shared probes pass through
the existing registry binding-authority queue, which serializes them with the
original append and lifecycle work. A matching positive durable receipt allows
the registry to remove its outstanding append barrier. Absence/failure leaves
the barrier in place for the existing fencing fallback. No fresh current binding
is substituted: an already accepted old-stream event retains its original
identity across movement/revocation. Destination reads are read-only; positive
registry/source reconciliation intentionally writes their recovery metadata.

The source verifies the response identity, fingerprint, original expiry and
outcome shape. It then uses the normal durable source cache and destination
confirmation path. A transaction checks the original lease token, current
pending state and active reset fence before accepting the outcome. A late
positive response cannot overwrite a reset or a newer owner attempt. Positive
append evidence clears publication uncertainty; a terminal receipt can also
retire the original obligation. Confirmation/retirement failures retain their
normal durable recovery rules. No state value, revision, operation sequence,
event identity or original event lifetime is regenerated.

## Scheduling, budgets and old rows

A full local/shared pending attempt reserves 8/19 conservative remote-call
weights, including the possible 1/2-call probe. A deferred probe reserves 4/9,
including confirmation and terminal cleanup. The owner invocation remains capped
at 20 weights, two claimed records and one new publication; a standalone probe
uses a record slot without consuming a publication attempt. Deferred probes
share the persisted [publication/cleanup schedule](state-event-cleanup-fairness.md).
A selected phase can defer remote terminal housekeeping, reserving 7/14 for
publication or 3/4 for a standalone probe; inline probes inherit that decision.
The confirmed terminal result becomes a charged `retiring` row with its own
subsequent cleanup claim. Every probe RPC is
charged before transmission. The structural owner-rooted nesting bound remains
two application calls, independent of Cloudflare's actual request-depth counter.

The source outbox adds `probe_state` (unused/scheduled/spent), a nullable saved
fallback deadline and a partial due index. The existing lazy SQL initializer adds
the fields to old tables. Old rows start unused, and old uncertainty does not
invent a probe. Owner constructor recovery still works before those columns are
added because the alarm reads the unchanged due index. There is no new Durable
Object class or Wrangler migration, manual cleanup or credential change.

New acceptance/useful wakeups cannot overwrite a scheduled probe with a later
lease deadline. Expiry maintenance preserves a pending probe while discarding
its payload. Active reset pauses probe scheduling; reset commit cancels the
opportunity before normal discarded-row cleanup. Unavailable destinations and
consumers never produce periodic probe polling. Source capacity stays charged
until terminal proof and cleanup, with the same finite outbox/receipt limits.

## Evidence and cost

`test/state-event-receipt-probe.spec.js` covers lost replies, early positive
reconciliation, delayed original appends after absent probes, registry-barrier
retirement, malformed identities, read-only behavior on initialized and empty
streams, exhausted-invocation continuation, failed/spent and scheduled probes
across eviction, competing handlers, coordinated reset, terminal ACK/gap
receipts and old SQL schemas. Existing fallback tests inject probe outages to
continue exercising the original lease/fencing path. The call guard enforces
20 remote calls and two application nesting levels around the complete relay.

The cost reporter includes isolated absent/positive destination reads and full
local/shared lost-reply recovery. Healthy operations send no new RPC; marker
selection and schema/index checks add bounded SQL reads. Fault cases add at most
one destination read and, for shared state, one registry request. Actual SQL and
alarm counts are recorded by the native meter; those counters are not measured
Cloudflare object duration or a production billing guarantee. The step-10
[full cost report and billing refresh](state-event-costs.md) includes these
profiles alongside complete immediate and fallback online cycles.

Step-6 local native-meter results (2026-10-19; SQL counts include catalog/index reads):

| Isolated destination read | Binding requests | SQL rows read | SQL rows written | Alarm operations |
| --- | ---: | ---: | ---: | ---: |
| Missing/uninitialized receipt | 1 | 22 | 0 | 0 |
| Positive appended receipt | 1 | 38 | 0 | 0 |

| Complete relay pass after acceptance | Requests | SQL rows read | SQL rows written | Alarm reads / sets |
| --- | ---: | ---: | ---: | ---: |
| Healthy local append | 3 | 1,979 | 58 | 8 / 6 |
| Local lost reply + positive probe | 4 | 2,350 | 65 | 10 / 7 |
| Healthy shared append | 4 | 1,698 | 67 | 8 / 6 |
| Shared lost reply + positive probe | 6 | 2,083 | 74 | 10 / 7 |

Thus the measured early recovery adds 1/2 requests, 371/385 rows read, seven
rows written, two alarm reads and one alarm set over the corresponding normal
local/shared pass. This includes source marker/reconciliation work and positive
registry barrier retirement, not just the destination read. The separate warm
immediate acceptance-plus-append profiles keep 5/10 requests, 76/89 SQL writes
and the same alarm counts as step 5; reads rise from 2,257/2,050 to 2,317/2,102.
Cold initialization adds one SQL write for the new partial index. These profiles
exclude ACK cleanup and object-duration billing; the CI artifact retains all 26
profiles, including finite outage and history-growth checks.

Step-6 CI exposed an immediate-activation interaction: eligible ACK cleanup
could consume the reservation before a fresh shared publication, or a running
cleanup activation could suppress the independent commit's runner. Separate
publication/useful-wakeup gates preserve independent commit activation. Step 7
now bounds publication preference, rotates persisted record turns, and splits
terminal housekeeping when needed to fit a cleanup phase plus publication into
one pass. Native health tests deliver eight commands with alarms withheld;
all four owner-wide leases, ordering and invocation limits still apply. See
[cleanup fairness](state-event-cleanup-fairness.md) for the current policy and
its explicit live-lease and dispatch limits.
