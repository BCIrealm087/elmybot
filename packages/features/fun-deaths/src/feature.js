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

function gameStateKey(game) {
  const identity = gameIdentity(game);
  const readable = identity
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "game";
  let hash = 0x811c9dc5;
  for (const character of identity) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `game_${readable}_${(hash >>> 0).toString(36)}`;
}

function countMessage(game, count) {
  return `${displayName(game)} deaths: ${count}`;
}

async function currentCount(ctx, key) {
  const value = await ctx.state.get(key);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function decrementCount(ctx, key) {
  const value = await ctx.state.increment(key, -1);
  if (value >= 0) return value;
  await ctx.state.increment(key, 1);
  return 0;
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
        const key = gameStateKey(game);
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
          count = await ctx.state.increment(key);
        } else if (operation === "minus") {
          count = await decrementCount(ctx, key);
        } else if (operation === "reset") {
          await ctx.state.set(key, 0);
          count = 0;
        } else {
          count = await currentCount(ctx, key);
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
