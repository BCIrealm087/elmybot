import { describe, expect, it } from "vitest";
import { CORE_ACTION_KINDS, coreActions } from "../src/actions/index.js";
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
});
