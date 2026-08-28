export const INTEGRATION_ROUTE_KINDS = Object.freeze({
  TWITCH_ANNOUNCE_TO_DISCORD: "twitch.announce-to-discord.v1",
  TWITCH_STREAM_ONLINE_TO_DISCORD: "twitch.stream-online-to-discord.v1"
});

export function defaultTwitchToDiscordRoutes(channelId) {
  return [
    {
      kind: INTEGRATION_ROUTE_KINDS.TWITCH_ANNOUNCE_TO_DISCORD,
      sourcePlatform: "twitch",
      targetPlatform: "discord",
      destination: { channelId }
    },
    {
      kind: INTEGRATION_ROUTE_KINDS.TWITCH_STREAM_ONLINE_TO_DISCORD,
      sourcePlatform: "twitch",
      targetPlatform: "discord",
      destination: { channelId }
    }
  ];
}
