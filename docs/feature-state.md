# Feature configuration, state ownership, and cooldowns

Framework actions can use controlled per-group or per-integration persistence
without receiving a Durable Object binding, object name, storage key prefix,
or SQL handle. The runtime derives the feature namespace and allows an
integration scope only through a default-link snapshot resolved by the current
action invocation.

## Choose the state boundary first

A shared action shares behavior, not storage. When the same action runs from a
Discord guild and a Twitch channel, `ctx.state` still resolves two independent
namespaces because the invocations have different origin groups. Linking those
groups does not merge their configuration, state, or cooldowns.

`await ctx.links.default(otherPlatform)` identifies the origin group's selected
active relationship. That read-only identity lookup does not change the owner
or namespace of `ctx.state`; it can instead be passed to
`ctx.integrationState.for(link)` when the product requirement explicitly makes
the selected integration the owner.

Use this decision table before adding state:

| Product requirement | State owner | Supported contributor shape |
| --- | --- | --- |
| Each Discord guild or Twitch channel has its own count, settings, or collection | The origin group | Use `ctx.state` or `ctx.config` |
| One group remembers local data and sends notifications or effects to linked groups | The origin group | Keep local state and use declared routes/effects for delivery |
| Linked groups must read and mutate one authoritative value | The selected integration relationship | Resolve a default link, then use `ctx.integrationState.for(link)` |

“Works on Discord and Twitch” means the behavior is available on both
platforms; it does not by itself mean the data is shared. Choose independent
state unless the requirement explicitly says that both platforms must observe
the same value and that the value exists because those groups are linked.

Examples:

- A remembered game that should differ between a Discord community and Twitch
  channel uses origin-group state.
- A Twitch stream-online event that sends a Discord message uses a route and an
  effect. Delivery across platforms does not make it shared state.
- Death counts or one tournament scoreboard that moderators update from either
  member of one Discord–Twitch link use integration-owned state.

Integration-owned feature state has these lifecycle rules:

1. The directional default selected at invocation time chooses the integration
   ledger. Opposite directions are independent and share data only when they
   select the same integration ID.
2. Switching a default selects the new integration's existing ledger. Data is
   not copied or merged; switching back selects the old ledger again.
3. Revocation blocks new access to that integration but does not erase its
   stored data. Relinking creates a new integration ID and therefore a new
   ledger; old data does not silently reappear.
4. The action owns user authorization. The storage boundary additionally
   verifies that the relationship is active and both snapshot groups are
   members before every operation.
5. Without a default active link there is no integration owner, so a feature
   must return an explicit unavailable response rather than falling back to a
   second local copy.
6. Each state or bounded-counter call is atomic. There is no transaction that
   spans integration state and origin-group state.

Feature code cannot pass an integration ID directly. It must declare both
`links` and `integrationState`, resolve the current default, and pass the exact
frozen snapshot to `ctx.integrationState.for()`. A copied, reconstructed, or
previous-invocation object is rejected.

Do not imitate shared state by embedding another platform's group ID or an
integration ID in a local `ctx.state` key. The value remains owned by the origin
group and creates separate copies. Do not synchronize two local copies with
routed effects when the requirement calls for one authoritative value; retries,
revocation, and many-to-many links make those copies capable of diverging.

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
and integer `increment` operations. It also provides a per-subject bounded
counter when a feature needs a floor or ceiling without composing multiple
storage calls:

```js
const deaths = ctx.state.boundedCounter("deaths", normalizedGameName);

await deaths.get();       // absent counters start at zero
await deaths.increment(); // add one
await deaths.decrement(); // subtract one, stopping at zero
await deaths.reset();     // return to zero
```

Integration state exposes the same state operations after resolving a default:

```js
const targetPlatform = ctx.origin.group.platform === "discord"
  ? "twitch"
  : "discord";
const link = await ctx.links.default(targetPlatform);
if (link === null) {
  return { output: { message: "A default link is required." }, effects: [] };
}

const sharedDeaths = ctx.integrationState
  .for(link)
  .boundedCounter("deaths", normalizedGameName);
await sharedDeaths.increment();
```

The action must list `"integrationState"` and `"links"` in `uses.services`.
The returned integration-state scope has `get`, `set`, `delete`, `increment`,
and `boundedCounter` with the same validation, limits, and atomicity as
`ctx.state`.

`boundedCounter(name, subject, options)` accepts an ordinary storage-safe name
and an arbitrary non-empty subject up to 300 characters. The runtime maps the
pair to a collision-resistant internal key, so authors do not slug or hash user
text. Subject identity is exact: case folding, Unicode normalization, and
whitespace normalization are domain choices the feature should make before
constructing the counter.

Options are `{ min, max, initial }`. They default to zero,
`Number.MAX_SAFE_INTEGER`, and `min`, respectively. Bounds and the initial value
must be safe integers satisfying `min <= initial <= max`. Increment and
decrement amounts are positive integers up to 1,000,000; operations saturate at
the applicable inclusive bound. `reset()` returns the new initial value.

Each state operation is atomic independently; API v1 does not expose a general
multi-operation or cross-owner transaction. A bounded-counter mutation and its
bound check are one storage operation, so concurrent decrements cannot cross
the floor.

Using an undeclared service fails immediately. Installing an action that
requires a service absent from the composition root fails at startup.

## Namespaces and limits

The effective group-state namespace is:

```text
origin group + feature ID + value kind + feature key
```

Feature code supplies only the final key. Keys must match
`^[a-z][a-z0-9_-]{0,63}$`. A feature cannot choose another group or feature ID.
Configuration and state are stored separately, so the same key may safely
exist in both.

The effective integration-state namespace is:

```text
integration ID + feature ID + state + feature key
```

The feature supplies neither the integration ID nor a storage object; the
runtime derives both from the accepted default-link snapshot.

Per feature, group configuration is limited to 100 keys. State is limited to
100 keys for each owning group or integration. For both state owners:

- each value is JSON-safe, no deeper than 20 levels, and at most 16 KiB;
- one increment is limited to an absolute value of 1,000,000; and
- incremented values must remain safe integers.

Bounded counters occupy the state namespace only after a mutation changes the
initial value. A missing `get()`, no-op decrement at the floor, or no-op reset
does not consume one of the 100 state entries.

The existing `GroupConfig` Durable Object owns these SQLite tables. Legacy
Discord role configuration remains in its existing storage and public listing;
framework namespaces are not exposed through `/config_list_entries`.
Integration-owned state uses the existing per-integration coordinator storage;
it is not exposed through the integration management or status commands.

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

The proof test for independent state should use two explicit groups, mutate one,
and assert that the other remains unchanged. The workspace `fun.deaths` feature
is the integration-state proof: its death ledger is shared by commands whose
directional defaults select the same integration, while its remembered game is
stored separately in each origin group. Its tests cover both member groups,
default switching, unlinked use, authorization, raw Twitch syntax, and the
zero-floor counter; the infrastructure suite covers membership and revocation.
