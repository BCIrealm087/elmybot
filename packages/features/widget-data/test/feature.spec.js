import { describe, expect, it, vi } from "vitest";
import feature, {
  WIDGET_DATA_ACTION_KIND,
  WIDGET_DATA_MAX_LENGTH,
  WIDGET_DATA_STREAM_ID,
  WIDGET_DATA_STREAM_VERSION
} from "../src/feature.js";

const QUEUED_MESSAGE = "Widget event queued.";

function definitions() {
  return {
    action: feature.actions[0],
    discord: feature.commands.discord[0],
    stream: feature.eventStreams[0],
    twitch: feature.commands.twitch[0]
  };
}

function actionContext(platform, { publish = vi.fn(async () => undefined) } = {}) {
  const current = vi.fn(async () => ({ publish }));
  return {
    ctx: {
      origin: { group: { platform } },
      eventStreams: { current }
    },
    current,
    publish
  };
}

describe("@elmybot/feature-widget-data", () => {
  it("declares the frozen durable-event contract without a readable-state surface", () => {
    const { action, discord, stream, twitch } = definitions();

    expect(feature).toMatchObject({
      apiVersion: 1,
      id: "widget.data",
      description:
        "Publishes every accepted widget command to a durable event consumer."
    });
    expect(feature.shareableState).toEqual([]);
    expect(feature.readableState).toEqual([]);
    expect(feature.eventStreams).toHaveLength(1);
    expect(stream).toMatchObject({
      id: WIDGET_DATA_STREAM_ID,
      version: WIDGET_DATA_STREAM_VERSION,
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
    });
    expect(action).toMatchObject({
      kind: WIDGET_DATA_ACTION_KIND,
      capability: "framework.moderators",
      supportedOrigins: ["discord", "twitch"],
      uses: { services: ["eventStreams"] },
      cooldown: { scope: "group", seconds: 1 }
    });
    expect(discord).toMatchObject({
      name: "widget_data",
      availability: "guild",
      actionKind: WIDGET_DATA_ACTION_KIND,
      options: [{
        arg: "data",
        name: "data",
        type: "string",
        required: true,
        minLength: 1,
        maxLength: null
      }]
    });
    expect(twitch).toMatchObject({
      name: "widgetdata",
      actionKind: WIDGET_DATA_ACTION_KIND,
      parse: { kind: "rest-text" }
    });
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

    const maximum = "x".repeat(WIDGET_DATA_MAX_LENGTH);
    expect(action.input.parse(
      { data: `  ${maximum}  ` },
      { path: "arguments" }
    )).toEqual({ data: maximum });
    expect(twitch.parse.parse(`  ${maximum}  `)).toEqual({ data: maximum });
  });

  it("rejects empty and oversized input before an action can publish", () => {
    const { action, twitch } = definitions();
    const oversized = "a".repeat(WIDGET_DATA_MAX_LENGTH + 1);

    expect(() => action.input.parse({ data: "   " }, { path: "arguments" }))
      .toThrow();
    expect(() => action.input.parse({ data: oversized }, { path: "arguments" }))
      .toThrow();
    expect(() => twitch.parse.parse("   ")).toThrow();
    expect(() => twitch.parse.parse(oversized)).toThrow();
  });

  it.each([
    ["discord", "twitch"],
    ["twitch", "discord"]
  ])("publishes the exact %s payload to its selected shared stream", async (
    platform,
    targetPlatform
  ) => {
    const { action } = definitions();
    const { ctx, current, publish } = actionContext(platform);

    await expect(action.execute(ctx, { data: "consumer-defined text" }))
      .resolves.toEqual({
        output: { message: QUEUED_MESSAGE },
        effects: []
      });
    expect(current).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledWith(targetPlatform, WIDGET_DATA_STREAM_ID);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      data: "consumer-defined text",
      origin: platform
    });
  });

  it("does not add identity, actor, group, or timing fields to the feature payload", async () => {
    const { action } = definitions();
    const { ctx, publish } = actionContext("discord");
    ctx.sourceEventId = "discord:interaction:private-source";
    ctx.origin.group.key = "discord:guild:private-group";

    await action.execute(ctx, { data: "safe payload" });

    expect(Object.keys(publish.mock.calls[0][0]).sort()).toEqual([
      "data",
      "origin"
    ]);
    expect(JSON.stringify(publish.mock.calls[0][0])).not.toMatch(
      /private-source|private-group|actor|timestamp/i
    );
  });

  it("propagates stream publication failures without a state fallback", async () => {
    const { action } = definitions();
    const error = Object.assign(new Error("Widget consumer is unavailable."), {
      code: "durable_event_consumer_unavailable",
      retryable: true
    });
    const { ctx, current, publish } = actionContext("twitch", {
      publish: vi.fn(async () => { throw error; })
    });

    await expect(action.execute(ctx, { data: "not accepted" })).rejects.toBe(error);
    expect(current).toHaveBeenCalledWith("discord", WIDGET_DATA_STREAM_ID);
    expect(publish).toHaveBeenCalledOnce();
    expect(ctx).not.toHaveProperty("shareableState");
  });
});
