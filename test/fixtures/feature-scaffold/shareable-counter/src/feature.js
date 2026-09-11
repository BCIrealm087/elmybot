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
      // Opt-in enforcement and catalog access come from these same rules.
      // conditionalAccess alone is metadata and still needs an explicit guard.
      modePolicy: {
        rules: [{
          capability: access.moderators,
          when: { argument: "operation", exceptValues: ["show"] }
        }],
        deniedOutput: { message: UPDATE_DENIED }
      },
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        operation: schema.enum(OPERATIONS, { optional: true, default: "show" })
      }),
      uses: { services: ["shareableState"] },
      async execute(ctx, { operation }) {
        // The mode policy ran before this code. Declare authorization and use
        // ctx.authorization.allows() for privileged side effects in public modes.
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
        usage: "/shareable operation:show",
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
        usage: "!shareable show",
        parse: twitchTokens([{
          arg: "operation",
          type: "string",
          optional: true
        }]),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;
