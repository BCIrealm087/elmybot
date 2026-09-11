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

export const RECIPE_SHARED_ACTION_KIND = "recipe.shared.run.v1";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "recipe.shared",
  description: "TODO: describe recipe.shared.",
  actions: [
    defineAction({
      kind: RECIPE_SHARED_ACTION_KIND,
      capability: null,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({}),
      execute: () => ({
        output: { message: "TODO: shared" },
        effects: []
      })
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "shared",
        description: "TODO: describe this command.",
        availability: "guild",
        actionKind: RECIPE_SHARED_ACTION_KIND,
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "shared",
        description: "TODO: describe this command.",
        actionKind: RECIPE_SHARED_ACTION_KIND,
        parse: twitchNoArgs(),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;
