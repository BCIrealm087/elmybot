# Publication and cleanup fairness

Latency roadmap step 7 prevents eligible publication and cleanup from
indefinitely monopolizing each other's relay admission. It adds no remote
request path, polling, coordinator, or higher concurrency allowance.

## Durable selection

All ordinary relay passes, commit activations, useful-wakeup activations and
explicit recovery share a persisted owner schedule:

- Publication has priority for at most three consecutive publication claims.
  If cleanup is eligible after that burst, its next claim takes priority.
- A cleanup claim resets that streak. If publication is eligible, another
  cleanup cannot precede the next publication claim.
- Each newly admitted row gets a monotonically increasing queue ticket.
  Each claim moves its ticket to the back. The oldest eligible ticket in the
  preferred class wins, across all streams sharing the owner. New first
  attempts cannot continually jump ahead of an eligible retry.
- Deferred one-shot receipt probes use the publication class and the same
  tickets. An inline probe belongs to the already admitted publication path;
  it does not create another claim, opportunity or invocation allowance.
- A preferred record must fit the invocation's selected complete-phase reservation.
  If it cannot fit, the pass yields rather than spending its budget on cheaper
  records from the other class. The existing durable continuation selects
  already-due work for a later pass with a fresh budget.

Three publications is a finite bias toward short command bursts, not three
publications per invocation: the existing one-publication quantum still holds.
With both classes continuously eligible, cleanup waits behind at most three
publication claims, and publication behind at most one cleanup claim. Claims
consume the preference even if subsequent I/O fails. Eligibility still requires
original due times, ordered-head checks, reset fences, per-stream lane leases,
owner capacity and remaining attempt budgets. An exhausted or future-due row
cannot demand a turn or keep the other class idle.

Explicit recovery cannot bypass an eligible preferred row, even on another
stream. It returns the existing `state_event_attempt_in_progress` conflict
without charging the requested operation, retaining the normal durable
continuation. It never silently executes a different requested operation.

## Sharing one bounded pass

When both classes need service, an appended outcome/confirmation phase can
persist its terminal result as the existing `retiring` state and defer remote
origin retirement/interest release. Its phase reserves six shared call weights;
a shared publication phase that also defers terminal housekeeping reserves
fourteen. Together they fit exactly within the existing twenty-call allowance.
An already-retiring cleanup reserves five and can share a pass with a
fourteen-call publication. No new durable state or remote endpoint is introduced.

The split flag is local to the claimed record. Deferred housekeeping cannot
issue a retirement/release call under the smaller allowance. Confirmation and
local retirement complete durably before that phase releases its lease and
records an immediate due time. The unresolved row stays fully charged; its next
cleanup claim owns remote retirement/release and the usual control budget.
Inline positive receipt probes carry the same split decision. Uncertain
confirmation still retains the original lease and follows normal recovery.
Control cleanup (`gap_recorded`, `retiring`, `reset_discarded`) is indivisible.
It always reserves its full confirmation/retirement/release path, preserving the
last automatic or total control attempt. A shared gap/control path (7) cannot
share twenty with a publication phase (14); that rare case yields publication
to its existing continuation after completing the control attempt.
If there is room for the full path, ordinary single-record handling keeps its
existing inline terminal cleanup. A phase must still fit its full reservation
before a claim, and all calls charge the selected allowance before transmission.

This lets an owed cleanup turn and the following command publish in one bounded
pass, including after the third command. It avoids introducing an alarm wait
solely to enforce fairness on healthy mixed traffic.

## Live leases, transitions and upgrades

There is deliberately no universal reserved publication slot. All live leases,
including uncertain publication leases whose records have since become
`appended` or `retiring`, count toward the same four-record owner limit. Four
existing leases can temporarily prevent a new claim. They keep their original
tokens, deadlines, attempt counts and recovery authority. Once capacity becomes
available, the persisted selection policy arbitrates the next eligible claim.

This handles append-to-cleanup transitions without pretending that refusing a
fourth cleanup claim reserves capacity. Eviction does not reset the schedule.
An upgrade adds `relay_turn` through the existing lazy SQL initializer and a
constant-size `state_event_relay_schedule` row. Legacy records start at ticket
zero ahead of new admissions; the initial publication streak is zero. Existing
leases and uncertainty are not rewritten. No operator cleanup or Wrangler
class migration is required. The ticket counter rejects unsafe integer
overflow rather than wrapping; it is not reset when the queue becomes empty.

Unresolved rows retain their outbox row/byte charges. Fairness does not permit
bypassing a truly uncertain unpublished head, removing a terminal obligation
before remote acknowledgement, or exceeding the existing 12 automatic/20 total
attempt limits. After retry exhaustion, recovery still needs an existing useful
wakeup or explicit recovery within the remaining total budget. Recovery of a
dependency alone does not start a poll or rediscover inactive owners.

The bounds are on eligible claim order, not wall-clock latency. Cloudflare
alarm dispatch, live uncertainty leases and unavailable dependencies can still
add delay. When an owed cleanup path and a publication cannot both fit the
20-call reservation, publication can wait for the existing continuation.

## Evidence and cost

`test/state-event-fairness.spec.js` covers local/shared sustained failures,
rotation across eight streams, concurrent activations, new admissions versus
retries, explicit recovery, deferred probes, an uncertain ordered head, and four
publication leases that transition into cleanup before an upgrade/eviction.
Native installed-health cases deliver and ACK eight commands with fallback
alarms withheld, for standalone and linked owners. Real shared delivery paths
separately inject repeated origin-retirement and
interest-release transport failures across three streams while eighteen new
operations publish on three other streams. Source charges remain exact;
restoring dependencies and allowing the original leases to mature drains all
obligations without duplicate events.

The existing relay, activation, receipt-probe and work-budget suites retain
ordering, deduplication, one-shot probing and request/nesting limits. Fairness
selection issues no RPC; split phases reuse the existing protocol calls.
Mixed traffic can require an additional cleanup claim, its SQL work and the
existing bounded continuation. The scheduler writes one singleton schedule row
per admission/claim, with ticket changes included in the existing outbox write.
The claim write replaces the old per-stream last-served write; admission adds
one schedule write.
SQL reads and cold schema work also increase. Complete local cost profiles are
recorded with the full suite; the step-10 [cost report](state-event-costs.md)
refreshes the billing scenarios. Provider-active duration remains an explicit
scenario assumption requiring production telemetry for an actual forecast.

The final local healthy warm immediate profiles retain 5/10 binding requests,
four alarm sets and seven alarm reads for local/shared owners. SQL writes are
77/90 (one more than step 6); reads are 2,366/2,143 (49/41 more). Cold profiles
record 147/179 writes including lazy schema work. The complete installed-health
warm cycle records 118 writes, 4,440 reads, fourteen requests and sixteen alarm
sets. These are controlled test-runtime counters, not production billing.
