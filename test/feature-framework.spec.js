import { describe, expect, it } from "vitest";
import {
  createFeatureRegistry,
  defineAction,
  defineFeature,
  discordActionCommand,
  discordNativeCommand,
  FEATURE_FRAMEWORK_API_VERSION,
  FeatureDefinitionError,
  FeatureRegistryError,
  mergeCommandDefinitions,
  twitchActionCommand,
  twitchNativeCommand
} from "../src/framework/index.js";
import { createActionRegistry } from "../src/actions/registry.js";
import { createActionDefinition } from "../src/integrations/index.js";

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
  discord = [],
  twitch = []
} = {}) {
  return defineFeature({
    apiVersion: FEATURE_FRAMEWORK_API_VERSION,
    id,
    description: `Feature ${id}`,
    actions,
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
