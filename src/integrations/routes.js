import { defineRoute } from "../framework/index.js";
import {
  ANNOUNCEMENT_ROUTE_KINDS,
  announcementsFeature
} from "../features/announcements/feature.js";

const STREAM_ONLINE_ROUTE_KIND = "twitch.stream-online-to-discord.v1";
const legacyStreamOnlineRoute = defineRoute({
  kind: STREAM_ONLINE_ROUTE_KIND,
  sourcePlatform: "twitch",
  targetPlatform: "discord",
  destination: "link-channel",
  newIntegration: "enabled"
});

export const INTEGRATION_ROUTE_KINDS = Object.freeze({
  DISCORD_ANNOUNCE_TO_TWITCH: ANNOUNCEMENT_ROUTE_KINDS.DISCORD_TO_TWITCH,
  TWITCH_ANNOUNCE_TO_DISCORD: ANNOUNCEMENT_ROUTE_KINDS.TWITCH_TO_DISCORD,
  TWITCH_STREAM_ONLINE_TO_DISCORD: STREAM_ONLINE_ROUTE_KIND
});

const defaultRouteCatalog = Object.freeze([
  ...announcementsFeature.routes,
  legacyStreamOnlineRoute
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
