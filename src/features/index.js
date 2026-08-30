import { createFeatureRegistry } from "../framework/index.js";
import { discordIntegrationEffectHandlers } from "../platforms/discord/integration-effects.js";
import { twitchIntegrationEffectHandlers } from "../platforms/twitch/integration-effects.js";
import { aliveFeature } from "./alive/feature.js";
import { announcementsFeature } from "./announcements/feature.js";
import { discordRoleAccessFeature } from "./discord-role-access/feature.js";

// Feature installation is explicit while legacy registries continue to coexist
// during the staged migration.
export const installedFeatures = Object.freeze([
  aliveFeature,
  announcementsFeature,
  discordRoleAccessFeature
]);
export const featureRegistry = createFeatureRegistry(installedFeatures, {
  effectAdapters: {
    discord: discordIntegrationEffectHandlers,
    twitch: twitchIntegrationEffectHandlers
  }
});
