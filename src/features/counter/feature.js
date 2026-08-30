import {
  defineAction,
  defineFeature,
  discordActionCommand,
  discordTextResult,
  frameworkApiVersion,
  schema,
  twitchActionCommand,
  twitchNoArgs,
  twitchTextResult
} from "../../framework/index.js";

export const COUNTER_ACTION_KIND = "fun.counter.increment.v1";

function counterLabel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    ? value
    : "Counter";
}

export const counterFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.counter",
  description: "A shared, per-platform-group counter demonstrating durable feature state.",
  actions: [
    defineAction({
      kind: COUNTER_ACTION_KIND,
      capability: null,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({}),
      uses: { services: ["config", "state"] },
      cooldown: { scope: "actor", seconds: 5 },
      async execute(ctx) {
        const label = counterLabel(await ctx.config.get("label"));
        const value = await ctx.state.increment("value");
        return {
          output: { message: `${label}: ${value}` },
          effects: []
        };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "counter",
        description: "Increment this server's feature counter.",
        availability: "guild",
        deferred: false,
        actionKind: COUNTER_ACTION_KIND,
        options: [],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "counter",
        description: "Increment this channel's feature counter.",
        actionKind: COUNTER_ACTION_KIND,
        parse: twitchNoArgs(),
        render: twitchTextResult
      })
    ]
  }
});

export default counterFeature;
