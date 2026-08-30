import { createFeatureRegistry } from "../framework/index.js";
import { FEATURE_RUNTIME_SERVICES } from "../framework/service-runtime.js";
import { discordIntegrationEffectHandlers } from "../platforms/discord/integration-effects.js";
import { twitchIntegrationEffectHandlers } from "../platforms/twitch/integration-effects.js";
import { aliveFeature } from "./alive/feature.js";
import { announcementsFeature } from "./announcements/feature.js";
import { discordRoleAccessFeature } from "./discord-role-access/feature.js";
import { counterFeature } from "./counter/feature.js";
import { streamOnlineFeature } from "./stream-online/feature.js";
import {
  scheduledTwitchAnnouncementsFeature
} from "./scheduled-twitch-announcements/feature.js";

// Feature installation is explicit while legacy registries continue to coexist
// during the staged migration.
export const installedFeatures = Object.freeze([
  aliveFeature,
  counterFeature,
  announcementsFeature,
  discordRoleAccessFeature,
  streamOnlineFeature,
  scheduledTwitchAnnouncementsFeature
]);
export const featureRegistry = createFeatureRegistry(installedFeatures, {
  availableServices: FEATURE_RUNTIME_SERVICES,
  effectAdapters: {
    discord: discordIntegrationEffectHandlers,
    twitch: twitchIntegrationEffectHandlers
  }
});
