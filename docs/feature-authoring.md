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
this repository; publishing it is a separate future decision.

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

Run `npm install` from the repository root to update `package-lock.json` and
create the workspace link. Then add the feature's default export to the
explicit catalog in `src/features/index.js`:

```js
import hypeFeature from "@elmybot/feature-fun-hype";

export const installedFeatures = Object.freeze([
  // Existing features...
  hypeFeature
]);
```

Then replace the `TODO` behavior and run:

```sh
npm test -- --run packages/features/fun-hype/test/feature.spec.js
npm run feature:workspaces
npm run feature:docs
npm run lint
```

`npm run feature:workspaces` checks package names, exports, peer compatibility,
metadata, default feature exports, and root dependency versions. `npm run lint`
also enforces workspace isolation and verifies that the checked-in
[`feature-catalog.md`](feature-catalog.md) matches the installed registry.

## Repository-local feature

Use the original scaffold when the feature is intentionally coupled to this
deployment rather than independently owned:

```sh
npm run feature:new -- fun-hype
```

It creates `src/features/fun-hype/feature.js` and
`test/features/fun-hype.spec.js`. Import that feature by relative path in the
same explicit installed catalog. The contributor APIs and behavioral contracts
are otherwise identical.

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
- Argument-dependent protected modes declare `conditionalAccess`, use the
  `authorization` service for the runtime check, and never inspect platform
  roles or badges.
- Feature code receives no `env`, OAuth token, request, webhook payload, Durable
  Object ID, SQL handle, coordinator envelope, or retry loop.
- Effects describe intended platform outcomes. The coordinator owns durable
  delivery and retry.
- Configuration and state keys match `^[a-z][a-z0-9_-]{0,63}$`.

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
| Domain event | `runtime.event(kind, input)` |
| Configuration | `runtime.config.set(group, featureId, key, value)` |
| State inspection | `runtime.state.get(group, featureId, key)` |
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

`twitchTokens()` accepts ordinary whitespace-delimited tokens and double-quoted
multi-word strings. For example, a two-field parser can normalize
`plus "Dark Souls"` into `{ operation: "plus", game: "Dark Souls" }`.

The harness does not replace platform ingress or durability integration tests.
Use the existing Worker tests when verifying signatures, raw Discord/Twitch
payload parsing, SQL migrations, alarms, coordinator retries, or real delivery
adapter behavior.

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
integration-owned or shared. It can be passed to the separately declared
`integrationState` service when the relationship should own the data. Read the
[state-ownership decision](feature-state.md#choose-the-state-boundary-first)
before storing data that both sides must mutate.

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
const deaths = ctx.state.boundedCounter("deaths", normalizedGameName);
const value = await deaths.decrement(); // atomically stops at zero
```

The framework safely maps the subject to an internal key. Normalize subject
identity in the feature only when the domain requires it—for example, if game
names should be case-insensitive.

When both members of the selected relationship must update one authoritative
value, declare `links` and `integrationState`, then scope the same state API
through the resolved default:

```js
const targetPlatform = ctx.origin.group.platform === "discord"
  ? "twitch"
  : "discord";
const link = await ctx.links.default(targetPlatform);
if (link === null) {
  return { output: { message: "A default link is required." }, effects: [] };
}

const deaths = ctx.integrationState
  .for(link)
  .boundedCounter("deaths", normalizedGameName);
const value = await deaths.increment();
```

Only the exact snapshot returned during this action invocation is accepted.
Changing the directional default selects another integration ledger, and a
revoked relationship cannot be read or mutated. Keep group-local convenience
state—such as the last selected game—in `ctx.state`; there is no transaction
spanning the two owners.

## Cookbook 7: conditionally protected command modes

Keep the action public when everyone may read but only moderators may mutate.
Declare `authorization` and ask the existing platform policy about a reviewed
capability before performing the protected operation:

```js
defineAction({
  kind: "fun.score.manage.v1",
  capability: null,
  conditionalAccess: [
    {
      capability: access.moderators,
      when: { argument: "operation", values: ["plus"] }
    }
  ],
  supportedOrigins: ["discord", "twitch"],
  uses: { services: ["authorization", "state"] },
  input: schema.object({
    operation: schema.enum(["show", "plus"], { optional: true, default: "show" })
  }),
  async execute(ctx, { operation }) {
    if (
      operation === "plus" &&
      !await ctx.authorization.allows(access.moderators)
    ) {
      return {
        output: { message: "Only moderators can change the score." },
        effects: []
      };
    }
    const score = ctx.state.boundedCounter("score", "shared");
    const value = operation === "plus"
      ? await score.increment()
      : await score.get();
    return { output: { message: `Score: ${value}` }, effects: [] };
  }
});
```

Use an ordinary action-level capability when the whole action is protected.
Conditional checks are for commands whose validated modes genuinely have
different access requirements. `authorization.allows()` accepts only reviewed,
registered capabilities and returns the platform policy's boolean decision.
`conditionalAccess` is validated metadata rather than automatic enforcement:
the explicit check remains required, while generated documentation can now
describe the public and protected modes accurately.

## Before opening a pull request

- Keep the feature module focused on one coherent capability.
- Test the successful path, authorization denial where applicable, validation,
  and no-route behavior for cross-platform actions.
- Use the test runtime for contributor behavior and existing Worker suites for
  platform ingress or durability changes.
- Add the feature once to `installedFeatures`.
- For a workspace feature, keep its package metadata and root dependency
  version aligned and run `npm run feature:workspaces`.
- Run `npm run feature:docs` after installation.
- Run the complete `npm test -- --run` and `npm run lint` checks.
- Do not add secrets, raw platform tokens, direct external `fetch` calls, or
  storage-layout knowledge to feature code.
