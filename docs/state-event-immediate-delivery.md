# Immediate delivery with durable recovery

Latency roadmap step 5 requests one bounded background relay pass after a new
local or shareable owner commit. It starts outside the mutation transaction and
uses the existing claims, source snapshots, ordering, fences and destination
identities. Acceptance still means saved and durably queued. It does not wait
for publication, a consumer, an ACK or an animation.

## Commit and activation

The atomic transaction still persists a first recovery deadline one second after
commit together with state, revision, receipt and outbox intent. This deadline is
an alarm fallback, not a prerequisite for the first publication. A commit
activation can select a never-attempted `pending` row before that deadline.
Retries and useful wakeups keep their existing backoff/coalescing times; live
leases, reset fences, ordered heads, automatic/total attempt ceilings, expiry and
admission limits still apply. Duplicate committed invocations return the original
receipt without scheduling a new pass.

`requestStateEventActivation` registers a non-awaited `waitUntil` task on the
owner. In particular the shareable commit does not await publication while the
registry holds its binding-authority queue: the owner response can return, the
registry removes its commit barrier and releases its queue, and a queued append
can then acquire it. No sleep, timer, self-request, coordinator or storage phase
is added. The existing durable alarm is installed before activation is requested.

Per-owner in-memory gates suppress redundant publication and useful-wakeup
runners separately. An ACK cleanup runner cannot suppress an independent new
commit activation. A commit pass prioritizes its never-attempted publication
before eligible cleanup can consume its reservation; ordered-head and lease
checks still apply. This is not a universal publication-slot reservation or a
sustained cleanup-fairness guarantee (latency roadmap step 7). The gate is only
an optimization; durable claims and lease tokens arbitrate concurrent alarms,
explicit reconciliation, other requests and eviction. A suppressed activation
does not cancel a persisted deadline. A pass runs once, with at most 20 reserved
remote-call weights, two claimed records and one publication. It never loops to
obtain another budget, restarts itself from completion or adds a trailing timer.
Remaining due work uses the existing durable continuation; future deadlines stay
future. Unexpected activation/registration failures cannot reject an already
committed command. Abrupt termination relies on the durable alarm/lease.

`waitUntil` does **not** detach Cloudflare's incoming request context, reset its
depth counter or increase its subrequest budget. The relay still includes all
its descendants in the existing reservation. Normal owner publication uses the
step-4 shallow path, but command ancestry remains outside the structural test's
owner-rooted two-level envelope. No production latency or numeric Cloudflare
depth threshold is established by these tests.

## Consumer and capacity wakeups

Reconnect/registration, ACKs that release retained capacity, and coordinated
reset completion first persist their existing destination notification marker
and alarm. If already eligible, they request a single background notification
pass. A new eligible source notification similarly requests one relay pass after
its source transaction commits. Source reset release can request the same pass.
Both local gates suppress duplicate runners; notification versions, epochs and
leases remain the durable authority.

The one-notification-per-second coalescing window remains. A wakeup still inside
that window waits on its persisted alarm; it does not install an in-memory timer.
A notification received during an active source lease cannot bypass the lease.
Offline events can append once and sleep until terminal evidence or expiry.
Full/disabled/reset-required destinations park, and active reset fences prevent
claims. No consumer-presence, capacity or receipt polling is introduced.

## Operational control and evidence

Immediate activation is enabled by default. Setting the optional private
`STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED` variable to the exact string `false`
suppresses background activations while retaining normal alarm recovery and
explicit reconciliation. It changes no acceptance switch, identity, stream,
credential or schema. No new variable is required for normal operation.

`test/state-event-activation.spec.js` covers local/shared first publication with
alarms deliberately undispatched, a held registry commit response and blocked
append, suppressed activation recovered through the persisted deadline,
concurrent accepted work coalesced behind a runner, request/reply loss, finite
unavailable-stream behavior, real reset fencing/release, reconnect/ACK
coalescing, and sanitized activation failure. Structural guards retain the
owner-rooted request/call bounds. Immediate cold/warm cost profiles record SQL,
RPC and alarm operations without pretending local elapsed time is billing time.

Installed health tests retain native bindings and installed declarations, with
only the activation flag configured on the tested owner/stream. They advance
the application clock so normal fallback alarms lie two minutes in the native
dispatcher's future, then deliver and ACK three sequential commands for both a
standalone owner and a linked Discord/Twitch owner. No forwarding bindings,
forced due dates, per-hop injection or manual relay drain are used in those
paths. Existing recovery/cost tests select alarm-only mode to isolate that path.
These are local workerd regressions, not a reproduction of Cloudflare's observed
minute-spaced production alarm dispatch or request-depth failure.
