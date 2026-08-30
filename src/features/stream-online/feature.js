import {
  defineAction,
  defineEventAction,
  defineFeature,
  defineRoute,
  schema
} from "../../framework/index.js";

export const STREAM_ONLINE_EVENT_KIND = "twitch.stream.online.v1";
export const STREAM_ONLINE_ACTION_KIND = "twitch.stream-online.publish.v1";
export const STREAM_ONLINE_ROUTE_KIND = "twitch.stream-online-to-discord.v1";

export const streamOnlineFeature = defineFeature({
  apiVersion: 1,
  id: "twitch.stream-online",
  description: "Publishes authenticated Twitch stream-online events to linked Discord channels.",
  routes: [
    defineRoute({
      kind: STREAM_ONLINE_ROUTE_KIND,
      sourcePlatform: "twitch",
      targetPlatform: "discord",
      destination: "link-channel",
      newIntegration: "enabled",
      existingIntegration: "disabled"
    })
  ],
  actions: [
    defineAction({
      kind: STREAM_ONLINE_ACTION_KIND,
      capability: null,
      supportedOrigins: ["twitch"],
      input: schema.object({
        stream_id: schema.string({ minLength: 1, maxLength: 200 }),
        broadcaster_login: schema.string({ minLength: 1, maxLength: 25 }),
        broadcaster_name: schema.string({ minLength: 1, maxLength: 100 }),
        stream_type: schema.string({ minLength: 1, maxLength: 100 })
      }),
      uses: {
        routes: [STREAM_ONLINE_ROUTE_KIND],
        effects: ["discord.message.send.v1"]
      },
      async execute(ctx, { broadcaster_login, broadcaster_name }) {
        const routes = await ctx.routes.resolve(STREAM_ONLINE_ROUTE_KIND);
        const content = `🔴 ${broadcaster_name} is live on Twitch! ` +
          `https://www.twitch.tv/${broadcaster_login}`;
        return {
          output: { routedChannels: routes.length },
          effects: routes.map((route) =>
            ctx.effects.discord.message(route, { content })
          )
        };
      }
    })
  ],
  events: [
    defineEventAction({
      eventKind: STREAM_ONLINE_EVENT_KIND,
      actionKind: STREAM_ONLINE_ACTION_KIND,
      mapPayload: (event) => ({
        stream_id: event.payload.streamId,
        broadcaster_login: event.payload.broadcasterLogin,
        broadcaster_name: event.payload.broadcasterName,
        stream_type: event.payload.streamType
      })
    })
  ]
});

export default streamOnlineFeature;
