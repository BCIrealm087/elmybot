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

export const RECIPE_SHAREABLE_ACTION_KIND = "recipe.shareable.run.v1";

const OPERATIONS = Object.freeze(["show", "plus", "minus", "reset"]);
const UPDATE_DENIED = "Only moderators can change the score.";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "recipe.shareable",
  description: "Tracks a standalone or linked score.",
  shareableState: [{
    id: "score",
    label: "Shareable score",
    schemaVersion: 1,
    collisionSummary: { kind: "presence" }
  }],
  actions: [
    defineAction({
      kind: RECIPE_SHAREABLE_ACTION_KIND,
      capability: null,
      conditionalAccess: [{
        capability: access.moderators,
        when: { argument: "operation", exceptValues: ["show"] }
      }],
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        operation: schema.enum(OPERATIONS, { optional: true, default: "show" })
      }),
      uses: { services: ["authorization", "shareableState"] },
      async execute(ctx, { operation }) {
        if (
          operation !== "show" &&
          !await ctx.authorization.allows(access.moderators)
        ) {
          return { output: { message: UPDATE_DENIED }, effects: [] };
        }

        const otherPlatform = ctx.origin.group.platform === "discord"
          ? "twitch"
          : "discord";
        const state = await ctx.shareableState.current(otherPlatform, "score");
        const score = state.boundedCounter("score", "shared");
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
        name: "shareable",
        description: "Show or update the score.",
        availability: "guild",
        actionKind: RECIPE_SHAREABLE_ACTION_KIND,
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
        name: "shareable",
        description: "Show or update the score.",
        actionKind: RECIPE_SHAREABLE_ACTION_KIND,
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
