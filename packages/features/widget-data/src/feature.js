import {
  access,
  defineAction,
  defineDurableEventStream,
  defineFeature,
  discordActionCommand,
  discordOption,
  discordTextResult,
  frameworkApiVersion,
  schema,
  twitchActionCommand,
  twitchRestText,
  twitchTextResult
} from "@elmybot/framework";

export const WIDGET_DATA_ACTION_KIND = "widget.data.emit.v2";
export const WIDGET_DATA_MAX_LENGTH = 400;
export const WIDGET_DATA_STREAM_ID = "updates";
export const WIDGET_DATA_STREAM_VERSION = 1;

const QUEUED_MESSAGE = "Widget event queued.";

function otherPlatform(platform) {
  if (platform === "discord") return "twitch";
  if (platform === "twitch") return "discord";
  throw new Error("Widget data origin platform is invalid.");
}

export const widgetDataFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "widget.data",
  description: "Publishes every accepted widget command to a durable event consumer.",
  eventStreams: [
    defineDurableEventStream({
      id: WIDGET_DATA_STREAM_ID,
      version: 1,
      label: "Widget events",
      description: "Commands delivered to an authorized widget consumer.",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable" },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: {
            data: {
              type: "string",
              minLength: 1,
              maxLength: WIDGET_DATA_MAX_LENGTH
            },
            origin: { type: "string", minLength: 6, maxLength: 7 }
          },
          required: ["data", "origin"]
        }
      }
    })
  ],
  actions: [
    defineAction({
      kind: WIDGET_DATA_ACTION_KIND,
      capability: access.moderators,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        data: schema.string({
          minLength: 1,
          maxLength: WIDGET_DATA_MAX_LENGTH,
          trim: true
        })
      }),
      uses: { services: ["eventStreams"] },
      cooldown: { scope: "group", seconds: 1 },
      async execute(ctx, { data }) {
        const stream = await ctx.eventStreams.current(
          otherPlatform(ctx.origin.group.platform),
          WIDGET_DATA_STREAM_ID
        );
        await stream.publish({
          data,
          origin: ctx.origin.group.platform
        });
        return {
          output: { message: QUEUED_MESSAGE },
          effects: []
        };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "widget_data",
        description: "Publish a durable widget event.",
        usage: "/widget_data data:hello",
        availability: "guild",
        deferred: false,
        actionKind: WIDGET_DATA_ACTION_KIND,
        options: [
          discordOption({
            arg: "data",
            name: "data",
            description: "Data to publish to subscribed widgets.",
            type: "string",
            required: true,
            minLength: 1
            // The action schema owns the post-trim maximum. A Discord
            // maxLength would reject outer whitespace before normalization.
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "widgetdata",
        description: "Publish a durable widget event.",
        usage: "!widgetdata hello",
        actionKind: WIDGET_DATA_ACTION_KIND,
        parse: twitchRestText({
          arg: "data",
          minLength: 1,
          maxLength: WIDGET_DATA_MAX_LENGTH
        }),
        render: twitchTextResult
      })
    ]
  }
});

export default widgetDataFeature;
