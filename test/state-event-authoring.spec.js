import { describe, expect, it, vi } from "vitest";
import * as workspace from "@elmybot/framework";
import {
  access, defineAction, defineDurableEventStream, defineEventAction, defineFeature,
  defineScheduledAction, defineStateEventOperation, discordActionCommand,
  frameworkApiVersion, schema, StateEventOperationDefinitionError,
  twitchActionCommand, twitchNoArgs
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import { createFeatureActionContext } from "../src/framework/action-context.js";
import { createFeatureServiceRuntime, FEATURE_RUNTIME_SERVICES } from "../src/framework/service-runtime.js";
import { createFeatureTestRuntime, discordTestGroup } from "../src/framework/testing.js";
import { createActionRegistry, executeAction } from "../src/actions/registry.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { createDurableEventStreamRuntime } from "../src/durable-events/publisher.js";
import { prepareStateEventOperation } from "../src/framework/state-event-operation.js";

const ACTION = "test.impacts.damage.v1";
const SCOPE = { kind: "effective_shareable", namespace: "health" };
const INPUT = schema.object({ amount: schema.integer({ min: 1, max: 100, optional: true, default: 10 }) });

function operationInput(overrides = {}) {
  return {
    id: "damage", input: INPUT, scope: { ...SCOPE },
    stream: { id: "impacts", version: 2 },
    mutation: {
      kind: "bounded_counter", name: "health", subject: { literal: "current" },
      min: 0, max: 100, initial: 100, operation: "decrement", amount: { input: "amount" }
    },
    event: {
      requested: { input: "amount" }, health: { result: "after" },
      applied: { result: "appliedAmount" }, changed: { result: "changed" }
    },
    ...overrides
  };
}

function stream(overrides = {}) {
  return defineDurableEventStream({
    id: "impacts", version: 2, label: "Health impacts", description: "Combined health impacts.",
    platforms: ["discord", "twitch"], scope: { kind: SCOPE.kind },
    publication: { kind: "state_event", source: SCOPE }, access: { kind: "operator_grant" },
    payload: { schema: {
      type: "object", properties: {
        requested: { type: "integer", minimum: 1, maximum: 100 },
        health: { type: "integer", minimum: 0, maximum: 100 },
        applied: { type: "integer", minimum: 0, maximum: 100 }, changed: { type: "boolean" }
      }, required: ["requested", "health", "applied", "changed"]
    } }, ...overrides
  });
}

function action(overrides = {}) {
  return defineAction({
    kind: ACTION, supportedOrigins: ["discord", "twitch"], input: INPUT,
    uses: { services: ["stateEvents"], stateEvents: ["damage"] },
    cooldown: { scope: "group", seconds: 1 },
    async execute(ctx, input) {
      const target = ctx.origin.group.platform === "discord" ? "twitch" : "discord";
      const impact = await ctx.stateEvents.current(target, "damage");
      await impact.commit(input);
      return { output: { message: "Health saved and impact queued." }, effects: [] };
    }, ...overrides
  });
}

function feature(overrides = {}) {
  return defineFeature({
    apiVersion: frameworkApiVersion, id: "test.impacts", description: "Tests combined operations.",
    shareableState: [{ id: "health", label: "Health", schemaVersion: 1 }],
    eventStreams: [stream()], stateEvents: [defineStateEventOperation(operationInput())],
    actions: [action()], commands: {
      discord: [discordActionCommand({ name: "impact", description: "Damage health.", availability: "guild", actionKind: ACTION })],
      twitch: [twitchActionCommand({ name: "impact", description: "Damage health.", actionKind: ACTION, parse: twitchNoArgs() })]
    }, ...overrides
  });
}

function registry(input = feature()) {
  return createFeatureRegistry([input], { availableServices: FEATURE_RUNTIME_SERVICES });
}

function invocation() {
  return createCommandInvocation({ kind: ACTION, args: {}, sourceEventId: "discord:interaction:123",
    origin: { group: discordTestGroup(), actor: { platform: "discord", id: "actor", claims: [] } }
  });
}

describe("state/event authoring declarations", () => {
  it("exports the branded additive helper through the workspace facade and freezes copied data", () => {
    expect(workspace.defineStateEventOperation).toBe(defineStateEventOperation);
    expect(workspace.StateEventOperationDefinitionError).toBe(StateEventOperationDefinitionError);
    const raw = operationInput();
    const definition = defineStateEventOperation(raw);
    raw.scope.namespace = "other";
    raw.mutation.amount.input = "missing";
    expect(definition.scope.namespace).toBe("health");
    expect(definition.mutation.amount.input).toBe("amount");
    expect(Object.isFrozen(definition.event.health)).toBe(true);
    expect(Object.isFrozen(definition.input)).toBe(true);
    const installed = registry();
    expect(installed.stateEvents["test.impacts:damage"].definition.id).toBe("damage");
    expect(installed.eventCatalog[0].publication).toMatchObject({
      kind: "state_event", source: SCOPE, implementation: "implemented"
    });
    expect(JSON.stringify(installed.eventCatalog)).not.toContain("current");
  });

  it("keeps omitted operations compatible and rejects unbranded/duplicate declarations", () => {
    expect(defineFeature({ apiVersion: 1, id: "test.empty", description: "Empty." }).stateEvents).toEqual([]);
    expect(() => feature({ stateEvents: [{}] })).toThrow(/defineStateEventOperation/);
    expect(() => feature({ stateEvents: [defineStateEventOperation(operationInput()), defineStateEventOperation(operationInput())] })).toThrow(/duplicates/);
    expect(() => feature({ stateEvents: Array(21).fill(defineStateEventOperation(operationInput())) })).toThrow(/at most 20/);
  });

  it("rejects callbacks, unsupported writes, undeclared selectors, owner IDs and malformed descriptions", () => {
    const cases = [
      { execute: () => {} }, { scope: { kind: "group_local", namespace: "health" } },
      { scope: { kind: "integration", owner: "chosen" } },
      { stream: { id: "someone.else:impacts", version: 2 } },
      { mutation: { kind: "batch", writes: [] } },
      { mutation: { ...operationInput().mutation, amount: () => 10 } },
      { mutation: { ...operationInput().mutation, amount: { result: "before" } } },
      { mutation: { ...operationInput().mutation, min: 101 } },
      { event: { health: { input: "unknown" } } },
      { event: { health: { input: "amount", literal: 10 } } },
      { event: { health: { result: "ownerId" } } },
      { event: { health: { literal: new Date() } } },
      { event: { health: { literal: { callback() {} } } } },
      { event: { health: { literal: "x".repeat(16_385) } } }
    ];
    for (const entry of cases) expect(() => defineStateEventOperation(operationInput(entry))).toThrow(StateEventOperationDefinitionError);
    const getter = vi.fn(() => "amount");
    expect(() => defineStateEventOperation(operationInput({ event: { health: { get input() { return getter(); } } } }))).toThrow(/data object/);
    expect(getter).not.toHaveBeenCalled();
    const cycle = {}; cycle.self = cycle;
    expect(() => defineStateEventOperation(operationInput({ event: { health: { literal: cycle } } }))).toThrow(/acyclic/);
  });

  it("binds a stream version to the exact declared owner and projected payload fields", () => {
    const cases = [
      [feature({ shareableState: [] }), "feature_state_event_namespace_undeclared"],
      [feature({ eventStreams: [] }), "feature_state_event_stream_incompatible"],
      [feature({ eventStreams: [stream({ publication: undefined })] }), "feature_state_event_stream_incompatible"],
      [feature({ stateEvents: [defineStateEventOperation(operationInput({ scope: { kind: "group_local" } }))] }), "feature_state_event_stream_incompatible"],
      [feature({ stateEvents: [defineStateEventOperation(operationInput({ event: { missing: { literal: 1 } } }))] }), "feature_state_event_projection_invalid"]
    ];
    for (const [input, code] of cases) expect(() => registry(input)).toThrow(expect.objectContaining({ code }));
    expect(() => stream({ publication: { kind: "event_only", source: SCOPE } })).toThrow();
    expect(() => stream({ publication: { kind: "state_event", source: { kind: "group_local" } } })).toThrow(/match the stream scope/);
  });

  it("requires explicit action operation lists, isolated dependencies, cooldown and supported origins", () => {
    for (const uses of [
      { services: ["stateEvents"] }, { stateEvents: ["damage"] },
      { services: ["stateEvents"], stateEvents: [] },
      { services: ["stateEvents"], stateEvents: ["damage", "damage"] }
    ]) expect(() => action({ uses })).toThrow(/uses.stateEvents/);
    for (const dependency of ["state", "shareableState", "integrationState", "eventStreams", "links", "random"]) {
      expect(() => registry(feature({ actions: [action({ uses: { services: ["stateEvents", dependency], stateEvents: ["damage"] } })] }))).toThrow();
    }
    const cases = [
      [feature({ actions: [action({ cooldown: null })] }), "feature_state_event_cooldown_required"],
      [feature({ actions: [action({ uses: { services: ["stateEvents"], stateEvents: ["foreign"] } })] }), "feature_state_event_operation_undeclared"],
      [feature({ eventStreams: [stream({ platforms: ["discord"] })] }), "feature_state_event_origin_unsupported"],
      [feature({ commands: {} }), "feature_state_event_command_required"],
      [feature({ events: [defineEventAction({ eventKind: "discord.test.event.v1", actionKind: ACTION, mapPayload: () => ({}) })] }), "feature_event_state_event_action_unsupported"],
      [feature({ schedules: [defineScheduledAction({ kind: "discord.test.scheduled.v1", sourcePlatform: "discord", actionKind: ACTION, timing: "timestamp", authorization: "grant-at-creation" })] }), "feature_schedule_state_event_action_unsupported"]
    ];
    for (const [input, code] of cases) expect(() => registry(input)).toThrow(expect.objectContaining({ code }));
    expect(() => registry(feature({ actions: [action({ uses: { services: ["eventStreams"] } })] }))).toThrow(expect.objectContaining({ code: "feature_action_event_stream_mode_invalid" }));
  });
});

describe("contributor state/event previews", () => {
  it("calculates requested/applied damage, clamping, defaults and no-ops without claiming acceptance", () => {
    const runtime = createFeatureTestRuntime(feature());
    const result = runtime.stateEvents.preview({ operation: "damage", input: {} });
    expect(result).toMatchObject({ preview: true, accepted: false, result: { before: 100, after: 90, changed: true, appliedAmount: 10 }, payload: { requested: 10, health: 90, applied: 10, changed: true } });
    expect(runtime.stateEvents.preview({ operation: "damage", input: { amount: 10 }, before: 3 }).payload.health).toBe(0);
    expect(runtime.stateEvents.preview({ operation: "damage", input: { amount: 10 }, before: 0 }).payload).toEqual({ requested: 10, health: 0, applied: 0, changed: false });
    expect(runtime.stateEvents.preview({ operation: "damage", input: {} }).payload.health).toBe(90);
    expect(Object.isFrozen(result.request.mutation)).toBe(true);
    expect(result).not.toHaveProperty("operationId");
    expect(result).not.toHaveProperty("sequence");
  });

  it("validates configuration dependencies and payloads and freezes only selected configuration", () => {
    const definition = defineStateEventOperation(operationInput({ mutation: { ...operationInput().mutation, amount: { config: "damage" } } }));
    const f = feature({ stateEvents: [definition] });
    expect(() => registry(f)).toThrow(expect.objectContaining({ code: "feature_state_event_config_undeclared" }));
    const runtime = createFeatureTestRuntime(feature({ stateEvents: [definition], actions: [action({ uses: { services: ["stateEvents", "config"], stateEvents: ["damage"] } })] }));
    const config = { damage: 4, unused: "ignore me" };
    const result = runtime.stateEvents.preview({ operation: "damage", input: {}, config });
    config.damage = 20;
    expect(result.payload.health).toBe(96);
    expect(JSON.stringify(result.request)).not.toContain("ignore me");
    expect(() => runtime.stateEvents.preview({ operation: "damage", input: {} })).toThrow(/missing/);
    expect(() => runtime.stateEvents.preview({ operation: "damage", input: {}, config: { damage: -1 } })).toThrow();
    expect(() => runtime.stateEvents.preview({ operation: "foreign", input: {} })).toThrow();
    expect(() => runtime.stateEvents.preview({ operation: "damage", input: { amount: 101 }, config })).toThrow();
    const bad = feature({ stateEvents: [defineStateEventOperation(operationInput({ event: { ...operationInput().event, health: { literal: "wrong" } } }))] });
    expect(() => createFeatureTestRuntime(bad).stateEvents.preview({ operation: "damage", input: {} })).toThrow();
  });

  it("rejects input accessors and inherited selectors before evaluating feature data", () => {
    const getter = vi.fn(() => 10);
    const runtime = createFeatureTestRuntime(feature());
    expect(() => runtime.stateEvents.preview({ operation: "damage", input: { get amount() { return getter(); } } })).toThrow(/data object/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => defineStateEventOperation(operationInput({ event: { health: { input: "constructor" } } }))).toThrow(/undeclared input/);
    expect(() => defineStateEventOperation(operationInput({ mutation: { ...operationInput().mutation, amount: { literal: -1 } } }))).toThrow();
    expect(() => defineStateEventOperation(operationInput({ mutation: { kind: "set", key: { literal: "Bad key" }, value: { literal: 1 } } }))).toThrow();
    for (const uses of [
      { services: ["stateEvents"], stateEvents: ["damage"], effects: ["discord.test.effect.v1"] },
      { services: ["stateEvents"], stateEvents: ["damage"], routes: ["discord.test.route.v1"] }
    ]) expect(() => registry(feature({ actions: [action({ uses })] }))).toThrow(expect.objectContaining({ code: "feature_state_event_mixed_dependencies" }));
  });

  it("supports local set/delete/increment and bounded set/reset descriptions", () => {
    const cases = [
      [{ kind: "set", key: { literal: "value" }, value: { literal: 4 } }, undefined, 4, true],
      [{ kind: "set", key: { literal: "value" }, value: { literal: 4 } }, 4, 4, false],
      [{ kind: "delete", key: { literal: "value" } }, 4, null, true],
      [{ kind: "delete", key: { literal: "value" } }, undefined, null, false],
      [{ kind: "increment", key: { literal: "value" }, amount: { literal: -2 } }, 4, 2, true],
      [{ ...operationInput().mutation, operation: "reset", amount: undefined }, 4, 100, true],
      [{ ...operationInput().mutation, operation: "set", amount: undefined, value: { literal: 7 } }, 4, 7, true]
    ];
    for (const [raw, before, after, changed] of cases) {
      const mutation = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
      const definition = defineStateEventOperation(operationInput({ scope: { kind: "group_local" }, mutation }));
      const s = stream({ scope: { kind: "group_local" }, publication: { kind: "state_event", source: { kind: "group_local" } }, payload: { schema: { type: "object", properties: {
        health: { type: "integer", nullable: true }, requested: { type: "integer" },
        applied: { type: "integer", nullable: true }, changed: { type: "boolean" }
      }, required: ["health", "requested", "applied", "changed"] } } });
      const runtime = createFeatureTestRuntime(feature({ stateEvents: [definition], eventStreams: [s] }));
      expect(runtime.stateEvents.preview({ operation: "damage", input: {}, before }).result).toMatchObject({ after, changed });
    }
    expect(() => prepareStateEventOperation(defineStateEventOperation(operationInput({ mutation: { kind: "increment", key: { literal: "Bad key" } } })), {})).toThrow();
  });
});

describe("combined action boundaries and explicit runtime opt-in", () => {
  it("keeps an existing event-only version usable beside the combined version of the same stream", async () => {
    const legacyKind = "test.impacts.legacy.v1";
    const legacy = action({ kind: legacyKind, uses: { services: ["eventStreams"] },
      async execute(ctx) {
        const stream = await ctx.eventStreams.local("impacts");
        await stream.publish({ requested: 10, health: 90, applied: 10, changed: true });
        return { output: { message: "Legacy queued." }, effects: [] };
      }
    });
    const localScope = { kind: "group_local" };
    const f = feature({
      stateEvents: [defineStateEventOperation(operationInput({ scope: localScope }))],
      eventStreams: [
        stream({ version: 1, scope: localScope, publication: undefined }),
        stream({ scope: localScope, publication: { kind: "state_event", source: localScope } })
      ], actions: [action(), legacy], commands: { twitch: [
        twitchActionCommand({ name: "impact", description: "Combined.", actionKind: ACTION, parse: twitchNoArgs() }),
        twitchActionCommand({ name: "legacy", description: "Event only.", actionKind: legacyKind, parse: twitchNoArgs() })
      ] }
    });
    const runtime = createFeatureTestRuntime(f);
    const group = { platform: "twitch", kind: "channel", id: "existing" };
    const consumer = runtime.eventStreams.connect({ group, stream: "test.impacts:impacts:v1" });
    (await runtime.twitch.command("legacy", { group })).toReply("Legacy queued.");
    expect((await consumer.receive()).payload.health).toBe(90);
    const production = createDurableEventStreamRuntime({
      DURABLE_EVENT_STREAMS_ENABLED: "true", DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT: "test"
    }, invocation(), runtime.registry);
    await expect(production.local("test.impacts", "impacts")).resolves.toHaveProperty("publish");
  });

  it("fails closed before cooldown, action code or injected commit services can execute", async () => {
    const execute = vi.fn(); const cooldown = vi.fn(); const local = vi.fn();
    const r = registry(feature({ actions: [action({ execute })] }));
    await expect(executeAction(createActionRegistry(r.actions), invocation(), {
      claimFeatureCooldown: cooldown, featureServices: { stateEvents: { local } },
      env: { STATE_EVENT_OPERATIONS_ENABLED: "true" }
    })).rejects.toMatchObject({ code: "state_event_not_implemented", status: 503 });
    expect(execute).not.toHaveBeenCalled(); expect(cooldown).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled();
    const runtime = createFeatureTestRuntime(feature());
    await expect(runtime.discord.command("impact")).rejects.toMatchObject({ code: "state_event_not_implemented" });
    await expect(runtime.twitch.command("impact")).rejects.toMatchObject({ code: "state_event_not_implemented" });
    expect(() => runtime.eventStreams.connect({ group: discordTestGroup(), stream: "test.impacts:impacts:v2" })).toThrow(/not implemented/);
    await expect(runtime.eventStreams.publish({ group: discordTestGroup(), stream: "test.impacts:impacts:v2", payload: {} })).rejects.toMatchObject({ code: "state_event_not_implemented" });
    await expect(createFeatureServiceRuntime({}, invocation(), r).featureServices.stateEvents.local()).rejects.toMatchObject({ code: "state_event_service_unavailable" });
    await expect(createDurableEventStreamRuntime({ DURABLE_EVENT_STREAMS_ENABLED: "true" }, invocation(), r).current("test.impacts", "twitch", "impacts")).rejects.toMatchObject({ code: "durable_event_service_unavailable" });
  });

  it("keeps authorization ahead of the unimplemented-mode response", async () => {
    const r = registry(feature({ actions: [action({ capability: access.moderators })] }));
    await expect(executeAction(createActionRegistry(r.actions), invocation(), { authorize: async () => false })).rejects.toMatchObject({ code: "action_forbidden" });
  });

  it("binds context handles to feature, scope and declared operations and allows one prepared commit attempt", async () => {
    const r = registry(); const commit = vi.fn(async (request) => ({ preview: true, request }));
    const current = vi.fn(async () => ({ commit }));
    const ctx = createFeatureActionContext(r.actions[ACTION], invocation(), { featureServices: { stateEvents: { current } } });
    await expect(ctx.stateEvents.local("damage")).rejects.toMatchObject({ code: "feature_state_event_scope_invalid" });
    await expect(ctx.stateEvents.current("discord", "damage")).rejects.toMatchObject({ code: "feature_event_stream_target_invalid" });
    await expect(ctx.stateEvents.current("twitch", "foreign")).rejects.toMatchObject({ code: "feature_state_event_operation_undeclared" });
    const first = await ctx.stateEvents.current("twitch", "damage");
    const second = await ctx.stateEvents.current("twitch", "damage");
    expect(current).toHaveBeenCalledWith("test.impacts", "twitch", "damage");
    const results = await Promise.allSettled([first.commit({ amount: 4 }), second.commit({ amount: 4 })]);
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1].reason.code).toBe("feature_state_event_multiple_commits");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toMatchObject({ operation: "damage", mutation: { amount: 4 } });
    expect(Object.isFrozen(commit.mock.calls[0][0])).toBe(true);
    expect(() => ctx.state.set("health", 50)).toThrow();
  });
});
