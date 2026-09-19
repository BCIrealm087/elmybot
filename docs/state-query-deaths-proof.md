# Deaths state-query proof and contributor workflow

Status: implemented by roadmap step 10 on 2026-09-14.

The `fun.deaths` feature is the first complete proof that ordinary feature
commands, readable-state declarations, composed snapshots, and live updates use
one state model. The feature does not contain notification, watcher, HTTP, or transport
code. Its normal `ctx.state` and `ctx.shareableState` mutations are observed by
the framework infrastructure from steps 6–9.

## Readable deaths surface

| Export | Query kind | Scope | Result |
| --- | --- | --- | --- |
| `remembered_game` v1 | value | group-local | selected game or `unselected` |
| `count` v1 | lookup by `game` | effective shareable | `{ game, count }`, defaulting to zero |
| `counts` v1 | complete collection | effective shareable | materialized labeled game counters |

The group-local selection remains different for each Discord guild and Twitch
channel. Counts follow that group's effective standalone or selected integration
realm. Counter subject labels are attached by ordinary deaths mutations. Exact
lookup remains compatible with historical unlabeled rows; collection reads fail
explicitly when legacy coverage is incomplete instead of hiding unknown rows.

## Five independently composed queries

The feature test constructs and evaluates all five user-created shapes required
by the roadmap:

1. one literal game's `count` lookup;
2. three independent `count` lookups selected into one result;
3. the group-local `remembered_game` value;
4. `remembered_game` dynamically supplied as the `count.game` argument; and
5. the complete `counts` collection.

The dynamic query changes its dependency when a moderator selects another game.
The collection query emits a replacement when an inserted game is materialized
or a reset removes it. A linked test evaluates the same literal query from both
Discord and Twitch and receives the same integration-owned count.

The public integration suites exercise these shapes with real scoped grants and
Durable Object-backed state. They verify multiplexed snapshots, remembered-game
dependency handoff, collection removal, and browser WebSocket delivery. Recovery
coalesces adjacent history per client query ID, so activity in one multiplexed
query cannot hide another query's newest result.

`fun.deaths` also exports two optional pure builders. They only return ordinary
version-1 query documents and have no additional permissions or execution rules:

```js
import {
  currentGameDeathsQuery,
  fixedGameDeathsQuery
} from "@elmybot/feature-fun-deaths";

const target = { platform: "twitch", groupId: "141981764" };
const fixed = fixedGameDeathsQuery(target, "Dark Souls");
const current = currentGameDeathsQuery(target);
```

Clients remain free to compose the same exports themselves. Presets do not
extend the language and are not required for discovery, snapshots, or live delivery.

## Contributor test workflow

Counter scaffolds now include a `defineReadableStateExport()` declaration and a
deployment-free query test. The same test API works for handwritten features:

```js
const runtime = createFeatureTestRuntime(feature);
const group = discordTestGroup();
const query = {
  version: 1,
  target: { platform: "discord", groupId: group.id },
  bindings: {
    score: {
      read: { feature: "fun.score", export: "score", version: 1 }
    }
  },
  select: { score: { ref: "score" } }
};

const subscription = await runtime.query.watch(query);
expect(subscription.initial.envelope.data.score)
  .toEqual({ state: "present", value: 0 });

await runtime.discord.command("score", {
  group,
  actor: discordTestModerator(),
  args: { operation: "plus" }
});
expect((await subscription.next()).envelope.data.score)
  .toEqual({ state: "present", value: 1 });
subscription.close();
```

`runtime.query.snapshot(document)` runs the production parser and evaluator
against the test runtime's in-memory group and shareable scopes.
`await runtime.query.watch(document)` returns an initial evaluation plus a
bounded latest-result subscription. `next()` waits for a semantically different
result and `close()` releases its listener. `runtime.links.set()` reevaluates
subscriptions as a source change, including same-value standalone/shared
handoffs.

This helper proves feature declarations, composition, dynamic dependencies,
ordinary mutation visibility, and directional test-link selection. Durable
storage, authorization grants, HTTP framing, alarms, and network WebSockets remain the
responsibility of their Worker integration suites.
