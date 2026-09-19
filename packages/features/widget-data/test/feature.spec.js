import { describe, expect, it, vi } from "vitest";
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
  twitchTestActor,
  twitchTestGroup,
  twitchTestModerator
} from "@elmybot/framework/testing";
import feature, {
  deriveWidgetDataUpdateId,
  WIDGET_DATA_ACTION_KIND,
  WIDGET_DATA_MAX_LENGTH,
  WIDGET_DATA_NAMESPACE_ID,
  WIDGET_DATA_STATE_KEY
} from "../src/feature.js";

const UPDATED_MESSAGE = "Widget data updated.";
const FEATURE_ID = "widget.data";
const INTEGRATION_ID = "widget-data-integration";

function definitions() {
  return {
    action: feature.actions[0],
    discord: feature.commands.discord[0],
    twitch: feature.commands.twitch[0]
  };
}

function linkedGroups() {
  const discordGroup = discordTestGroup({ id: "widget-data-guild" });
  const twitchGroup = twitchTestGroup({ id: "widget-data-channel" });
  return {
    discordGroup,
    twitchGroup,
    links: [
      defaultTestLink({
        sourceGroup: discordGroup,
        targetGroup: twitchGroup,
        integrationId: INTEGRATION_ID
      }),
      defaultTestLink({
        sourceGroup: twitchGroup,
        targetGroup: discordGroup,
        integrationId: INTEGRATION_ID
      })
    ]
  };
}

async function publication({ group, sourceEventId, data }) {
  return {
    updateId: await deriveWidgetDataUpdateId({
      originGroupKey: group.key,
      sourceEventId
    }),
    data,
    origin: group.platform
  };
}

describe("@elmybot/feature-widget-data", () => {
  it("declares the frozen cross-platform publication contract", () => {
    const { action, discord, twitch } = definitions();

    expect(feature).toMatchObject({
      apiVersion: 1,
      id: FEATURE_ID,
      shareableState: [{
        id: WIDGET_DATA_NAMESPACE_ID,
        label: "Published widget data",
        schemaVersion: 1,
        compatibleVersions: [1],
        collisionSummary: { kind: "presence" }
      }]
    });
    expect(action).toMatchObject({
      kind: WIDGET_DATA_ACTION_KIND,
      capability: "framework.moderators",
      supportedOrigins: ["discord", "twitch"],
      uses: { services: ["shareableState"] },
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
  ])("accepts and publishes %s raw Twitch data for a moderator", async (_label, data) => {
    const runtime = createFeatureTestRuntime(feature);
    const group = twitchTestGroup();

    (await runtime.twitch.commandText("!widgetdata " + data, {
      group,
      actor: twitchTestModerator()
    })).toReply(UPDATED_MESSAGE);
    expect(runtime.shareableState.getStandalone(
      group,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toEqual(await publication({
      group,
      sourceEventId: "twitch:feature-test:command:1",
      data
    }));
  });

  it("publishes normalized Discord data for a moderator", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = discordTestGroup();

    (await runtime.discord.command("widget_data", {
      group,
      actor: discordTestModerator(),
      args: { data: "  hello   世界 🔥  " }
    })).toReply(UPDATED_MESSAGE);
    expect(runtime.shareableState.getStandalone(
      group,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toEqual(await publication({
      group,
      sourceEventId: "discord:feature-test:command:1",
      data: "hello   世界 🔥"
    }));
  });

  it("rejects empty and oversized input before publication", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();
    const oversized = "a".repeat(WIDGET_DATA_MAX_LENGTH + 1);

    await expect(runtime.twitch.commandText("!widgetdata   ", {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).rejects.toMatchObject({ code: "argument_validation_failed" });
    await expect(runtime.twitch.commandText("!widgetdata " + oversized, {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).rejects.toMatchObject({ code: "argument_validation_failed" });
    await expect(runtime.discord.command("widget_data", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { data: "   " }
    })).rejects.toMatchObject({ code: "action_arguments_invalid" });
    await expect(runtime.discord.command("widget_data", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { data: oversized }
    })).rejects.toMatchObject({ code: "action_arguments_invalid" });
    expect(runtime.shareableState.getStandalone(
      discordGroup,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toBeNull();
    expect(runtime.shareableState.getStandalone(
      twitchGroup,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toBeNull();
  });

  it("denies non-moderators before publication on Discord and Twitch", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();

    await expect(runtime.discord.command("widget_data", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { data: "hello" }
    })).rejects.toMatchObject({ code: "action_forbidden" });
    await expect(runtime.twitch.commandText("!widgetdata hello", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).rejects.toMatchObject({ code: "action_forbidden" });
    expect(runtime.shareableState.getStandalone(
      discordGroup,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toBeNull();
    expect(runtime.shareableState.getStandalone(
      twitchGroup,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toBeNull();
  });

  it("keeps standalone Discord and Twitch publications isolated", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();

    await runtime.discord.command("widget_data", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { data: "discord standalone" }
    });
    await runtime.twitch.commandText("!widgetdata twitch standalone", {
      group: twitchGroup,
      actor: twitchTestModerator()
    });

    expect(runtime.shareableState.getStandalone(
      discordGroup,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toEqual(await publication({
      group: discordGroup,
      sourceEventId: "discord:feature-test:command:1",
      data: "discord standalone"
    }));
    expect(runtime.shareableState.getStandalone(
      twitchGroup,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toEqual(await publication({
      group: twitchGroup,
      sourceEventId: "twitch:feature-test:command:2",
      data: "twitch standalone"
    }));
  });

  it("publishes both linked origins into the selected integration realm", async () => {
    const { discordGroup, twitchGroup, links } = linkedGroups();
    const runtime = createFeatureTestRuntime(feature, { defaultLinks: links });

    await runtime.discord.command("widget_data", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { data: "from discord" }
    });
    expect(runtime.shareableState.getIntegration(
      INTEGRATION_ID,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toEqual(await publication({
      group: discordGroup,
      sourceEventId: "discord:feature-test:command:1",
      data: "from discord"
    }));

    await runtime.twitch.commandText("!widgetdata from twitch", {
      group: twitchGroup,
      actor: twitchTestModerator()
    });
    expect(runtime.shareableState.getIntegration(
      INTEGRATION_ID,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    )).toEqual(await publication({
      group: twitchGroup,
      sourceEventId: "twitch:feature-test:command:2",
      data: "from twitch"
    }));
  });

  it("gives distinct source events distinct IDs even when data is unchanged", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = discordTestGroup();
    const actor = discordTestModerator();

    await runtime.discord.command("widget_data", {
      group,
      actor,
      args: { data: "same data" }
    });
    const first = runtime.shareableState.getStandalone(
      group,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    );
    runtime.clock.advance({ seconds: 1 });
    await runtime.discord.command("widget_data", {
      group,
      actor,
      args: { data: "same data" }
    });
    const second = runtime.shareableState.getStandalone(
      group,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    );

    expect(second).toMatchObject({ data: first.data, origin: first.origin });
    expect(second.updateId).not.toBe(first.updateId);
  });

  it("derives the same complete publication for a same-source retry", async () => {
    const { action } = definitions();
    const set = vi.fn(async () => undefined);
    const current = vi.fn(async () => ({ set }));
    const ctx = {
      origin: {
        group: {
          platform: "discord",
          key: "discord:guild:retry-guild"
        }
      },
      sourceEventId: "discord:interaction:retry-one",
      shareableState: { current }
    };

    await expect(action.execute(ctx, { data: "retry data" }))
      .resolves.toEqual({ output: { message: UPDATED_MESSAGE }, effects: [] });
    await expect(action.execute(ctx, { data: "retry data" }))
      .resolves.toEqual({ output: { message: UPDATED_MESSAGE }, effects: [] });

    expect(current).toHaveBeenCalledTimes(2);
    expect(current).toHaveBeenCalledWith("twitch", WIDGET_DATA_NAMESPACE_ID);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[0]).toEqual(set.mock.calls[1]);
    expect(set.mock.calls[0]).toEqual([
      WIDGET_DATA_STATE_KEY,
      await publication({
        group: ctx.origin.group,
        sourceEventId: ctx.sourceEventId,
        data: "retry data"
      })
    ]);
  });

  it("propagates a transition write failure without falling back", async () => {
    const { action } = definitions();
    const error = Object.assign(new Error("Shareable state is transitioning."), {
      code: "shareable_state_transitioning",
      retryable: true
    });
    const set = vi.fn(async () => {
      throw error;
    });
    const current = vi.fn(async () => ({ set }));
    const ctx = {
      origin: {
        group: {
          platform: "twitch",
          key: "twitch:channel:transitioning"
        }
      },
      sourceEventId: "twitch:eventsub:transitioning",
      shareableState: { current }
    };

    await expect(action.execute(ctx, { data: "not stored" })).rejects.toBe(error);
    expect(current).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledWith("discord", WIDGET_DATA_NAMESPACE_ID);
    expect(set).toHaveBeenCalledOnce();
  });

  it("keeps one complete last-writer-wins value for concurrent linked writes", async () => {
    const { discordGroup, twitchGroup, links } = linkedGroups();
    const runtime = createFeatureTestRuntime(feature, { defaultLinks: links });

    await Promise.all([
      runtime.discord.command("widget_data", {
        group: discordGroup,
        actor: discordTestModerator(),
        args: { data: "discord concurrent" }
      }),
      runtime.twitch.commandText("!widgetdata twitch concurrent", {
        group: twitchGroup,
        actor: twitchTestModerator()
      })
    ]);

    const finalValue = runtime.shareableState.getIntegration(
      INTEGRATION_ID,
      FEATURE_ID,
      WIDGET_DATA_NAMESPACE_ID,
      WIDGET_DATA_STATE_KEY
    );
    const candidates = await Promise.all([
      publication({
        group: discordGroup,
        sourceEventId: "discord:feature-test:command:1",
        data: "discord concurrent"
      }),
      publication({
        group: twitchGroup,
        sourceEventId: "twitch:feature-test:command:2",
        data: "twitch concurrent"
      })
    ]);
    expect(candidates).toContainEqual(finalValue);
    expect(Object.keys(finalValue).sort()).toEqual(["data", "origin", "updateId"]);
  });
});
