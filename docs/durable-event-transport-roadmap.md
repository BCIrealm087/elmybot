# Durable feature-event delivery: development roadmap

Status: implementation roadmap; steps 1–4 are complete and steps 5–10 are pending.
Created: 2026-09-23.
Work branch: `codex-querying-experiment` in `BCIrealm087/elmybot`.
Baseline reviewed: `68b4677bf2f06dd738155d8d6fad7500eff013a9`.

This roadmap adds a second application-level delivery mode for feature authors.
It does not replace or reinterpret the existing composable state-query system.
Both modes may use hibernating WebSockets as their network transport, but their
product semantics remain deliberately different:

- readable state converges on a complete current result and may coalesce
  intermediate mutations; and
- durable feature events preserve every accepted event within explicit
  retention and capacity bounds and deliver them at least once.

The existing commands and readable exports continue to use current-state query
semantics. The first feature migrated to durable event delivery is
`widget.data`, through the existing Discord `/widget_data` and Twitch
`!widgetdata` command names.

## Product goal and fixed boundaries

A feature author should be able to answer one product question and select the
matching framework surface:

| Product need | Authoring surface | Delivery meaning |
| --- | --- | --- |
| “What is true now?” | `readableState` plus ordinary state services | Complete current replacement; coalescing allowed |
| “Handle every accepted trigger.” | A declared durable event stream plus its publish service | Ordered, bounded, at-least-once event delivery |

The choice is semantic rather than a low-level WebSocket option. A durable event
stream is not a readable-state export with a transport flag: it has no snapshot,
query composition, projection, collection lookup, result revision, or
state-query recovery cursor. Conversely, state-query history must not become a
hidden event log.

The framework will allow a feature to declare state, durable events, or both.
Using both must be explicit because an ordinary action cannot atomically commit
unrelated state and event owners. The version-1 `widget.data` migration selects
durable events as its authoritative consumer surface and does not dual-publish a
replacement value.

All other installed features keep their existing storage, readable exports,
grants, snapshots, and `state-query-socket/v1` behavior.

## Recommended first-release contract

The approved [durable-event version-1 contract](durable-event-contract.md)
freezes the public names and the semantics below. Later implementation steps
must preserve that contract unless an explicit compatibility decision amends it.

### Delivery guarantee

- A successful command acknowledgement means one event was committed durably.
- Events are delivered in ascending sequence within one stream.
- Delivery is at least once. Duplicate delivery is valid.
- The client acknowledges only after its handler completes successfully.
- A reconnect replays retained unacknowledged events before newer events.
- The server sends at most one unacknowledged event per consumer in version 1.
- A stable opaque event ID lets consumers deduplicate retries and duplicate
  transport delivery.
- A sequence orders one stream only. It is not a global clock or credential.
- Exactly-once browser-side effects are not promised. A crash after applying an
  effect but before acknowledgement can cause replay.

The framework derives the event identity from the feature, stream, origin group,
and stable platform source-event identity. A retry of one Discord interaction or
Twitch EventSub message therefore resolves to the existing logical event rather
than appending another event. A deduplication tombstone outlives ordinary payload
retention so a late source retry cannot recreate an expired event.

### Initial bounds

The proposed version-1 defaults are:

| Limit | Initial value |
| --- | ---: |
| Durable consumers per stream | 1 |
| Unacknowledged events in flight | 1 |
| Retained unacknowledged events | 1,000 |
| Retained event bytes | 1 MiB |
| Event retention | 30 minutes |
| Serialized payload per event | 4 KiB |
| Accepted ingress | 10 events/second per physical stream |
| Event receipt tombstone window | 2 hours |
| Widget-data payload | 1–400 UTF-16 code units after trimming |
| Widget-data command cooldown | 1 second per origin group |

Count, byte, and age bounds apply together. Reaching the count or byte capacity
rejects a new publication; it must never silently discard an already accepted
unacknowledged event to make room. Expiry may end the bounded guarantee, but the
next client interaction receives an explicit retention-gap status rather than
silently continuing at a later sequence.

Version 1 accepts a command only while its selected stream has an attached,
authorized consumer. If the widget is offline before publication, the command
returns a bounded “widget unavailable” failure and no event is accepted. If the
consumer disconnects after acceptance, the retained event remains replayable
until acknowledged or expired. This avoids indefinite offline queues and stale
OBS effects while making the success acknowledgement meaningful.

Retention and capacity are framework-owned safety limits in version 1, not
arbitrary per-feature settings. A later API may allow narrower declarations.

### Stream identity and integration changes

A durable stream has a stable public identity such as
`widget.data:updates:v1`, plus an internal physical identity derived from the
deployment environment, effective standalone or integration realm, feature,
and stream version.

An event-consumer grant selects exactly one platform group, one declared stream,
and the effective binding resolved at issuance. Discord and Twitch commands
whose directional defaults select the same integration publish to the same
physical stream.

Version 1 does not silently carry an event cursor across a link activation,
default switch, revocation successor, or other effective-realm handoff. The old
grant remains usable only to drain its retained old-stream backlog. It then
receives a terminal `stream_moved` status. The operator issues a new grant for
the group’s current stream. Commands resolving to the new stream are rejected
until that stream has an authorized consumer.

This explicit handoff avoids merging independently ordered logs or losing old
events behind a new binding. Seamless multi-realm draining can be considered
after the first release has operational evidence.

### Authorization and browser safety

Durable event grants are distinct from state-query read grants. A state-query
grant, query digest, result cursor, stream identity, event ID, or sequence does
not authorize event consumption.

The event transport follows the existing security posture:

- Discord issuance requires Administrator or Manage Server access for the exact
  guild; Twitch issuance requires broadcaster reauthentication.
- Credentials are random, environment-bound, expiring, revocable, and shown
  once.
- Browser and OBS clients exchange a grant for a secure same-origin HttpOnly
  session. Credentials never appear in URLs, subprotocols, event payloads, logs,
  or metrics.
- The public Worker validates the target and grant before routing a WebSocket;
  the stream object revalidates authorization before attaching the consumer.
- Revocation and expiry close an attached consumer through durable invalidation
  and exact deadlines rather than authorization polling.
- Payloads are untrusted strings. Maintained clients expose data to handlers but
  never evaluate it or insert it into HTML.

### Proposed contributor API shape

The preferred additive API is intentionally parallel to readable-state
declarations without pretending the meanings are interchangeable:

```js
defineFeature({
  // Existing current-state features keep using readableState.
  eventStreams: [
    defineDurableEventStream({
      id: "updates",
      version: 1,
      label: "Widget events",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable" },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: {
            data: { type: "string", minLength: 1, maxLength: 400 },
            origin: { type: "string", minLength: 6, maxLength: 7 }
          },
          required: ["data", "origin"]
        }
      }
    })
  ],
  actions: [
    defineAction({
      kind: "widget.data.emit.v2",
      uses: { services: ["eventStreams"] },
      async execute(ctx, { data }) {
        const stream = await ctx.eventStreams.current(
          otherPlatform(ctx.origin.group.platform),
          "updates"
        );
        await stream.publish({ data, origin: ctx.origin.group.platform });
        return { output: { message: "Widget event queued." }, effects: [] };
      }
    })
  ]
});
```

The framework supplies event IDs, sequence allocation, serialization,
idempotence, capacity enforcement, and safe errors. Feature code supplies only a
declared payload. Direct Durable Object, SQL, WebSocket, grant, or integration
registry access remains outside the stable feature boundary.

The exact top-level and service names are frozen in step 1. They must avoid
confusion with the existing `events` collection, which describes platform event
action adapters rather than consumer delivery streams.

## Runtime architecture direction

Use a new SQLite-backed `DurableEventStream` Durable Object class. One object is
addressed by the canonical physical stream identity. It owns:

- monotonically increasing per-stream sequence allocation;
- retained payload rows and byte accounting;
- event-ID receipt tombstones;
- one durable consumer acknowledgement position;
- bounded socket attachments and replay state;
- exact expiry, grant, cleanup, and binding-movement deadlines; and
- the hibernating consumer WebSocket.

Publishing and consumer delivery therefore meet in one serialized owner. A
bounded source-publication ledger in the origin group's existing `GroupConfig`
object first pins the event ID, canonical payload fingerprint, physical route,
and binding revision. That ledger closes the retry-versus-binding-handoff race
without merging logs or letting one platform source append to two realms.

The public Worker does not poll the stream object, and Cloudflare Queues are not required
for the first release. The object wakes for publication, registration,
acknowledgement, close/error, lifecycle invalidation, revocation, or a real
deadline. It creates no heartbeat timer; Cloudflare’s WebSocket auto-response
handles protocol ping/pong while the object hibernates.

SQLite operations append or resolve the idempotent event, advance a cumulative
acknowledgement, and prune acknowledged rows transactionally. Cleanup is lazy on
ordinary activity plus one alarm for the next actual deadline. There is no
per-event-per-second alarm or empty polling turn.

The physical event stream is separate from `ShareableStateRealm`. The feature
runtime uses the existing effective-realm resolver to choose its identity, then
addresses the event object. This avoids teaching shareable-state snapshots,
collision resolution, cloning, or current-state mutation versions about event
history.

## Widget-data migration result

The existing command names and writer behavior remain:

- Discord: `/widget_data data:<text>`;
- Twitch: `!widgetdata <text...>`;
- moderator capability;
- trimming and the 1–400-unit limit;
- one-second group cooldown;
- no payload reflection in acknowledgements, errors, logs, or metrics; and
- deterministic handling of source-event retries.

The consumer contract changes deliberately:

- `widget.data:latest:v1`, `published_data`, and the `latest` state key stop
  being the authoritative product surface;
- the new event stream is `widget.data:updates:v1` unless step 1 selects a better
  frozen name;
- the event envelope owns `eventId`, `sequence`, acceptance time, expiry, and
  acknowledgement cursor;
- the feature payload contains only `data` and `origin`;
- the action kind is versioned for the new meaning; and
- success wording changes to “Widget event queued.” only after durable append.

No event is synthesized from an old stored `latest` value. Existing experimental
state-query grants for `widget.data:latest:v1` are not converted into event
credentials. The migration documentation must explain their removal and provide
the new grant/setup flow. Old inert state may be left untouched unless a separate
review approves bounded cleanup; implementation must not perform broad deletion
as a side effect of the transport change.

## Milestones and step tracking

Keep these step numbers stable during implementation. A step is complete only
when its code, focused tests, documentation, and relevant CI checks satisfy its
exit criteria.

| Milestone | Steps | Result |
| --- | --- | --- |
| A: Contract and contributor boundary | 1–2 | Frozen guarantees and an additive author-facing API |
| B: Durable core and authorization | 3–5 | Idempotent bounded log, lifecycle identity, and event grants |
| C: Delivery and browser consumption | 6–7 | Hibernating replay protocol and maintained client/setup flow |
| D: Feature migration and proof | 8–9 | Widget data uses events and contributors can test both modes |
| E: Hardening and release readiness | 10 | Security, cost, failure, and complete CI evidence |

### 1. Freeze the durable-event version-1 contract

**Status:** complete (2026-09-23). **Depends on:** this roadmap.

Completed in [`durable-event-contract.md`](durable-event-contract.md). The
contract freezes the author API, physical ownership, source-publication ledger,
event/grant identities, bounded storage, operator reset, hibernating protocol,
widget migration, failures, and compatibility boundary.

Write a normative `durable-event-contract.md`. Freeze declaration, stream,
grant, route, protocol, event-envelope, close-code, status, acknowledgement, and
widget migration identities. Confirm the exact limits, retention clock,
capacity behavior, source-event identity input, dedupe-tombstone lifetime, and
command success/failure wording.

Specify exactly what happens for publication/acknowledgement races, duplicate
source delivery, disconnect before and after commit, handler rejection, grant
expiry/revocation, retention expiry, full streams, server restart, and
standalone/integration binding changes. Separate “durably accepted by Elmybot”
from “browser side effect completed.”

Record that version 1 has one consumer, requires an attached consumer before
acceptance, provides per-stream order and at-least-once delivery, and does not
provide exactly-once effects, unbounded offline retention, global ordering,
topics, multiple consumers, history browsing, arbitrary binary data, or an
alternate Queue backend.

**Exit criteria:** every public identity and state transition is fixed; examples
cover ordinary delivery, same-source retry, duplicate replay, reconnect, full
capacity, expired backlog, consumer absence, handler failure, revocation, and
binding movement; no unresolved choice changes the persistence or authorization
model.

**Completion evidence:** contract commit
[`24b9164`](https://github.com/BCIrealm087/elmybot/commit/24b9164ba4a8caccc893904aa17af79fee978303);
authoritative CI
[#225](https://github.com/BCIrealm087/elmybot/actions/runs/35934236757) passed
439 tests across 47 files, lint, Chromium WebSocket smoke, JavaScript syntax,
and the non-deploying Wrangler dry run.

### 2. Add the declarative event-stream feature API

**Status:** complete (2026-09-24). **Depends on:** step 1.

Completed as an additive framework surface. Features can declare validated,
value-free durable event streams with `defineDurableEventStream`, select the
`eventStreams` action service, and resolve `local(...)` or `current(...)` stream
handles. The registry indexes declarations, validates publisher compatibility,
and emits a deterministic public catalog. Contributor documentation and the new
`event-stream` scaffold put current replacement state and every-trigger delivery
side by side. The production publish backend was then completed in step 3.

Add the approved declaration helper and optional `defineFeature` collection,
registry indexing, public value-free catalog shape, and action service name.
Validate stream IDs/versions, platforms, scopes, access policy, payload schemas,
and duplicate identities. Validate that effective-shareable streams are
compatible with the feature and action origins that publish them.

Extend the stable framework package exports and compatibility documentation
additively. Do not alter existing readable-state declarations or installed
features. Registry validation must distinguish platform trigger `events` from
durable consumer event streams.

Add a minimal compile-time contributor example and generated documentation that
places current state and durable events side by side. Update the feature
scaffold/check scripts so authors receive a clear “current value or every
trigger?” decision path without internal imports.

**Exit criteria:** existing feature definitions normalize byte-for-byte as
before; valid stream declarations appear in a deterministic public catalog;
invalid identities, schemas, scopes, and undeclared service use fail with stable
errors; framework API tests demonstrate a feature selecting either mode or both.

**Completion evidence:** implementation commit
[`a99147c`](https://github.com/BCIrealm087/elmybot/commit/a99147c0a62942bdfef28029b398476fe9c2b388);
authoritative CI
[#227](https://github.com/BCIrealm087/elmybot/actions/runs/35975435893) passed
446 tests across 48 files, lint and generated-catalog checks, Chromium WebSocket
smoke, JavaScript syntax, and the non-deploying Wrangler dry run.

### 3. Implement the bounded durable event log and publish service

**Status:** complete (2026-09-24). **Depends on:** steps 1–2.

Completed with a new SQLite-backed `DurableEventStream` object and additive
Wrangler migration, a bounded source-publication ledger in each origin group's
`GroupConfig`, and the production `local(...).publish()` and
`current(...).publish()` runtime paths. Publication now validates and
canonically serializes declared payloads, derives opaque logical and physical
identities, pins the first resolved route, and returns success only after the
stream transaction commits. The implementation keeps consumer readiness behind
an internal boundary for the grant and WebSocket work in steps 5–6.

Add the SQLite-backed `DurableEventStream` class, Wrangler binding and additive
migration. Implement canonical object naming, schema initialization, sequence
allocation, bounded JSON validation, byte accounting, event-ID receipts,
cumulative acknowledgement storage, and transactional pruning. Add the bounded
source-publication ledger to `GroupConfig` so the first attempt pins its physical
route before append and supported source retries cannot cross a binding handoff.

Implement the feature runtime’s `current(...).publish(payload)` path. Resolve
only declarations owned by the invoking feature, validate the normalized
payload again at the trust boundary, derive the opaque event identity from the
invocation’s stable source event, and return a value-free receipt. The command
must not report success until the append is durable. Reject publication when no
authorized consumer is attached or capacity cannot preserve existing accepted
events.

Use exact safe error codes for unavailable consumer, full stream, transitioning
binding, invalid payload, storage failure, and retryable service failure. Error
text and operational metadata must never contain the payload.

**Exit criteria:** tests prove monotonic per-stream order, atomic append, same-
source idempotence across restart, different-source same-payload distinction,
count/byte/age bounds, rejection without a consumer, safe retry behavior, and no
unbounded tables or timers.

**Completion evidence:** implementation commit
[`3f50e9b`](https://github.com/BCIrealm087/elmybot/commit/3f50e9b3c98f72d88cd9e966fc7f2d9ca05b7b0d);
authoritative CI
[#229](https://github.com/BCIrealm087/elmybot/actions/runs/35983259347) passed
455 tests across 49 files, lint and generated-catalog checks, Chromium WebSocket
smoke, JavaScript syntax, and the non-deploying Wrangler dry run.

### 4. Resolve stream ownership and lifecycle transitions

**Status:** complete (2026-09-24). **Depends on:** step 3.

Reuse the existing effective standalone/integration resolution contract to map
a declared event stream to a physical object. Pin the resolved realm identity
and binding revision in trusted grant/stream metadata. Register bounded lifecycle
interest so selected-default activation, switching, revocation, fallback, and
standalone successor changes durably invalidate the old stream without polling.

Implement the version-1 drain-and-move rule. Old grants can replay only their
old retained backlog, receive `stream_moved`, and cannot consume events from the
new realm. New commands resolve the new realm and fail as unavailable until a
new authorized consumer is attached. Delayed old invalidations cannot close a
new binding.

Do not merge event logs during integration collision resolution, copy events to
successor realms, or interpret timestamps as a cross-realm order. Pending link
creation that is not the selected default must not redirect a stream.

**Exit criteria:** lifecycle tests cover standalone operation, shared Discord and
Twitch publication, asymmetric defaults, A-to-B-to-A changes, revocation with
and without fallback, interrupted transitions, delayed invalidations, old-backlog
draining, and explicit new-stream unavailability.

**Completion evidence:** implementation commit
[`34d54ab`](https://github.com/BCIrealm087/elmybot/commit/34d54ab3a9072d9c90fd1088615ac0a60191776a);
authoritative CI
[#231](https://github.com/BCIrealm087/elmybot/actions/runs/36005604001) passed
461 tests across 50 files, lint and generated-catalog checks, Chromium WebSocket
smoke, JavaScript syntax, and the non-deploying Wrangler dry run. The lifecycle
suite covers standalone activation, symmetric and asymmetric defaults,
independent physical sequences, A-to-B-to-A movement both before and after
notification delivery, stale invalidations, revocation fallback and standalone
successors, retained old backlog, and unavailable new streams.

### 5. Add event-specific grants, sessions, and discovery

**Status:** pending. **Depends on:** steps 2 and 4.

Add a separate event-consumer grant type and issuance flows for Discord managers
and Twitch broadcasters. A grant authorizes one exact target, declared stream,
version, pinned physical identity, and deployment environment. Reuse shared
credential primitives where safe, but do not let state-query tokens authorize
events or vice versa.

Add value-free event catalog/discovery and a same-origin secure session exchange.
Define independent cookie/path names so state-query and event sessions cannot be
confused. Store only hashed secrets and bounded routing metadata. Commit
revocation intent durably and deliver it to the stream object with retry; close
registration/revocation races with a tombstone or equivalent authority check.

Grant issuance and discovery must reveal no realm internals, integration IDs,
stored payloads, actor IDs, or consumer history. Stream/cursor identifiers are
never credentials.

**Exit criteria:** tests cover issuance authorization, target isolation,
environment isolation, expiry, revocation, session origin/CSRF rules, one-time
secret display, wrong-token-type rejection, catalog filtering, registration
races, and payload-free logs/errors.

### 6. Implement the hibernating durable-event WebSocket protocol

**Status:** pending. **Depends on:** steps 3–5.

Add an authenticated route such as `/event-stream/socket` and the frozen
`durable-event-socket/v1` protocol. Route only from validated grant metadata to
the pinned stream object. Use the Durable Object Hibernation API, serialized
bounded attachments, automatic ping/pong, and SQLite-backed correctness state.

Implement one registration, one event in flight, cumulative acknowledgements,
ordered replay, duplicate acknowledgement tolerance, future/wrong-cursor
rejection, bounded control frames, handler-failure non-acknowledgement, reconnect,
retention gaps, terminal movement/revocation/expiry, and idempotent close/error
cleanup. A socket send is not an acknowledgement.

No open socket may require a polling loop, interval, ordinary heartbeat timer,
or continuously resident object. Alarms exist only for the next actual retention,
grant, lifecycle, retry, or cleanup deadline.

**Exit criteria:** real Worker/Miniflare socket tests prove initial delivery,
multi-event order, disconnect/replay, duplicate delivery, asynchronous ack,
non-ack backpressure, eviction/reconstruction, auto-response heartbeat,
revocation, movement, expiry, oversize rejection, full-stream recovery, and no
polling calls.

### 7. Add the browser/OBS client and operator setup flow

**Status:** pending. **Depends on:** steps 5–6.

Provide a maintained same-origin browser client whose event handler may return a
Promise. Send the acknowledgement only after that Promise fulfills. A rejected
or interrupted handler remains unacknowledged and is replayed. Expose `eventId`,
sequence, accepted/expiry metadata, and the feature payload without evaluating
the payload.

Persist only non-secret recovery/deduplication hints where useful. Explain the
fundamental crash window between a browser side effect and its acknowledgement;
offer a bounded recent-event-ID helper but do not label it exactly once.

Extend the setup UI to exchange an event grant, show the selected target/stream
and retention contract, test a live handler, and copy a credential-free OBS URL
and minimal integration snippet. Keep the existing state-query client and setup
paths working unchanged.

**Exit criteria:** deterministic browser tests cover successful async handling,
handler rejection and replay, reconnect, duplicates, unsafe string rendering,
offline/unavailable status, gap/movement/revocation termination, and separation
between state-query and event sessions.

### 8. Migrate `widget.data` to durable event delivery

**Status:** pending. **Depends on:** steps 1–7.

Update the private widget-data package to declare the frozen event stream and
publish through the stable event service. Preserve both command names, parsing,
normalization, moderator access, cooldown, platform parity, and safe
acknowledgement/error behavior. Version the action kind for event semantics.

Remove the feature’s authoritative readable-state export and shareable current-
value write. Do not synthesize events from old `published_data/latest` values and
do not delete old realm data automatically. Update generated registration,
catalog, grants, consumer documentation, and tests so no text still promises a
current replacement value or suggests that an old state-query grant consumes
events.

Prove that linked Discord and Twitch commands reach the same selected stream,
distinct source commands remain distinct even with identical strings, a source
retry is one logical event, command success follows durable append, and a missing
consumer/full stream returns a bounded failure without leaking data.

**Exit criteria:** `widget.data` has one authoritative event surface; its old
query export is absent from the installed catalog; end-to-end Discord and Twitch
tests receive every accepted event in order and replay unacknowledged events;
all unrelated feature/query tests remain unchanged and passing.

### 9. Complete contributor tooling and dual-mode verification

**Status:** pending. **Depends on:** steps 2–8.

Extend the feature test runtime with event-stream connection, publish, receive,
acknowledge, disconnect, restart, expiry, and binding-handoff helpers. Keep the
existing state-query snapshot/watch helpers unchanged. Make transport selection
obvious in the feature quickstart, authoring guide, API reference, generated
catalog, and package scaffold.

Document decision examples: counters/configuration/current labels use readable
state; alerts/animations/commands that must each run use durable events; a
feature that deliberately needs both declares and tests both. Explain that
durable events are bounded at-least-once delivery, not a general job runner,
permanent audit log, or exactly-once effects system.

Add reusable contract tests so future event features inherit payload, identity,
authorization, capacity, replay, and leakage checks without reimplementing
transport internals.

**Exit criteria:** a hobby contributor can create one state feature and one event
feature using only stable framework imports and test-runtime APIs; validation
catches accidental undeclared service use and ambiguous dual publication;
generated docs remain deterministic.

### 10. Harden, measure, and prepare the milestone

**Status:** pending. **Depends on:** steps 1–9.

Run a focused security and resource audit across command input, grant routing,
stream naming, socket attachments, SQL rows, logs, diagnostics, browser rendering,
and lifecycle invalidations. Confirm payloads cannot enter errors/metrics, forged
acks cannot advance delivery, one grant cannot inspect another target, stale
bindings cannot receive new events, and capacity failure never discards retained
accepted work silently.

Exercise bounded load matrices for idle hibernatable sockets, burst publication,
slow/no-ack consumers, reconnect storms, expiry cleanup, revocation retry,
binding movement, and repeated object eviction. Record requests, alarms, rows,
stored bytes, duration assumptions, and per-event amplification. Fail tests if an
idle connected stream introduces polling or periodic alarms.

Run the complete Vitest suite, workspace checks, generated-doc check, ESLint,
JavaScript syntax checks, Chromium smoke, and non-deploying Wrangler dry run in
CI. Update the roadmap with implementation commits and authoritative run links.
Do not deploy from this step. Live test and production rollout remain operator-
owned unless explicitly requested; manual testing is not a standalone roadmap
gate.

**Exit criteria:** all automated checks pass from a clean install; resource and
failure behavior stay within the frozen bounds; migration and rollback notes are
complete; the milestone is ready for review without changing any unrelated
feature’s delivery semantics.

## Required acceptance matrix

Before the roadmap is complete, automated evidence must cover at least:

| Area | Required evidence |
| --- | --- |
| Author choice | State-only, event-only, and explicit-both feature definitions |
| Platform parity | Discord and Twitch normalize and publish the same payload contract |
| Identity | Retry is one event; distinct source events are distinct |
| Ordering | Ascending per-stream delivery across burst and restart |
| Acknowledgement | Ack after async success; rejection/crash path replays |
| Backpressure | One in flight; no-ack cannot create unbounded sends or memory |
| Retention | Count, bytes, age, gap, tombstone, and cleanup behavior |
| Availability | No attached consumer rejects publication before acceptance |
| Authorization | Target, stream, environment, expiry, revocation, session, and token-type isolation |
| Lifecycle | Standalone/shared, asymmetric defaults, switch, revocation, fallback, and old-stream drain |
| Hibernation | Eviction/reconstruction, auto heartbeat, no polling/timer dependency |
| Security | No payload reflection, URL credentials, overbroad metadata, or unsafe browser insertion |
| Compatibility | Existing state-query catalog, snapshots, sockets, grants, and features remain unchanged |

## Explicitly deferred work

Version 1 does not implement:

- exactly-once browser-side effects;
- more than one durable consumer per stream;
- named topics within a stream;
- automatic cursor merging across realm changes;
- seamless background migration of old stream grants;
- indefinite offline acceptance or retention;
- configurable feature-authored retention above framework bounds;
- arbitrary binary payloads;
- event search, history browsing, analytics, or audit-log APIs;
- global ordering across streams;
- public/member publication;
- Cloudflare Queues or another interchangeable backend;
- webhook delivery to arbitrary external origins; or
- conversion of state-query history/cursors into event offsets.

Those capabilities require separate product, authorization, quota, cost, and
compatibility decisions. They must not weaken the first release’s boundedness or
reinterpret either transport’s established semantics.
