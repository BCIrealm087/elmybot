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
  twitchTextResult,
  twitchTokens
} from "@elmybot/framework";

export const RECIPE_LOCAL_ACTION_KIND = "recipe.local.run.v1";

const OPERATIONS = Object.freeze(["show", "plus", "minus", "reset"]);
const UPDATE_DENIED = "Only moderators can change the score.";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "recipe.local",
  description: "Tracks a group-local score.",
  actions: [
    defineAction({
      kind: RECIPE_LOCAL_ACTION_KIND,
      capability: null,
      conditionalAccess: [{
        capability: access.moderators,
        when: { argument: "operation", exceptValues: ["show"] }
      }],
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        operation: schema.enum(OPERATIONS, { optional: true, default: "show" })
      }),
      uses: { services: ["authorization", "state"] },
      async execute(ctx, { operation }) {
        if (
          operation !== "show" &&
          !await ctx.authorization.allows(access.moderators)
        ) {
          return { output: { message: UPDATE_DENIED }, effects: [] };
        }

        const score = ctx.state.boundedCounter("score", "shared");
        let value;
        if (operation === "plus") value = await score.increment();
        else if (operation === "minus") value = await score.decrement();
        else if (operation === "reset") value = await score.reset();
        else value = await score.get();

        return { output: { message: `Score: ${value}` }, effects: [] };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "local",
        description: "Show or update the score.",
        availability: "guild",
        actionKind: RECIPE_LOCAL_ACTION_KIND,
        options: [
          discordOption({
            arg: "operation",
            name: "operation",
            description: "Show, increase, decrease, or reset the score.",
            type: "string",
            required: false
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "local",
        description: "Show or update the score.",
        actionKind: RECIPE_LOCAL_ACTION_KIND,
        parse: twitchTokens([{
          arg: "operation",
          type: "string",
          optional: true,
          default: "show"
        }]),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;
