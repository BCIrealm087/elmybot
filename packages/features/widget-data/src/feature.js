import {
  access,
  defineAction,
  defineFeature,
  defineReadableStateExport,
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
export const WIDGET_DATA_READABLE_EXPORT_ID = "latest";
export const WIDGET_DATA_STATE_KEY = "latest";

const UPDATED_MESSAGE = "Widget data updated.";
const UPDATE_ID_PATTERN = /^wdu1\.[A-Za-z0-9_-]{43}$/;
const ORIGINS = new Set(["discord", "twitch"]);

function present(value) {
  return Object.freeze({ state: "present", value });
}

function isValidPublication(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.updateId === "string" &&
    UPDATE_ID_PATTERN.test(value.updateId) &&
    ORIGINS.has(value.origin)
  );
}

function otherPlatform(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

export const widgetDataFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "widget.data",
  description: "Publishes current widget data for state-query clients.",
  readableState: [
    defineReadableStateExport({
      id: WIDGET_DATA_READABLE_EXPORT_ID,
      version: 1,
      label: "Latest widget data",
      description: "The current string published for subscribed widgets.",
      kind: "value",
      platforms: ["discord", "twitch"],
      scope: {
        kind: "effective_shareable",
        namespace: WIDGET_DATA_NAMESPACE_ID
      },
      access: { kind: "operator_grant" },
      result: {
        schema: {
          type: "object",
          properties: {
            updateId: { type: "string", minLength: 48, maxLength: 48 },
            data: {
              type: "string",
              minLength: 1,
              maxLength: WIDGET_DATA_MAX_LENGTH
            },
            origin: { type: "string", minLength: 6, maxLength: 7 }
          },
          required: ["updateId", "data", "origin"]
        },
        absence: { kind: "absent" }
      },
      async resolve(ctx) {
        const latest = await ctx.state.get(WIDGET_DATA_STATE_KEY);
        if (!latest.found) return Object.freeze({ state: "absent" });
        if (!isValidPublication(latest.value)) {
          throw new Error("Stored widget data is invalid.");
        }
        return present(latest.value);
      }
    })
  ],
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
