# Feature configuration, state, and cooldowns

Framework actions can use controlled per-group persistence without receiving a
Durable Object binding, object name, storage key prefix, or SQL handle. The
runtime derives both boundaries from the installed feature ID and the current
action origin.

## Author API

An action declares only the services it needs:

```js
defineAction({
  kind: "fun.score.increment.v1",
  supportedOrigins: ["discord", "twitch"],
  uses: { services: ["config", "state", "random"] },
  cooldown: { scope: "actor", seconds: 30 },
  async execute(ctx) {
    const label = await ctx.config.get("label");
    const score = await ctx.state.increment("score");
    const bonus = ctx.random.integer({ min: 1, max: 3 });
    return { output: { message: `${label}: ${score + bonus}` }, effects: [] };
  }
});
```

`ctx.config` is read-only feature code input controlled by operators.
`ctx.state` is feature-owned data and provides atomic `get`, `set`, `delete`,
and integer `increment` operations. Each operation is atomic independently;
API v1 does not expose a multi-operation transaction.

Using an undeclared service fails immediately. Installing an action that
requires a service absent from the composition root fails at startup.

## Namespaces and limits

The effective namespace is:

```text
origin group + feature ID + value kind + feature key
```

Feature code supplies only the final key. Keys must match
`^[a-z][a-z0-9_-]{0,63}$`. A feature cannot choose another group or feature ID.
Configuration and state are stored separately, so the same key may safely
exist in both.

Per group and feature:

- configuration is limited to 100 keys;
- state is limited to 100 keys;
- each value is JSON-safe, no deeper than 20 levels, and at most 16 KiB;
- one increment is limited to an absolute value of 1,000,000; and
- incremented values must remain safe integers.

The existing `GroupConfig` Durable Object owns these SQLite tables. Legacy
Discord role configuration remains in its existing storage and public listing;
framework namespaces are not exposed through `/config_list_entries`.

## Operator configuration

Discord owners and intrinsic moderators can manage configuration for installed
features:

| Command | Purpose |
| --- | --- |
| `/feature_config_set feature key json_value` | Set a JSON value |
| `/feature_config_show feature key` | Inspect one value |
| `/feature_config_delete feature key` | Delete one value |

Text is JSON too, so it must be quoted in `json_value`. For example, the
installed counter proof reads `fun.counter`'s `label` key:

```text
/feature_config_set feature:fun.counter key:label json_value:"Wins"
```

These generic commands are an operations surface. A feature may later provide
a friendlier native configuration command while still writing through the same
bounded adapter.

## Cooldowns

Cooldowns are action metadata, not hand-written state logic. `scope: "actor"`
uses one lease per platform actor in the origin group; `scope: "group"` uses
one lease for the whole group. Claims happen after argument validation and
authorization but before feature code runs. The check and claim are one SQLite
transaction, so concurrent invocations cannot both pass.

An active cooldown returns a platform-appropriate retry message and does not
run the action. Actor cooldowns cannot be attached to actorless event actions.
Expired rows are pruned in bounded batches as new claims arrive.

## Installed proof

`src/features/counter/feature.js` exposes the same stateful action as Discord
`/counter` and Twitch `!counter`. Counts remain independent because Discord
guilds and Twitch channels have different origin-group namespaces. The feature
also demonstrates operator configuration and a five-second actor cooldown.
