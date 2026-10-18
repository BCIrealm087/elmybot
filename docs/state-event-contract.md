# Atomic state changes with durable events: contract

Status: normative implementation contract. Steps 2–7 implement declarations,
preview, private recovery and local/shareable atomic storage with lifecycle
authority, private deferred admission and gap/reset reconciliation. Production
combined commands remain blocked; bounded relay is implemented in step 7, with
[integration and enablement](state-event-roadmap.md) following in steps 8–12.
This document alone does not enable runtime support.
Created: 2026-10-17.
Work branch: `codex-state-ironing` in `BCIrealm087/elmybot`.
Baseline reviewed: `9c3ebf82aae63f5d0ce27ee63a9a3de1fae9f170`.

This contract adds an explicit command operation that atomically commits
authoritative feature state and its corresponding durable event intent. It
does not relax the existing prohibition on independent state writes followed
by `stream.publish()`. Public helper names, declaration spellings, the finite
projection vocabulary and reserved identity formats are specified in
[the step-2 authoring reference](state-event-authoring.md); the semantics and
limits below constrain that API. Production combined execution is still blocked.

## 1. Product guarantee and compatibility

The state owner's local SQLite transaction commits all of:

1. the validated state operation and its observable operation watermark;
2. the normal state-query revision/invalidation work, where applicable;
3. an immutable receipt containing the original operation result; and
4. exactly one pending event with its fixed identity, payload and deadline.

Either all four commit or none does. The origin routing record and destination
event log are separate owners and are not part of that transaction. The
framework must recover across those boundaries rather than claim a distributed
transaction.

**Command success means state saved and event durably queued at the state
owner.** It does not mean appended to the destination stream, received by a
widget, acknowledged, animated, or permanently retained. Delivery is bounded
and at least once; explicit retention/lifecycle gaps are possible. Committed
state is never rolled back because later event delivery fails.

| Surface | Meaning after this addition |
| --- | --- |
| Existing state-only action | Unchanged atomic state operations and coalescing readable-state notifications. |
| Existing event-only action | Unchanged connected-consumer admission and confirmed-stream-append success. |
| Explicit combined action | Atomic state/result/event-intent acceptance, including while no consumer or grant exists; subsequent bounded delivery. |
| Independent state plus event calls | Still rejected; they do not become a combined operation. |

Existing stream versions cannot silently adopt combined admission or payload
semantics. A combined stream must explicitly declare this mode and its source
partition. One stream version cannot mix event-only and combined writers.
Existing state-query/event credentials, public access rules and the event
master switch remain distinct.

## 2. Supported authoring boundary

Initial support is deliberately limited to:

- command-triggered feature actions, with existing platform authorization and a
  group cooldown of at least one second;
- exactly one combined operation and one event per action invocation;
- one group-local feature partition in `GroupConfig`, or one declared
  effective-shareable namespace in `ShareableStateRealm`;
- one target key or bounded-counter subject in that partition; and
- one associated declared stream of the same feature and logical owner.

A combined stream version is bound to exactly one source partition declaration.
Its physical incarnation therefore has exactly one authoritative producer
owner, even when Discord and Twitch both invoke it. A partition can declare
different streams, but an invocation uses only one. Receipts, pending work,
rate limits and byte budgets are aggregated at their stated owner boundary,
not multiplied by choosing more actions or namespaces.

Supported mutation forms are the existing JSON-safe set/delete, integer
increment, and bounded-counter set/increment/decrement/reset semantics. Existing
key, subject, value, schema and counter limits continue to apply. This is not a
general multi-key transaction, an `integrationState` migration surface, or a way
to update local remembered state and shared state atomically.

The author submits a validated mutation description and event projection as one
operation. The projection may use bounded literals, validated command input,
frozen read-only configuration and the mutation's before/after/changed result.
It cannot execute feature callbacks, perform I/O, read another state owner, or
consult a fresh clock/random source inside the transaction. Dynamic computation
that is not expressible by the reviewed projection/mutation forms is deferred.
The [step-2 authoring reference](state-event-authoring.md) defines the finite
projection vocabulary; arbitrary code is rejected.

The payload is constructed and schema-validated against the actual mutation
result inside the commit boundary. An invalid or oversized resulting payload
rolls back the whole operation. State-dependent results must not be computed
through a separate read followed by a later write.

Read-only preparation is allowed; its selected configuration/input values are
frozen into the prepared request. No additional mutable state service,
independent publication or routed effect is allowed in a combined action.
Return `effects: []`; the combined commit is the action's final externally
observable operation. Static output rendering after receipt recovery is allowed
and must not turn an accepted operation into a new failed mutation attempt.

## 3. Acceptance and outcomes

Preparation validates input, authorization, installed declarations, mode,
configuration, cooldown eligibility, request size and current owner selection.
The state owner revalidates the declaration, pinned authority, deadline,
storage capacity, mutation bounds and event projection at the commit boundary.
An earlier resolution or preflight request does not reserve authority or
destination capacity.

| Condition | State/result/intent outcome | Command or recovery meaning |
| --- | --- | --- |
| Unauthorized, malformed or unsupported request | No combined commit | Safe denial/input error. |
| New source is under cooldown | No combined commit | Existing cooldown response. |
| New acceptance disabled or source too old | No combined commit | Bounded unavailable/expired outcome; never execute late. |
| Source outbox, receipt or rate capacity unavailable | No combined commit | Retryable bounded capacity failure before mutation. |
| Owner sealed, frozen or binding authority changed before commit | No combined commit | Transition failure; repinning requires proof of no commit. |
| Event projection/schema fails after calculating a result | Entire transaction rolls back | Safe input/declaration error. |
| Valid operation and source capacity available | State, receipt and intent commit together | Success: state saved and event queued. |
| No consumer or grant at acceptance | Same atomic commit | Success within source/destination storage and retention bounds. |
| Destination full/unavailable after acceptance | Keep committed state and recoverable intent | Delivery pending; never rerun the mutation. |
| Commit response lost | Outcome may initially be unknown | Recover the pinned owner's receipt; do not report definite rollback. |
| Same source and same prepared request retried | Return original committed result, if present | No new mutation, watermark or event. |
| Same source reused with different action/request | Original records unchanged | Stable conflict; no overwrite or second operation. |
| Event is acknowledged | State remains; payloads may be pruned | Receipt remains for its identity window. |
| Event deadline passes or unappended work loses its binding | State remains; record an explicit gap | Terminal delivery outcome; snapshots can recover current state. |

A retry that recovers an accepted operation returns its original acceptance
receipt even if delivery is now acknowledged or terminal. Protected diagnostics
can additionally show current delivery status. A fresh command is a new logical
operation, even if its text is identical.

The origin cooldown and shared mutation do not have a cross-owner rollback
guarantee: a precommit rejection may consume that source's original cooldown
claim. Same-source recovery checks the prepared operation/receipt before claiming
cooldown again; this bypass permits recovery only, not another mutation. Current
authorization must still be enforced before exposing saved output to a caller.

## 4. Identity, routing and receipt lifetime

Use the authenticated platform source identity already supplied by the adapters
(Discord interaction ID or Twitch EventSub message ID), with the normalized
origin group, deployment environment, feature, action kind and operation format
version. The logical operation identity excludes physical owner/generation and
binding revision. Use a collision-resistant opaque digest, not a user-provided
idempotency key. Its versioned tuple and prefix are reserved in the
[authoring reference](state-event-authoring.md); step 3 implements their use.

Continue deriving the associated event's `dev1` identity through the existing
feature/stream/version/origin/source algorithm. The dedicated combined stream
version and single-operation rule prevent competing writers for that identity.
Store the operation-to-event relationship and reject any inconsistent reuse.

Fingerprint the complete canonical prepared request: declaration versions,
mutation target/parameters, event projection/literals, normalized input and
selected configuration. Before/after values and the final state-dependent
payload are results, not inputs to recompute on retry. Receipt lookup precedes
mutation calculation and payload construction.

Before sending a mutation, the origin group durably prepares one pinned route
and request fingerprint. A preparation record is not evidence that the state
owner committed. The state-owner receipt is authoritative for that fact. Lost
origin-finalization responses and lost mutation responses must both recover
through this protocol.

Repinning is allowed only after the previous owner proves that the request did
not commit and fences the old attempt against later execution. Never infer
non-commit from a timeout, missing response, or a route that is no longer
current. If proof is unavailable, fail retryably until the acceptance deadline;
do not mutate a second owner. A logical operation has at most eight pinned
attempts, including its initial owner. Reaching this limit rejects further
repinning without fencing its last still-valid attempt; receipt recovery remains
available.

The admission deadline is two hours after the authenticated source creation
time. That time must come from verified platform data or a durable ingress
record tied to that source; the adapter must reject sources for which a stable
trusted time cannot be established. Caller-supplied time, retry time and a new
HTTP signature timestamp cannot extend it. The state owner checks the deadline
at commit, so delayed old requests cannot execute after expiry.

Origin route/conflict records and state-owner receipts live until at least two
hours after first preparation or commit, respectively. They cannot be pruned
while pending delivery, an uncertain result, or a recovery lease still needs
them. An owner receipt is not eligible for pruning until delivery is terminal
and the origin has acknowledged a durable cache of the committed receipt. A lost
acknowledgement preserves the receipt and can be retried independently of mutation.
Payloads expire at their shorter event deadline. Minimal records that
remain uncertain stay charged against bounded receipt capacity and block new
admission if needed; they are not evicted to make a retry ambiguous. A deadline
check plus an authoritative receipt read can prove a late attempt can no longer
commit. Late platform retries must fail closed after expiry rather than recreate
an operation whose tombstone has been pruned.

This covers the current five-attempt Twitch retry delays (30 seconds, 2 minutes,
10 minutes and 30 minutes) under ordinary service recovery. A delayed backlog
can exceed admission age and be rejected without mutation. Completed Twitch
inbox deduplication remains unchanged; manual replay after the identity window
is not supported. A deliberately new command has a new platform source ID.

## 5. State transaction, no-ops and correlation

The commit allocates a strictly increasing safe-integer operation sequence for
the source partition and records an opaque scope token, operation identity,
original result, commit time and event deadline. The scope token changes for a
fresh standalone/integration generation. It exposes no physical realm ID and
is neither a credential nor a cross-scope ordering key. Counter/sequence
exhaustion rejects before mutation instead of wrapping.

The readable snapshot and associated event expose compatible, versioned
correlation metadata: scope token, committed operation sequence and state-query
revision/watermark as needed for snapshot/watch consistency. Correlation field
names are reserved in the authoring reference, with wire integration in step 8;
their meaning cannot depend on browser clock ordering. Ordinary event-stream
sequence/cursor values remain separate.

A valid combined invocation at a counter floor/ceiling is accepted. It creates
one receipt, watermark and event even when the requested change applies zero.
The result explicitly distinguishes requested amount, applied amount and
whether the feature value changed. The watermark is observable state: its
change must participate in snapshot/watch revision advancement and notification
within the same transaction even if the health number is unchanged. Legacy
state-only no-op/revision behavior is not altered.

Only feature state participates in existing collision comparison, copying and
successor initialization. Infrastructure receipts, outboxes and watermark
ownership are not copied as historical delivery obligations; a successor gets
a fresh scope token and operation sequence domain. Snapshot capture must remain
consistent with whatever feature state committed before its seal.

The outbox is append-only per accepted operation until delivery/terminal
cleanup; it cannot use the notification outbox's latest-revision coalescing.
Transactionally maintained counters and indexed expiry/due-work lookups must
enforce capacities without scanning all historical receipts per command.
Schema initialization is additive and idempotent. Persist recovery scheduling
before or with the mutation so a crash immediately after commit cannot strand
the first event on an otherwise idle owner.

## 6. Deferred stream admission and ordering

Only an internal, validated combined-record path may append without a connected
consumer. Validate the installed stream mode, producer identity, source scope,
pinned route, canonical payload, event identity, original commit/deadline and
receipt authority. A feature or public HTTP caller cannot forge proof by
supplying owner IDs or timestamps. Authentication and authority checks remain
framework infrastructure.

Destination insertion remains transactional and deduplicated. A repeated append
returns its original receipt, sequence and expiry without extending the
deadline. Both source and destination enforce `expiresAt = committedAt + 30
minutes`; late relay does not buy another 30 minutes. A confirmed acknowledgement
resolves delivery even if later source cleanup encounters that deadline.

Deliver in state-commit order for one source partition/stream incarnation.
Different streams, state owners and scopes have no total order. A source
partition sequence can have gaps in a particular stream when operations target
another declared stream; destination sequences keep their existing meaning.
Retrying a blocked head must not allow later events on that stream to overtake
it. Parallel delivery is allowed only across independent stream domains.

An original operation can consume a source slot and later a destination slot
during acknowledgement/recovery overlap. Bound and account for both; preflight
destination capacity is not an atomic reservation. A known destination gap or
administrative block should reject new acceptance before mutation once known
at the source, but a racing block may leave a committed, explicitly tracked
intent. Never disguise that case as no state change.

## 7. Offline behavior, retention gaps and resets

No active grant or socket is required to save a combined operation. A later
properly authorized consumer of that same physical stream may receive its
retained backlog. New grant issuance does not extend retention or authorize
another realm. Keep the existing one-consumer/one-ready-socket/one-in-flight
delivery model and separate event/read credentials.

When the source outbox or destination stream reaches its bound, retain existing
accepted events. The source rejects new combined work if its own capacity is
full; destination pressure leaves already committed source work pending. Do not
silently evict accepted events, roll back state or coalesce impacts to free space.

An event that cannot be delivered within its original deadline becomes an
explicit retention gap. This includes an event never appended to the stream.
Persist an idempotent bounded gap marker at the source before pruning its
payload. Mirror/reconcile that marker with the destination; unresolved source
gap authority must be checked before a consumer can be told the stream is
complete/ready. An unavailable producer prevents that assurance rather than
allowing a false clean stream.

Gap markers record scope, reason and operation-sequence coverage, without
inventing a destination sequence/cursor for an unappended event. Coalescing gap
coverage into a bounded summary is allowed; coalescing payload events is not.
A lost append response is resolved by receipt recovery; source expiry alone
does not prove the event was never appended or acknowledged.

As with existing event retention gaps, an explicit operator reset is required
before normal delivery resumes. A readable-state refresh can recover health
immediately, but it neither acknowledges unseen events nor clears a stream gap.
Reset is idempotent and coordinated across source/destination, never a state
rollback. Temporarily fence new combined acceptance for the affected stream
while establishing a reset checkpoint; discard only the backlog/coverage the
operator explicitly accepts. Resume only when both sides agree. Never reset
operation identity/sequence domains to reuse old IDs. Step 6 implements this
internal extension using the existing protected operator reset workflow.

## 8. Binding movement, revocation and drain

Current state owner selection, namespace seals/freezes and binding revisions
remain authoritative. Commit must serialize against the transition: a mutation
accepted before the state fence is included in the captured state; one after
the fence fails before mutation. Resolving the route earlier is insufficient.

For the initial combined mode, choose the following bounded rule:

| Work at binding movement | Required behavior |
| --- | --- |
| No committed operation | Resolve/retry only after proving and fencing non-commit at the old owner. |
| Committed and confirmed appended to old stream | Drain retained events under the existing old-stream grant rules. |
| Committed but append outcome unknown | Recover that event's old-stream receipt; never append to the new stream. |
| Committed, proven not appended, binding no longer valid | Terminal lifecycle gap at the original owner; preserve state. No late append exception. |
| Future new source invocation | Resolve the then-current owner and associated stream normally. |

This intentionally gives up replay of unappended events across a binding
handoff. It avoids a new distributed reservation/late-append protocol and is an
explicit lifecycle gap, not silent data loss. Already appended backlog retains
the existing drain behavior. Revoking/replacing a grant stops that grant's
delivery immediately; it does not move events, erase state, or transfer rights
to a different scope. A newly authorized grant for the same still-eligible
physical stream follows the existing backlog/reset rules.

A stream cannot announce a clean complete drain merely because its own event
table is empty while its producer has unresolved committed work. Coordinate a
producer watermark/fence before terminal `stream_moved`, or report the explicit
gap/block. Frozen owners may finish receipt recovery and terminal outbox
bookkeeping without becoming writable for feature state again.

Never clone pending payloads, receipt identities or old gap obligations into a
new standalone successor or integration. Preserve state under the existing
collision/revocation rules and use fresh public correlation scope. Grant
discovery and logs must not expose frozen state or event contents to a newly
selected audience.

## 9. Initial resource and recovery limits

All limits apply together. These are design ceilings, not claims about measured
billed operations; step 11 measures amplification and may justify stricter
limits. Raising them or changing retention requires an explicit contract update.

| Limit | Initial value and boundary |
| --- | --- |
| Combined commits per action invocation | 1 mutation target, 1 stream, 1 event. |
| Command group cooldown | At least 1 second per origin action. |
| Source admission rate | 10 new combined operations/second per state owner, across partitions. |
| Combined partitions with receipt/outbox/gap state | 100 per state owner. |
| Canonical prepared request | 16 KiB, including selected input/configuration and projection. |
| Serialized event payload | 4 KiB. |
| Saved result summary | 4 KiB; do not implicitly copy an entire state namespace. |
| Origin pending preparations | 100 rows and 512 KiB per origin group. |
| Registry uncertain owner/append calls | 100 rows and 512 KiB per registry; at most 8 KiB per locator, no event payload. |
| Registry recovery work | At most 20 affected records and a 5-second deadline per handler; unresolved authority blocks the affected lifecycle mutation. |
| Source pending events | 100 rows and 512 KiB per state owner. |
| Receipt/route records | 100,000 rows and 16 MiB serialized application data per owning object; local origin/source records share the cap. |
| Single serialized receipt/route record | 8 KiB; payload/request buffers are counted separately. |
| Admission/source replay age | 2 hours from trusted source creation. |
| Receipt minimum retention | 2 hours after its first preparation/commit; preserve unresolved rows as described above. |
| End-to-end event retention | 30 minutes from state commit. |
| Destination retained events/bytes | Existing 1,000 events and 1 MiB per stream, including all retained combined events. |
| Destination admission rate | Existing 10 appends/second per physical stream. |
| Live producer interests | 1 producer per physical combined stream; at most 100 associated stream interests per state owner. |
| Relay claim/cleanup batch | At most 20 records per owner handler. |
| Parallel outbound delivery | At most 4 independent streams per owner handler; 1 ordered head per stream. |
| Relay work-start budget | Start new attempts for at most 5 seconds per handler; finish bounded calls already started and reschedule remaining due work. |
| Attempt lease | 30 seconds. |
| Outbound request timeout | 5 seconds per attempt; abandon/wait for the durable lease on uncertain results. |
| Transient retry backoff | 1, 2, 4, 8, 16, 32, 60, 120, 240 seconds, then 300 seconds, bounded by deadline. |
| Scheduled automatic delivery attempts | At most 12 per intent, including the immediate attempt; later useful wakeups remain bounded below. |
| Total append/receipt recovery attempts | At most 20 per intent before its event deadline; duplicate command retries do not reset this budget. |
| Producer notifications | Coalesce per stream; at most 1 reconnect/capacity wakeup per second, never a periodic presence probe. |

Pending-byte accounting includes serialized payloads and required routing/lease
metadata, not only user text. Receipt/result and preparation bytes count against
their corresponding caps. Index/database overhead is additional real storage
and must be measured; these caps describe bounded application records, not an
exact invoice ceiling. Rejection, cleanup and diagnostics must themselves use
bounded records and work.

On transient failure, use the retry schedule within the deadline and attempt
budgets. After scheduled attempts are exhausted, park work for a useful bounded
wakeup or expiry; do not spin or invent additional timers. Known capacity
pressure parks on capacity/reconnect interest plus expiry. Offline consumers
alone do not prevent a deferred append while destination storage is available.

Stream registration/reconnect, acknowledgement that releases capacity, new
accepted work, or an explicit recovery action can request a coalesced wakeup.
They cannot extend deadlines, reset attempt counters, bypass an earlier ordered
head, or exceed rate/concurrency limits. At the total attempt limit, preserve
the intent until expiry or a definitive terminal outcome; a recovery-only
receipt check needed to resolve ambiguity is counted and must be reserved
within the budget rather than replaced by a guessed outcome. Unresolved gap
authority stays visible and blocks false completeness if a service remains
unreachable.

Schedule only actual retry, lease recovery or earliest-expiry work. Remove the
combined-work alarm contribution when no such work exists. Share each owner's
single alarm with existing state notification/maintenance scheduling. Never use
`setInterval`, a waiting promise, unbounded `waitUntil`, or a permanent relay to
hold an owner awake. Index due work and keep transactional counters; no global
owner scan or periodic consumer liveness polling.

## 10. Widget snapshot and event behavior

Current health comes from a readable snapshot/watch. Impact events drive
individual animations; they are not a second authority that subtracts damage
from an already updated snapshot. Public correlation lets the widget compare
the same scope and recognize which operations the snapshot already includes.

During initial setup/recovery, buffer registered events while acquiring the
snapshot. Treat events at or below its operation watermark as historical:
handle/acknowledge them safely without replaying old impact animations. Process
later events in stream order and keep current values from snapshots or their
correlated absolute results without moving backward. Store handled event IDs
for at-least-once deduplication. A scope change invalidates comparison with the
old watermark; acquire a fresh snapshot and authorized stream.

A fresh widget therefore recovers current health without replaying every old
delta. It may deliberately omit historical animations during startup or after
a gap. Once live, it handles each retained new event, including an accepted
zero-applied impact. Exactly-once animation across a browser crash is not
guaranteed; acknowledgement and local storage cannot atomically commit a
visible browser effect.

The state and event credentials remain separately issued and scoped. A widget
that wants both authoritative recovery and impacts needs authorization to both;
an event grant does not implicitly grant state access. Neither path exposes
raw platform/source IDs, realm IDs or credentials in event payloads.

## 11. Worked health cases

`fun.health` will use shareable health, initially 100, bounded to 0–100. Existing
command permissions, one-second group cooldown, damage/heal syntax, default
amount 10, and valid requested amounts 1–100 remain unchanged. Exact new
action/stream/readable-export identities are fixed in steps 2 and 9 before
implementation; `fun.health:impacts:v1` is not silently reinterpreted.

| Case | Atomic result and event meaning |
| --- | --- |
| Damage 10 at 100 | Save 90; one event says requested 10, applied 10, before 100, after 90. |
| Damage 10 at 3 | Save 0; one event says requested 10, applied 3, before 3, after 0. |
| Heal 10 at 100 | Value remains 100; one accepted operation/watermark/event says applied 0 and changed false. |
| Retry the first source after later healing | Return its original result of 90 and original event; do not damage the newer health. |
| Widget disconnected, queues have room | Save health and intent; retained events can arrive after authorized reconnect. |
| Source outbox full | Reject before changing health or creating an accepted event. |
| Destination unavailable beyond retention | Keep saved health; explicit gap, then authorized snapshot/reset recovery. |
| Binding moves before a pending event appends | Keep committed health in its lifecycle-defined owner/successor; original event gets a lifecycle gap and is never sent to the new stream. |
| Browser-local storage cleared | Recover bot-owned health from the snapshot; suppress covered historical impacts during setup. |

Upgrading the existing widget does not upload its local health as trusted bot
state. Initialize the new namespace at 100 under the feature's normal absence
policy. Old stream backlog/credentials and local browser values follow the
explicit version-transition guidance in step 9, not an automatic conversion.

## 12. Operational controls, failures and diagnostics

Reserve `STATE_EVENT_OPERATIONS_ENABLED` as the new-acceptance switch; only the
literal string `true` enables it. New combined acceptance also requires the
existing event master switch. Missing/malformed values fail closed. Runtime
binding of this switch is future implementation, not part of step 1.

Disabling new combined acceptance does not erase receipts, hide accepted
results or stop safe drain/cleanup. Keep the event master switch enabled for
normal drain. If the global event master is disabled, respect its publication
and socket stop, keep pending state/receipts, enforce original expiry/gaps, and
avoid repeated disabled-service retries. Resume only through an actual enable
or other useful recovery wakeup. Re-enabling never extends an event deadline.

Rollback disables new acceptance first and retains the storage/handlers needed
to drain, expire and recover accepted operations. Do not roll back to code that
ignores committed outboxes, deletes additive tables or removes referenced
semantic versions. Existing migration tags remain append-only.

Use stable, safe outcome categories for unavailable/disabled, input invalid,
source conflict/expired, cooldown, source capacity, transition, outcome unknown,
pending, delivered/acknowledged, retention gap and lifecycle gap. The authoring
reference lists the existing identifiers; later persistent handlers must map
their remaining outcomes explicitly. A transport timeout after mutation can
be ambiguous; never tell the user that state was unchanged without proof.

Aggregate counters may include accepted/duplicate/rejected operations, pending
count/bytes buckets, age buckets, attempt counts, alarm/request work, terminal
gap reasons and recovery outcomes. Do not log feature payloads, state values,
raw source/actor/group IDs, grants or scope tokens as metric labels. Protected
operator diagnostics can report bounded status and gap coverage without
returning payloads or exposing another scope's records.

Cost evidence must separate existing state/event work from added transaction,
receipt, outbox, relay and notification work. Include actual SQL/index/trigger
amplification, deletes, alarms, internal requests and active time, and show
that a long idle/offline interval does not create a constant polling cost.
Local operation counts are evidence about implementation work, not a measured
Cloudflare invoice. Step 11 sets measured regression ceilings before release.

## 13. Acceptance evidence and implementation boundary

Steps 2–12 must provide automated evidence for:

1. atomic rollback and valid no-op/clamped commits with consistent watermarks;
2. concurrent duplicates, changed inputs, lost commit/append/finalization
   responses, cooldown recovery and safe source-age/receipt expiry;
3. both local and shareable owners, simultaneous platform writers, namespace
   sealing, default changes, revocation, fallback and relinking;
4. offline admission, bounded pressure, ordering, reconnect wakeups, retry/lease
   recovery and restart immediately after the first commit;
5. retention/lifecycle gaps before and after append, uncertainty reconciliation,
   protected reset and no false clean drain;
6. browser setup races, snapshots ahead/behind events, historical suppression,
   live zero-applied impacts, duplicate delivery and cleared local storage;
7. unchanged state-only/event-only behavior, grants, mode guards and API import
   boundaries; and
8. bounded memory/storage/SQL work, long offline behavior, switches and safe
   drain/rollback, with the full suite and authoritative CI checks passing.

This document completes the design-contract work of roadmap step 1. It does not
implement helpers, loosen runtime guards, change health ownership, migrate
streams, modify production switches or deploy the Worker. Routine manual
operator tests are not a milestone gate; use simulated time, fault injection,
storage integration tests and browser CI for the required evidence.

## References

- [Implementation roadmap](state-event-roadmap.md)
- [Existing durable event contract](durable-event-contract.md)
- [Feature state ownership](feature-state.md)
- [State-query notifications](state-query-notifications.md)
- [Shareable state lifecycle](shareable-state-lifecycle.md)
- [Shareable state revocation](shareable-state-revocation.md)
- [Framework API stability](framework-api.md)
