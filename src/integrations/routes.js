import {
  ANNOUNCEMENT_ROUTE_KINDS,
  announcementsFeature
} from "../features/announcements/feature.js";
import {
  STREAM_ONLINE_ROUTE_KIND,
  streamOnlineFeature
} from "../features/stream-online/feature.js";

export const INTEGRATION_ROUTE_KINDS = Object.freeze({
  DISCORD_ANNOUNCE_TO_TWITCH: ANNOUNCEMENT_ROUTE_KINDS.DISCORD_TO_TWITCH,
  TWITCH_ANNOUNCE_TO_DISCORD: ANNOUNCEMENT_ROUTE_KINDS.TWITCH_TO_DISCORD,
  TWITCH_STREAM_ONLINE_TO_DISCORD: STREAM_ONLINE_ROUTE_KIND
});

const defaultRouteCatalog = Object.freeze([
  ...announcementsFeature.routes,
  ...streamOnlineFeature.routes
]);

export function defaultDiscordTwitchRoutes(channelId) {
  return defaultRouteCatalog
    .filter((route) => route.newIntegration === "enabled")
    .map((route) => ({
      kind: route.kind,
      sourcePlatform: route.sourcePlatform,
      targetPlatform: route.targetPlatform,
      destination: route.destination === "link-channel" ? { channelId } : {}
    }));
}
