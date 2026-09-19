import {
  access,
  defineAction,
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
import { deriveWidgetDataUpdateId } from "./update-id.js";

export { deriveWidgetDataUpdateId };

export const WIDGET_DATA_ACTION_KIND = "widget.data.publish.v1";
export const WIDGET_DATA_MAX_LENGTH = 400;
export const WIDGET_DATA_NAMESPACE_ID = "published_data";
export const WIDGET_DATA_STATE_KEY = "latest";

const UPDATED_MESSAGE = "Widget data updated.";

function otherPlatform(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

export const widgetDataFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "widget.data",
  description: "Publishes current widget data for state-query clients.",
  shareableState: [{
    id: WIDGET_DATA_NAMESPACE_ID,
    label: "Published widget data",
    schemaVersion: 1,
    collisionSummary: { kind: "presence" }
  }],
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
      uses: { services: ["shareableState"] },
      cooldown: { scope: "group", seconds: 1 },
      async execute(ctx, { data }) {
        const state = await ctx.shareableState.current(
          otherPlatform(ctx.origin.group.platform),
          WIDGET_DATA_NAMESPACE_ID
        );
        const publication = Object.freeze({
          updateId: await deriveWidgetDataUpdateId({
            originGroupKey: ctx.origin.group.key,
            sourceEventId: ctx.sourceEventId
          }),
          data,
          origin: ctx.origin.group.platform
        });
        await state.set(WIDGET_DATA_STATE_KEY, publication);
        return {
          output: { message: UPDATED_MESSAGE },
          effects: []
        };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "widget_data",
        description: "Publish the current widget data.",
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
            minLength: 1,
            maxLength: WIDGET_DATA_MAX_LENGTH
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "widgetdata",
        description: "Publish the current widget data.",
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
