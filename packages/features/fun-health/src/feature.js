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
  twitchTextResult,
  twitchTokens
} from "@elmybot/framework";

export const FUN_HEALTH_ACTION_KIND = "fun.health.impact.v1";
export const FUN_HEALTH_STREAM_ID = "impacts";

const MAX_AMOUNT = 100;

function otherPlatform(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.health",
  description: "Sends damage and healing events to a health-bar widget.",

  eventStreams: [
    defineDurableEventStream({
      id: FUN_HEALTH_STREAM_ID,
      version: 1,
      label: "Health impacts",
      description: "One damage or healing event per accepted command.",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable" },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: {
            operation: { type: "string", minLength: 4, maxLength: 6 },
            amount: { type: "integer", minimum: 1, maximum: MAX_AMOUNT }
          },
          required: ["operation", "amount"]
        }
      }
    })
  ],

  actions: [
    defineAction({
      kind: FUN_HEALTH_ACTION_KIND,
      capability: access.moderators,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        operation: schema.enum(["damage", "heal"]),
        amount: schema.integer({
          min: 1,
          max: MAX_AMOUNT,
          optional: true,
          default: 10
        })
      }),
      uses: { services: ["eventStreams"] },
      cooldown: { scope: "group", seconds: 1 },

      async execute(ctx, { operation, amount }) {
        const stream = await ctx.eventStreams.current(
          otherPlatform(ctx.origin.group.platform),
          FUN_HEALTH_STREAM_ID
        );

        await stream.publish({ operation, amount });

        return {
          output: { message: "Health event queued." },
          effects: []
        };
      }
    })
  ],

  commands: {
    discord: [
      discordActionCommand({
        name: "health",
        description: "Send damage or healing to the health-bar widget.",
        usage: "/health operation:damage amount:15",
        availability: "guild",
        actionKind: FUN_HEALTH_ACTION_KIND,
        options: [
          discordOption({
            arg: "operation",
            name: "operation",
            description: "Damage or heal.",
            type: "string",
            required: true
          }),
          discordOption({
            arg: "amount",
            name: "amount",
            description: "Amount from 1 to 100; defaults to 10.",
            type: "integer",
            required: false,
            min: 1,
            max: MAX_AMOUNT
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "health",
        description: "Send damage or healing to the health-bar widget.",
        usage: "!health damage 15",
        actionKind: FUN_HEALTH_ACTION_KIND,
        parse: twitchTokens([
          { arg: "operation", type: "string" },
          { arg: "amount", type: "integer", optional: true }
        ]),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;