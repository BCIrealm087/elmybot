import { describe, expect, it } from "vitest";
import {
  createFeatureTestRuntime,
  discordTestActor,
  discordTestModerator,
  twitchTestActor,
  twitchTestModerator
} from "@elmybot/framework/testing";
import feature, {
  deriveWidgetDataUpdateId,
  WIDGET_DATA_ACTION_KIND,
  WIDGET_DATA_MAX_LENGTH
} from "../src/feature.js";

const pendingMessage = "Widget data publishing is not available yet.";

function definitions() {
  return {
    action: feature.actions[0],
    discord: feature.commands.discord[0],
    twitch: feature.commands.twitch[0]
  };
}

describe("@elmybot/feature-widget-data", () => {
  it("declares the frozen cross-platform command contract", () => {
    const { action, discord, twitch } = definitions();

    expect(feature).toMatchObject({ apiVersion: 1, id: "widget.data" });
    expect(action).toMatchObject({
      kind: WIDGET_DATA_ACTION_KIND,
      capability: "framework.moderators",
      supportedOrigins: ["discord", "twitch"],
      cooldown: { scope: "group", seconds: 1 }
    });
    expect(discord).toMatchObject({
      name: "widget_data",
      availability: "guild",
      options: [{
        arg: "data",
        name: "data",
        type: "string",
        required: true,
        minLength: 1,
        maxLength: WIDGET_DATA_MAX_LENGTH
      }]
    });
    expect(twitch).toMatchObject({
      name: "widgetdata",
      parse: { kind: "rest-text" }
    });
  });

  it("derives deterministic opaque update IDs from the frozen digest contract", async () => {
    const input = {
      originGroupKey: "twitch:channel:123",
      sourceEventId: "twitch:eventsub:message-456"
    };
    const expected = "wdu1.nooc6-IGx7Sug_0ALex6fB973kjaZ6W9Hkc5YwdaXAg";

    await expect(deriveWidgetDataUpdateId(input)).resolves.toBe(expected);
    await expect(deriveWidgetDataUpdateId(input)).resolves.toBe(expected);
    await expect(deriveWidgetDataUpdateId({
      ...input,
      sourceEventId: "twitch:eventsub:message-457"
    })).resolves.not.toBe(expected);
    expect(expected).toMatch(/^wdu1\.[A-Za-z0-9_-]{43}$/);
  });

  it("normalizes both platforms to the same bounded action input", () => {
    const { action, twitch } = definitions();
    const input = "  alpha   β 🔥  ";
    const expected = { data: "alpha   β 🔥" };

    expect(action.input.parse({ data: input }, { path: "arguments" }))
      .toEqual(expected);
    expect(twitch.parse.parse(input)).toEqual(expected);
    expect(action.input.parse(
      { data: "🔥".repeat(200) },
      { path: "arguments" }
    )).toEqual({ data: "🔥".repeat(200) });
  });

  it.each([
    ["ordinary", "hello widget"],
    ["Unicode with internal spaces", "hello   世界 🔥"]
  ])("accepts %s raw Twitch data for a moderator", async (_label, data) => {
    const runtime = createFeatureTestRuntime(feature);
    (await runtime.twitch.commandText("!widgetdata " + data, {
      actor: twitchTestModerator()
    })).toReply(pendingMessage);
  });

  it("accepts normalized Discord data for a moderator", async () => {
    const runtime = createFeatureTestRuntime(feature);
    (await runtime.discord.command("widget_data", {
      actor: discordTestModerator(),
      args: { data: "  hello   世界 🔥  " }
    })).toReply(pendingMessage);
  });

  it("rejects empty and oversized input on both command paths", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const oversized = "a".repeat(WIDGET_DATA_MAX_LENGTH + 1);

    await expect(runtime.twitch.commandText("!widgetdata   ", {
      actor: twitchTestModerator()
    })).rejects.toMatchObject({ code: "argument_validation_failed" });
    await expect(runtime.twitch.commandText("!widgetdata " + oversized, {
      actor: twitchTestModerator()
    })).rejects.toMatchObject({ code: "argument_validation_failed" });
    await expect(runtime.discord.command("widget_data", {
      actor: discordTestModerator(),
      args: { data: "   " }
    })).rejects.toMatchObject({ code: "action_arguments_invalid" });
    await expect(runtime.discord.command("widget_data", {
      actor: discordTestModerator(),
      args: { data: oversized }
    })).rejects.toMatchObject({ code: "action_arguments_invalid" });
  });

  it("enforces moderator access on Discord and Twitch", async () => {
    const runtime = createFeatureTestRuntime(feature);

    await expect(runtime.discord.command("widget_data", {
      actor: discordTestActor(),
      args: { data: "hello" }
    })).rejects.toMatchObject({ code: "action_forbidden" });
    await expect(runtime.twitch.commandText("!widgetdata hello", {
      actor: twitchTestActor()
    })).rejects.toMatchObject({ code: "action_forbidden" });
  });
});
