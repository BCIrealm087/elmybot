import { describe, expect, it } from "vitest";
import { ActionRegistryError } from "../src/actions/registry.js";
import { aliveFeature } from "../src/features/alive/feature.js";
import {
  ANNOUNCEMENT_CAPABILITY,
  ANNOUNCEMENT_ROUTE_KINDS,
  announcementsFeature
} from "../src/features/announcements/feature.js";
import { counterFeature } from "../src/features/counter/feature.js";
import { discordRoleAccessFeature } from "../src/features/discord-role-access/feature.js";
import {
  SCHEDULED_TWITCH_ANNOUNCEMENT_KIND,
  scheduledTwitchAnnouncementsFeature
} from "../src/features/scheduled-twitch-announcements/feature.js";
import {
  STREAM_ONLINE_EVENT_KIND,
  STREAM_ONLINE_ROUTE_KIND,
  streamOnlineFeature
} from "../src/features/stream-online/feature.js";
import {
  defineAction,
  defineFeature,
  discordActionCommand,
  discordTextResult,
  frameworkApiVersion,
  schema,
  twitchActionCommand,
  twitchNoArgs,
  twitchTextResult
} from "../src/framework/index.js";
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestActor,
  discordTestGroup,
  linkedTestRoute,
  twitchTestActor,
  twitchTestGroup
} from "../src/framework/testing.js";

const DEFAULT_LINK_ACTION_KIND = "test.default-link.show.v1";
const defaultLinkFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "test.default-link",
  description: "Exercises the contributor-facing default-link resolver.",
  actions: [
    defineAction({
      kind: DEFAULT_LINK_ACTION_KIND,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({}),
      uses: { services: ["links"] },
      async execute(ctx) {
        const target = ctx.origin.group.platform === "discord"
          ? "twitch"
          : "discord";
        const link = await ctx.links.default(target);
        return {
          output: {
            message: link === null ? "No default link." : link.targetGroup.id,
            snapshotFrozen: link === null || Object.isFrozen(link)
          },
          effects: []
        };
      }
    })
  ],
  commands: {
    discord: [discordActionCommand({
      name: "default_link",
      description: "Show the default linked Twitch channel.",
      availability: "guild",
      deferred: false,
      actionKind: DEFAULT_LINK_ACTION_KIND,
      options: [],
      render: discordTextResult
    })],
    twitch: [twitchActionCommand({
      name: "default_link",
      description: "Show the default linked Discord server.",
      actionKind: DEFAULT_LINK_ACTION_KIND,
      parse: twitchNoArgs(),
      render: twitchTextResult
    })]
  }
});

describe("Feature test kit", () => {
  it("executes one shared action through Discord and Twitch commands", async () => {
    const runtime = createFeatureTestRuntime(aliveFeature);

    (await runtime.discord.command("alive")).toReply("I'm here!!1");
    (await runtime.twitch.command("alive")).toReply("I'm here!!1");
  });

  it("accepts raw Twitch command text and rejects text outside the command boundary", async () => {
    const runtime = createFeatureTestRuntime(aliveFeature);

    (await runtime.twitch.commandText("  !ALIVE  ")).toReply("I'm here!!1");
    (await runtime.twitch.commandText("!ALIVE \u034F")).toReply("I'm here!!1");
    (await runtime.twitch.commandText("!ALIVE \u{E0000}")).toReply("I'm here!!1");
    await expect(runtime.twitch.commandText("hello chat")).rejects.toMatchObject({
      code: "feature_test_twitch_command_text_invalid"
    });
    await expect(runtime.twitch.commandText("!missing")).rejects.toMatchObject({
      code: "feature_test_command_not_found"
    });
  });

  it("executes platform-native commands and records narrow adapter operations", async () => {
    const runtime = createFeatureTestRuntime(discordRoleAccessFeature);
    const manager = discordTestActor({
      capabilities: ["framework.members", "config.manage"]
    });
    const result = await runtime.discord.command("config_allow_role", {
      actor: manager,
      args: { role: "role-1" }
    });

    result.toReply("Successfully added <@&role-1> to allowed roles.");
    expect(result.nativeOperations).toEqual([{
      kind: "discord.role.allow",
      roleId: "role-1"
    }]);
    await expect(runtime.discord.command("config_allow_role", {
      actor: discordTestActor(),
      args: { role: "role-1" }
    })).rejects.toBeInstanceOf(ActionRegistryError);
  });

  it("resolves linked routes and exposes routed effects for inspection", async () => {
    const discordGroup = discordTestGroup({ id: "guild-1" });
    const twitchGroup = twitchTestGroup({ id: "channel-1" });
    const route = linkedTestRoute({
      kind: ANNOUNCEMENT_ROUTE_KINDS.DISCORD_TO_TWITCH,
      sourceGroup: discordGroup,
      targetGroup: twitchGroup
    });
    const runtime = createFeatureTestRuntime(announcementsFeature, {
      routes: [route]
    });
    const actor = discordTestActor({
      capabilities: ["framework.members", ANNOUNCEMENT_CAPABILITY]
    });

    const result = await runtime.discord.command("integration_announce_twitch", {
      group: discordGroup,
      actor,
      args: { message: "Hello from Discord" }
    });

    result
      .toReply("Announcement queued for 1 Twitch channel.")
      .toEmitTwitchChat("Hello from Discord");
  });

  it("models directional default links without exposing registry mutation", async () => {
    const discordGroup = discordTestGroup({ id: "default-guild" });
    const twitchGroup = twitchTestGroup({ id: "default-channel" });
    const reverseDiscordGroup = discordTestGroup({ id: "reverse-guild" });
    const runtime = createFeatureTestRuntime(defaultLinkFeature, {
      defaultLinks: [
        defaultTestLink({
          sourceGroup: discordGroup,
          targetGroup: twitchGroup,
          integrationId: "integration-forward"
        }),
        defaultTestLink({
          sourceGroup: twitchGroup,
          targetGroup: reverseDiscordGroup,
          integrationId: "integration-reverse"
        })
      ]
    });

    const discordResult = await runtime.discord.command("default_link", {
      group: discordGroup
    });
    discordResult.toReply("default-channel");
    expect(discordResult.output.snapshotFrozen).toBe(true);
    (await runtime.twitch.command("default_link", { group: twitchGroup }))
      .toReply("reverse-guild");

    runtime.links.set([]);
    (await runtime.discord.command("default_link", { group: discordGroup }))
      .toReply("No default link.");

    expect(() => defaultTestLink({
      sourceGroup: discordGroup,
      targetGroup: discordTestGroup({ id: "same-platform" })
    })).toThrow("must connect different platforms");
    expect(() => createFeatureTestRuntime(defaultLinkFeature, {
      defaultLinks: [
        defaultTestLink({ sourceGroup: discordGroup, targetGroup: twitchGroup }),
        defaultTestLink({
          sourceGroup: discordGroup,
          targetGroup: twitchTestGroup({ id: "duplicate-direction" })
        })
      ]
    })).toThrow("must not contain duplicate directions");
  });

  it("maps authenticated events into actions and Discord effects", async () => {
    const twitchGroup = twitchTestGroup({ id: "live-channel" });
    const discordGroup = discordTestGroup({ id: "notice-guild" });
    const runtime = createFeatureTestRuntime(streamOnlineFeature, {
      routes: [linkedTestRoute({
        kind: STREAM_ONLINE_ROUTE_KIND,
        sourceGroup: twitchGroup,
        targetGroup: discordGroup,
        destination: { channelId: "notice-channel" }
      })]
    });

    const result = await runtime.event(STREAM_ONLINE_EVENT_KIND, {
      group: twitchGroup,
      payload: {
        streamId: "stream-1",
        broadcasterLogin: "elmy",
        broadcasterName: "Elmy",
        streamType: "live"
      }
    });

    result.toEmitDiscordMessage(
      "🔴 Elmy is live on Twitch! https://www.twitch.tv/elmy"
    );
    expect(result.triggerKind).toBe("event");
  });

  it("advances fake time, prepares a schedule occurrence, and replays its plan", async () => {
    const discordGroup = discordTestGroup({ id: "schedule-guild" });
    const twitchGroup = twitchTestGroup({ id: "schedule-channel" });
    const runtime = createFeatureTestRuntime([
      announcementsFeature,
      scheduledTwitchAnnouncementsFeature
    ], {
      routes: [linkedTestRoute({
        kind: ANNOUNCEMENT_ROUTE_KINDS.DISCORD_TO_TWITCH,
        sourceGroup: discordGroup,
        targetGroup: twitchGroup
      })]
    });
    const actor = discordTestActor({
      capabilities: ["framework.members", ANNOUNCEMENT_CAPABILITY]
    });

    const created = await runtime.discord.command("integration_schedule_twitch", {
      group: discordGroup,
      actor,
      args: {
        message: "Scheduled hello",
        min_interval: 600,
        max_interval: 600
      }
    });
    created.toSchedule(SCHEDULED_TWITCH_ANNOUNCEMENT_KIND);
    expect(await runtime.schedules.runDue()).toEqual([]);

    runtime.clock.advance({ seconds: 600 });
    const [occurrence] = await runtime.schedules.runDue();
    occurrence.toEmitTwitchChat("Scheduled hello");
    expect(occurrence.occurrencePlan).toMatchObject({
      actionKind: "integration.announcement.publish.v1",
      actionArgs: { message: "Scheduled hello" }
    });
    runtime.schedules.replay(occurrence.occurrencePlan)
      .toEmitTwitchChat("Scheduled hello");
  });

  it("models namespaced config, state, and actor cooldowns", async () => {
    const discordGroup = discordTestGroup({ id: "counter-guild" });
    const twitchGroup = twitchTestGroup({ id: "counter-channel" });
    const runtime = createFeatureTestRuntime(counterFeature);
    const firstActor = discordTestActor({ id: "user-1" });
    const secondActor = discordTestActor({ id: "user-2" });
    runtime.config.set(discordGroup, "fun.counter", "label", "Wins");

    (await runtime.discord.command("counter", {
      group: discordGroup,
      actor: firstActor
    })).toReply("Wins: 1");
    await expect(runtime.discord.command("counter", {
      group: discordGroup,
      actor: firstActor
    })).rejects.toMatchObject({ code: "action_cooldown_active" });
    (await runtime.discord.command("counter", {
      group: discordGroup,
      actor: secondActor
    })).toReply("Wins: 2");
    expect(runtime.state.get(discordGroup, "fun.counter", "value")).toBe(2);

    (await runtime.twitch.command("counter", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Counter: 1");
  });
});
