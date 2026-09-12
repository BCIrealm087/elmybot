# Feature authoring reference

Adding your first command? Start with
[`feature-quickstart.md`](feature-quickstart.md). It contains the shortest
scaffold-to-test path and tells you which section to open only when your feature
needs it. This page is the detailed pattern reference; it is not intended to be
read front to back.

The normative API shapes remain in
[`command-feature-framework-contract.md`](command-feature-framework-contract.md).
The supported entry point, compatibility rules, and deprecation lifecycle are
defined in [`framework-api.md`](framework-api.md).

The contributor framework is intentionally a build-time JavaScript API.
Features are reviewed, tested, explicitly installed, and bundled with the
Worker. They may live directly under `src/features/` or in a private npm
workspace package. Elmybot does not execute uploaded or remotely supplied code.

## Workspace scaffold reference

From the repository root:

```sh
npm run feature:new -- fun-hype --workspace
```

The omitted template name means `minimal`. Three optional recipes cover common
combinations without limiting later edits:

```sh
npm run feature:new -- fun-hype --workspace --template shared-command
npm run feature:new -- fun-score --workspace --template local-counter
npm run feature:new -- fun-score --workspace --template shareable-counter
```

`shared-command` binds one action to Discord and Twitch. Both counter recipes
generate public `show` behavior plus moderator-only `plus`, `minus`, and
`reset` operations. `local-counter` keeps a value per origin group;
`shareable-counter` works in isolated standalone state and resolves through a
directional default link when one exists. Its namespace is new and contains no
legacy-adoption metadata. Each recipe includes focused behavioral tests.
Counter recipes opt into `modePolicy`: one declaration supplies both access
documentation and enforcement. Their tests exercise every update with and
without the moderator capability and assert that denial leaves state unchanged.

The name must contain at least two lowercase dash-separated words. The scaffold
converts `fun-hype` to feature ID `fun.hype`, command `hype`, and action kind
`fun.hype.run.v1`. It creates:

```text
packages/features/fun-hype/
  package.json
  README.md
  src/feature.js
  test/feature.spec.js
```

The package imports production helpers from `@elmybot/framework` and test
helpers from `@elmybot/framework/testing`. It starts private and remains part of
this repository; publishing it is a separate future decision. A recipe does
not add runtime discovery or constrain the resulting feature: after generation,
the JavaScript files are ordinary contributor-owned code.

The scaffold never overwrites an existing file and does not install the feature
automatically. Add its exact version to the root `dependencies` without
removing the existing entries:

```json
{
  "dependencies": {
    "@elmybot/feature-fun-hype": "0.1.0"
  }
}
```

Then add the feature's default export to the explicit catalog in
`src/features/index.js`:

```js
import hypeFeature from "@elmybot/feature-fun-hype";

export const installedFeatures = Object.freeze([
  // Existing features...
  hypeFeature
]);
```

Run `npm install` from the repository root to update `package-lock.json` and
create the workspace link:

```sh
npm install
```

Then replace the `TODO` behavior and use the fast check while iterating:

```sh
npm run feature:check -- fun-hype
```

The command labels package-link or installation drift separately from behavior
test failures, public API boundary violations, and a stale
[`feature-catalog.md`](feature-catalog.md). It checks without editing files.
Use `npm run feature:docs` as the explicit regeneration action when the catalog
is stale.

Before review, run the complete readiness mode:

```sh
npm run feature:check -- fun-hype --ready
```

It runs every existing local contributor gate, including the complete Vitest
suite; it does not substitute the feature's focused test for repository-wide
coverage.

## Repository-local feature

Use the original scaffold when the feature is intentionally coupled to this
deployment rather than independently owned:

```sh
npm run feature:new -- fun-hype
```

It creates `src/features/fun-hype/feature.js` and
`test/features/fun-hype.spec.js`. Import that feature by relative path in the
same explicit installed catalog. The contributor APIs and behavioral contracts
are otherwise identical. The same `--template` choices work for this local
form.

## Choose the smallest useful feature shape

| Need | Recommended shape |
| --- | --- |
| Discord- or Twitch-specific presentation | Native command |
| Same semantic behavior on both platforms | One action with two command adapters |
| Send something to a linked platform | Action + route + routed effect |
| Read the selected relationship to another platform | Action using the links service |
| Run automatically from an authenticated event | Event binding + action |
| Run later or repeatedly | Schedule definition + action |
| Remember scores, quotes, or counters | Action using namespaced state |

Do not force platform-specific behavior into a shared abstraction. A Discord
command that needs role selection or a Discord-only response shape can remain a
Discord native command. Extract an action only when sharing the semantic intent
helps.

## Core rules

- Repository-local features import contributor helpers only from
  `src/framework/index.js`. Workspace feature source imports only
  `@elmybot/framework`. `npm run lint` rejects imports into project internals
  and relative imports that escape a workspace package.
- Set `apiVersion: frameworkApiVersion` so each manifest declares the stable
  authoring contract it expects.
- Feature IDs and semantic kinds are namespaced and stable.
- Versioned action, route, event, effect, and schedule kinds end in `.v1`, `.v2`,
  and so on.
- Commands validate into semantic arguments before feature code runs.
- Protected action commands inherit the action's baseline capability and
  conditional-access metadata.
- Actions declare every route, effect, and optional service they may use.
- Default-link reads declare `links`; the source is always the current origin
  group and the returned relationship is read-only.
- Simple protected command modes may declare an enforced `modePolicy`.
  Custom rules declare metadata-only `conditionalAccess` and use the
  `authorization` service for runtime checks. Neither inspects platform roles
  or badges.
- Feature code receives no `env`, OAuth token, request, webhook payload, Durable
  Object ID, SQL handle, coordinator envelope, or retry loop.
- Effects describe intended platform outcomes. The coordinator owns durable
  delivery and retry.
- Configuration and state keys match `^[a-z][a-z0-9_-]{0,63}$`.

## Input constraints and useful corrections

Keep the action schema authoritative. Reuse small local constants for shared
constraints, with explicit overrides where a platform or destination differs:

```js
const MESSAGE_LIMITS = Object.freeze({ minLength: 1, maxLength: 2_000 });

// In the semantic action's input:
schema.object({ message: schema.string({ ...MESSAGE_LIMITS, trim: true }) });

// Twitch chat supplies the rest of the line for a Discord destination:
twitchRestText({ arg: "message", ...MESSAGE_LIMITS });

// A Discord option sending to Twitch needs the smaller destination limit:
discordOption({
  arg: "message", name: "message", description: "Message to send.",
  type: "string", required: true, ...MESSAGE_LIMITS, maxLength: 500
});
```

The installed [announcements feature](../src/features/announcements/feature.js)
uses this pattern and shares its Twitch destination limits with the scheduled
variant. The counter scaffolds declare their operation choices and default only
in the action schema; their Twitch parser just extracts the optional string.

Add a `usage` example to each command that accepts arguments. Every action,
native, and scheduled command helper accepts it:

```js
// On the Discord command:
usage: "/deaths operation:check game:Dark Souls"
// On the Twitch command:
usage: '!deaths check "Dark Souls"'
```

The example must use that command's platform prefix and name, stay on one line,
and fit within 160 characters. Test that it works; metadata validation checks
its shape, not whether its arguments are semantically valid. It defaults to
`null` and does not change parsing, native options, or permissions. The generated
catalog includes supplied examples.

Schema and parser failures now name the command, the visible argument, and the
relevant requirement, then include the example. For example:
`!score: operation must be one of: show, plus, minus, reset. Example: !score show`.
Discord uses the option's `name`, even when its semantic `arg` differs; Twitch
quote and extra-token errors explain how to quote multi-word values. Original
error codes, messages, and paths such as `arguments.operation` remain available
for diagnostics. Author-written domain replies should provide the same useful
correction; they are not inferred from action output.

`deaths` remains the only installed choice-or-integer command. Its numeric
syntax, game normalization, and remembered-game rules therefore stay local.
Consider a reusable parser only after another command demonstrates the same
need. Token quoting, rest-of-line text, Discord role selection, and native
responses remain explicit platform choices.

## The feature test kit

Import test helpers from the test-only module:

```js
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestActor,
  discordTestGroup,
  linkedTestRoute,
  twitchTestGroup
} from "../../src/framework/testing.js";
```

Inside a workspace package, use the equivalent package entry:

```js
import { createFeatureTestRuntime } from "@elmybot/framework/testing";
```

`createFeatureTestRuntime(feature)` composes the real feature and action
registries. It therefore catches duplicate names, missing actions, unknown
capabilities, undeclared services, bad routes, and incompatible effects before
the test executes a command.

The runtime replaces only external infrastructure with deterministic in-memory
facilities:

| Facility | Test API |
| --- | --- |
| Discord command | `runtime.discord.command(name, input)` |
| Twitch command | `runtime.twitch.command(name, input)` |
| Raw Twitch command text | `runtime.twitch.commandText(text, input)` |
| Input-error reply text | `runtime.inputError(platform, commandName, error)` |
| Domain event | `runtime.event(kind, input)` |
| Configuration | `runtime.config.set(group, featureId, key, value)` |
| State inspection | `runtime.state.get(group, featureId, key)` |
| Standalone shareable state | `runtime.shareableState.getStandalone(group, featureId, namespaceId, key)` |
| Integration shareable state | `runtime.shareableState.getIntegration(integrationId, featureId, namespaceId, key)` |
| Clock | `runtime.clock.now()` and `runtime.clock.advance(...)` |
| Scheduled occurrences | `runtime.schedules.runDue()` |
| Stored-plan replay | `runtime.schedules.replay(plan)` |
| Current routes | `runtime.routes.set(routes)` |
| Directional default links | `defaultLinks: [defaultTestLink(...)]` and `runtime.links.set(...)` |
| Feature logs | `runtime.logs.all()` |

Command and trigger results expose `reply`, `output`, `effects`, `schedules`,
and `occurrencePlan`. Small assertion helpers keep the common cases readable:

```js
result.toReply("Hype queued!");
result.toEmitTwitchChat("Let's go!");
result.toEmitDiscordMessage("The stream is live!");
result.toSchedule("discord.fun.hype-random.v1");
```

Use `runtime.twitch.commandText()` when Twitch tokenization or quoting is part
of the behavior under test. It accepts the same bang-prefixed text a chatter
types and then runs command lookup, the command's declared parser, action input
validation, execution, and rendering:

```js
const result = await runtime.twitch.commandText(
  '!deaths plus "Dark Souls"',
  { actor: twitchTestModerator() }
);

result.toReply("Dark Souls deaths: 1");
```

Text without a command prefix and command names that are not installed reject
with `FeatureTestRuntimeError`. Keep using `runtime.twitch.command()` when a
test intentionally starts from already parsed semantic arguments.

Actors carry explicit capabilities. Public actors default to
`framework.members`; protected tests should state the grant being exercised:

```js
const moderator = discordTestActor({
  id: "moderator-1",
  capabilities: ["framework.members", "framework.moderators"]
});
```

Convenience helpers are also available: `discordTestModerator()`,
`discordTestManager()`, `twitchTestModerator()`, and
`twitchTestBroadcaster()`.

For representative protected inputs, `runCapabilityCases()` changes only one
explicit capability on the same actor. Import it from the test-only entry and
assert both outcomes and the state evidence:

```js
const { withoutCapability: denied, withCapability: allowed } = await runCapabilityCases({
  actor: discordTestActor(),
  capability: "framework.moderators",
  invoke: (actor) => runtime.discord.command("score", {
    actor, args: { operation: "plus" }
  }),
  readState: async () => (await runtime.discord.command("score")).output
});

expect(denied.error).toBeNull();
denied.result.toReply("Only moderators can change the score.");
expect(denied.result.effects).toEqual([]);
expect(denied.stateAfter).toEqual(denied.stateBefore);
expect(allowed.error).toBeNull();
allowed.result.toReply("Score: 1");
expect(allowed.stateAfter).toEqual({ message: "Score: 1" });
```

The helper runs without the capability first, then with it, against the same
runtime; it does not reset state or assert the expected policy for you. Each
case returns `{ result, error, stateBefore, stateAfter }`; a thrown invocation
has `result: null` and its original `error` (for example `action_forbidden`).
Assert the expected error or result explicitly. `readState` is required and
must return JSON evidence; snapshots are copied before each invocation so an
accidental mutation remains visible. Observer errors propagate. Observe every
state value the operation could change, and start each representative input
with a fresh, appropriately seeded runtime. The generated counter tests show
`plus`, `minus`, and `reset` starting from a nonzero value. For raw Twitch syntax,
use `runtime.twitch.commandText()` inside `invoke`.

These are capability-policy tests, not evidence that platform roles or badges
were authenticated. The helper preserves actor identity, claims, and all other
capabilities; the test runtime uses the explicit capability list.

`twitchTokens()` accepts ordinary whitespace-delimited tokens and double-quoted
multi-word strings. For example, a two-field parser can normalize
`plus "Dark Souls"` into `{ operation: "plus", game: "Dark Souls" }`.

The runtime still rejects schema and parser failures so tests can inspect their
diagnostics. Use `runtime.inputError()` on the caught error to check the same
correction text rendered by the live adapters; it returns `null` for unrelated
errors. For example, the counter recipes test both the invalid input and its
suggested correction:

```js
const error = await runtime.twitch.commandText("!score multiply")
  .catch((error) => error);
expect(error).toMatchObject({ code: "action_arguments_invalid" });
expect(runtime.inputError("twitch", "score", error)).toBe(
  "!score: operation must be one of: show, plus, minus, reset. Example: !score show"
);
(await runtime.twitch.commandText("!score show")).toReply("Score: 0");
```

When invalid input could affect state, seed a nonzero value and read it back
after the error. Check remembered selections separately where they matter.
`inputError()` formats an existing error; it does not run Discord option
extraction or replace adapter integration tests.

### Choose tests by feature behavior

Each feature test should establish the behavior introduced by that feature.
Use the smallest rows that apply:

| Feature behavior | Contributor-owned evidence |
| --- | --- |
| Input parsing | Representative valid input and one meaningful invalid case; use `runtime.twitch.commandText()` when raw syntax matters |
| Protected updates | An allowed update and a denied update followed by a read proving state did not change |
| Bounded counters | The relevant floor, ceiling, or assignment boundary |
| Local preferences or state | Isolation between the groups that must remember independently |
| Shareable state | Isolated standalone groups and two origins whose defaults select the same integration |
| Custom routes or platform options | The relevant missing-route result, emitted effect, or platform-specific response |

The test runtime proves feature composition, parsing, authorization decisions,
state selection, and returned effects. It does not replace platform-ingress or
durability integration tests. Use the existing Worker suites when changing
signatures, raw Discord or Twitch payload parsing, SQL migrations, alarms,
coordinator retries, or real delivery adapters.

Lifecycle guarantees also remain framework evidence unless a contribution
changes them. Collision selection, stale-snapshot retries, revocation forks,
CSRF, and legacy adoption are covered by the
[shareable-state lifecycle verification](shareable-state-lifecycle-verification.md),
not by every command package.

Fixture names do not widen that boundary. `defaultTestLink()` records a
directional default and integration identity so a feature test can prove state
selection. It does not run OAuth, discovery, collision resolution, activation,
revocation, or migration. `linkedTestRoute()` supplies a configured route and
lets the test inspect the feature's emitted effect; it does not deliver through
a real adapter. Any future lifecycle fixture must call the real lifecycle
operations rather than merely relabeling in-memory state.

## Cookbook 1: platform-native command

Use a native command when the behavior or response is intentionally tied to one
platform. This Discord-only example does not need an action:

```js
import {
  access,
  defineFeature,
  discordNativeCommand,
  frameworkApiVersion,
  schema
} from "../../framework/index.js";

export default defineFeature({
  apiVersion: frameworkApiVersion,
  id: "discord.secret-handshake",
  description: "A Discord-only moderator handshake.",
  commands: {
    discord: [
      discordNativeCommand({
        name: "handshake",
        description: "Perform the moderator handshake.",
        availability: "guild",
        capability: access.moderators,
        input: schema.object({}),
        execute(ctx) {
          return ctx.response.text("🤝 Handshake complete.", { ephemeral: true });
        }
      })
    ]
  }
});
```

Test it with `discordTestModerator()`. Also assert that `discordTestActor()` is
denied when access is important.

## Cookbook 2: shared Discord and Twitch command

Put shared intent in one action, then give each platform its own presentation:

```js
const KIND = "fun.cheer.run.v1";

export default defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.cheer",
  description: "Cheers from either platform.",
  actions: [
    defineAction({
      kind: KIND,
      capability: null,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({}),
      execute: () => ({ output: { message: "Let's go!" }, effects: [] })
    })
  ],
  commands: {
    discord: [discordActionCommand({
      name: "cheer",
      description: "Cheer.",
      availability: "global",
      actionKind: KIND,
      render: discordTextResult
    })],
    twitch: [twitchActionCommand({
      name: "cheer",
      description: "Cheer.",
      actionKind: KIND,
      parse: twitchNoArgs(),
      render: twitchTextResult
    })]
  }
});
```

One runtime can execute both adapters and prove they reach the same action.

## Cookbook 3: routed cross-platform command

Declare the link direction and effect dependency in metadata. The action only
resolves current routes and returns effects:

```js
const ROUTE = "discord.fun-hype-to-twitch.v1";
const ACTION = "integration.fun-hype.publish.v1";

const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "integrations.fun-hype",
  description: "Sends Discord hype to linked Twitch chats.",
  routes: [defineRoute({
    kind: ROUTE,
    sourcePlatform: "discord",
    targetPlatform: "twitch",
    destination: "none",
    newIntegration: "enabled",
    existingIntegration: "disabled"
  })],
  actions: [defineAction({
    kind: ACTION,
    capability: access.moderators,
    supportedOrigins: ["discord"],
    input: schema.object({
      message: schema.string({ minLength: 1, maxLength: 500, trim: true })
    }),
    uses: {
      routes: [ROUTE],
      effects: ["twitch.chat.send.v1"]
    },
    async execute(ctx, { message }) {
      const routes = await ctx.routes.resolve(ROUTE);
      return {
        output: { message: `Queued for ${routes.length} channel(s).` },
        effects: routes.map((route) =>
          ctx.effects.twitch.chat(route, { message })
        )
      };
    }
  })]
});
```

In the test, create Discord and Twitch groups plus a `linkedTestRoute()`, give
the actor the moderator capability, invoke the Discord command, and call
`toEmitTwitchChat()`.

## Cookbook 4: scheduled action

A schedule points to an action; it does not contain delivery code. The command
maps presentation arguments into action arguments and timing:

```js
defineScheduledAction({
  kind: "discord.fun.hype-random.v1",
  sourcePlatform: "discord",
  actionKind: "integration.fun-hype.publish.v1",
  timing: "bounded-random",
  authorization: "grant-at-creation"
});

discordScheduledActionCommand({
  name: "hype_random",
  description: "Repeat hype at bounded random intervals.",
  availability: "guild",
  scheduleKind: "discord.fun.hype-random.v1",
  options: [/* message, min_interval, max_interval */],
  mapSchedule(args) {
    return {
      actionArgs: { message: args.message },
      timing: {
        type: "bounded-random",
        minSeconds: args.min_interval,
        maxSeconds: args.max_interval
      },
      repeats: true
    };
  }
});
```

Test creation with `toSchedule()`. Advance deterministic time, call
`runtime.schedules.runDue()`, and inspect the occurrence effects and immutable
`occurrencePlan`. `runtime.schedules.replay(plan)` verifies that replay uses the
stored plan without running feature logic again.

Production bounded-random schedules currently require 600–86,400 seconds.

## Cookbook 5: event-driven action

Transport code authenticates and normalizes the domain event. The feature maps
that event to an ordinary action:

```js
defineEventAction({
  eventKind: "twitch.channel.celebration.v1",
  actionKind: "twitch.celebration.publish.v1",
  mapPayload: (event) => ({
    title: event.payload.title
  })
});
```

The target action can use the same route/effect API as a command action. Test
without constructing a raw EventSub webhook:

```js
const result = await runtime.event("twitch.channel.celebration.v1", {
  group: twitchGroup,
  payload: { title: "We did it!" }
});

result.toEmitDiscordMessage("We did it!");
```

Add or change the platform EventSub definition separately when a genuinely new
authenticated domain event is required.

## Read the selected linked group

Use the `links` service when behavior needs the single relationship selected as
the current origin group's default, without sending an effect yet. Declare the
dependency and ask for the other platform:

```js
defineAction({
  kind: "fun.example.inspect-link.v1",
  supportedOrigins: ["discord", "twitch"],
  uses: { services: ["links"] },
  async execute(ctx) {
    const targetPlatform = ctx.origin.group.platform === "discord"
      ? "twitch"
      : "discord";
    const link = await ctx.links.default(targetPlatform);
    return {
      output: {
        message: link === null
          ? "No linked default is available."
          : `Default target: ${link.targetGroup.id}`
      },
      effects: []
    };
  }
});
```

The promise resolves to `null` or a frozen object containing only
`integration`, `sourceGroup`, and `targetGroup`. The source group is fixed to
the invocation; feature code cannot inspect every candidate, choose on behalf
of another group, update the default, or read registry history.
Default lifecycle and manager operations belong to the authenticated platform
surface described in the
[integration management reference](integration-management.md#default-link-management-surface),
not to contributor feature code.

Model both directions explicitly in a feature test:

```js
const runtime = createFeatureTestRuntime(feature, {
  defaultLinks: [defaultTestLink({
    sourceGroup: discordGroup,
    targetGroup: twitchGroup
  })]
});
```

A link identifies the selected relationship; it does not make `ctx.state`
integration-owned or shared. New features that need one value across the
selected relationship should declare a shareable namespace as shown next.
The older `integrationState` service is a compatibility path for installed
features awaiting reviewed data migration, not the normal authoring model.

## Declare and resolve a shareable-state namespace

The shareable-state lifecycle lets a feature declare a namespace that
can resolve independently for an unlinked group and through its selected
integration when linked:

```js
defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.score",
  description: "Tracks a score.",
  shareableState: [{
    id: "score",
    label: "Shared score",
    schemaVersion: 1,
    collisionSummary: { kind: "presence" }
  }]
});
```

Omitted compatibility, summary, and limits normalize to `[schemaVersion]`,
`presence`, 100 entries, and 16 KiB per value. `entry_count` is the only other
summary policy. Neither policy can render stored keys or values.

An action using the namespace declares `shareableState` and resolves it once:

```js
const otherPlatform = ctx.origin.group.platform === "discord"
  ? "twitch"
  : "discord";
const state = await ctx.shareableState.current(otherPlatform, "score");
const value = await state.increment("value");
```

The returned frozen scope supports `get`, `set`, `delete`, `increment`, and
`boundedCounter`. Without a default it uses the current group's standalone
realm. With a default it uses that integration's realm. A later default switch
affects later resolutions without moving either realm's data.

This does not reclassify `ctx.state`, and local preferences remain ordinary
group state. Snapshot, collision resolution, safe finalization, and independent
post-revocation successors are implemented. Existing-data migration remains an
explicit maintainer-reviewed step; new features should never claim legacy
state.
See the
[`shareable-state lifecycle contract`](shareable-state-lifecycle.md) for the
implemented behavior and constraints.

## Cookbook 6: stateful command

First use the [state-ownership decision](feature-state.md#choose-the-state-boundary-first).
A shared Discord/Twitch action still receives independent state for each origin
group. Once group-local ownership is the intended behavior, declare services
and a cooldown in the action. Feature code cannot select a different group or
feature namespace:

```js
defineAction({
  kind: "fun.streak.increment.v1",
  capability: null,
  supportedOrigins: ["discord", "twitch"],
  uses: { services: ["config", "state", "random"] },
  cooldown: { scope: "actor", seconds: 30 },
  input: schema.object({}),
  async execute(ctx) {
    const label = await ctx.config.get("label") ?? "Streak";
    const value = await ctx.state.increment("value");
    const bonus = ctx.random.integer({ min: 0, max: 2 });
    return {
      output: { message: `${label}: ${value + bonus}` },
      effects: []
    };
  }
});
```

Seed operator configuration with `runtime.config.set(...)`, execute the command,
and inspect durable state through `runtime.state.get(...)`. Invoke twice as the
same actor to test the cooldown, then advance the fake clock or use a different
actor.

See [`feature-state.md`](feature-state.md) for production limits and operator
configuration commands.

When a counter belongs to arbitrary user text or must never cross a floor or
ceiling, use the bounded-counter handle instead of deriving a storage key or
combining `get()` with `increment()`:

```js
const deaths = ctx.state.boundedCounter("deaths", normalizedGameName, {
  subjectLabel: displayGameName
});
const value = await deaths.decrement(); // atomically stops at zero
```

The framework safely maps the subject to an internal key. Normalize subject
identity in the feature only when the domain requires it—for example, if game
names should be case-insensitive. Supply `subjectLabel` when the counter may be
declared as a readable collection: it lets the framework enumerate a safe
display label without changing the normalized identity or exposing its hashed
storage key. Existing rows without labels keep their count and are reported as
unidentified until a later mutation safely supplies the metadata. See
[`state-query-readable-state.md`](state-query-readable-state.md).

When both members of the selected relationship must update one authoritative
value, declare a shareable namespace on the feature and resolve it through
`shareableState`. The same command then works in the origin group's standalone
realm before linking and in the selected integration realm afterward:

```js
const targetPlatform = ctx.origin.group.platform === "discord"
  ? "twitch"
  : "discord";
const deaths = (await ctx.shareableState.current(targetPlatform, "game_deaths"))
  .boundedCounter("deaths", normalizedGameName, {
    subjectLabel: displayGameName
  });
const value = await deaths.increment();
```

The action declares `shareableState`, while the feature declares `game_deaths`
as shown in [Declare and resolve a shareable-state namespace](#declare-and-resolve-a-shareable-state-namespace).
Changing the directional default affects later resolutions. Keep group-local
convenience state—such as the last selected game—in `ctx.state`; there is no
transaction spanning the two owners. See the
[compatibility-only legacy section](feature-state.md#compatibility-only-legacy-integration-state)
only when maintaining already deployed integration-owned data.

To make selected state eligible for later operator-granted queries, add
`readableState` declarations with `defineReadableStateExport()`. Each declaration
includes a `resolve(ctx, arguments)` function whose context has only read methods
for that declaration's group-local or effective-shareable source. It cannot call
the command action or mutate state. See the complete
[read-only evaluator contract](state-query-evaluator.md).

## Cookbook 7: conditionally protected command modes

Keep the action public when everyone may read but only moderators may mutate.
For simple validated command modes, use the optional enforced policy:

```js
defineAction({
  kind: "fun.score.manage.v1",
  capability: null,
  modePolicy: {
    rules: [{
      capability: access.moderators,
      when: { argument: "operation", values: ["plus"] }
    }],
    deniedOutput: { message: "Only moderators can change the score." }
  },
  supportedOrigins: ["discord", "twitch"],
  uses: { services: ["state"] },
  input: schema.object({
    operation: schema.enum(["show", "plus"], { optional: true, default: "show" })
  }),
  async execute(ctx, { operation }) {
    // The mode policy has already checked access before any state use.
    const score = ctx.state.boundedCounter("score", "shared");
    const value = operation === "plus"
      ? await score.increment()
      : await score.get();
    return { output: { message: `Score: ${value}` }, effects: [] };
  }
});
```

Use `exceptValues` instead when every supplied value except a small public set
requires the capability. Matching uses schema-normalized values, including
defaults; an omitted optional argument without a default matches neither form:

```js
modePolicy: {
  rules: [{
    capability: access.moderators,
    when: { argument: "operation", exceptValues: ["show"] }
  }],
  deniedOutput: { message: "Only moderators can change the score." }
}
```

Input validation runs first, then the baseline capability, then every matching
mode rule. A denied mode returns the static `deniedOutput` with no effects,
before cooldowns or feature code. Make sure both platform renderers accept this
output shape. The same rules generate the catalog's enforced access label; do
not also declare `conditionalAccess`. No `authorization` service is needed for
automatic checks. An ordinary action-level capability remains the right choice
when the whole action is protected.

This initial policy form is command-only, with guild-only Discord bindings.
Events and schedules cannot bind to it; they keep their existing authorization
contracts. See the [normative policy semantics](command-feature-framework-contract.md#opt-in-enforced-command-modes)
for limits and failure behavior.

### Keep explicit checks for custom decisions and side effects

`conditionalAccess` is still validated documentation metadata, never automatic
enforcement. Use it with the declared `authorization` service when rules depend
on custom parsing or state. For example, declare `plus` as moderator-only, then
check it before the mutation:

```js
if (operation === "plus" && !await ctx.authorization.allows(access.moderators)) {
  return { output: { message: "Only moderators can change the score." }, effects: [] };
}
```

Keep `ctx.authorization.allows()` when a public operation has a privileged side
effect. `fun.deaths` intentionally retains its existing explicit checks:
custom operation-or-integer parsing runs before access checks, and a public
`check` remembers a named game only for moderators. A whole-mode guard cannot
express that side-effect distinction. Existing metadata declarations, custom
denials, and command behavior remain unchanged. Use `runCapabilityCases()` for
these cases too, asserting the public reply and the intentionally different
remembered-state results.

## Ask for framework help when

You can independently build and test commands using the documented schemas,
native bindings, routes, schedules, permissions, and state services. Routine
behavior development needs no live Twitch channel, Discord server, OAuth
credentials, or deployment access.

Ask a maintainer when the behavior needs:

- a permission or capability the public API cannot express;
- access to a new external service, credential, or platform operation;
- an addition or change to the supported framework API; or
- migration of already deployed data, including changes to its ownership or
  persisted meaning.

Use the [Framework help issue outline](../.github/ISSUE_TEMPLATE/framework-help.md)
with four details: intended user behavior, the unsupported operation, who owns
the state (and whether data already exists), and one small example. A command
invocation, pseudocode, or focused failing test is enough; an architecture
proposal is not required. You can also put those details in a draft PR and link
the relevant feature or test.

Keep developing the supported behavior and record the missing operation in the
handoff. Maintainers can point to an existing helper or coordinate the framework
change, its compatibility review, and infrastructure tests. Keep those tests
with the framework change; use the feature runtime for the command's behavior.
The [API change checklist](framework-api.md#change-checklist) is the maintainer's
reference for public API work.

For new shareable commands, use the `shareable-counter` scaffold or the
[migration-free namespace example](#declare-and-resolve-a-shareable-state-namespace).
`fun.deaths` sets `adoptLegacyIntegrationState: true` solely to preserve its
previously deployed ledger. Do not copy that marker into a new feature or
remove it from `deaths` as cleanup; existing-data changes need the migration
handoff above.

## Before opening a pull request

- Keep the feature module focused on one coherent capability.
- Test the successful path, authorization denial where applicable, validation,
  and no-route behavior for cross-platform actions.
- Use the test runtime for contributor behavior and existing Worker suites for
  platform ingress or durability changes.
- Add the feature once to `installedFeatures`.
- For a workspace feature, keep its package metadata and root dependency
  version aligned, then run `npm install` to update the lockfile and link it.
- Run `npm run feature:docs` after installation and review the generated diff.
- Run `npm run feature:check -- <feature-directory> --ready`; it includes the
  complete test suite, workspace validation, lint, boundary, and catalog checks.
- Do not add secrets, raw platform tokens, direct external `fetch` calls, or
  storage-layout knowledge to feature code.

In the PR description, summarize the user-visible behavior, validation results,
and any unresolved [framework-help request](#ask-for-framework-help-when).
Identify operational changes by name, such as a new command registration,
configuration key, OAuth scope, or reviewed migration; include no credential
values. Link the [feature operator checklist](feature-operator-checklist.md)
for the person deploying the change. If no operational change is needed beyond
the normal Worker deployment, say so. Contributors can hand off a locally
verified feature without deploying it or completing live onboarding.
