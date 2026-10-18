# Atomic state changes with durable events: development roadmap

Status: steps 1–6 are complete; implementation steps 7–12 are pending.
Created: 2026-10-17.
Work branch: `codex-state-ironing` in `BCIrealm087/elmybot`.
Baseline reviewed: `df7e28c58670a7c110a8dc7b01aeb2b6b4e046ca`.

## Goal and agreed direction

Allow one command invocation to change authoritative bot-owned state and record
its corresponding durable feature event without leaving an untracked partial
write. The first product proof is `fun.health`: persist current health in the
bot, expose it through readable state, and deliver individual damage/heal events
for widget animation.

The selected approach is a transactional outbox at the state owner. One local
SQLite transaction commits the state mutation, its operation receipt, and the
pending event. Delivery to the existing event-stream object follows afterward.
Successful command acceptance means **state saved and event durably queued**;
it does not mean that a stream append or browser animation has already finished.

This roadmap authorizes no deployment and does not make a proposed API available.
It records the implementation sequence agreed in the development conversation.

## Fixed boundaries

- Start with command actions, one state owner, one declared state namespace or
  local feature partition, and one associated event stream per combined
  operation. State and event scope must refer to the same logical owner. Local
  and shareable writes cannot be combined into one atomic operation.
- Provide an explicit combined operation. Independently calling an existing
  state mutation and `stream.publish()` does not acquire atomicity. Keep that
  arbitrary combination rejected.
- Permit a combined operation while the widget is offline, within bounded
  storage and retention. Existing event-only publication keeps its current
  connected-consumer requirement and success meaning.
- Atomically reject a new combined operation before mutation when its source
  outbox or receipt capacity is unavailable. Destination stream capacity may
  delay an already accepted intent; it cannot roll back committed state.
- Retain bounded at-least-once event delivery, browser deduplication, and
  coalescing current-state queries. Do not claim exactly-once browser effects,
  unlimited offline replay, or simultaneous visibility across both transports.
- A retry of the same source invocation must recover the original mutation
  result and event intent. It must not mutate state again, regenerate a different
  event from newer state, or move an uncertain commit into another realm.
- Never coalesce distinct accepted feature events. The existing state-query
  notification outbox remains a separate, coalescing facility.
- Preserve hibernation. Delivery and cleanup must have bounded work; no periodic
  consumer polling, always-running relay, or global scan of inactive owners.
- Keep existing state-only features, event-only features, grants, stream
  versions, framework import boundaries, and platform authorization compatible.

## Current foundations and gaps

| Foundation | Reuse and remaining work |
| --- | --- |
| `GroupConfig` and `ShareableStateRealm` own state | Add receipts and event intent inside the actual mutation owner's transaction. |
| State-query revisions and notification outboxes | Preserve atomic invalidation and existing watcher behavior; do not reuse coalesced notifications as event history. |
| Event source ledger and stream append receipts | Extend operation recovery and routing carefully; their current event-publication deduplication alone does not protect a state mutation. |
| Durable event stream, grants, hibernating sockets and acknowledgements | Add an explicit internal admission path for deferred combined events; retain the existing event-only path. |
| Binding revisions, namespace seals, revocation and successor cloning | Include pending operations and outboxes in the lifecycle design without cloning historical event obligations into successor realms. |
| Health commands and widget | Replace widget-owned health with a compatible, explicitly versioned state-plus-event proof. |

## Recommended implementation sequence

### 1. Define the combined-operation contract

Write `docs/state-event-contract.md` as the normative additive contract before
relaxing any runtime guard. Specify:

- supported scopes, mutation forms, event declaration, command acknowledgement,
  authorization, cooldown and output rules;
- atomic state/receipt/intent acceptance and the distinction between accepted,
  appended, acknowledged, expired, and terminally blocked work;
- deterministic event construction from the committed operation's input and
  before/after result, including clamped/no-op mutations;
- whole-operation identity, receipt lifetime, retry/conflict behavior, owner
  pinning, and recovery across binding changes;
- per-owner queue count/bytes, payload size, admission rate, receipt capacity,
  retry limits, and batch/concurrency limits;
- an end-to-end event deadline measured from the original state commit, rather
  than starting a fresh retention window at each relay attempt;
- explicit gap/resynchronization behavior after expiry, revocation or movement,
  and which pending work may still drain to its original authorized consumer;
- the operational switch and rollback/drain policy.

Use existing event limits as reference points: 4 KiB payloads, 30-minute event
retention, two-hour publication receipts, and bounded source pending storage.
Finalize the new mode's numeric limits explicitly; source and destination
buffers both count toward the storage model. Retry identity must remain valid
for the entire supported platform retry and outbox-recovery window.

**Completion evidence:** a complete behavior/outcome table, worked health
examples, and documented lifecycle and resource bounds. This step is contract
work, not a claim that implementation is complete.

Completed 2026-10-17: [`state-event-contract.md`](state-event-contract.md)
defines the atomic boundary, explicit combined mode, pinned retry recovery,
30-minute end-to-end retention, finite owner budgets, lifecycle gaps, reset,
correlation, and drain controls. Public API spellings and runtime work remain
in steps 2–12.

### 2. Add the explicit authoring surface and validation

Design an additive API through the stable framework entry points and private
workspace facade. The caller supplies one supported mutation and its associated
event description as one operation. The framework must be able to validate both
before committing; do not accept arbitrary asynchronous feature code inside a
storage transaction.

Reject incompatible scopes, multiple owners, undeclared streams/namespaces,
unsupported mutations, arbitrary extra writes, and routed effects in this mode.
Read-only configuration may remain available. Retain the old blanket guard for
ordinary independent state and event calls; replace it only for the declared
combined capability. Specify one combined commit as the action's final
externally observable operation.

Extend the contributor test runtime alongside the declarations. Until storage
and delivery are ready, fail closed rather than simulate production support.

**Completion evidence:** declaration, compatibility and misuse tests, plus a
feature-level API example without exposing SQL or Durable Object bindings.

Completed 2026-10-17: `defineStateEventOperation`, explicit stream publication
source/mode, action allowlists, scoped context handles, registry/dependency
validation and pure `stateEvents.preview()` contributor support are implemented.
See [`state-event-authoring.md`](state-event-authoring.md) for the tested API,
projection vocabulary and reserved identity/correlation formats. Persistent
command execution, ordinary publication/append bypasses and consumer simulation
for combined streams remain blocked; no installed feature was migrated.

### 3. Establish operation identity and pinned-owner recovery

Define a command-source operation identity and persist routing/recovery intent
before any mutation can become ambiguous. The authoritative state owner stores
the committed receipt and original result. The origin-side record can locate
that owner on retry but must not pretend to be a cross-object transaction.

Handle a lost response before and after commit, conflicting reuse of an
identity, concurrent duplicate invocations, and receipt expiry. Check an existing
receipt before recomputing a state-dependent event. Integrate platform retry
lifetimes and cooldown behavior so recovery neither re-applies the mutation nor
gets permanently blocked by its first attempt's cooldown.

An uncertain old-owner result must be resolved before repinning. A proven
uncommitted rejection may follow the contract's bounded re-resolution rules.

**Completion evidence:** protocol tests covering duplicate input, changed input,
response loss and default movement, with exactly one authoritative mutation.

Completed 2026-10-17: deterministic operation/source identity, immutable platform
source timing, lazy bounded origin/owner records, transactional cooldown
preparation, original receipt recovery and durable fencing/CAS repinning are
implemented. Real SQLite protocol tests cover concurrent duplicates, changed
input, lost responses, movement, expiry and resource rejection. See
[`state-event-recovery.md`](state-event-recovery.md). Combined production commands
remain blocked; the real state/revision/outbox adapters are steps 4–5.

### 4. Implement the atomic commit for group-local state

Add lazy, bounded receipt and event-outbox storage to `GroupConfig`. Validate
the mutation, resulting payload and all admission limits before commit. Commit
state, its existing revision/notification changes, the operation receipt, and
the pending event in one synchronous storage transaction.

Ensure crash-safe recovery scheduling: interruption immediately after commit
must leave discoverable work with a durable wakeup, even if the object receives
no further command. Coordinate with existing notification alarms rather than
overwriting their scheduled work. Recover additive schemas idempotently.

**Completion evidence:** real storage tests for rollback, bounds, concurrency,
clamping/no-op policy, existing watcher behavior, and restart immediately after
commit. No state write may survive without its receipt and event intent.

Completed 2026-10-17: the private `GroupConfig` adapter commits supported state
mutations, readable revisions/notifications, operation watermarks, receipts and
bounded event intents atomically. An outer storage transaction includes durable
alarm scheduling; all local notification schedulers share the alarm decision.
Real storage tests cover rollback (including an alarm failure), bounds, no-ops,
concurrency, watcher delivery and immediate eviction/recovery. See
[`state-event-local-storage.md`](state-event-local-storage.md). Production
combined commands remain blocked; shared acceptance and deferred delivery follow.

### 5. Extend the commit to shareable state and lifecycle transitions

Implement the same storage guarantee in `ShareableStateRealm`, using one resolved
namespace and its associated stream. Revalidate authority at the mutation
boundary; an earlier successful resolution is not permission to write after a
seal or freeze.

Serialize acceptance against namespace sealing, default movement, revocation,
fallback selection and successor materialization. Pin each committed intent to
its original owner/route. Clone authoritative feature state using existing
rules, but do not clone outbox obligations or receipts into successor realms in
a way that replays old operations or sends old events to a new audience.

**Completion evidence:** standalone isolation, symmetric/asymmetric defaults,
concurrent Discord/Twitch writes to one realm, link collision handling, sealing,
revocation, fallback and relinking tests, including uncertain-commit recovery.

Completed 2026-10-17: the private shared adapter atomically commits one namespace,
its revision/notifications, original receipt and bounded event intent. Registry
serialization and durable uncertain-call barriers protect binding authority;
owner-local checks enforce seals/freezes inside the mutation transaction.
Successor cloning excludes receipts, event payloads and operation watermarks.
Real storage tests cover standalone/shared and directional defaults, concurrent
platform calls, collisions, revocation/fallback/relinking, delayed RPCs, restart
recovery and bounded rejection. See
[`state-event-shareable-storage.md`](state-event-shareable-storage.md).
Production combined commands remain blocked pending delivery and integration.

### 6. Add deferred event admission and explicit gap handling

Extend the internal stream append protocol for framework-validated combined
outbox records. This path can durably append without a connected socket while
still enforcing grants/lifecycle authority as specified, stream bounds,
deduplication, source ordering and the original event deadline.

Do not expose a public bypass of the event-only connected-consumer rule. Verify
the original state owner and pinned binding; never retarget an accepted intent
merely to make delivery succeed. Carry safe operation/revision correlation in a
versioned form without exposing physical owner identities or credentials.

Define idempotent gap signaling for an accepted intent that expires before
append as well as an event that expires after append. Resolve an ambiguous
append through its receipt before deciding the outcome. Preserve gaps without
inventing a contiguous stream sequence for an event never appended.

**Completion evidence:** offline append, full stream, expired intent, duplicate
append, lost append response, lifecycle movement and both gap paths. Existing
event-only acceptance and socket tests must remain valid.

Completed 2026-10-18: private owner-verified deferred admission preserves stream
bounds, ordering and original deadlines without requiring a connected consumer.
Shared appends use durable registry uncertainty/fencing; retries recover the
original destination outcome. Both expiry paths retain explicit operation gap
coverage, producer checks prevent false readiness/drain, and the protected reset
workflow coordinates an idempotent source/destination checkpoint. See
[`state-event-delivery.md`](state-event-delivery.md). Automatic relay and command
execution remain deferred; production combined commands still fail closed.

### 7. Implement bounded relay, reconnect wakeup and cleanup

Attempt delivery promptly after commit, then recover through durable owner
alarms and idempotent destination appends. Drain in state-commit order within
the declared owner/stream ordering domain; do not promise global ordering.
Complete source receipts and prune payloads only after the destination outcome
is known.

Use bounded batches, attempt leases, capped exponential backoff and request
timeouts. Distinguish transient service failures from known consumer absence,
capacity pressure, binding movement and terminal expiry. Avoid keeping objects
awake while waiting for backoff.

Connect consumer registration/reconnection and useful capacity changes to
bounded wakeups of registered pending producers. Store that interest durably,
deduplicate wakeups, and bound producer registration/fanout; do not discover
pending work through polling or global enumeration. Expiry cleanup may use a
deadline alarm without repeatedly probing an offline consumer. Share the
owner's single alarm with existing maintenance correctly.

**Completion evidence:** prompt recovery after reconnect, fair bounded draining,
restart recovery, no lost wakeups, no unnecessary alarm after draining, and a
long-offline simulation with no periodic consumer probes.

### 8. Integrate readable state and browser event correlation

Expose committed state through normal readable-state declarations and preserve
the race-free snapshot/watch behavior. Define how a widget initializes a
snapshot while subscribing to events, including changes during setup and
snapshots that already include later events.

Keep current state authoritative. Events drive per-operation handling and
animations; a widget must not apply the same delta again to a snapshot that
already includes it. Operation identity and owner-scoped revision/order markers
must distinguish a clamped no-op event from a state revision change. Support
duplicate delivery, delayed events, reconnect and explicit gap recovery without
assuming state and events arrive in the same order.

Keep read credentials and event-consumer credentials separate. Document the
bounded limits of browser-side acknowledgement and local deduplication.

**Completion evidence:** automated browser cases for both arrival orders,
setup races, duplicate events, rapid updates, no-op impacts and resynchronization.

### 9. Migrate the health feature as the end-to-end proof

Give `fun.health` authoritative shareable health state with an initial value of
100 and bounds of 0–100. Preserve existing command authorization, syntax,
default damage/heal amount and cooldown unless the contract requires an
explicitly documented change. Use the combined operation for each accepted
damage/heal invocation and expose readable current health.

Update the widget to recover health from the bot and animate individual impact
events. Replace widget-owned health arithmetic as the authority. Treat the old
`fun.health:impacts:v1` payload and existing local-storage values as compatibility
inputs, not authoritative bot state. Select an explicit new stream/action
version where semantics change; never silently reinterpret old grants or
backlogged events. Initialize new state at its documented default; do not trust
or automatically upload browser-local health. Document the one-time transition
and maintain a defined drain/retirement path for the old stream.

**Completion evidence:** Discord and Twitch feature tests, shared/standalone
health behavior, offline command acceptance, bot-state recovery after cleared
browser storage, per-impact animation and version-transition browser tests.

### 10. Complete failure, compatibility and resource verification

Run a systematic failure matrix around each commit and acknowledgement
boundary: before state commit, after state commit, before append, after append,
after acknowledgement and during cleanup. Include crashes, timeouts, repeated
retries, payload/schema errors, queue exhaustion, operation conflicts and
expired receipts. Test binding changes at those boundaries.

Verify undeclared/cross-feature access rejection, unchanged operator-grant
authorization, retained-payload bounds, gap reporting and safe diagnostics.
Preserve event-only and state-only contracts and framework API/package boundary
checks. Use simulated time and fault injection for retention and long outages.

**Completion evidence:** the full automated suite plus a documented matrix
showing no double mutation, no untracked partial write, bounded storage/work,
and explicit terminal outcomes.

### 11. Measure cost and enforce bounded work

Measure the additional work over the existing state and event paths, separating
that outbox overhead from the cost of adding state to today's event-only widget.
Record SQL rows read/written, index/trigger work, deletes, alarm scheduling,
internal requests, delivery attempts and object-active time where measurable.
State which measurements are local proxies rather than actual billed usage.

Cover successful online commands, bursts, duplicates, destination errors,
backpressure, reconnect drain, expiry, many independent groups and a long offline
period with no new commands. Count existing state-query watcher work separately.
Use current official Cloudflare prices when producing worked scenarios and
account for shared allowances, metering and billing rounding.

Set and enforce quantitative operation budgets from the measured design. Reject
an implementation whose idle costs grow with frequent offline retries or whose
per-command work scans an accumulating history. Batch cleanup and cap retries;
retain hibernation and deadline-driven recovery.

**Completion evidence:** a reproducible cost/operation report and automated
bounded-work assertions. Report limitations without requiring a manual live
billing experiment as a routine gate.

### 12. Finish contributor guidance and prepare review

Update the state/event contracts, framework API reference, authoring guide,
health documentation, generated catalog and test tooling to describe the
implemented surface and its limits. Clearly distinguish original event-only
publication from the new combined mode and document error/success meanings,
offline capacity, retention gaps and retry guarantees.

Provide a safe enable/disable plan: disabling new combined acceptance must not
erase pending intents or strand already accepted work. Document drain,
expiry/recovery behavior, additive storage upgrades and health-version
transition. Keep existing migration tags append-only; add a new tag only if a
binding/class change actually requires one.

Run the full test suite, lint and contributor gates, both browser smoke tests,
syntax checks and the supported CI Wrangler dry run. Inspect the pushed CI run
and its logs. Summarize the implementation, automated evidence, cost findings
and remaining limits for review. Deployment remains with the human operator
unless specifically requested; routine manual testing is not a roadmap gate.

**Completion evidence:** current documentation, passing authoritative CI, a
reviewable change on `codex-state-ironing`, and no undocumented change to
existing feature behavior.

## Completion criteria

The milestone is complete when a damage/heal command can atomically persist
health and its event intent, safely recover the same result after retries,
deliver retained events after offline recovery, and let a fresh widget recover
current health without replaying every historical delta. Queue exhaustion must
reject before mutation, retention/lifecycle gaps must be explicit, and automated
measurements must demonstrate bounded cost without polling idle consumers.

## Deferred capabilities

- Transactions spanning local state, multiple realms or arbitrary owners.
- Atomic event publication plus Discord/Twitch routed effects.
- Arbitrary asynchronous transactions in feature code.
- Multiple event streams or unrestricted mutation batches in one operation.
- Exactly-once browser effects or simultaneous state/event transport visibility.
- Unlimited offline history, automatic event-log merging across realms, or
  delivery to a newly selected audience after a binding change.
- Replacing hibernating WebSockets, moving every stream into the state owner,
  or introducing Cloudflare Queues without a separate need and review.

## References

- [Durable event contract](durable-event-contract.md)
- [Durable event implementation roadmap](durable-event-transport-roadmap.md)
- [Feature state ownership](feature-state.md)
- [State-query notification outbox](state-query-notifications.md)
- [Shareable state lifecycle](shareable-state-lifecycle.md)
- [Shareable state realms](shareable-state-realms.md)
- [Framework API v1](framework-api.md)
- [State/event authoring API and preview example](state-event-authoring.md)

## Progress

- 2026-10-17: Roadmap created from the agreed transactional-outbox direction,
  bounded offline acceptance and hibernation/cost requirements. No implementation
  step had started at roadmap creation.
- 2026-10-17: Step 1 completed in `state-event-contract.md`. The design contract
  fixes behavior and resource ceilings; no runtime API, stream migration or
  deployment was performed. Steps 2–12 remain pending.
- 2026-10-17: Step 2 completed: additive authoring/validation and pure previews,
  with fail-closed production execution and compatibility/misuse coverage.
  Persistent operation identity and pinned-owner recovery are next in step 3.
