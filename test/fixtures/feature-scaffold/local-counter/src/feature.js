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
  readableState: [
    defineReadableStateExport({
      id: "score",
      version: 1,
      label: "Local score",
      description: "The current group-local score.",
      kind: "value",
      platforms: ["discord", "twitch"],
      scope: { kind: "group_local" },
      access: { kind: "operator_grant" },
      result: {
        schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        absence: { kind: "default" }
      },
      async resolve(ctx) {
        return {
          state: "present",
          value: await ctx.state.boundedCounter("score", "shared")
        };
      }
    })
  ],
  actions: [
    defineAction({
      kind: RECIPE_LOCAL_ACTION_KIND,
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
      uses: { services: ["state"] },
      async execute(ctx, { operation }) {
        // The mode policy ran before this code. Declare authorization and use
        // ctx.authorization.allows() for privileged side effects in public modes.
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
        usage: "/local operation:show",
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
        usage: "!local show",
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
