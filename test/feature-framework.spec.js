import { describe, expect, it, vi } from "vitest";
import {
  createFeatureRegistry,
  defineAction,
  defineEventAction,
  defineFeature,
  defineRoute,
  defineScheduledAction,
  discordActionCommand,
  discordNativeCommand,
  FEATURE_FRAMEWORK_API_VERSION,
  FeatureDefinitionError,
  FeatureRegistryError,
  mergeCommandDefinitions,
  twitchActionCommand,
  twitchNativeCommand
} from "../src/framework/index.js";
import {
  createActionRegistry,
  executeAction
} from "../src/actions/registry.js";
import {
  createActionDefinition,
  createCommandInvocation,
  createEventActionInvocation
} from "../src/integrations/index.js";

function action(kind) {
  return defineAction({
    kind,
    supportedOrigins: ["discord", "twitch"],
    execute: () => ({ output: { ok: true }, effects: [] })
  });
}

function feature({
  id = "test.feature",
  actions = [],
  routes = [],
  events = [],
  schedules = [],
  discord = [],
  twitch = []
} = {}) {
  return defineFeature({
    apiVersion: FEATURE_FRAMEWORK_API_VERSION,
    id,
    description: `Feature ${id}`,
    actions,
    routes,
    events,
    schedules,
    commands: { discord, twitch }
  });
}

describe("Command and feature framework", () => {
  it("normalizes and deeply freezes a feature definition", () => {
    const execute = () => ({ content: "hello" });
    const command = discordNativeCommand({
      name: "hello",
      description: "Hello",
      availability: "global",
      execute
    });
    const definition = defineFeature({
      apiVersion: 1,
      id: "fun.hello",
      description: "Says hello.",
      commands: {
        discord: [command]
      }
    });

    expect(definition).toMatchObject({
      apiVersion: 1,
      id: "fun.hello",
      actions: [],
      commands: {
        discord: [command],
        twitch: []
      },
      routes: [],
      events: [],
      schedules: [],
      effectAdapters: { discord: [], twitch: [] }
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.commands.discord)).toBe(true);
    expect(Object.isFrozen(definition.commands.discord[0])).toBe(true);
    expect(() => {
      definition.commands.discord[0].name = "changed";
    }).toThrow(TypeError);
  });

  it("rejects unsupported versions, invalid IDs, unknown fields, and bad collections", () => {
    expect(() => defineFeature({
      apiVersion: 2,
      id: "test.feature",
      description: "Test"
    })).toThrow(FeatureDefinitionError);
    expect(() => defineFeature({
      apiVersion: 1,
      id: "unqualified",
      description: "Test"
    })).toThrow("Feature definition.id is invalid.");
    expect(() => defineFeature({
      apiVersion: 1,
      id: "test.feature",
      description: "Test",
      command: []
    })).toThrow("Feature definition.command is not a supported field.");
    expect(() => defineFeature({
      apiVersion: 1,
      id: "test.feature",
      description: "Test",
      actions: {}
    })).toThrow("Feature definition.actions must be an array.");
  });

  it("requires catalog entries to be created by defineFeature", () => {
    expect(() => createFeatureRegistry([{
      apiVersion: 1,
      id: "test.raw",
      description: "Raw"
    }])).toThrow("Installed features[0] must be created with defineFeature().");
  });

  it("collects immutable action and per-platform command registries", () => {
    const helloAction = action("test.hello.run.v1");
    const hello = feature({
      id: "test.hello",
      actions: [helloAction],
      discord: [discordActionCommand({
        name: "hello",
        description: "Hello",
        availability: "global",
        actionKind: helloAction.kind
      })],
      twitch: [twitchActionCommand({
        name: "hello",
        description: "Hello",
        actionKind: helloAction.kind
      })]
    });
    const registry = createFeatureRegistry([hello]);

    expect(registry.features).toEqual([hello]);
    expect(registry.featuresById[hello.id]).toBe(hello);
    expect(registry.actions[helloAction.kind]).toMatchObject({
      kind: helloAction.kind
    });
    expect(registry.commands.discord.hello).toMatchObject({ name: "hello" });
    expect(registry.commands.twitch.hello).toMatchObject({ name: "hello" });
    expect(Object.isFrozen(registry.actions)).toBe(true);
    expect(Object.isFrozen(registry.commands.discord)).toBe(true);
  });

  it("catalogs feature routes and verifies routed action dependencies", () => {
    const route = defineRoute({
      kind: "discord.test-to-twitch.v1",
      sourcePlatform: "discord",
      targetPlatform: "twitch",
      destination: "none"
    });
    const routedAction = defineAction({
      kind: "test.routed.publish.v1",
      supportedOrigins: ["discord"],
      uses: {
        routes: [route.kind],
        effects: ["twitch.chat.send.v1"]
      },
      execute: () => ({ output: {}, effects: [] })
    });
    const adapter = Object.freeze({
      platform: "twitch",
      validateEffect: () => null,
      deliver: async () => null
    });
    const registry = createFeatureRegistry([
      feature({ actions: [routedAction], routes: [route] })
    ], {
      effectAdapters: { twitch: { "twitch.chat.send.v1": adapter } }
    });

    expect(registry.routes[route.kind]).toBe(route);
    expect(registry.effectAdapters["twitch.chat.send.v1"]).toBe(adapter);
    expect(Object.isFrozen(registry.routes)).toBe(true);

    expect(() => createFeatureRegistry([
      feature({ actions: [routedAction], routes: [route] })
    ])).toThrow("refers to an unavailable effect");
    expect(() => createFeatureRegistry([
      feature({ actions: [routedAction] })
    ], {
      effectAdapters: { twitch: { "twitch.chat.send.v1": adapter } }
    })).toThrow("refers to an uninstalled route");
  });

  it("resolves declared routes and creates controlled routed effects", async () => {
    const route = defineRoute({
      kind: "discord.test-to-twitch.v1",
      sourcePlatform: "discord",
      targetPlatform: "twitch",
      destination: "none"
    });
    const routedAction = defineAction({
      kind: "test.routed.publish.v1",
      supportedOrigins: ["discord"],
      uses: {
        routes: [route.kind],
        effects: ["twitch.chat.send.v1"]
      },
      async execute(ctx) {
        const routes = await ctx.routes.resolve(route.kind);
        return {
          output: { count: routes.length },
          effects: routes.map((resolved) =>
            ctx.effects.routedMessage(resolved, { message: "hello" })
          )
        };
      }
    });
    const adapter = Object.freeze({
      platform: "twitch",
      validateEffect: () => null,
      deliver: async () => null
    });
    const featureCatalog = createFeatureRegistry([
      feature({ actions: [routedAction], routes: [route] })
    ], {
      effectAdapters: { twitch: { "twitch.chat.send.v1": adapter } }
    });
    const registry = createActionRegistry(featureCatalog.actions);
    const invocation = createCommandInvocation({
      kind: routedAction.kind,
      origin: {
        group: { platform: "discord", kind: "guild", id: "guild-1" },
        actor: { platform: "discord", id: "user-1", claims: [] }
      },
      sourceEventId: "discord:interaction:1",
      correlationId: "discord:interaction:1"
    });
    const result = await executeAction(registry, invocation, {
      routeDefinitions: featureCatalog.routes,
      effectAdapters: featureCatalog.effectAdapters,
      routedMessageEffectKinds: { twitch: "twitch.chat.send.v1" },
      resolveRoutes: async () => [{
        kind: route.kind,
        integration: { id: "integration-1" },
        sourceGroup: invocation.origin.group,
        targetGroup: { platform: "twitch", kind: "channel", id: "channel-1" },
        destination: {}
      }]
    });

    expect(result.output).toEqual({ count: 1 });
    expect(result.effects[0]).toMatchObject({
      kind: "twitch.chat.send.v1",
      target: { group: { platform: "twitch", id: "channel-1" } },
      payload: { message: "hello" },
      integration: { id: "integration-1" }
    });
  });

  it("catalogs event and scheduled-action bindings against installed actions", () => {
    const twitchAction = defineAction({
      kind: "test.event.handle.v1",
      supportedOrigins: ["twitch"],
      execute: () => ({ output: {}, effects: [] })
    });
    const discordAction = defineAction({
      kind: "test.schedule.handle.v1",
      supportedOrigins: ["discord"],
      execute: () => ({ output: {}, effects: [] })
    });
    const event = defineEventAction({
      eventKind: "twitch.test.received.v1",
      actionKind: twitchAction.kind,
      mapPayload: ({ payload }) => payload
    });
    const schedule = defineScheduledAction({
      kind: "discord.test.random.v1",
      sourcePlatform: "discord",
      actionKind: discordAction.kind,
      timing: "bounded-random",
      authorization: "grant-at-creation"
    });
    const registry = createFeatureRegistry([feature({
      actions: [twitchAction, discordAction],
      events: [event],
      schedules: [schedule]
    })]);

    expect(registry.events[event.eventKind]).toBe(event);
    expect(registry.schedules[schedule.kind]).toBe(schedule);
    expect(Object.isFrozen(registry.events)).toBe(true);
    expect(Object.isFrozen(registry.schedules)).toBe(true);
  });

  it("rejects raw trigger definitions, missing actions, and protected actorless events", () => {
    expect(() => createFeatureRegistry([feature({
      events: [{ eventKind: "twitch.raw.event.v1" }]
    })])).toThrow("must use defineEventAction");

    const missing = defineScheduledAction({
      kind: "discord.test.missing.v1",
      sourcePlatform: "discord",
      actionKind: "test.missing.action.v1",
      timing: "bounded-random",
      authorization: "grant-at-creation"
    });
    expect(() => createFeatureRegistry([feature({ schedules: [missing] })]))
      .toThrow("refers to an uninstalled action");

    const protectedAction = defineAction({
      kind: "test.protected.event.v1",
      capability: "framework.moderators",
      supportedOrigins: ["twitch"],
      execute: () => ({ output: {}, effects: [] })
    });
    const protectedEvent = defineEventAction({
      eventKind: "twitch.protected.event.v1",
      actionKind: protectedAction.kind,
      mapPayload: () => ({})
    });
    expect(() => createFeatureRegistry([feature({
      actions: [protectedAction],
      events: [protectedEvent]
    })])).toThrow("cannot invoke a protected action");
  });

  it("exposes the event trigger kind to an actorless feature action", async () => {
    const triggeredAction = defineAction({
      kind: "test.event.trigger.v1",
      supportedOrigins: ["twitch"],
      execute: (ctx) => ({
        output: { trigger: ctx.trigger.kind, actor: ctx.origin.actor },
        effects: []
      })
    });
    const catalog = createFeatureRegistry([
      feature({ actions: [triggeredAction] })
    ]);
    const invocation = createEventActionInvocation({
      kind: triggeredAction.kind,
      origin: {
        group: { platform: "twitch", kind: "channel", id: "channel-1" },
        actor: null
      },
      sourceEventId: "twitch:eventsub:event-1",
      correlationId: "twitch:eventsub:event-1"
    });
    const result = await executeAction(
      createActionRegistry(catalog.actions),
      invocation,
      { triggerKind: "event" }
    );

    expect(result.output).toEqual({ trigger: "event", actor: null });
  });

  it("provides only declared namespaced services and enforces atomic cooldown claims", async () => {
    const statefulAction = defineAction({
      kind: "test.services.run.v1",
      supportedOrigins: ["discord"],
      uses: { services: ["config", "state", "random"] },
      cooldown: { scope: "actor", seconds: 30 },
      async execute(ctx) {
        const label = await ctx.config.get("label");
        await ctx.state.set("last_roll", 4);
        const total = await ctx.state.increment("total", 2);
        return {
          output: {
            label,
            total,
            roll: ctx.random.integer({ min: 4, max: 4 })
          },
          effects: []
        };
      }
    });
    const catalog = createFeatureRegistry([
      feature({ actions: [statefulAction] })
    ], { availableServices: ["config", "state", "random"] });
    const configGet = vi.fn(async () => "Score");
    const stateSet = vi.fn(async () => undefined);
    const stateIncrement = vi.fn(async () => 2);
    const claimFeatureCooldown = vi.fn(async () => ({
      allowed: true,
      retryAfterSeconds: 0
    }));
    const input = createCommandInvocation({
      kind: statefulAction.kind,
      origin: {
        group: { platform: "discord", kind: "guild", id: "guild-1" },
        actor: { platform: "discord", id: "user-1", claims: [] }
      },
      sourceEventId: "discord:interaction:services",
      correlationId: "discord:interaction:services"
    });
    const runtime = {
      featureServices: {
        config: { get: configGet },
        state: {
          get: vi.fn(),
          set: stateSet,
          delete: vi.fn(),
          increment: stateIncrement
        }
      },
      random: { integer: ({ min }) => min },
      claimFeatureCooldown
    };

    await expect(executeAction(
      createActionRegistry(catalog.actions),
      input,
      runtime
    )).resolves.toMatchObject({
      output: { label: "Score", total: 2, roll: 4 }
    });
    expect(configGet).toHaveBeenCalledWith("test.feature", "label");
    expect(stateSet).toHaveBeenCalledWith("test.feature", "last_roll", 4);
    expect(stateIncrement).toHaveBeenCalledWith("test.feature", "total", 2);
    expect(claimFeatureCooldown).toHaveBeenCalledWith({
      featureId: "test.feature",
      actionKind: statefulAction.kind,
      scopeKey: "discord:user-1",
      seconds: 30
    });

    claimFeatureCooldown.mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 12
    });
    await expect(executeAction(
      createActionRegistry(catalog.actions),
      input,
      runtime
    )).rejects.toMatchObject({
      code: "action_cooldown_active",
      status: 429,
      retryAfterSeconds: 12
    });
  });

  it("fails composition for unavailable services and blocks undeclared service access", async () => {
    const serviceAction = defineAction({
      kind: "test.service.required.v1",
      supportedOrigins: ["discord"],
      uses: { services: ["state"] },
      execute: () => ({ output: {}, effects: [] })
    });
    expect(() => createFeatureRegistry([
      feature({ actions: [serviceAction] })
    ])).toThrow("requires unavailable service `state`");

    const undeclaredAction = defineAction({
      kind: "test.service.undeclared.v1",
      supportedOrigins: ["discord"],
      execute: async (ctx) => {
        await ctx.state.get("value");
        return { output: {}, effects: [] };
      }
    });
    const catalog = createFeatureRegistry([
      feature({ actions: [undeclaredAction] })
    ]);
    await expect(executeAction(
      createActionRegistry(catalog.actions),
      createCommandInvocation({
        kind: undeclaredAction.kind,
        origin: {
          group: { platform: "discord", kind: "guild", id: "guild-1" },
          actor: { platform: "discord", id: "user-1", claims: [] }
        },
        sourceEventId: "discord:interaction:undeclared"
      }),
      { featureServices: { state: { get: vi.fn() } } }
    )).rejects.toMatchObject({ code: "feature_service_undeclared" });
  });

  it("rejects duplicate feature IDs, actions, and same-platform commands", () => {
    expect(() => createFeatureRegistry([
      feature({ id: "test.one" }),
      feature({ id: "test.one" })
    ])).toThrow("Duplicate feature ID: `test.one`.");

    expect(() => createFeatureRegistry([
      feature({ id: "test.one", actions: [action("test.same.run.v1")] }),
      feature({ id: "test.two", actions: [action("test.same.run.v1")] })
    ])).toThrow("Duplicate feature action kind: `test.same.run.v1`.");

    expect(() => createFeatureRegistry([
      feature({
        id: "test.one",
        discord: [discordNativeCommand({
          name: "same",
          description: "One",
          availability: "global",
          execute: () => ({ content: "one" })
        })]
      }),
      feature({
        id: "test.two",
        discord: [discordNativeCommand({
          name: "same",
          description: "Two",
          availability: "global",
          execute: () => ({ content: "two" })
        })]
      })
    ])).toThrow("Duplicate discord feature command: `same`.");
  });

  it("merges legacy and feature commands while rejecting collisions", () => {
    const legacy = { alive: { description: "Legacy" } };
    const contributed = { hello: { name: "hello", description: "Feature" } };
    const merged = mergeCommandDefinitions("discord", legacy, contributed);

    expect(Object.keys(merged)).toEqual(["alive", "hello"]);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(() => mergeCommandDefinitions("discord", legacy, {
      alive: { name: "alive", description: "Feature" }
    })).toThrow("Duplicate discord command name: `alive`.");
    expect(() => mergeCommandDefinitions("youtube", legacy)).toThrow(
      FeatureRegistryError
    );
  });

  it("lets the existing action registry reject legacy-feature collisions", () => {
    const shared = action("test.shared.run.v1");
    const legacy = createActionDefinition({
      kind: shared.kind,
      supportedOrigins: ["discord"],
      execute: () => ({ output: { ok: true } })
    });
    const contributed = createFeatureRegistry([
      feature({ id: "test.contributor", actions: [shared] })
    ]);

    expect(() => createActionRegistry(
      { [shared.kind]: legacy },
      contributed.actions
    )).toThrow(`Duplicate action kind: \`${shared.kind}\`.`);
  });

  it("rejects raw command definitions and missing action references", () => {
    expect(() => createFeatureRegistry([feature({
      discord: [{ name: "raw", description: "Raw" }]
    })])).toThrow("must use a discord command helper");

    expect(() => createFeatureRegistry([feature({
      twitch: [twitchActionCommand({
        name: "missing",
        description: "Missing",
        actionKind: "test.missing.run.v1"
      })]
    })])).toThrow("refers to an uninstalled action");
  });

  it("accepts native Twitch command helpers", () => {
    const definition = feature({
      twitch: [twitchNativeCommand({
        name: "native",
        description: "Native",
        execute: () => "ok"
      })]
    });
    expect(createFeatureRegistry([definition]).commands.twitch.native)
      .toMatchObject({ name: "native", mode: "native-command" });
  });
});
