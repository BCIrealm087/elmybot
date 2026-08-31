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

export const FUN_DEATHS_ACTION_KIND = "fun.deaths.manage.v1";

const OPERATIONS = Object.freeze(["show", "plus", "minus", "reset"]);

function displayName(game) {
  return game.trim().replace(/\s+/g, " ");
}

function gameIdentity(game) {
  return displayName(game).normalize("NFKC").toLowerCase();
}

function countMessage(game, count) {
  return `${displayName(game)} deaths: ${count}`;
}

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.deaths",
  description: "Tracks per-game death counts in a Discord server or Twitch channel.",
  actions: [
    defineAction({
      kind: FUN_DEATHS_ACTION_KIND,
      capability: null,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        game: schema.string({ minLength: 1, maxLength: 80, trim: true }),
        operation: schema.enum(OPERATIONS, { optional: true, default: "show" })
      }),
      uses: { services: ["authorization", "state"] },
      async execute(ctx, { game, operation }) {
        const deaths = ctx.state.boundedCounter("game", gameIdentity(game));
        if (
          operation !== "show" &&
          !await ctx.authorization.allows(access.moderators)
        ) {
          return {
            output: { message: "Only moderators can change death counts." },
            effects: []
          };
        }

        let count;
        if (operation === "plus") {
          count = await deaths.increment();
        } else if (operation === "minus") {
          count = await deaths.decrement();
        } else if (operation === "reset") {
          count = await deaths.reset();
        } else {
          count = await deaths.get();
        }
        return {
          output: { message: countMessage(game, count) },
          effects: []
        };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "deaths",
        description: "Show or update this server's deaths for a game.",
        availability: "guild",
        actionKind: FUN_DEATHS_ACTION_KIND,
        options: [
          discordOption({
            arg: "game",
            name: "game",
            description: "Game whose deaths should be shown or updated.",
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 80
          }),
          discordOption({
            arg: "operation",
            name: "operation",
            description: "Optional moderator action: plus, minus, or reset.",
            type: "string",
            required: false,
            minLength: 4,
            maxLength: 5
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "deaths",
        description: "Show or update this channel's deaths for a game.",
        actionKind: FUN_DEATHS_ACTION_KIND,
        parse: twitchTokens([
          { arg: "game", type: "string" },
          { arg: "operation", type: "string", optional: true, default: "show" }
        ]),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;
