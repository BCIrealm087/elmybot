import {
  access,
  defineAction,
  defineDurableEventStream,
  defineFeature,
  defineReadableStateExport,
  defineStateEventOperation,
  discordActionCommand,
  discordOption,
  discordTextResult,
  frameworkApiVersion,
  schema,
  twitchActionCommand,
  twitchTextResult,
  twitchTokens
} from "@elmybot/framework";

export const FUN_HEALTH_ACTION_KIND = "fun.health.impact.v2";
export const FUN_HEALTH_STREAM_ID = "impacts";

const MAX_AMOUNT = 100;
const amount = schema.integer({ min: 1, max: MAX_AMOUNT, optional: true, default: 10 });
const operationInput = schema.object({ amount });
const scope = { kind: "effective_shareable", namespace: "health" };

function otherPlatform(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.health",
  description: "Stores shared health and queues one impact per accepted command.",
  shareableState: [{ id: "health", label: "Health", schemaVersion: 1, limits: { maxEntries: 10, maxValueBytes: 1024 } }],
  readableState: [defineReadableStateExport({
    id: "current", version: 1, label: "Current health", description: "Authoritative health, initially 100.", kind: "value",
    platforms: ["discord", "twitch"], scope, access: { kind: "operator_grant" }, parameters: {},
    result: { schema: { type: "integer", minimum: 0, maximum: 100 }, absence: { kind: "default" } },
    async resolve(ctx) { return { state: "present", value: await ctx.state.boundedCounter("health", "current", { min: 0, max: 100, initial: 100 }) }; }
  })],
  stateEvents: ["damage", "heal"].map((operation) => defineStateEventOperation({
    id: operation, scope, stream: { id: "impacts", version: 2 }, input: operationInput,
    mutation: { kind: "bounded_counter", name: "health", subject: { literal: "current" }, min: 0, max: 100, initial: 100,
      operation: operation === "damage" ? "decrement" : "increment", amount: { input: "amount" } },
    event: { operation: { literal: operation }, requestedAmount: { input: "amount" }, appliedAmount: { result: "appliedAmount" },
      before: { result: "before" }, after: { result: "after" }, changed: { result: "changed" } }
  })),

  eventStreams: [
    defineDurableEventStream({
      id: FUN_HEALTH_STREAM_ID,
      version: 1,
      label: "Legacy health impacts (v1)",
      description: "Legacy requested deltas; retained for old grants and backlog drain only.",
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
    }),
    defineDurableEventStream({ id: "impacts", version: 2, label: "Authoritative health impacts", description: "One committed damage/heal result per operation.",
      platforms: ["discord", "twitch"], scope: { kind: "effective_shareable" }, publication: { kind: "state_event", source: scope }, access: { kind: "operator_grant" },
      payload: { schema: { type: "object", properties: {
        operation: { type: "string", minLength: 4, maxLength: 6 }, requestedAmount: { type: "integer", minimum: 1, maximum: 100 },
        appliedAmount: { type: "integer", minimum: 0, maximum: 100 }, before: { type: "integer", minimum: 0, maximum: 100 },
        after: { type: "integer", minimum: 0, maximum: 100 }, changed: { type: "boolean" }
      }, required: ["operation", "requestedAmount", "appliedAmount", "before", "after", "changed"] } }
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
      uses: { services: ["stateEvents"], stateEvents: ["damage", "heal"] },
      cooldown: { scope: "group", seconds: 1 },

      async execute(ctx, { operation, amount }) {
        const impact = await ctx.stateEvents.current(
          otherPlatform(ctx.origin.group.platform),
          operation
        );

        await impact.commit({ amount });

        return {
          output: { message: "Health saved and impact queued." },
          effects: []
        };
      }
    })
  ],

  commands: {
    discord: [
      discordActionCommand({
        name: "health",
        description: "Save damage or healing and queue its widget impact.",
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
        description: "Save damage or healing and queue its widget impact.",
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
