import { describe, expect, it } from "vitest";
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
  featureRegistry,
  installedFeatures
} from "../src/features/index.js";
import { commands as discordCommands } from "../src/platforms/discord/commands.js";
import { CAPABILITIES } from "../src/platforms/discord/discord-permissions.js";
import { commands as twitchCommands } from "../src/platforms/twitch/commands.js";

describe("Representative feature migrations", () => {
  it("installs alive as one shared action with two command presentations", () => {
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

  it("installs announcements as one routed action with two route directions", () => {
    expect(installedFeatures.map(({ id }) => id))
      .toContain("integrations.announcements");
    expect(featureRegistry.actions[ANNOUNCEMENT_ACTION_KIND]).toMatchObject({
      featureId: "integrations.announcements",
      supportedOrigins: ["discord", "twitch"]
    });
    expect(Object.keys(featureRegistry.routes)).toEqual(
      Object.values(ANNOUNCEMENT_ROUTE_KINDS)
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
});
