import { describe, expect, it, vi } from "vitest";
import {
  access,
  defineAction,
  defineFeature,
  discordActionCommand,
  discordNativeCommand,
  discordOption,
  discordTextResult,
  schema,
  SchemaValidationError,
  twitchNativeCommand,
  twitchNoArgs,
  twitchRestText,
  twitchTextResult,
  twitchTokens
} from "../src/framework/index.js";
import {
  createFeatureRegistry,
  discordOptionDescriptor
} from "../src/framework/internal.js";
import {
  createActionRegistry,
  executeAction
} from "../src/actions/registry.js";
import { createCommandInvocation } from "../src/integrations/index.js";
import {
  compileDiscordFeatureCommands,
  createDiscordCommandDescriptors
} from "../src/platforms/discord/feature-commands.js";
import {
  compileTwitchFeatureCommands
} from "../src/platforms/twitch/feature-commands.js";

function feature({ actions = [], discord = [], twitch = [] } = {}) {
  return defineFeature({
    apiVersion: 1,
    id: "test.command-helpers",
    description: "Tests command authoring helpers.",
    actions,
    commands: { discord, twitch }
  });
}

function invocation(kind, args) {
  return createCommandInvocation({
    kind,
    origin: {
      group: { platform: "discord", kind: "guild", id: "guild-1" },
      actor: { platform: "discord", id: "user-1", claims: [] }
    },
    args,
    sourceEventId: "discord:interaction:one"
  });
}

describe("Framework argument schemas", () => {
  it("normalizes defaults and returns deeply frozen objects", () => {
    const input = schema.object({
      message: schema.string({ minLength: 1, maxLength: 20, trim: true }),
      count: schema.integer({ min: 1, max: 10, optional: true, default: 2 }),
      ratio: schema.number({ min: 0, max: 1, optional: true }),
      enabled: schema.boolean({ optional: true, default: false }),
      mode: schema.enum(["quiet", "loud"], { optional: true, default: "quiet" })
    });

    const value = input.parse({ message: "  hello  " }, { path: "arguments" });
    expect(value).toEqual({
      message: "hello",
      count: 2,
      enabled: false,
      mode: "quiet"
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => { value.message = "changed"; }).toThrow(TypeError);
  });

  it("rejects unknown keys, unsafe values, and invalid constraints", () => {
    const input = schema.object({ count: schema.integer() });
    expect(() => input.parse({ count: 1, extra: true }, { path: "arguments" }))
      .toThrow("`arguments.extra` is not supported.");
    expect(() => input.parse({ count: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(SchemaValidationError);
    expect(() => schema.string({ minLength: 5, maxLength: 2 })).toThrow(
      "Schema minLength exceeds maxLength."
    );
    expect(() => schema.number({ default: 1 })).toThrow(
      "A schema default requires `optional: true`."
    );
  });
});

describe("Framework actions and access presets", () => {
  it("validates arguments before authorization and calls the author API", async () => {
    const authorExecute = vi.fn((ctx, args) => {
      expect(ctx).toMatchObject({
        apiVersion: 1,
        featureId: "test.command-helpers",
        trigger: { kind: "command" },
        sourceEventId: "discord:interaction:one"
      });
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(ctx.clock.now()).toBeInstanceOf(Date);
      return { output: { message: `${args.message}:${args.count}` }, effects: [] };
    });
    const action = defineAction({
      kind: "test.message.send.v1",
      capability: access.moderators,
      supportedOrigins: ["discord"],
      input: schema.object({
        message: schema.string({ trim: true, minLength: 1 }),
        count: schema.integer({ min: 1 })
      }),
      execute: authorExecute
    });
    const contributed = createFeatureRegistry([feature({ actions: [action] })]);
    const registry = createActionRegistry(contributed.actions);
    const authorize = vi.fn(() => true);

    await expect(executeAction(
      registry,
      invocation(action.kind, { message: "hello", count: "1" }),
      { authorize }
    )).rejects.toMatchObject({ code: "action_arguments_invalid" });
    expect(authorize).not.toHaveBeenCalled();
    expect(authorExecute).not.toHaveBeenCalled();

    await expect(executeAction(
      registry,
      invocation(action.kind, { message: " hello ", count: 2 }),
      { authorize }
    )).resolves.toMatchObject({ output: { message: "hello:2" } });
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorExecute).toHaveBeenCalledOnce();
  });

  it("rejects capabilities outside the reviewed capability catalog", () => {
    const command = twitchNativeCommand({
      name: "unknown_access",
      description: "Unknown access.",
      capability: access.capability("unregistered.example"),
      execute: () => "no"
    });
    expect(() => createFeatureRegistry([feature({ twitch: [command] })]))
      .toThrow("Command capability is not registered");
  });

  it("fails closed when a protected Discord command is declared global", () => {
    const command = discordNativeCommand({
      name: "protected_global",
      description: "Protected global command.",
      availability: "global",
      capability: access.moderators,
      execute: () => ({ content: "no" })
    });
    expect(() => createFeatureRegistry([feature({ discord: [command] })]))
      .toThrow("Protected Discord command `protected_global` must be guild-only.");
  });
});

describe("Discord command helpers", () => {
  it("creates immutable action metadata and registration descriptors", () => {
    const option = discordOption({
      arg: "message",
      name: "message",
      description: "Message to send.",
      type: "string",
      required: true,
      minLength: 1,
      maxLength: 500
    });
    const command = discordActionCommand({
      name: "HeLLo",
      description: "Says hello.",
      availability: "global",
      actionKind: "test.hello.run.v1",
      options: [option]
    });

    expect(command.name).toBe("hello");
    expect(Object.isFrozen(command)).toBe(true);
    expect(discordOptionDescriptor(option)).toEqual({
      name: "message",
      description: "Message to send.",
      type: 3,
      required: true,
      min_length: 1,
      max_length: 500
    });
    expect(discordTextResult({ output: { message: "hello" } })).toEqual({
      content: "hello",
      allowed_mentions: { parse: [] }
    });
  });

  it("compiles native commands with normalized arguments and safe replies", async () => {
    const execute = vi.fn((ctx, { count }) => ctx.response.text(`Count: ${count}`));
    const definition = discordNativeCommand({
      name: "count",
      description: "Reports a count.",
      availability: "global",
      options: [discordOption({
        arg: "count",
        name: "count",
        description: "Count.",
        type: "integer",
        required: true,
        min: 1
      })],
      input: schema.object({ count: schema.integer({ min: 1 }) }),
      execute
    });
    const commands = compileDiscordFeatureCommands({ count: definition }, {});
    const interaction = {
      id: "one",
      channel_id: "channel-1",
      user: { id: "user-1" },
      data: { options: [{ name: "count", value: 3 }] }
    };

    await expect(commands.count.exec(interaction, {}, "count", {
      sourceInteraction: interaction
    })).resolves.toEqual({
      content: "Count: 3",
      allowed_mentions: { parse: [] }
    });
    expect(execute).toHaveBeenCalledOnce();

    interaction.data.options = [];
    const invalid = await commands.count.exec(interaction, {}, "count", {
      sourceInteraction: interaction
    });
    expect(invalid).toMatchObject({ flags: 64 });
    expect(invalid.content).toContain("count");
  });

  it("generates descriptors for legacy and feature command maps", () => {
    const descriptors = createDiscordCommandDescriptors({
      alive: { description: "Alive." },
      count: {
        description: "Count.",
        options: [{ name: "count", description: "Count.", type: 4, required: true }]
      }
    });
    expect(descriptors).toEqual([
      { name: "alive", description: "Alive." },
      {
        name: "count",
        description: "Count.",
        options: [{ name: "count", description: "Count.", type: 4, required: true }]
      }
    ]);
    expect(Object.isFrozen(descriptors)).toBe(true);
  });

  it("does not expose role mutation to an unprivileged native command", async () => {
    const definition = discordNativeCommand({
      name: "unsafe_role",
      description: "Attempts an unsafe role update.",
      availability: "global",
      execute: (ctx) => ctx.permissions.allowRole("role-1")
    });
    const command = compileDiscordFeatureCommands({ unsafe_role: definition }, {})
      .unsafe_role;
    const interaction = {
      id: "one",
      channel_id: "channel-1",
      user: { id: "user-1" },
      data: { options: [] }
    };

    await expect(command.exec(interaction, {}, "unsafe_role", {
      sourceInteraction: interaction
    })).rejects.toMatchObject({ code: "discord_permission_service_forbidden" });
  });
});

describe("Twitch command helpers", () => {
  it("parses no-arg, rest-text, and typed-token command inputs", () => {
    expect(twitchNoArgs().parse("  ")).toEqual({});
    expect(() => twitchNoArgs().parse("extra")).toThrow(SchemaValidationError);
    expect(twitchRestText({ arg: "message", minLength: 1 }).parse(" hello "))
      .toEqual({ message: "hello" });
    expect(twitchTokens([
      { arg: "count", type: "integer" },
      { arg: "loud", type: "boolean", optional: true, default: false }
    ]).parse("3 true")).toEqual({ count: 3, loud: true });
    expect(twitchTextResult({ output: { message: "hello" } })).toBe("hello");
  });

  it("compiles native commands with capability presets", async () => {
    const execute = vi.fn((ctx, { message }) => ctx.response.text(message));
    const definition = twitchNativeCommand({
      name: "shout",
      description: "Repeats text.",
      capability: access.moderators,
      parse: twitchRestText({ arg: "message", minLength: 1 }),
      input: schema.object({ message: schema.string({ minLength: 1 }) }),
      execute
    });
    const command = compileTwitchFeatureCommands({ shout: definition }).shout;
    const moderator = {
      broadcaster_user_id: "channel-1",
      chatter_user_id: "moderator-1",
      badges: [{ set_id: "moderator", id: "1" }]
    };
    await expect(command.exec(moderator, {}, {
      messageId: "one",
      argsText: "hello"
    })).resolves.toBe("hello");
    expect(execute).toHaveBeenCalledOnce();

    const member = { ...moderator, badges: [] };
    await expect(command.exec(member, {}, {
      messageId: "two",
      argsText: "hello"
    })).resolves.toContain("not authorized");
    expect(execute).toHaveBeenCalledOnce();
  });
});
