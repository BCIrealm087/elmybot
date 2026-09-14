# Composable state queries and live subscriptions: development roadmap

Status: implementation in progress; steps 1–7 are complete.
Created: 2026-09-11.
Work branch: `codex-state-querying` in `BCIrealm087/elmybot`.
Baseline reviewed: `de7bdd87a446195ada5743518a62a4f064f103ab`.

This document records the product direction reached in the design conversation
and a recommended implementation sequence. It does not change the existing
Framework API v1 or shareable-state lifecycle contracts. API spellings,
transport details, and resource limits remain proposals until their relevant
contract or feasibility step is complete.

## Product goal and agreed direction

A bot user or web-source developer should be able to discover readable command
state, choose the values they want, and receive an initial result and automatic
updates in a browser widget. They should not need to understand internal storage,
integration IDs, or which platform last changed a shared value.

The baseline is user-composed queries over declared readable state. Users must
not be restricted to a fixed catalog of feature-authored queries. Optional
presets such as “current deaths” should expand into the same query machinery.

The agreed behavior is:

- A query explicitly selects a platform group: a Twitch channel or, with the
  current model, a Discord server/guild.
- A stable, serializable logical reference identifies readable state independently
  of its physical storage owner.
- Local state stays local. Shareable state follows the selected group's current
  effective standalone or integration realm.
- Linking, unlinking, default switching, and reconnection automatically resolve
  the current source. A subscription must not remain attached to an obsolete
  realm.
- Platform selection defines the observer's perspective, not the mutation's
  originating platform. A Discord mutation of the same effective shared counter
  must update a Twitch observer too.
- Users can select individual values, parameterized counters, several values
  together, collections, and values whose parameters depend on other readable
  state.
- One-time reads and live subscriptions use the same query meaning. SSE is the
  intended first browser delivery surface; the core model is transport-neutral.
- Query execution is read-only and does not invoke command side effects.
- Feature authors describe readable state and domain rules; the framework owns
  discovery, authorization, dependency tracking, lifecycle following, and delivery.

“Flexible” means composition within a documented, bounded query language over
authorized state. It does not mean arbitrary client JavaScript or SQL executing
inside the bot, or unrestricted access to every stored value.

## Existing foundation and gaps

| Area | Current foundation | Work still needed |
| --- | --- | --- |
| Group identity | Discord guilds and Twitch channels are explicit platform groups | Public logical references and friendly discovery |
| Local state | Feature-owned state lives in GroupConfig; commands have controlled access | Read declarations, public schemas, revisions, and change notifications |
| Shareable state | Namespaces resolve to standalone or directional-default integration realms | Long-lived observation that re-resolves instead of retaining one invocation scope |
| Lifecycle | Linking finalizes state; revocation freezes shared state and provides fallback or standalone successors | Reliable observer invalidation and source handoff |
| Mutations | Storage operations are atomic individually; shareable namespaces have mutation versions | Recoverable change delivery and observation of local state |
| Counters | Helpers normalize descriptors and hash internal subject keys | Discoverable subject metadata, collection semantics, and legacy handling |
| Framework | Stable v1 import boundaries, registry, schemas, and test runtime exist | Additive authoring helpers, query test support, and compatibility documentation |
| Browser access | Worker handles platform and protected onboarding/management routes | Authorized catalog, snapshot, and subscription endpoints; browser client and setup UI |

Relevant code and contracts:

- [Feature state and ownership](feature-state.md)
- [Shareable-state lifecycle](shareable-state-lifecycle.md)
- [Revocation and standalone continuation](shareable-state-revocation.md)
- [Framework API stability](framework-api.md)
- [Deaths feature](../packages/features/fun-deaths/src/feature.js)
- [Feature storage](../src/framework/feature-storage.js)
- [Shareable realm storage](../src/shareable-state/realm.js)
- [Feature service runtime](../src/framework/service-runtime.js)
- [Integration registry](../src/integrations/registry.js)

## Recommended first-release boundaries

These scope choices were finalized by step 1 in
[`state-query-contract.md`](state-query-contract.md).

### Readable state and query composition

Feature declarations describe readable scalar/object values and parameterized
collections, including public names, schemas, ownership policy, normalization,
default values, and access eligibility. Public IDs are stable logical names;
storage keys, SQL layouts, realm generations, archived snapshots, and credentials
remain internal.

Start with one explicitly selected platform group per query. Within that group,
allow bounded composition of authorized exports, including exports from multiple
features. Support:

1. Reading an exposed value.
2. Looking up a collection entry using typed literal parameters.
3. Selecting fields and assembling named results from several reads.
4. Enumerating a bounded collection of materialized entries.
5. Supplying a lookup parameter from another readable value, such as the
   remembered game.

Dynamic values may select typed subjects within declared exports. They must not
become arbitrary platform IDs, feature IDs, raw paths, or executable code.

Fixed-game counters can return their documented default without a persisted row.
“All counters” means a finite, declared collection of materialized entries, not
an infinite enumeration of every possible game with a zero count. Define
membership, insertion, deletion, reset, ordering, overflow, and completeness
explicitly. Never silently truncate a result advertised as complete.

Version the query format and public export schemas separately from storage
schemas. Canonicalization must use the feature's domain normalization rules,
including deaths game-name normalization, without changing existing identities.

### State semantics and lifecycle

A source binding and a value revision are different things. Maintain a binding
revision that changes on every relevant handoff, including A-to-B-to-A. A
namespace's existing mutation version alone cannot identify the current binding.

Keep command invocation scopes pinned as their existing contract requires.
Subscriptions instead re-resolve on lifecycle changes. They must not retain a
command scope for the lifetime of a browser connection.

| Lifecycle event | Expected observer behavior |
| --- | --- |
| No selected active integration | Read the group's current standalone state |
| Selected link activates | Switch to its materialized shared state and send a replacement snapshot |
| Additional link leaves the default unchanged | Continue using the existing source |
| Default switches | Follow the new integration's existing state without copying data |
| Pending link cancels or expires | Keep the existing source |
| Selected integration revokes with a fallback | Follow the fallback integration's existing state |
| Selected integration revokes without a fallback | Follow the new standalone successor copied from the final shared snapshot |
| State is transitioning or unavailable | Report an explicit temporary status; do not present an old value as fresh |
| Subscription reconnects | Reauthorize and resolve the current source before any replay or snapshot |

Opposite platform views agree on a shareable value only when both directional
defaults select the same integration. Routes are independent of this selection.

### Delivery contract

The first release is a current-state subscription, not an exhaustive history of
command invocations or mutations.

Send a full initial result, then replacement results when relevant values,
collection membership, dynamic dependencies, or source bindings change. A source
handoff is observable even if the value is unchanged. Coalescing intermediate
values is allowed; the latest committed result must eventually be delivered
while the client remains authorized and the service is available.

Do not claim instantaneous freshness or exactly-once delivery. Define measurable
healthy-delivery and recovery targets in step 2. Mark stale or reconnecting
clients explicitly. After a source handoff is applied, delayed events from the
old binding cannot overwrite the new result.

Snapshots and watcher attachment need a version-checked handshake so a mutation
cannot disappear between the initial read and subscription registration.
Reconnects can use a fresh snapshot; historical replay is optional and bounded.
An old cursor never authorizes reading an archived or unselected realm.

Atomicity remains per storage operation. Queries combining local and shared
state need dependency revision validation and bounded retries; they do not
create a transaction spanning owners or an atomic boundary around a multi-write
command.

### Authorization and cost

Readable declarations make state eligible for exposure, not automatically public.
An authenticated group operator grants read access to selected exports,
parameters, or composed queries under a defined policy. Grants authorize the
logical group view, including permitted future source changes, rather than a
permanent right to a physical shared realm.

Authorization applies to discovery, reads, initial attachment, dynamic dependency
changes, source handoffs, reconnects, and continued use after revocation.
Cross-group composition, private configuration, OAuth data, cooldowns, snapshots,
and raw storage enumeration are outside the initial public surface.

Use active interest to avoid unnecessary query evaluation and network fanout.
Revisions still advance with no subscribers. Watchers, notification records,
buffers, retry work, and collection results must have bounded lifetimes or sizes.
Delivery failure must not undo an already committed command mutation.

## Milestones and step tracking

Steps 1–7 are complete; steps 8–12 remain pending. Complete the relevant
acceptance criteria before marking another step done. Keep these numbers stable
for subsequent work requests; record implementation commits and checks in the
progress log.

| Milestone | Steps | Result |
| --- | --- | --- |
| A: Contract and feasibility | 1–2 | Precise semantics, resource budgets, and a tested transport approach |
| B: Composable snapshot queries | 3–5 | Discoverable state, user-defined reads, and scoped access |
| C: Live state following | 6–9 | Reliable invalidation, dynamic dependencies, lifecycle handoffs, and SSE |
| D: Usable product and stabilization | 10–12 | Deaths proof, contributor tools, browser setup, and verified release |

### 1. Specify the public state-query contract

**Status:** completed on 2026-09-11. **Depends on:** this roadmap.

The normative result is
[`state-query-contract.md`](state-query-contract.md). It closes the version-1
query, identity, result, revision, authorization, collection, lifecycle, and
snapshot/subscription semantics while leaving transport placement for step 2.

Write a contract for reference identity, readable export declarations, query
syntax and typing, normalization, errors, result status, ownership selection,
binding revisions, and snapshot/subscription behavior. Define the supported
operations above and their resource limits. Distinguish an absent value,
explicit JSON null, an unselected game, an empty collection, and a zero counter.

Specify authorization for literal, dynamic, and collection access, including
whether insufficient permission rejects an entire composed query. Recommended
default: reject the query rather than return an ambiguous partial result.

Decide finite collection semantics, freshness targets to measure, and required
protocol compatibility. Keep presets optional and require them to use ordinary
composition. Resolve open choices before implementing the affected API; do not
silently infer product semantics from storage.

**Exit criteria:** examples cover all five composition operations, both platforms,
standalone/shared transitions, and denied access. Every example has an expected
result or error. The document clearly separates existing behavior from new APIs.

### 2. Validate the Cloudflare transport and cost assumptions

**Status:** completed on 2026-09-12. **Depends on:** step 1 semantics.

The recorded result is
[`state-query-transport-decision.md`](state-query-transport-decision.md). It
keeps SSE as the public surface, selects a provisional Worker SSE adapter backed
by per-group hibernating WebSocket observer objects, establishes initial budgets,
and explicitly lists the evidence that still requires a deployed test Worker.
The bounded transport proof and cost model are reproducible repository artifacts;
no deployment was performed.

Build a bounded technical proof of snapshot-plus-SSE delivery, disconnection,
cleanup, reconnection, and idle behavior. Compare its expected Durable Object
duration and request costs with a hibernating WebSocket design using the same
query/result contract. Document the tested environment and distinguish local
simulation from evidence requiring a deployed test environment.

Record budgets for concurrent clients, active query/dependency counts, result
sizes, notification throughput, healthy update latency, stale detection, and
recovery. Test one active observer, several observers of the same shared source,
and idle connections. Evaluate placement so browser connections do not force a
single global registry to serve all value traffic.

SSE remains the target surface. If direct SSE ownership is too costly, document
a compatible topology or transport recommendation; changing that product
surface is an explicit design decision, not an incidental implementation change.

**Exit criteria:** a recorded architecture decision, reproducible measurements
or clearly identified measurement blockers, concrete initial limits, and a
connection/recovery design. Any deployment is a separate operational action,
not performed merely by adding this roadmap.

### 3. Add readable state declarations, identities, and subject metadata

**Status:** completed on 2026-09-12. **Depends on:** steps 1–2.

The implemented declaration, catalog, logical-reference, counter-subject
metadata, snapshot, lifecycle, and legacy-coverage boundary is recorded in
[`state-query-readable-state.md`](state-query-readable-state.md). Query
evaluation remains step 4; no public state route or subscription was added by
this step.

Add optional declarations and helpers through the supported framework entry
points. Validate public names, schemas, ownership policy, parameter types,
normalizers, defaults, and collection behavior at registration time. Build a
catalog model for discovery and canonical logical references.

Pilot declarations on deaths: group-local remembered game and effective
shareable per-game counters. Keep preset query definitions optional. Helpers
must reuse existing counter identity and domain normalization instead of asking
authors to duplicate key construction.

Plan and implement the metadata needed to identify collection subjects. Existing
counter keys are hashed; original game names cannot be recovered from hashes
alone. Preserve exact-game lookup against existing counts. Decide and document
how known subjects gain metadata and how unidentified historical entries are
reported or reconciled. Do not claim a complete labeled legacy collection while
silently omitting unknown entries.

Subject identity and labels must survive snapshotting, linking, cloning,
revocation, and relinking with their counter data. Any schema migration must be
idempotent, preserve counts, and respect deployed namespace limits.

**Exit criteria:** declarations are optional and compatible with existing
features; reference normalization has behavioral coverage; known subjects can
be enumerated; legacy coverage is explicit and tested; metadata follows state
ownership through the lifecycle.

### 4. Implement the read-only composable evaluator

**Status:** completed on 2026-09-12. **Depends on:** step 3.

The implemented parser, planner, scope-bound read runtime, resolver contract,
revision validation, dependency observation, and deaths proof are recorded in
[`state-query-evaluator.md`](state-query-evaluator.md). This remains an internal,
transport-neutral evaluator: read grants, discovery, and public snapshot HTTP
access begin in step 5.

Implement parsing, validation, planning, and evaluation for the bounded query
language. Support direct reads, parameterized lookups, named combinations and
field selection, collection reads, and dynamic parameter lookup.

Resolve each export under the selected group's ownership rules. Track exact
dependencies plus collection membership dependencies and source bindings.
Deduplicate repeated reads where safe. Validate revisions across async reads
and retry a bounded number of times; report temporary instability on exhaustion.

Use controlled read access, not command execution or arbitrary feature effects.
Internal lazy materialization already required by state resolution can remain,
but query execution must not change feature values, remembered choices, or
counter values.

**Exit criteria:** a caller composes useful queries without adding a named query
to a feature. Fixed and dynamic deaths reads match command data without command
side effects. Invalid, cyclic, excessive, and unsupported queries fail clearly.
Composed reads are not advertised as cross-owner transactions.

### 5. Add read grants, discovery, and snapshot HTTP access

**Status:** completed on 2026-09-12. **Depends on:** step 4.

The implemented grant model, platform issuance flows, authorized discovery,
snapshot route, same-origin browser session, revocation, and security boundary
are recorded in [`state-query-http.md`](state-query-http.md). SSE remains step 9;
the session established here provides its browser-compatible credential flow.

Implement authenticated grant issuance for each supported platform group,
scoped read credentials, expiry/revocation, and environment isolation. Reuse
existing platform authority checks where applicable; separately define who may
expose state. Do not use a bot OAuth token or operator-wide setup token as an
overlay credential.

Expose authorized catalog and one-time snapshot access using the query model.
Define grant scope for dynamic subjects and collection membership, including
new subjects. Query identity and cache identity must never bypass authorization.

Choose a browser-compatible credential flow. Native EventSource does not expose
arbitrary request-header configuration, so evaluate same-origin sessions or
narrow, revocable stream credentials. Define credential handling, origin/CORS
policy, cache behavior, and log redaction; CORS is not authorization.

**Exit criteria:** authorized users can discover, construct, and read queries;
unauthorized groups, features, subjects, and environments cannot be read or
enumerated. Revoked grants fail subsequent reads. Error responses do not reveal
hidden state.

### 6. Record committed changes and recoverable notifications

**Status:** completed on 2026-09-12. **Depends on:** steps 3–5.

The implemented leased source watchers, atomic revision outboxes, retry and
restart recovery, deduplicated observer inbox, no-op rules, and bounded cleanup
are recorded in
[`state-query-notifications.md`](state-query-notifications.md). Lifecycle
binding invalidation remains step 7, live dependency attachment remains step 8,
and browser SSE remains step 9.

Instrument local and shareable storage mutation boundaries, including collection
membership and subject metadata changes. Use existing namespace revisions where
appropriate and add missing local revisions.

Commit revision changes and durable notification intent together when active
watchers require delivery. Design watcher registration so a subscriber racing
a write cannot miss the write just because an interest check saw no watcher.

Implement retryable notification delivery, deduplication, bounded cleanup, and
watcher leases. Keep the state commit independent of subscriber availability.
Use a durable pending marker, outbox, or equivalent repair protocol so a crash
between commit and notification cannot leave a connected observer stale forever.

With no interest, skip unnecessary evaluation and fanout; the next subscriber
must still receive the current snapshot. Same-value operations need not emit
value changes, but membership or binding changes still matter.

**Exit criteria:** a restart after commit but before delivery recovers; duplicate
notifications are harmless; no-op semantics and collection membership changes
are correct; stale watcher records expire; command behavior remains compatible.

### 7. Make live bindings follow the effective-state lifecycle

**Status:** completed on 2026-09-13. **Depends on:** step 6.

The implemented ordered binding authority, recoverable lifecycle invalidation,
evaluation handoff checks, limits, and failure behavior are recorded in
[`state-query-bindings.md`](state-query-bindings.md). The internal observer
boundary is ready for step 8 to attach and replace complete query dependency
sets; public SSE remains step 9.

Add reliable invalidation for activation, default changes, transition entry and
completion, revocation, fallback repair, and standalone successor readiness.
Persist binding revisions or equivalent ordered authority so restarts and
A-to-B-to-A transitions cannot reuse an obsolete binding identity.

Implement a per-group observation boundary that re-resolves affected exports,
validates access, prepares replacement dependencies, and applies a source
handoff. Notifications from superseded bindings must be discarded. Do not
redirect an already-running command's pinned scope.

Account for interrupted transitions and lazy standalone creation; subscribers
receive explicit unavailable/transition status until the current source is
ready. Changes to unselected links must not spuriously retarget observations.

**Exit criteria:** every lifecycle row above passes with a connection already
open, including same-value handoffs and asymmetric directional defaults.
Delayed old-source notifications cannot overwrite the new binding.

### 8. Implement live query dependencies and collection observation

**Status:** completed on 2026-09-13. **Depends on:** steps 4, 6–7.

Maintain a dependency graph for active composed queries and re-evaluate only
affected work. Observe collection membership so new entries can enter a query
even when their keys were absent at subscription time.

For a remembered-game lookup, watch the remembered game and its selected
counter. Attach and version-check the new counter before completing a game
handoff, then remove obsolete interest. Handle absent selections, permission
changes, collection deletion/reset, and a source switch during re-evaluation.

Share underlying observation work where safe while preserving per-client
permissions. Coalesce work and bound query complexity, fanout, retries, and
pending results. Do not scan every stored group on each mutation.

**Exit criteria:** changing the remembered game changes the observed counter;
later changes to the old counter do not contaminate the result. Multi-value
queries and collection insertion/removal work without additional feature-authored
queries. Resource limits fail explicitly.

### 9. Expose SSE snapshots, updates, status, and recovery

**Status:** implementation published; CI validation pending. **Depends on:*
steps 2, 5, 7–8. Implementation commit: `5686037`.

The public API, recovery model, bounded durable history, cleanup behavior, and
the tested durable-polling fallback are recorded in
[`state-query-sse.md`](state-query-sse.md).

Implement the selected SSE architecture with validated query registration,
multiplexed query IDs where supported, UTF-8 event framing, connection cleanup,
heartbeats, and bounded buffering. Use a tested snapshot-and-attach handshake
rather than an uncoordinated read followed by registration.

Return complete results with a query identity, result status, opaque cursor,
and reason such as initial, value change, dependency change, or source change.
Define cursor scope across restarts and bindings. A reconnect always
reauthorizes and resolves current state; unknown or expired cursors resynchronize
without replaying obsolete-realm data.

Handle slow clients, duplicate delivery, disconnects, credential expiry and
revocation, and temporary source unavailability. Prevent expired credentials
from causing endless unauthorized reconnect loops in the browser client.

**Exit criteria:** actual streaming tests cover first attachment, disconnect,
reconnect after a link change, restart recovery, duplicate/out-of-order internal
notifications, slow consumers, and access revocation. No unbounded queues or
permanent stale subscriptions remain.

### 10. Complete the deaths proof and contributor workflow

**Status:** pending. **Depends on:** steps 3–9.

Finish deaths declarations, subject metadata compatibility, and optional presets
for fixed-game and current-game views. Keep normal command syntax, permissions,
remembered-game rules, counter boundaries, and lifecycle semantics intact.

Demonstrate independently composed subscriptions to one game's count, three
selected counts, remembered game only, the dynamically selected count, and the
bounded counter collection. Include standalone and shared group views. Make
legacy collection coverage visible according to step 3's decision.

Extend the feature test runtime, authoring documentation, and scaffold helpers
so a contributor can expose a new readable value or counter through supported
imports. Ordinary mutations should become observable without handwritten
notification or SSE logic. Share pure domain read/normalization logic where
useful rather than executing commands from queries.

**Exit criteria:** all five user-created query examples work end to end;
existing deaths behavior passes; a separate simple feature can expose state
using documented helpers without depending on persistence internals.

### 11. Deliver the browser client, discovery flow, and widget example

**Status:** pending. **Depends on:** steps 5, 9–10.

Provide a small client interface for catalog discovery, read, watch, and
unsubscribe using the same query descriptor. Handle reconnects, replacement
snapshots, statuses, and teardown internally. Allow a browser page to share
connection work across its subscriptions.

Build a bounded setup flow: choose an authorized platform group, browse readable
state, choose literal or state-derived parameters, combine fields, preview the
result, and copy an integration snippet or browser-source URL. Offer presets
without hiding custom selection.

Supply a working deaths widget with configurable presentation, an unselected
game state, and a stale/reconnecting indication. Treat state values as text/data,
not executable HTML. Expose logical concepts in the UI rather than realm IDs,
storage hashes, or implementation revisions.

**Exit criteria:** a user can configure a custom multi-value query without
editing bot code; a developer can embed and stop a subscription with documented
client calls; a browser-source smoke test follows count, game, and link changes.
Any hosting or deployment is handled explicitly as a separate rollout action.

### 12. Verify, document, and stabilize the release

**Status:** pending. **Depends on:** steps 1–11.

Run the acceptance matrix below, the full repository suite, and CI's lint,
syntax, and non-deploying Wrangler build. Add behavioral and failure-recovery
tests at the relevant steps rather than deferring all tests to this final step.

Measure the step 2 budgets under representative active and idle load. Confirm
cleanup after the last subscriber, bounded recovery after injected failures,
and observability for active connections, lag, retries, handoffs, and discarded
obsolete notifications without logging credentials or private values.

Update API stability policy, public exports, test-kit documentation, generated
catalogs where affected, README routes, operator guidance, and migration notes.
Record exact implementation commits and validation results. Distinguish local,
CI, and deployed-browser evidence; passing CI alone does not prove production
latency, hibernation, or cost.

Prepare a test-first rollout and rollback procedure. Existing bot commands must
continue to operate if public subscriptions are disabled. Do not change or
remove deployed migration tags, reset state to simplify tests, or claim a
deployment has occurred merely because implementation is complete.

**Exit criteria:** the agreed query surface is documented as implemented, all
required checks pass, budget results and legacy limitations are explicit, and
the release has an operational rollout path.

## Acceptance matrix

| Scenario | Required outcome | Primary steps |
| --- | --- | --- |
| User selects one exposed value | Immediate correctly typed snapshot and relevant updates | 4, 9 |
| User combines three counters | One composed result without authoring a preset | 4, 8, 10 |
| Query reads deaths as a privileged user | No remembered-game or count mutation | 4, 10 |
| Named counter has no row | Documented default, distinct from an unselected game | 3–4 |
| Remembered game changes | Dynamic counter dependency follows and old dependency is removed | 8 |
| New counter enters the collection | Collection observer updates within its declared bounds | 3, 8 |
| Counter resets or is deleted | Default and collection-membership rules agree | 3, 6, 8 |
| Historical counter has no subject metadata | Count preserved; collection coverage is explicit | 3, 10 |
| Shared counter is changed from the other platform | Both views update when they select the same integration | 7, 10 |
| Linked groups remember different games | Current-game results may differ correctly | 8, 10 |
| Link activates while subscribed | Fresh selected state replaces standalone binding | 7, 9 |
| Additional nondefault link is created | Current binding remains unchanged | 7 |
| Pending link is cancelled | Current state remains selected | 7 |
| Default changes without a value mutation | Observer still receives the source handoff | 7 |
| Default changes A-to-B-to-A | Delayed earlier-A events cannot overwrite the current binding | 7, 9 |
| Unlink leaves no fallback | Fresh independent successor follows final shared state | 7 |
| Unlink leaves a fallback | Observer selects the fallback's existing state | 7 |
| Transition or lazy clone is interrupted | Explicit temporary status followed by recoverable resolution | 7, 9 |
| Mutation races initial attachment or rebinding | No lost final value or obsolete-source overwrite | 6–9 |
| Process stops after commit before notification | Retry or repair delivers the current result | 6, 9 |
| Client reconnects after default change | Reauthorized current state; no archived-source replay | 9 |
| Grant expires or is revoked during a stream | Access stops and client reports the status | 5, 9, 11 |
| Dynamic lookup reaches a forbidden subject | No value or metadata leak | 5, 8 |
| Query is oversized or collection exceeds bounds | Explicit bounded rejection/status, never silent completeness | 4, 8 |
| Slow client or duplicate notification | Bounded memory and correct final displayed result | 8–9 |
| Last client disconnects | Watcher interest and delivery work are cleaned up | 6, 9 |
| Test credentials target production | Access is rejected; state remains isolated | 5 |
| Existing feature never opts into readable declarations | Commands and storage semantics remain compatible | 3, 12 |

## Deferred capabilities

The first release does not require arbitrary expressions or scripting, general
SQL/GraphQL, historical analytics, replay of every death for offline animations,
cross-group joins, querying archived realms, public state mutation, or new
Discord text-channel ownership.

Additional filters, sorting, aggregation, transports, and semantic event history
can be considered after the bounded composable core is proven. Deferral must
not remove the core ability to choose values, combine them, follow dynamic
parameters, and observe declared collections.

## Feasibility references

The preceding investigation checked the official documentation on 2026-09-11.
Step 2 must recheck applicable limits and costs before implementation decisions.

- [Cloudflare Workers HTTP duration and streaming limits](https://developers.cloudflare.com/workers/platform/limits/)
  support long-lived streaming while a client is connected, subject to runtime
  interruption and other resource limits.
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
  and [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
  explain why long-lived SSE and hibernating WebSocket designs have different
  idle behavior.
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  is the source for a measured cost model; no fixed price estimate is assumed here.
- [WHATWG server-sent events](https://html.spec.whatwg.org/dev/server-sent-events.html)
  specifies EventSource, UTF-8 framing, reconnection, and Last-Event-ID.
  Durable replay and query recovery remain application responsibilities.

## Progress log

- 2026-09-11: Roadmap created from the agreed composable-state-query direction.
  Existing branch and contracts reviewed; implementation steps 1–12 are pending.
- 2026-09-11: Step 1 completed. The public contract selects a bounded JSON query
  graph, user-composed reads over declared exports, whole-query authorization,
  explicit value-state semantics, effective-state following, and
  transport-neutral snapshot/subscription results. Steps 2–12 remain pending.
- 2026-09-12: Step 2 completed. A bounded Web Streams proof covers SSE snapshots,
  fanout, cancellation cleanup, replay/resynchronization, slow-reader coalescing,
  idle heartbeat framing, and admission limits. The architecture decision keeps
  public SSE while provisionally using a Worker adapter and group-local
  hibernating WebSocket observers to avoid pinning Durable Objects for idle
  browser streams. Cost assumptions, initial budgets, and deployment-only
  validation blockers are recorded. Implementation commit
  [`a3e17ca`](https://github.com/BCIrealm087/elmybot/commit/a3e17ca48c5f03d4849569ac43d85d5da749c6f4)
  passed all 346 tests, lint, syntax checks, and the Wrangler dry run in
  [CI run 34661139725](https://github.com/BCIrealm087/elmybot/actions/runs/34661139725).
  Steps 3–12 remain pending.
- 2026-09-12: Step 3 completed. Framework API v1 now supports optional validated
  readable-state declarations, a value-free public catalog, and canonical
  logical references. Deaths declares its group-local remembered game and its
  effective-shareable count lookup and materialized collection. Additive
  counter-subject metadata preserves the existing hash identity, reports
  unidentified legacy history explicitly, and follows snapshot cloning,
  linking, revocation successors, and relinking. Implementation commit
  [`baa8715`](https://github.com/BCIrealm087/elmybot/commit/baa8715c7bec2a2294408068eda572d9f12fb7a0)
  passed all 354 tests, lint, syntax checks, and the Wrangler dry run in
  [CI run 34677582714](https://github.com/BCIrealm087/elmybot/actions/runs/34677582714).
  Steps 4–12 remain pending.
- 2026-09-12: Step 4 completed. A bounded parser and read-only evaluator now
  support user-composed direct, literal, dynamic, projected, combined, and
  collection reads. Scope-bound sources follow current effective ownership per
  attempt, record exact dependencies, deduplicate equivalent reads, and validate
  source revisions with bounded retries without claiming cross-owner atomicity.
  Deaths resolvers prove local and shareable reads without command effects or
  feature-state mutations. Implementation commit
  [`d33b64e`](https://github.com/BCIrealm087/elmybot/commit/d33b64e6e2a43b54bdcfb5b94d90cdab000f1557)
  passed all 361 tests, lint, syntax checks, and the Wrangler dry run in
  [CI run 34683269492](https://github.com/BCIrealm087/elmybot/actions/runs/34683269492).
  Steps 5–12 remain pending.
- 2026-09-12: Step 5 completed. Scoped, expiring, revocable read grants now
  authorize one exact Discord guild or Twitch channel, selected exports,
  normalized literal and dynamic subjects, future collection membership, and
  reduced resource ceilings. Discord managers issue grants through an ephemeral
  command; Twitch broadcasters reauthenticate through identity-only OAuth.
  Authorized catalog and snapshot routes, whole-query enforcement, environment
  isolation, HMAC-authenticated routing fields, hashed stored secrets, and a
  same-origin secure browser session prevent query or cache identities from
  becoming credentials. Implementation commit
  [`4301c09`](https://github.com/BCIrealm087/elmybot/commit/4301c09e07ea2a43d2f78e1b02f26cd43a6ecfac)
  passed all 370 tests, lint, syntax checks, and the Wrangler dry run in
  [CI run 34687256942](https://github.com/BCIrealm087/elmybot/actions/runs/34687256942).
  Steps 6–12 remain pending.
- 2026-09-12: Step 6 completed. Group-local and effective-shareable state
  revisions now create coalesced outbox invalidations atomically with committed
  mutations when leased watchers exist. Registration closes the snapshot/write
  race, source alarms recover retryable delivery, observer inboxes deduplicate
  and reject older revisions, and bounded expiry removes stale interest and
  pending work. Equal writes avoid revision churn while subject metadata and
  collection membership remain observable; never-watched sources allocate no
  notification storage. Implementation commits
  [`9cf3cc9`](https://github.com/BCIrealm087/elmybot/commit/9cf3cc972399cdd61949e8ab98a968b74f77f7c8)
  and
  [`ffcad1e`](https://github.com/BCIrealm087/elmybot/commit/ffcad1e07c3bd4c786c8008d245ab1ab757b372d),
  with the documented tree at
  [`27d4d40`](https://github.com/BCIrealm087/elmybot/commit/27d4d40a9103ef11c18edd047f917fdb45f6cce7),
  passed all 376 tests, lint, syntax checks, and the Wrangler dry run in
  [CI run 34722915097](https://github.com/BCIrealm087/elmybot/actions/runs/34722915097).
  The roadmap-status tree passed the same checks in
  [CI run 34723048624](https://github.com/BCIrealm087/elmybot/actions/runs/34723048624).
  Steps 7–12 remain pending.
- 2026-09-13: Step 7 completed. The integration registry now persists ordered,
  directional effective-state binding revisions and recoverable lifecycle
  invalidations for activation, default changes, revocation transitions,
  fallback repair, and standalone successor readiness. Registration closes the
  snapshot/attachment race, observer high-water authority rejects delayed old
  bindings after acknowledgement, and evaluation re-resolves the current source
  and rechecks access before accepting a handoff. Tests cover same-value and
  A-to-B-to-A changes, asymmetric defaults, interrupted transitions, lazy
  successor recovery, restart delivery, unavailable status, and unselected-link
  stability. The verified implementation tree at
  [`ec00dd7`](https://github.com/BCIrealm087/elmybot/commit/ec00dd74ebc1a4c5135bc47e642b1300dfc306f6)
  passed all 384 tests, lint, syntax checks, and the Wrangler dry run in
  [CI run 34750303408](https://github.com/BCIrealm087/elmybot/actions/runs/34750303408).
  Steps 8–12 remain pending.
- 2026-09-13: Step 8 completed. Group-local observers now persist active
  composed queries, exact dependencies, and shared leased source edges; source
  and binding invalidations reevaluate only graph-related queries. Evaluation
  attaches and version-checks replacement dependencies before retiring old
  interest, including remembered-game selection changes, initially absent
  selections, collection insertion/removal, and same-value realm handoffs.
  Grant references are revalidated independently per query, sharing cannot let
  one client's lease or revocation affect another, and explicit budgets bound
  retained queries, distinct plans, dependency fanout, alarm batches, retries,
  and pending work. Implementation commit
  [`c22be90`](https://github.com/BCIrealm087/elmybot/commit/c22be9027af67d8ca5caa4cfc32b700d27e19e35)
  passed all 391 tests, lint, syntax checks, and the Wrangler dry run in
  [CI run 34769121986](https://github.com/BCIrealm087/elmybot/actions/runs/34769121986).
  Steps 9–12 remain pending.
