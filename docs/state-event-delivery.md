# Deferred combined-event admission and gap reconciliation

Roadmap step 6 adds private source/destination reconciliation to the atomic
storage adapters. Combined production commands still return
`state_event_not_implemented`. [Automatic relay, reconnect/capacity wakeups and
terminal source cleanup](state-event-relay.md) are implemented in step 7;
[browser snapshot/event correlation](state-event-browser.md) is implemented in step 8.
No feature, existing stream version or deployment is migrated here.

## Private delivery boundary

A delivery request identifies an operation and its original physical owner and
stream. It cannot supply an event payload, result or replacement route. The
stream reads the actual source outbox and owner receipt through binding-only
handlers on `GroupConfig` or `ShareableStateRealm`. The source verifies its
physical Durable Object identity and the immutable receipt/intent relationship.
The destination checks its own physical identity, deployment environment,
installed combined stream and namespace association, event identity, schema,
original commit/deadline and versioned correlation. These private modules are
not feature framework exports or public HTTP routes. Internal protocol headers
are markers on trusted binding calls, not public credentials.

The stream can then append without any grant or connected socket. It retains the
existing event count/bytes, ingress and receipt budgets. Ordinary `publish()` and
ordinary append still reject combined streams and retain event-only semantics.
The event master switch stops new appends; receipt recovery and gap/reset
bookkeeping do not extend deadlines or mutate feature state.

Only the earliest unresolved operation for that physical stream can append.
Other streams can skip partition operation sequences and have independent
ordering. An accepted intent always uses `expiresAt = committedAt + 30 minutes`;
a later append cannot start a new retention window. Destination event sequence
and opaque cursor remain separate from the source operation sequence.

Insertion, the destination receipt, correlation and producer association share
the destination transaction. A duplicate returns its original append result and
deadline. The source saves that verified result before releasing its payload,
then confirms its durable cache to the destination. Unconfirmed destination
outcomes have no expiry: they remain charged to finite receipt capacity until
source confirmation or a coordinated reset resolves them. Confirmed outcomes
retain the normal minimum receipt window. Source-side acceptance receipts still
follow the step-3 rules; step 7 implements terminal owner retirement/relay cleanup.

## Shared lifecycle authority

Shared appends pass through the integration registry's binding authority queue.
It revalidates the original directional binding and records an uncertain-call
locator before forwarding. Commit and append locators share the same registry
budget: 100 rows / 512 KiB, at most 8 KiB per locator.

Before an affected default/link/revocation transition proceeds, a destination
receipt or durable append-call fence must resolve every affected uncertain call.
The fence prevents a delayed RPC from executing after movement. A retry under
unchanged authority can use a new call token; at twenty fenced calls the stream
fences all further calls for that operation. Expiry or lifecycle gap reconciliation
remains possible. Registry recovery retains its twenty-record/five-second bound;
unknown outcomes cannot authorize movement. Already appended receipts recover
without requiring another producer read.

If the binding moved and the original destination proves no append, reconciliation
records a lifecycle gap on that original stream. It never appends to a newly
selected stream. Already appended work retains its original receipt and existing
old-grant drain rules. Frozen owners can perform this infrastructure bookkeeping
without reopening feature writes. Successor snapshots still exclude all receipts,
outboxes, producer state and gap obligations.

## Two gap paths and consumer assurance

| Situation | Durable evidence |
| --- | --- |
| Intent expires before append | Source retains `gap_pending` metadata before pruning its payload. Destination reconciliation recovers an append receipt or records retention coverage without allocating any destination sequence/cursor. |
| Event expires after append | Existing destination retention gap records the lost destination range; combined metadata also records source operation coverage. |
| Binding moved before an unappended event | Destination and source retain lifecycle coverage for the original stream; feature state remains committed. |
| Append response lost | Recover the original destination receipt, including after movement or source expiry; do not infer non-append from an empty event table. |
| Destination outcome not durably cached by source | Retain destination authority indefinitely within the finite receipt budget. |

Per-stream gap summaries retain a covering source-operation interval and reason
flags. A covering interval can include intervening operations; it is not a claim
that every operation in that interval was lost. Payload events are never
coalesced. Source and destination sequences retain their separate meanings.

Protected grant issuance and socket registration check the original producer.
An empty stream cannot announce readiness across an unresolved source expiry or
reset, and an unreachable producer fails closed. An empty moved stream reports
`stream_moved` only after a producer check proves no unresolved work. Existing
grant revocation/replacement and one-consumer/one-in-flight acknowledgement rules
continue to apply. Server event frames carry the reserved `stateEvent` v1
correlation object; [step 8](state-event-browser.md) implements consumer
interpretation and snapshot integration.

Once the source learns of a destination reset requirement, it blocks further
combined acceptance for that stream before mutation. This does not roll back an
already accepted operation that raced the block.

## Protected coordinated reset

The existing operator grant/reset workflow remains the entry point. It uses the
validated grant ID as the idempotent reset ID:

1. Persist a source fence and operation checkpoint, temporarily rejecting new
   combined acceptance for the stream.
2. Persist the destination reset fence, then durably mark source work through
   that checkpoint as explicitly discarded. Feature values and operation
   identity/sequence domains remain intact.
3. In the existing grant/reset transaction, discard the accepted destination
   backlog and gap coverage, record a bounded operator audit, and save the grant.
4. Release the source fence and then the destination fence. A lost response
   resumes the same reset rather than selecting a newer checkpoint.

A stale proof or delayed append at/below the persisted checkpoint cannot recreate
an event or gap after reset. Reset interruption leaves a durable fence; retrying
the same grant/reset completes it. Reading state does not perform a reset.
Ordinary grant replacement without `resetBacklog` cannot clear a gap.

## Bounds, scheduling and evidence

There is at most one producer association and gap summary per physical stream,
100 source stream controls per state owner, twenty fenced call tokens per
operation, and 100 reset audit rows per destination. Destination receipt accounting
includes both ordinary append receipts and combined outcome records under the
existing 100,000-row / 16 MiB cap. Lazy transactional counters avoid a growing
history scan per combined append; confirmed combined-record pruning handles at
most twenty rows per call. Existing event-only retention maintenance is unchanged.

The explicit private reconciliation handler adds bounded owner proof, append or
receipt recovery, durable source caching and destination confirmation. Shared
work also uses registry forwarding and its durable locator. Producer checks run
on grant/registration and useful lifecycle/acknowledgement events, not polling.
No periodic consumer probe, producer enumeration or always-running relay is added.
Owner alarms now run the [step-7 bounded relay](state-event-relay.md), including
lease recovery and terminal cleanup. Quantitative cost measurement remains step 11.

`test/state-event-delivery.spec.js` uses real Durable Object SQLite and binding
forwarding. It covers offline local/shared append, count/bytes/rate/receipt
pressure, ordering, duplicate/lost replies, receipt confirmation, both expiry
paths, consumer assurance, opaque wire correlation, reset interruption and stale
proofs, frozen-owner reconciliation, and delayed shared RPCs across real default
movement. Existing state-only, event-only and socket suites remain compatibility
gates.
