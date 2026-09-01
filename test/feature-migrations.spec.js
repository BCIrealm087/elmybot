import { describe, expect, it } from "vitest";
import packagedAliveFeature from "@elmybot/feature-alive";
import {
  CORE_ACTION_KINDS,
  coreActions,
  integrationActions
} from "../src/actions/index.js";
import {
  ANNOUNCEMENT_ACTION_KIND,
  ANNOUNCEMENT_ROUTE_KINDS
} from "../src/features/announcements/feature.js";
import {
  SCHEDULED_TWITCH_ANNOUNCEMENT_KIND
} from "../src/features/scheduled-twitch-announcements/feature.js";
import { COUNTER_ACTION_KIND } from "../src/features/counter/feature.js";
import {
  STREAM_ONLINE_ACTION_KIND,
  STREAM_ONLINE_EVENT_KIND,
  STREAM_ONLINE_ROUTE_KIND
} from "../src/features/stream-online/feature.js";
import {
  featureRegistry,
  installedFeatures
} from "../src/features/index.js";
import { commands as discordCommands } from "../src/platforms/discord/commands.js";
import { CAPABILITIES } from "../src/platforms/discord/discord-permissions.js";
import { commands as twitchCommands } from "../src/platforms/twitch/commands.js";

describe("Representative feature migrations", () => {
  it("installs alive as one shared action with two command presentations", () => {
    expect(installedFeatures).toContain(packagedAliveFeature);
    expect(installedFeatures.map(({ id }) => id)).toContain("core.alive");
    expect(featureRegistry.actions[CORE_ACTION_KINDS.ALIVE]).toMatchObject({
      featureId: "core.alive",
      supportedOrigins: ["discord", "twitch"]
    });
    expect(featureRegistry.commands.discord.alive).toMatchObject({
      mode: "action-command",
      actionKind: CORE_ACTION_KINDS.ALIVE
    });
    expect(featureRegistry.commands.twitch.alive).toMatchObject({
      mode: "action-command",
      actionKind: CORE_ACTION_KINDS.ALIVE
    });
    expect(discordCommands.alive.actionKind).toBe(CORE_ACTION_KINDS.ALIVE);
    expect(twitchCommands.alive.actionKind).toBe(CORE_ACTION_KINDS.ALIVE);
    expect(coreActions).toEqual({});
  });

  it("installs role access as a Discord-native protected command", () => {
    expect(installedFeatures.map(({ id }) => id)).toContain("discord.role-access");
    expect(featureRegistry.commands.discord.config_allow_role).toMatchObject({
      mode: "native-command",
      availability: "guild",
      capability: CAPABILITIES.CONFIG_MANAGE
    });
    expect(featureRegistry.commands.twitch.config_allow_role).toBeUndefined();
    expect(discordCommands.config_allow_role).toMatchObject({
      deferred: true,
      guild: { capability: CAPABILITIES.CONFIG_MANAGE }
    });
    expect(discordCommands.config_allow_role.options).toEqual([{
      name: "role",
      description: "Role to allow",
      type: 8,
      required: true
    }]);
  });

  it("installs the shared counter as the stateful feature proof", () => {
    expect(installedFeatures.map(({ id }) => id)).toContain("fun.counter");
    expect(featureRegistry.actions[COUNTER_ACTION_KIND]).toMatchObject({
      featureId: "fun.counter",
      uses: { services: ["config", "state"] },
      cooldown: { scope: "actor", seconds: 5 }
    });
    expect(featureRegistry.commands.discord.counter).toMatchObject({
      actionKind: COUNTER_ACTION_KIND,
      availability: "guild"
    });
    expect(featureRegistry.commands.twitch.counter).toMatchObject({
      actionKind: COUNTER_ACTION_KIND
    });
    expect(discordCommands.counter.actionKind).toBe(COUNTER_ACTION_KIND);
    expect(twitchCommands.counter.actionKind).toBe(COUNTER_ACTION_KIND);
    expect(featureRegistry.services).toEqual([
      "authorization",
      "config",
      "links",
      "random",
      "state"
    ]);
  });

  it("installs announcements as one routed action with two route directions", () => {
    expect(installedFeatures.map(({ id }) => id))
      .toContain("integrations.announcements");
    expect(featureRegistry.actions[ANNOUNCEMENT_ACTION_KIND]).toMatchObject({
      featureId: "integrations.announcements",
      supportedOrigins: ["discord", "twitch"]
    });
    expect(Object.keys(featureRegistry.routes)).toEqual(
      expect.arrayContaining(Object.values(ANNOUNCEMENT_ROUTE_KINDS))
    );
    expect(featureRegistry.commands.discord.integration_announce_twitch)
      .toMatchObject({ mode: "action-command", actionKind: ANNOUNCEMENT_ACTION_KIND });
    expect(featureRegistry.commands.twitch.announce)
      .toMatchObject({ mode: "action-command", actionKind: ANNOUNCEMENT_ACTION_KIND });
    expect(discordCommands.integration_announce_twitch.actionKind)
      .toBe(ANNOUNCEMENT_ACTION_KIND);
    expect(twitchCommands.announce.actionKind).toBe(ANNOUNCEMENT_ACTION_KIND);
    expect(integrationActions).toEqual({});
  });

  it("installs stream events and bounded-random action schedules", () => {
    expect(featureRegistry.events[STREAM_ONLINE_EVENT_KIND]).toMatchObject({
      actionKind: STREAM_ONLINE_ACTION_KIND
    });
    expect(featureRegistry.routes[STREAM_ONLINE_ROUTE_KIND]).toMatchObject({
      sourcePlatform: "twitch",
      targetPlatform: "discord"
    });
    expect(featureRegistry.schedules[SCHEDULED_TWITCH_ANNOUNCEMENT_KIND])
      .toMatchObject({
        actionKind: ANNOUNCEMENT_ACTION_KIND,
        timing: "bounded-random",
        authorization: "grant-at-creation"
      });
    expect(featureRegistry.commands.discord.integration_schedule_twitch)
      .toMatchObject({
        mode: "scheduled-action-command",
        scheduleKind: SCHEDULED_TWITCH_ANNOUNCEMENT_KIND
      });
    expect(discordCommands.integration_schedule_twitch).toMatchObject({
      scheduleKind: SCHEDULED_TWITCH_ANNOUNCEMENT_KIND,
      guild: { capability: "integration.announcement.publish" }
    });
  });
});
