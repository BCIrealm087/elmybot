import { describe, expect, it, vi } from "vitest";
import {
  defineFeature,
  discordActionCommand,
  discordNativeCommand,
  discordOption,
  discordScheduledActionCommand,
  schema,
  SchemaValidationError,
  twitchActionCommand,
  twitchNativeCommand,
  twitchNoArgs,
  twitchTokens
} from "../src/framework/index.js";
import { createFeatureTestRuntime } from "../src/framework/testing.js";
import { formatCommandInputError } from "../src/framework/command-input-error.js";
import { featureRegistry } from "../src/features/index.js";
import { compileDiscordFeatureCommands } from "../src/platforms/discord/feature-commands.js";
import { compileTwitchFeatureCommands } from "../src/platforms/twitch/feature-commands.js";
import deaths from "../packages/features/fun-deaths/src/feature.js";
import { announcementsFeature } from "../src/features/announcements/feature.js";
import {
  scheduledTwitchAnnouncementsFeature
} from "../src/features/scheduled-twitch-announcements/feature.js";

function discordInteraction(options = []) {
  return {
    id: "input-error-test",
    guild_id: "guild-1",
    channel_id: "channel-1",
    user: { id: "user-1" },
    data: { options }
  };
}

const twitchEvent = {
  broadcaster_user_id: "channel-1",
  chatter_user_id: "user-1",
  badges: []
};

function nativeFeature(platform, command) {
  return defineFeature({
    apiVersion: 1,
    id: "test.input-errors",
    description: "Exercises input corrections.",
    commands: { [platform]: [command] }
  });
}

describe("Command input corrections", () => {
  it("uses the visible Discord option for binding and semantic errors", async () => {
    const execute = vi.fn((ctx, { internal_count: count }) => ctx.response.text(`Count: ${count}`));
    const definition = discordNativeCommand({
      name: "count",
      description: "Reports a count.",
      availability: "global",
      usage: "/count amount:2",
      options: [discordOption({
        arg: "internal_count", name: "amount", description: "Count.",
        type: "integer", required: true, min: 1
      })],
      input: schema.object({ internal_count: schema.integer({ min: 1, max: 3 }) }),
      execute
    });
    const command = compileDiscordFeatureCommands({ count: definition }, {}).count;
    for (const [options, reason] of [
      [[], "is required."],
      [[{ name: "amount", value: 0 }], "must be at least 1."],
      [[{ name: "amount", value: 4 }], "must be at most 3."]
    ]) {
      const result = await command.exec(discordInteraction(options), {});
      expect(result).toEqual({
        content: `/count: amount ${reason} Example: /count amount:2`,
        flags: 64,
        allowed_mentions: { parse: [] }
      });
    }
    expect(execute).not.toHaveBeenCalled();
    const runtime = createFeatureTestRuntime(nativeFeature("discord", definition));
    const error = await runtime.discord.command("count", {
      args: { internal_count: 4 }
    }).catch((error) => error);
    expect(error).toMatchObject({
      code: "argument_validation_failed",
      path: "arguments.internal_count",
      message: "`arguments.internal_count` must be at most 3."
    });
    expect(runtime.inputError("discord", "count", error)).toBe(
      "/count: amount must be at most 3. Example: /count amount:2"
    );
    expect(await command.exec(discordInteraction([{ name: "amount", value: 2 }]), {}))
      .toMatchObject({ content: "Count: 2" });
  });

  it("renders Twitch token and schema corrections and accepts the suggested invocation", async () => {
    const execute = vi.fn((ctx, { operation }) => ctx.response.text(operation));
    const definition = twitchNativeCommand({
      name: "score", description: "Reports a score.", usage: "!score show",
      parse: twitchTokens([{ arg: "operation", type: "string" }]),
      input: schema.object({ operation: schema.enum(["show", "plus"]) }),
      execute
    });
    const command = compileTwitchFeatureCommands({ score: definition }).score;
    const runtime = createFeatureTestRuntime(nativeFeature("twitch", definition));
    for (const [argsText, correction] of [
      ["multiply", "operation must be one of: show, plus."],
      ["show extra", "Too many arguments. Put multi-word values in double quotes."],
      ['"show', "Close the double quote around multi-word text."],
      ["", "operation is required."]
    ]) {
      const reply = await command.exec(twitchEvent, {}, { messageId: "one", argsText });
      expect(reply).toBe(`!score: ${correction} Example: !score show`);
      const error = await runtime.twitch.commandText(`!score ${argsText}`)
        .catch((error) => error);
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect(runtime.inputError("twitch", "score", error)).toBe(reply);
    }
    expect(execute).not.toHaveBeenCalled();
    (await runtime.twitch.commandText("!score show")).toReply("show");
    expect(await command.exec(twitchEvent, {}, { messageId: "two", argsText: "show" }))
      .toBe("show");
  });

  it("formats wrapped action errors on both adapters without changing diagnostics", async () => {
    const runtime = createFeatureTestRuntime(deaths);
    const discord = compileDiscordFeatureCommands({ deaths: deaths.commands.discord[0] },
      featureRegistry.actions).deaths;
    const twitch = compileTwitchFeatureCommands({ deaths: deaths.commands.twitch[0] },
      featureRegistry.actions).deaths;
    const error = await runtime.twitch.commandText('!deaths check " "')
      .catch((error) => error);
    expect(error).toMatchObject({
      code: "action_arguments_invalid",
      cause: {
        code: "argument_validation_failed", path: "arguments.game",
        message: "`arguments.game` must contain at least 1 characters."
      }
    });
    expect(await twitch.exec(twitchEvent, {}, {
      messageId: "one", argsText: 'check " "'
    })).toBe(runtime.inputError("twitch", "deaths", error));
    expect(await discord.exec(discordInteraction([
      { name: "operation", value: "check" }, { name: "game", value: " " }
    ]), {})).toMatchObject({
      content: "/deaths: game must contain at least 1 characters. " +
        "Example: /deaths operation:check game:Dark Souls",
      flags: 64, allowed_mentions: { parse: [] }
    });
  });

  it("preserves the explicit announcement limits for each destination", async () => {
    const immediate = announcementsFeature.commands.discord[0];
    const scheduled = scheduledTwitchAnnouncementsFeature.commands.discord[0];
    const discord = compileDiscordFeatureCommands({
      [immediate.name]: immediate, [scheduled.name]: scheduled
    }, featureRegistry.actions, featureRegistry.schedules);
    for (const definition of [immediate, scheduled]) {
      expect(discord[definition.name].options[0]).toMatchObject({
        min_length: 1, max_length: 500
      });
      expect(await discord[definition.name].exec(discordInteraction([
        { name: "message", value: "a".repeat(501) }
      ]), {})).toMatchObject({
        content: `/${definition.name}: message must contain at most 500 characters. ` +
          `Example: ${definition.usage}`
      });
    }
    const twitch = announcementsFeature.commands.twitch[0];
    const action = announcementsFeature.actions[0];
    const valid = twitch.parse.parse("a".repeat(2_000));
    expect(action.input.parse(valid)).toEqual(valid);
    expect(() => twitch.parse.parse("a".repeat(2_001))).toThrow("at most 2000");
    expect(() => action.input.parse({ message: "a".repeat(2_001) })).toThrow("at most 2000");
  });

  it("keeps scheduled action validation guidance and its cause", async () => {
    const definition = scheduledTwitchAnnouncementsFeature.commands.discord[0];
    const command = compileDiscordFeatureCommands({ [definition.name]: definition },
      featureRegistry.actions, featureRegistry.schedules)[definition.name];
    const runtime = createFeatureTestRuntime([
      announcementsFeature, scheduledTwitchAnnouncementsFeature
    ]);
    const error = await runtime.discord.command(definition.name, {
      args: { message: " " },
      actor: { platform: "discord", id: "manager", claims: [],
        capabilities: ["integration.announcement.publish"] }
    }).catch((error) => error);
    const result = await command.exec(discordInteraction([{ name: "message", value: " " }]),
      {}, definition.name, { authorizedCapability: "integration.announcement.publish" });
    expect(error).toBeInstanceOf(SchemaValidationError);
    expect(result.content).toBe(runtime.inputError("discord", definition.name, error));
    expect(result.content).toContain("message must contain at least 1 characters.");
    expect(result.content).toContain(`Example: ${definition.usage}`);
  });

  it("supports commands without usage and leaves unrelated failures alone", async () => {
    const failure = new Error("native implementation failed");
    const definition = twitchNativeCommand({
      name: "ping", description: "Pings.", parse: twitchNoArgs(),
      execute: () => { throw failure; }
    });
    expect(definition.usage).toBeNull();
    const command = compileTwitchFeatureCommands({ ping: definition }).ping;
    expect(await command.exec(twitchEvent, {}, { messageId: "one", argsText: "extra" }))
      .toBe("!ping: This command does not take arguments. Example: !ping");
    await expect(command.exec(twitchEvent, {}, { messageId: "two", argsText: "" }))
      .rejects.toBe(failure);
    expect(formatCommandInputError(failure, definition)).toBeNull();
    expect(formatCommandInputError({
      code: "action_forbidden", cause: new SchemaValidationError("arguments", "bad")
    }, definition)).toBeNull();
  });

  it("keeps long corrections within Twitch's limit with the complete example", () => {
    const name = "a".repeat(32);
    const usage = `!${name} ${"b".repeat(126)}`;
    const definition = twitchNativeCommand({ name, description: "Long example.", usage,
      execute: () => "ok" });
    const error = new SchemaValidationError(`arguments.${"c".repeat(64)}`, "d".repeat(300));
    const reply = formatCommandInputError(error, definition);
    expect(reply.length).toBe(500);
    expect(reply).toContain("… Example:");
    expect(reply.endsWith(usage)).toBe(true);
    expect(error.reason).toBe("d".repeat(300));
  });
});

describe("Optional command usage metadata", () => {
  const common = { name: "example", description: "Example command." };
  const constructors = [
    [discordActionCommand, { availability: "global", actionKind: "test.example.run.v1" }, "/"],
    [discordNativeCommand, { availability: "global", execute: () => ({ content: "ok" }) }, "/"],
    [discordScheduledActionCommand, { availability: "guild", scheduleKind: "test.example.daily.v1",
      mapSchedule: () => ({}) }, "/"],
    [twitchActionCommand, { actionKind: "test.example.run.v1" }, "!"],
    [twitchNativeCommand, { execute: () => "ok" }, "!"]
  ];

  it("accepts platform-specific examples for every command helper with a stable default", () => {
    for (const [create, options, prefix] of constructors) {
      expect(create({ ...common, ...options }).usage).toBeNull();
      const usage = `${prefix}example`;
      expect(create({ ...common, ...options, usage }).usage).toBe(usage);
      for (const invalid of ["example", `${prefix}other`, `${usage}\nmore`,
        `${usage}\u2028more`, `${usage} ${"x".repeat(160)}`, 123]) {
        expect(() => create({ ...common, ...options, usage: invalid }))
          .toThrow("single-line example");
      }
    }
  });
});
