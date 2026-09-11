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

const OPERATIONS = Object.freeze(["check", "plus", "minus", "reset"]);
const LAST_GAME_KEY = "last_game";
const TEXT_LIMITS = Object.freeze({ minLength: 1, maxLength: 80 });
const OPTIONAL_TEXT = Object.freeze({ ...TEXT_LIMITS, trim: true, optional: true });
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const USAGE = Object.freeze({
  discord: "/deaths operation:check game:Dark Souls",
  twitch: '!deaths check "Dark Souls"'
});
const OPERATION_HELP =
  `${OPERATIONS.join(", ")}, or a whole number from 0 to ${MAX_COUNT} (digits only)`;

function operationError(platform, { gameWithoutOperation = false } = {}) {
  const command = platform === "discord" ? "/deaths" : "!deaths";
  const suffix = gameWithoutOperation ? " before naming a game" : "";
  return `${command}: operation must be ${OPERATION_HELP}${suffix}. Example: ${USAGE[platform]}`;
}

function displayName(game) {
  return game.trim().replace(/\s+/g, " ");
}

function gameIdentity(game) {
  return displayName(game).normalize("NFKC").toLowerCase();
}

function countMessage(game, count) {
  return `${game} deaths: ${count}`;
}

function otherPlatform(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

function parseOperation(operation) {
  if (operation === undefined || operation === "check") {
    return Object.freeze({ kind: "check" });
  }
  if (OPERATIONS.includes(operation)) return Object.freeze({ kind: operation });
  if (!/^\d+$/.test(operation)) return null;
  const value = Number(operation);
  if (!Number.isSafeInteger(value) || value > MAX_COUNT) return null;
  return Object.freeze({ kind: "set", value });
}

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.deaths",
  description: "Tracks per-game deaths locally or across linked Discord and Twitch groups.",
  shareableState: [{
    id: "game_deaths",
    label: "Per-game death counts",
    schemaVersion: 1,
    collisionSummary: { kind: "entry_count" },
    // Maintainer-owned migration for previously deployed deaths ledgers.
    // New features omit this marker; use the shareable-counter scaffold.
    // See this package's README for the migration handoff and fresh-state example.
    adoptLegacyIntegrationState: true
  }],
  actions: [
    defineAction({
      kind: FUN_DEATHS_ACTION_KIND,
      capability: null,
      conditionalAccess: [
        {
          capability: access.moderators,
          when: {
            argument: "operation",
            exceptValues: ["check"]
          }
        }
      ],
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        operation: schema.string(OPTIONAL_TEXT),
        game: schema.string(OPTIONAL_TEXT)
      }),
      uses: {
        services: ["authorization", "shareableState", "state"]
      },
      async execute(ctx, { game, operation }) {
        if (game !== undefined && operation === undefined) {
          return {
            output: {
              message: operationError(ctx.origin.group.platform, { gameWithoutOperation: true })
            },
            effects: []
          };
        }

        const selectedOperation = parseOperation(operation);
        if (selectedOperation === null) {
          return { output: { message: operationError(ctx.origin.group.platform) }, effects: [] };
        }
        const isModerator = await ctx.authorization.allows(access.moderators);
        if (selectedOperation.kind !== "check" && !isModerator) {
          return {
            output: { message: "Only moderators can change death counts." },
            effects: []
          };
        }

        const selectedGame = game === undefined
          ? await ctx.state.get(LAST_GAME_KEY)
          : displayName(game);
        if (selectedGame === null) {
          return {
            output: {
              message: "No game is selected yet. A moderator must check or update a named game first."
            },
            effects: []
          };
        }

        const sharedState = await ctx.shareableState.current(
          otherPlatform(ctx.origin.group.platform),
          "game_deaths"
        );
        const deaths = sharedState
          .boundedCounter("game", gameIdentity(selectedGame));

        let count;
        if (selectedOperation.kind === "plus") {
          count = await deaths.increment();
        } else if (selectedOperation.kind === "minus") {
          count = await deaths.decrement();
        } else if (selectedOperation.kind === "reset") {
          count = await deaths.reset();
        } else if (selectedOperation.kind === "set") {
          count = await deaths.set(selectedOperation.value);
        } else {
          count = await deaths.get();
        }
        if (game !== undefined && isModerator) {
          await ctx.state.set(LAST_GAME_KEY, selectedGame);
        }
        return {
          output: { message: countMessage(selectedGame, count) },
          effects: []
        };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "deaths",
        usage: USAGE.discord,
        description: "Check or update a game's local or shared death count.",
        availability: "guild",
        actionKind: FUN_DEATHS_ACTION_KIND,
        options: [
          discordOption({
            arg: "operation",
            name: "operation",
            description: "Check, plus, minus, reset, or set a non-negative count.",
            type: "string",
            required: false,
            ...TEXT_LIMITS
          }),
          discordOption({
            arg: "game",
            name: "game",
            description: "Optional game; requires an operation.",
            type: "string",
            required: false,
            ...TEXT_LIMITS
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "deaths",
        usage: USAGE.twitch,
        description: "Check or update a game's local or shared death count.",
        actionKind: FUN_DEATHS_ACTION_KIND,
        parse: twitchTokens([
          { arg: "operation", type: "string", optional: true },
          { arg: "game", type: "string", optional: true }
        ]),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;
