import { describe, expect, it, vi } from "vitest";
import {
  access, defineAction, defineEventAction, defineFeature, defineScheduledAction,
  discordActionCommand, discordTextResult, frameworkApiVersion, schema,
  twitchActionCommand, twitchTextResult, twitchTokens
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import { createActionRegistry, executeAction } from "../src/actions/registry.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { generateFeatureCatalogMarkdown } from "../src/framework/catalog-documentation.js";
import {
  createFeatureTestRuntime, discordTestActor, runCapabilityCases, twitchTestActor
} from "../src/framework/testing.js";

const KIND = "test.mode-policy.run.v1";
const rule = { capability: access.moderators,
  when: { argument: "operation", exceptValues: ["show"] } };
const policy = { rules: [rule], deniedOutput: { message: "Moderator required." } };

function action(overrides = {}) {
  return defineAction({
    kind: KIND,
    supportedOrigins: ["discord", "twitch"],
    input: schema.object({
      operation: schema.enum(["show", "plus", "minus", "reset"], {
        optional: true, default: "show"
      })
    }),
    modePolicy: policy,
    uses: { services: ["state"] },
    async execute(ctx, { operation }) {
      const score = ctx.state.boundedCounter("score", "shared");
      const value = operation === "plus" ? await score.increment()
        : operation === "minus" ? await score.decrement()
          : operation === "reset" ? await score.reset() : await score.get();
      return { output: { message: `Score: ${value}` }, effects: [] };
    },
    ...overrides
  });
}

function feature(definition, extra = {}) {
  return defineFeature({
    apiVersion: frameworkApiVersion, id: "test.mode-policy",
    description: "Tests opt-in mode authorization.", actions: [definition],
    commands: {
      discord: [discordActionCommand({
        name: "score", description: "Score.", availability: "guild",
        actionKind: KIND, render: discordTextResult
      })],
      twitch: [twitchActionCommand({
        name: "score", description: "Score.", actionKind: KIND,
        parse: twitchTokens([{ arg: "operation", type: "string", optional: true }]),
        render: twitchTextResult
      })]
    },
    ...extra
  });
}

function compose(features) {
  return createFeatureRegistry(features, { availableServices: ["state", "authorization"] });
}

async function direct(definition, args = {}, context = {}) {
  const registry = createActionRegistry(compose([feature(definition)]).actions);
  return await executeAction(registry, createCommandInvocation({
    kind: KIND, args,
    origin: {
      group: { platform: "discord", kind: "guild", id: "guild" },
      actor: { platform: "discord", id: "actor", claims: [] }
    },
    sourceEventId: "discord:interaction:mode-test"
  }), context);
}

describe("Opt-in mode policies", () => {
  it.each(["discord", "twitch"])("protects all updates on %s without mutating denied state", async (platform) => {
    for (const [operation, expected] of [["plus", 3], ["minus", 1], ["reset", 0]]) {
      const runtime = createFeatureTestRuntime(feature(action()));
      const actor = platform === "discord" ? discordTestActor() : twitchTestActor();
      const invoke = (operation, actor) => platform === "discord"
        ? runtime.discord.command("score", { actor, args: { operation } })
        : runtime.twitch.commandText(`!score ${operation}`, { actor });
      const moderator = { ...actor, capabilities: [...actor.capabilities, access.moderators] };
      await invoke("plus", moderator);
      await invoke("plus", moderator);
      const { withoutCapability: denied, withCapability: allowed } = await runCapabilityCases({
        actor, capability: access.moderators,
        invoke: (caseActor) => invoke(operation, caseActor),
        readState: async () => (await invoke("show", actor)).output
      });
      expect(denied.error).toBeNull();
      denied.result.toReply("Moderator required.");
      expect(denied.result.effects).toEqual([]);
      expect(denied.stateAfter).toEqual(denied.stateBefore);
      expect(allowed.error).toBeNull();
      allowed.result.toReply(`Score: ${expected}`);
      expect(allowed.stateAfter).toEqual({ message: `Score: ${expected}` });
    }
  });

  it("normalizes rule values and defaults, while absent optional values match neither form", async () => {
    const execute = () => ({ output: { message: "executed" }, effects: [] });
    for (const when of [{ values: [" plus "] }, { exceptValues: ["show"] }]) {
      const define = (field) => action({
        input: schema.object({ operation: field }), execute,
        modePolicy: { ...policy, rules: [{ capability: access.moderators,
          when: { argument: "operation", ...when } }] }
      });
      const optional = define(schema.string({ trim: true, optional: true }));
      await expect(direct(optional)).resolves.toMatchObject({ output: { message: "executed" } });
      await expect(direct(optional, { operation: " plus " }, { authorize: () => false }))
        .resolves.toMatchObject({ output: policy.deniedOutput });
      const defaulted = define(schema.string({ trim: true, optional: true, default: "plus" }));
      await expect(direct(defaulted, {}, { authorize: () => false }))
        .resolves.toMatchObject({ output: policy.deniedOutput });
    }
    const runtime = createFeatureTestRuntime(feature(action()));
    (await runtime.discord.command("score")).toReply("Score: 0");
    (await runtime.twitch.commandText("!score")).toReply("Score: 0");
  });

  it("validates before authorization and denies before cooldown or feature execution", async () => {
    const execute = vi.fn(() => ({ output: {}, effects: [] }));
    const claimFeatureCooldown = vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 }));
    const authorize = vi.fn(() => false);
    const definition = action({ execute, cooldown: { scope: "actor", seconds: 10 } });
    await expect(direct(definition, { operation: "bad" }, { authorize }))
      .rejects.toMatchObject({ code: "action_arguments_invalid" });
    expect(authorize).not.toHaveBeenCalled();
    await expect(direct(definition, { operation: "plus" }, { authorize, claimFeatureCooldown }))
      .resolves.toMatchObject({ output: policy.deniedOutput, effects: [] });
    expect(claimFeatureCooldown).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await direct(definition, { operation: "plus" }, { authorize: () => true, claimFeatureCooldown });
    expect(execute).toHaveBeenCalledOnce();
    expect(claimFeatureCooldown).toHaveBeenCalledOnce();
  });

  it.each([
    ["zero", schema.integer(), 0, 1],
    ["false", schema.boolean(), false, true]
  ])("matches primitive %s values without truthiness coercion", async (_label, field, protectedValue, publicValue) => {
    const definition = action({
      input: schema.object({ operation: field }),
      modePolicy: { ...policy, rules: [{ capability: access.moderators,
        when: { argument: "operation", values: [protectedValue] } }] },
      execute: () => ({ output: { message: "public" }, effects: [] })
    });
    await expect(direct(definition, { operation: protectedValue }, { authorize: () => false }))
      .resolves.toMatchObject({ output: policy.deniedOutput });
    await expect(direct(definition, { operation: publicValue }))
      .resolves.toMatchObject({ output: { message: "public" } });
  });

  it("allows explicit privileged side effects in public modes of a policy action", async () => {
    const definition = action({ uses: { services: ["authorization", "state"] },
      async execute(ctx) {
        if (await ctx.authorization.allows(access.moderators)) {
          await ctx.state.set("remembered", "game");
        }
        return { output: { message: "public result" }, effects: [] };
      }
    });
    const runtime = createFeatureTestRuntime(feature(definition));
    const results = await runCapabilityCases({
      actor: discordTestActor(), capability: access.moderators,
      invoke: (actor) => runtime.discord.command("score", { actor }),
      readState: () => runtime.state.get({ platform: "discord", kind: "guild", id: "discord-test-group" },
        "test.mode-policy", "remembered")
    });
    results.withoutCapability.result.toReply("public result");
    expect(results.withoutCapability.stateAfter).toBeNull();
    results.withCapability.result.toReply("public result");
    expect(results.withCapability.stateAfter).toBe("game");
  });

  it("keeps baseline access mandatory and requires all matching capabilities", async () => {
    const execute = () => ({ output: { message: "executed" }, effects: [] });
    const definition = action({ capability: access.members, execute, modePolicy: {
      ...policy, rules: [rule, { ...rule, capability: access.managers }]
    } });
    await expect(direct(definition, { operation: "plus" }, { authorize: () => false }))
      .rejects.toMatchObject({ code: "action_forbidden" });
    await expect(direct(definition, { operation: "plus" }, {
      authorize: ({ capability }) => capability !== access.managers
    })).resolves.toMatchObject({ output: policy.deniedOutput });
    await expect(direct(definition, { operation: "plus" }, { authorize: () => true }))
      .resolves.toMatchObject({ output: { message: "executed" } });
  });

  it("fails closed for missing, invalid, and failing authorizers", async () => {
    const execute = vi.fn();
    const definition = action({ execute });
    await expect(direct(definition, { operation: "plus" }))
      .rejects.toMatchObject({ code: "action_authorizer_missing" });
    for (const decision of [undefined, null, 1, "true", {}]) {
      await expect(direct(definition, { operation: "plus" }, { authorize: () => decision }))
        .rejects.toMatchObject({ code: "action_authorizer_result_invalid" });
    }
    const failure = new Error("policy unavailable");
    await expect(direct(definition, { operation: "plus" }, { authorize: () => { throw failure; } }))
      .rejects.toBe(failure);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps old metadata non-enforcing and explicit privileged side effects available", async () => {
    const definition = action({ modePolicy: null, conditionalAccess: [rule],
      uses: { services: ["authorization", "state"] },
      async execute(ctx) {
        if (await ctx.authorization.allows(access.moderators)) {
          await ctx.state.set("remembered", "game");
        }
        return { output: { message: "public result" }, effects: [] };
      }
    });
    const runtime = createFeatureTestRuntime(feature(definition));
    const actor = discordTestActor();
    const results = await runCapabilityCases({ actor, capability: access.moderators,
      invoke: (actor) => runtime.discord.command("score", { actor, args: { operation: "plus" } }),
      readState: () => runtime.state.get({ platform: "discord", kind: "guild", id: "discord-test-group" },
        "test.mode-policy", "remembered")
    });
    results.withoutCapability.result.toReply("public result");
    expect(results.withoutCapability.stateAfter).toBeNull();
    results.withCapability.result.toReply("public result");
    expect(results.withCapability.stateAfter).toBe("game");
  });

  it("derives enforced catalog access from frozen policy rules", () => {
    const source = { rules: [{ ...rule }], deniedOutput: { message: "No.", details: { reason: "access" } } };
    const definition = action({ modePolicy: source });
    source.deniedOutput.details.reason = "changed";
    expect(definition.modePolicy.deniedOutput.details.reason).toBe("access");
    expect(Object.isFrozen(definition.modePolicy.deniedOutput.details)).toBe(true);
    expect(definition.conditionalAccess).toBe(definition.modePolicy.rules);
    expect(Object.isFrozen(definition.modePolicy.rules[0].when.exceptValues)).toBe(true);
    const catalog = generateFeatureCatalogMarkdown(compose([feature(definition)]));
    expect(catalog).toContain("framework.moderators when `operation` is present and is not `show` (enforced)");
  });

  it("rejects ambiguous or invalid policy declarations", () => {
    expect(() => action({ conditionalAccess: [] })).toThrow(/either/);
    for (const modePolicy of [false, {}, { ...policy, rules: [] },
      { ...policy, rules: Array(21).fill(rule) }, { ...policy, deniedOutput: undefined },
      { ...policy, deniedOutput: () => ({}) }, { ...policy, deniedOutput: { x: Infinity } },
      { ...policy, effects: [] },
      { ...policy, rules: [{ ...rule, when: { argument: "absent", values: ["plus"] } }] },
      { ...policy, rules: [{ ...rule, when: { argument: "operation", values: ["bad"] } }] },
      { ...policy, rules: [{ ...rule, when: { argument: "operation", values: ["plus"], exceptValues: ["show"] } }] }
    ]) expect(() => action({ modePolicy })).toThrow();
    expect(() => compose([feature(action({ modePolicy: {
      ...policy, rules: [{ ...rule, capability: "unregistered.capability" }]
    } }))])).toThrow(/not registered/);
  });

  it("rejects non-command bindings and global Discord exposure", async () => {
    const definition = action();
    expect(() => compose([feature(definition, { events: [defineEventAction({
      eventKind: "twitch.stream.online.v1", actionKind: KIND,
      mapPayload: () => ({ operation: "plus" })
    })] })])).toThrow(/protected action/);
    expect(() => compose([feature(definition, { schedules: [defineScheduledAction({
      kind: "discord.test.mode-policy.v1", actionKind: KIND, sourcePlatform: "discord",
      timing: "timestamp", authorization: "grant-at-creation"
    })] })])).toThrow(/command-only/);
    expect(() => compose([feature(definition, { commands: { discord: [discordActionCommand({
      name: "score", description: "Score.", availability: "global",
      actionKind: KIND, render: discordTextResult
    })] } })])).toThrow(/guild-only/);
    await expect(direct(definition, {}, { triggerKind: "schedule" }))
      .rejects.toMatchObject({ code: "action_mode_policy_trigger_unsupported" });
  });
});
