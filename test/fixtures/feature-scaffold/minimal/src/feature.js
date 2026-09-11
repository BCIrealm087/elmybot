import {
  defineAction,
  defineFeature,
  discordActionCommand,
  discordTextResult,
  frameworkApiVersion,
  schema
} from "@elmybot/framework";

export const RECIPE_MINIMAL_ACTION_KIND = "recipe.minimal.run.v1";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "recipe.minimal",
  description: "TODO: describe recipe.minimal.",
  actions: [
    defineAction({
      kind: RECIPE_MINIMAL_ACTION_KIND,
      capability: null,
      supportedOrigins: ["discord"],
      input: schema.object({}),
      execute: () => ({
        output: { message: "TODO: minimal" },
        effects: []
      })
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "minimal",
        description: "TODO: describe this command.",
        availability: "guild",
        actionKind: RECIPE_MINIMAL_ACTION_KIND,
        render: discordTextResult
      })
    ]
  }
});

export default feature;
