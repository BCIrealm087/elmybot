# Authoring combined state and event operations

Status: declaration, validation and pure preview support implemented in roadmap
step 2. Step 3 adds the private [identity/recovery protocol](state-event-recovery.md).
Steps 4–5 add [private local atomic storage](state-event-local-storage.md) and
[shared storage with lifecycle authority](state-event-shareable-storage.md).
Step 6 adds [private deferred admission and gap/reset handling](state-event-delivery.md).
Step 7 adds the private [bounded relay and producer wakeups](state-event-relay.md).
Step 8 adds [readable snapshot correlation and browser coordination](state-event-browser.md).
Step 9 implements [command acceptance and health v2](health-state-event-migration.md)
behind explicit operational switches, disabled in checked-in Wrangler environments.

Import `defineStateEventOperation` and `StateEventOperationDefinitionError` from
`@elmybot/framework` or `src/framework/index.js`. These are additive Framework
API v1 exports; the workspace facade exposes the same objects.

## Availability and compatibility

Command execution for `stateEvents` is implemented. Fresh acceptance requires
`STATE_EVENT_OPERATIONS_ENABLED === "true"` and the event master switch. Both
checked-in Wrangler environments keep fresh combined acceptance disabled while
steps 10–12 verify failures, costs and rollout. Original accepted receipts remain
recoverable when acceptance is disabled. Unregistered/injected runtimes still
fail closed with `state_event_not_implemented`.

The contributor runtime keeps a separate synchronous calculation preview that
creates no acceptance or persistence. Opt into in-memory combined command
behavior with `createFeatureTestRuntime(feature, { stateEventsEnabled: true })`;
see the step-9 migration guide for that simulator's limits. Existing event-only
and state-only test/runtime behavior remains unchanged.

## Complete feature example

This example is a declaration/preview fixture, not a deployable health migration.
Its command requires explicit combined-acceptance and event-master enablement;
checked-in Wrangler environments leave fresh combined acceptance disabled.

```js
import {
  access, defineAction, defineDurableEventStream, defineFeature,
  defineStateEventOperation, frameworkApiVersion, schema,
  twitchActionCommand, twitchTextResult, twitchTokens
} from "@elmybot/framework";

const actionKind = "example.health.damage.v1";
const scope = { kind: "effective_shareable", namespace: "health" };
const input = schema.object({
  amount: schema.integer({ min: 1, max: 100, optional: true, default: 10 })
});

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "example.health",
  description: "Previews authoritative health and per-impact events.",
  shareableState: [{ id: "health", label: "Health", schemaVersion: 1 }],
  eventStreams: [defineDurableEventStream({
    id: "impacts", version: 2,
    label: "Health impacts", description: "Combined damage events.",
    platforms: ["twitch"], scope: { kind: "effective_shareable" },
    publication: { kind: "state_event", source: scope },
    access: { kind: "operator_grant" },
    payload: { schema: {
      type: "object",
      properties: {
        health: { type: "integer", minimum: 0, maximum: 100 },
        applied: { type: "integer", minimum: 0, maximum: 100 },
        changed: { type: "boolean" }
      },
      required: ["health", "applied", "changed"]
    } }
  })],
  stateEvents: [defineStateEventOperation({
    id: "damage", input, scope,
    stream: { id: "impacts", version: 2 },
    mutation: {
      kind: "bounded_counter", name: "health",
      subject: { literal: "current" },
      min: 0, max: 100, initial: 100,
      operation: "decrement", amount: { input: "amount" }
    },
    event: {
      health: { result: "after" },
      applied: { result: "appliedAmount" },
      changed: { result: "changed" }
    }
  })],
  actions: [defineAction({
    kind: actionKind, capability: access.moderators,
    supportedOrigins: ["twitch"], input,
    uses: { services: ["stateEvents"], stateEvents: ["damage"] },
    cooldown: { scope: "group", seconds: 1 },
    async execute(ctx, args) {
      const damage = await ctx.stateEvents.current("discord", "damage");
      await damage.commit(args);
      return { output: { message: "Health saved and impact queued." }, effects: [] };
    }
  })],
  commands: { twitch: [twitchActionCommand({
    name: "healthdemo", description: "Damage the demo health bar.",
    actionKind,
    parse: twitchTokens([{ arg: "amount", type: "integer", optional: true }]),
    render: twitchTextResult
  })] }
});
```

Preview the calculations with the test-only package:

```js
import { createFeatureTestRuntime } from "@elmybot/framework/testing";

const runtime = createFeatureTestRuntime(feature);
const result = runtime.stateEvents.preview({
  operation: "damage", input: { amount: 10 }, before: 3
});
// result.preview === true; result.accepted === false
// result.result: { before: 3, after: 0, changed: true, appliedAmount: 3 }
// result.payload: { health: 0, applied: 3, changed: true }
```

Omit `before` to calculate against an absent value (the counter's initial value,
or zero for a plain increment). `null` is a real value, not absence. Supply
`feature: "example.health"` when testing multiple features. `config: { ... }`
supplies selected operator-config values explicitly for a pure preview; it does
not read or update the runtime's configuration store. Repeated previews do not
retain the preceding calculated health.

## Declaration and dependency rules

`defineFeature({ stateEvents: [...] })` accepts at most 20 branded operations
with unique IDs. An operation declares exactly `id`, `input`, `scope`, `stream`,
`mutation`, and `event`. Its input is a normal framework object schema; operation
input is validated independently of the action's command input.

| Field | Supported shape |
| --- | --- |
| `scope` | `{ kind: "group_local" }` or `{ kind: "effective_shareable", namespace: "health" }`. |
| `stream` | Exact same-feature `{ id, version }`, with a positive version up to 1,000,000. |
| Stream publication | `{ kind: "state_event", source: scope }`; source kind must match the stream scope. |
| Group-local handle | `await ctx.stateEvents.local(operationId)`. |
| Shareable handle | `await ctx.stateEvents.current(otherPlatform, operationId)`. |
| Commit request | `await handle.commit(input)`; exactly one attempt across all handles in an invocation. |

The registry requires the namespace and stream to exist, verifies that the
operation scope exactly equals the stream's declared producer scope, and checks
projection field names against the stream's object payload schema. Literal
projections are schema-checked at composition; the actual computed payload is
checked by preview and, later, inside the state transaction. A combined stream
cannot use the independent `eventStreams` service. Its public catalog entry
includes `publication.implementation: "implemented"` for combined support;
this describes code availability, not operational enablement;
mutation descriptions, event literals, config values and operation input are
not public catalog data. Existing event-only catalog entries keep their shape.

Actions explicitly allowlist their own operation IDs in `uses.stateEvents` and
declare the `stateEvents` service. Only read-only `config` and `authorization`
services may accompany it. Every referenced operation's stream must support
every action origin. A group cooldown of at least one second and direct command
binding are required. Event triggers, scheduled actions, routes, routed effects,
ordinary state services, `links`, `random`, and independent publication are
rejected. An operation using configuration selectors requires `config` in its
action dependencies. Scope/target and allowlist checks run before resolving a
context handle; the target must be the other supported platform.

## Mutation and projection vocabulary

| Mutation | Required fields beyond `kind` |
| --- | --- |
| `set` | `key` selector, `value` selector. |
| `delete` | `key` selector. |
| `increment` | `key` selector, optional `amount` selector (defaults to literal 1). |
| `bounded_counter` | Literal `name`, `subject` selector, literal `operation`; optional `min`, `max`, `initial`, `subjectLabel`; `amount` selector for increment/decrement or `value` selector for set. |

Counter operations are `set`, `increment`, `decrement`, and `reset`. Bounds and
initial values are safe integers, defaulting to zero, the maximum safe integer,
and the minimum. Counter amounts are 1–1,000,000; plain increment accepts
-1,000,000 through 1,000,000. Keys use the existing lowercase identifier rules;
counter subjects contain 1–300 characters. Counter arithmetic saturates at the
bounds. Literal invalid targets/amounts are rejected during definition and
dynamic ones during request preparation. No callbacks, extra mutation fields,
multi-key writes or arbitrary expressions are accepted.

Every selector is a plain data object containing exactly one field:

| Selector | Meaning |
| --- | --- |
| `{ literal: value }` | Copied JSON value; may include bounded static objects/arrays. |
| `{ input: "amount" }` | An explicitly declared top-level operation-input field, after schema validation/defaults. |
| `{ config: "damage" }` | A selected feature-config key, frozen during preparation. |
| `{ result: "after" }` | Event-only selector: `before`, `after`, `changed`, or `appliedAmount`. |

`event` is an object with 1–20 projected field names; each field uses one
selector. Nested assembly, arithmetic expressions and mutation result selectors
inside the mutation descriptor are not part of this version. A projected field
may itself contain an object/array selected as a whole. JSON data must be
acyclic, finite, at most 20 levels deep, and contain no getters, callbacks,
sparse arrays, symbols or custom prototypes.

Prepared requests contain the operation ID, scope, exact stream version,
normalized input, resolved mutation and event projection with result selectors
still unresolved. Only selected config values enter the frozen request. Its
serialized JSON is at most 16 KiB. The preview's result summary is at most 4 KiB,
and the final event payload must pass the stream schema and 4 KiB payload cap.

`before`/`after` describe logical values; missing values and deletion use `null`
in the result. `changed` also distinguishes deletion of a present JSON `null`
from deleting an absent entry. `appliedAmount` is the absolute safe-integer
numeric difference, or `null` when not applicable/representable. A clamped
counter no-op reports zero and `changed: false`; future persistent acceptance
will still allocate its operation watermark and event.

## Reserved persistence and correlation identities

Operation identity, scope tokens and correlation are implemented in steps 3–8.
Pure previews generate none of these persistence identities:

- Operation format version 1 uses the exact compact JSON tuple
  `["elmybot.state-event-operation.v1", environment, featureId, actionKind,
  originGroupKey, sourceEventId]`, UTF-8 SHA-256, unpadded base64url, prefixed
  `seo1.`. Owner, namespace generation and binding revision are absent so an
  uncertain retry cannot acquire a new identity by moving its route.
- Scope token `ses1.` plus 16 cryptographically random bytes as unpadded
  base64url is generated/persisted once per producer partition incarnation.
  A successor receives a fresh token; tokens are not credentials or order keys.
- Public event correlation is named `stateEvent` with `version: 1`, `operationId`,
  `scopeToken`, `operationSequence`, and `stateRevision`. Snapshot result cells
  carry the same marker without `operationId`, representing a partition watermark
  rather than one operation. Step 8 implements the wire surfaces and compatibility
  checks; ordinary event-only frames are unchanged.
- Event IDs keep the existing `dev1` tuple and algorithm. No raw origin/source
  IDs are exposed through public correlation. Private receipt/route recovery is
  implemented in step 3; command execution is implemented behind the step-9 switches.

The concrete currently implemented errors are
`invalid_state_event_operation` for declaration/data problems,
`state_event_not_implemented` for an unregistered command runtime, and the
`feature_state_event_*` registry/context categories exercised by
`test/state-event-authoring.spec.js`. Existing schema errors retain their type;
existing production event-only endpoints return their safe service-unavailable
error for an attempted combined-stream bypass. Persistent acceptance/delivery
error mappings follow the contract outcomes when their later handlers exist.

See [the contract](state-event-contract.md) for the complete transaction,
retention and lifecycle requirements, and [the roadmap](state-event-roadmap.md)
for what remains to be implemented.
