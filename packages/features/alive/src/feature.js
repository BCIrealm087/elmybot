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
} from "@elmybot/framework";

export const ALIVE_ACTION_KIND = "core.health.check.v1";

export const aliveFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "core.alive",
  description: "A shared responsiveness check.",
  actions: [
    defineAction({
      kind: ALIVE_ACTION_KIND,
      capability: null,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({}),
      execute: () => ({
        output: { message: "I'm here!!1" },
        effects: []
      })
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "alive",
        description: "Replies if alive.",
        availability: "global",
        deferred: false,
        actionKind: ALIVE_ACTION_KIND,
        options: [],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "alive",
        description: "Replies if alive.",
        actionKind: ALIVE_ACTION_KIND,
        parse: twitchNoArgs(),
        render: twitchTextResult
      })
    ]
  }
});

export default aliveFeature;
