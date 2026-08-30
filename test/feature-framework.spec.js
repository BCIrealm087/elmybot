import { describe, expect, it } from "vitest";
import {
  createFeatureRegistry,
  defineAction,
  defineFeature,
  defineRoute,
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
  createCommandInvocation
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
  discord = [],
  twitch = []
} = {}) {
  return defineFeature({
    apiVersion: FEATURE_FRAMEWORK_API_VERSION,
    id,
    description: `Feature ${id}`,
    actions,
    routes,
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
