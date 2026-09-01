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
const OPERATION_HELP =
  "check, plus, minus, reset, or a non-negative safe integer";
const OPERATION_ERROR = `Choose ${OPERATION_HELP}.`;

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

function missingLinkMessage(platform) {
  return platform === "discord"
    ? "Death counts require a default linked Twitch channel."
    : "Death counts require a default linked Discord server.";
}

function parseOperation(operation) {
  if (operation === undefined || operation === "check") {
    return Object.freeze({ kind: "check" });
  }
  if (OPERATIONS.includes(operation)) return Object.freeze({ kind: operation });
  if (!/^\d+$/.test(operation)) return null;
  const value = Number(operation);
  if (!Number.isSafeInteger(value)) return null;
  return Object.freeze({ kind: "set", value });
}

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.deaths",
  description: "Tracks shared per-game deaths for linked Discord and Twitch groups.",
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
        operation: schema.string({
          minLength: 1,
          maxLength: 80,
          trim: true,
          optional: true
        }),
        game: schema.string({
          minLength: 1,
          maxLength: 80,
          trim: true,
          optional: true
        })
      }),
      uses: {
        services: ["authorization", "integrationState", "links", "state"]
      },
      async execute(ctx, { game, operation }) {
        if (game !== undefined && operation === undefined) {
          return {
            output: {
              message: `Choose ${OPERATION_HELP} before naming a game.`
            },
            effects: []
          };
        }

        const selectedOperation = parseOperation(operation);
        if (selectedOperation === null) {
          return { output: { message: OPERATION_ERROR }, effects: [] };
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

        const link = await ctx.links.default(
          otherPlatform(ctx.origin.group.platform)
        );
        if (link === null) {
          return {
            output: { message: missingLinkMessage(ctx.origin.group.platform) },
            effects: []
          };
        }

        const deaths = ctx.integrationState
          .for(link)
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
        description: "Check or update shared deaths for a linked game.",
        availability: "guild",
        actionKind: FUN_DEATHS_ACTION_KIND,
        options: [
          discordOption({
            arg: "operation",
            name: "operation",
            description: "Check, plus, minus, reset, or set a non-negative count.",
            type: "string",
            required: false,
            minLength: 1,
            maxLength: 80
          }),
          discordOption({
            arg: "game",
            name: "game",
            description: "Optional game; requires an operation.",
            type: "string",
            required: false,
            minLength: 1,
            maxLength: 80
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "deaths",
        description: "Check or update shared deaths for a linked game.",
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
