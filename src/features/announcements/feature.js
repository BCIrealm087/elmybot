import {
  defineAction,
  defineFeature,
  defineRoute,
  discordActionCommand,
  discordOption,
  discordTextResult,
  schema,
  twitchActionCommand,
  twitchRestText,
  twitchTextResult
} from "../../framework/index.js";

export const ANNOUNCEMENT_ACTION_KIND = "integration.announcement.publish.v1";
export const ANNOUNCEMENT_CAPABILITY = "integration.announcement.publish";
export const ANNOUNCEMENT_ROUTE_KINDS = Object.freeze({
  DISCORD_TO_TWITCH: "discord.announce-to-twitch.v1",
  TWITCH_TO_DISCORD: "twitch.announce-to-discord.v1"
});
export const ANNOUNCEMENT_EFFECT_KINDS = Object.freeze({
  DISCORD_MESSAGE: "discord.message.send.v1",
  TWITCH_CHAT: "twitch.chat.send.v1"
});

function targetName(platform, count) {
  const name = platform === "twitch" ? "Twitch" : "Discord";
  return `${name} ${count === 1 ? "channel" : "channels"}`;
}

const discordToTwitch = defineRoute({
  kind: ANNOUNCEMENT_ROUTE_KINDS.DISCORD_TO_TWITCH,
  sourcePlatform: "discord",
  targetPlatform: "twitch",
  destination: "none",
  newIntegration: "enabled"
});

const twitchToDiscord = defineRoute({
  kind: ANNOUNCEMENT_ROUTE_KINDS.TWITCH_TO_DISCORD,
  sourcePlatform: "twitch",
  targetPlatform: "discord",
  destination: "link-channel",
  newIntegration: "enabled"
});

export const announcementsFeature = defineFeature({
  apiVersion: 1,
  id: "integrations.announcements",
  description: "Publishes immediate announcements across linked platforms.",
  routes: [discordToTwitch, twitchToDiscord],
  actions: [
    defineAction({
      kind: ANNOUNCEMENT_ACTION_KIND,
      capability: ANNOUNCEMENT_CAPABILITY,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        message: schema.string({ minLength: 1, maxLength: 2_000, trim: true })
      }),
      uses: {
        routes: Object.values(ANNOUNCEMENT_ROUTE_KINDS),
        effects: Object.values(ANNOUNCEMENT_EFFECT_KINDS)
      },
      async execute(ctx, { message }) {
        const targetPlatform = ctx.origin.group.platform === "discord"
          ? "twitch"
          : "discord";
        const routeKind = targetPlatform === "twitch"
          ? ANNOUNCEMENT_ROUTE_KINDS.DISCORD_TO_TWITCH
          : ANNOUNCEMENT_ROUTE_KINDS.TWITCH_TO_DISCORD;
        const routes = await ctx.routes.resolve(routeKind);
        return {
          output: {
            message: routes.length === 0
              ? `No ${targetPlatform === "twitch" ? "Twitch" : "Discord"} ` +
                "announcement route is configured."
              : `Announcement queued for ${routes.length} ` +
                `${targetName(targetPlatform, routes.length)}.`
          },
          effects: routes.map((route) => ctx.effects.routedMessage(route, { message }))
        };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "integration_announce_twitch",
        description: "Publish an announcement to linked Twitch channels.",
        availability: "guild",
        deferred: true,
        actionKind: ANNOUNCEMENT_ACTION_KIND,
        options: [
          discordOption({
            arg: "message",
            name: "message",
            description: "Message to send to linked Twitch chats.",
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 500
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "announce",
        description: "Publishes an announcement to linked Discord channels.",
        actionKind: ANNOUNCEMENT_ACTION_KIND,
        parse: twitchRestText({ arg: "message", minLength: 1, maxLength: 2_000 }),
        render: twitchTextResult
      })
    ]
  }
});

export default announcementsFeature;
