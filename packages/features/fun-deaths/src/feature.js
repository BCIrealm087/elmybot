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

export function normalizeGameSubject(game) {
  const label = displayName(game);
  return Object.freeze({ value: gameIdentity(label), label });
}

function queryTarget(target) {
  return { platform: target.platform, groupId: target.groupId };
}

export function fixedGameDeathsQuery(target, game) {
  return {
    version: 1,
    target: queryTarget(target),
    bindings: {
      count: {
        read: { feature: "fun.deaths", export: "count", version: 1 },
        arguments: { game: { literal: game } }
      }
    },
    select: { deaths: { ref: "count" } }
  };
}

export function currentGameDeathsQuery(target) {
  return {
    version: 1,
    target: queryTarget(target),
    bindings: {
      remembered: {
        read: { feature: "fun.deaths", export: "remembered_game", version: 1 }
      },
      current: {
        read: { feature: "fun.deaths", export: "count", version: 1 },
        arguments: { game: { ref: "remembered" } }
      }
    },
    select: { deaths: { ref: "current" } }
  };
}

function countMessage(game, count) {
  return `${game} deaths: ${count}`;
}

function present(value) {
  return Object.freeze({ state: "present", value });
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
  readableState: [
    defineReadableStateExport({
      id: "remembered_game",
      version: 1,
      label: "Remembered game",
      description: "The game currently selected by this Discord guild or Twitch channel.",
      kind: "value",
      platforms: ["discord", "twitch"],
      scope: { kind: "group_local" },
      access: { kind: "operator_grant" },
      result: {
        schema: { type: "string", minLength: 1, maxLength: 80 },
        absence: { kind: "unselected" }
      },
      async resolve(ctx) {
        const remembered = await ctx.state.get(LAST_GAME_KEY);
        return remembered.found
          ? present(remembered.value)
          : Object.freeze({ state: "unselected" });
      }
    }),
    defineReadableStateExport({
      id: "count",
      version: 1,
      label: "Death count",
      description: "The effective standalone or shared death count for one game.",
      kind: "lookup",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable", namespace: "game_deaths" },
      access: { kind: "operator_grant" },
      parameters: {
        game: {
          label: "Game",
          schema: { type: "string", minLength: 1, maxLength: 80 },
          normalize: normalizeGameSubject
        }
      },
      result: {
        schema: {
          type: "object",
          properties: {
            game: { type: "string", minLength: 1, maxLength: 80 },
            count: { type: "integer", minimum: 0, maximum: MAX_COUNT }
          },
          required: ["game", "count"]
        },
        absence: { kind: "default" }
      },
      async resolve(ctx, { game }) {
        const [count, collection] = await Promise.all([
          ctx.state.boundedCounter("game", game, { min: 0, max: MAX_COUNT }),
          ctx.state.boundedCounterSubjects("game")
        ]);
        const known = collection.subjects.find(({ identity }) => identity === game);
        return present({ game: known?.label ?? game, count });
      }
    }),
    defineReadableStateExport({
      id: "counts",
      version: 1,
      label: "Materialized death counts",
      description: "Known game subjects with materialized counters in the effective state.",
      kind: "collection",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable", namespace: "game_deaths" },
      access: { kind: "operator_grant" },
      result: {
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              game: { type: "string", minLength: 1, maxLength: 80 },
              count: { type: "integer", minimum: 0, maximum: MAX_COUNT }
            },
            required: ["game", "count"]
          },
          maxItems: 100
        },
        absence: { kind: "default" }
      },
      collection: {
        membership: "materialized",
        order: "canonical_subject",
        legacyCoverage: "explicit"
      },
      async resolve(ctx) {
        const collection = await ctx.state.boundedCounterSubjects("game");
        return present(collection.subjects.map((subject) => ({
          game: subject.label,
          count: subject.value
        })));
      }
    })
  ],
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
        const gameSubject = normalizeGameSubject(selectedGame);
        const deaths = sharedState.boundedCounter(
          "game",
          gameSubject.value,
          { subjectLabel: gameSubject.label }
        );

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
