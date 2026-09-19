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

const pendingMessage = "Widget data publishing is not available yet.";

export const widgetDataFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "widget.data",
  description: "Publishes current widget data for state-query clients.",
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
      cooldown: { scope: "group", seconds: 1 },
      execute: () => ({
        output: { message: pendingMessage },
        effects: []
      })
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
