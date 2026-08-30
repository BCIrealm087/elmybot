# Command and feature framework design

## Status

This document is the design overview and implementation plan. The proposed
normative Framework API v1 contract is in
`docs/command-feature-framework-contract.md`. The project owner approved that
contract on 2026-08-30, and its implementation is proceeding in stages. An API
is not available merely because it appears in the contract; until each stage is
implemented and stabilized, the existing action, integration, scheduling, and
platform contracts remain authoritative.

## Motivation

Elmybot should be usable as a canvas for contributors who primarily want to
write fun and interesting commands. A contributor should be able to add a
platform-native, shared, or cross-platform feature without first learning the
details of Durable Object addressing, webhook authentication, integration
execution envelopes, idempotency ledgers, or retry machinery.

The target experience is:

> A contributor adds a command in one feature folder, registers it once, and
> can use replies, linked-platform routing, scheduling, permissions,
> configuration, and durable delivery through a small, documented API.

The first version should be an in-repository contributor framework. Feature
code remains reviewed, committed, tested, and bundled into the Worker. Loading
arbitrary third-party code at runtime is not part of this design. Build-time
feature packages can be considered after the framework API is stable.

## Author mental model

Feature authors should normally need four concepts:

```mermaid
flowchart LR
    T["Trigger<br/>command, event, schedule"] --> A["Action<br/>intent and validation"]
    A --> R["Route<br/>linked destinations"]
    R --> E["Effect<br/>Discord or Twitch outcome"]
    A --> O["Source reply"]
```

| Feature type | Pipeline |
| --- | --- |
| Discord-only command | Discord command -> action or native handler -> Discord reply |
| Twitch-only command | Twitch command -> action or native handler -> Twitch reply |
| Shared command | Discord and Twitch adapters -> one shared action |
| Cross-platform command | Source command -> action -> integration route -> target effect |
| Automatic interaction | Platform event -> action -> integration route -> target effect |
| Scheduled interaction | Schedule -> action -> optional route -> effect |

Platform-specific behavior remains first-class. A feature enters the shared
action layer only when that semantic boundary is useful. Discord components,
embeds, autocomplete, and permissions and Twitch-specific parsing or behavior
must not be reduced to a lowest-common-denominator command format.

## Existing foundation

The project already has most of the low-level execution model:

- versioned `CommandInvocation`, `ActionResult`, `DomainEvent`, `Effect`, and
  `IntegrationExecution` contracts;
- an immutable action registry;
- platform-owned Discord and Twitch ingress adapters;
- explicit capability authorization;
- authenticated integration linking and configurable routes;
- durable per-integration execution ledgers and effect outboxes;
- Discord-message and Twitch-chat effects;
- EventSub definitions backed by a durable inbox;
- a generic scheduling backend; and
- stable replay protection, retries, and dead-letter handling.

The principal missing layer is contributor-facing composition. At present, a
new cross-platform feature may require edits to command maps, action sets, route
constants and defaults, permission policies, the Worker composition root,
documentation, and several test fixtures.

## Proposed feature model

Introduce a validated `defineFeature()` contract and one explicit installed
feature catalog. The exact proposed manifest, context, command, route, event,
schedule, compatibility, and example contracts are specified in
`docs/command-feature-framework-contract.md`. The following remains a compact
conceptual preview:

```js
export default defineFeature({
  id: "fun.hype",

  actions: [
    defineAction({
      kind: "integration.hype.publish.v1",
      origins: ["discord"],
      access: "moderators",
      args: {
        message: text({ maxLength: 500 })
      },
      execute(ctx, { message }) {
        return {
          reply: ctx.text("Hype queued!"),
          effects: ctx.routes("discord.hype-to-twitch.v1")
            .twitchChat({ message })
        };
      }
    })
  ],

  commands: {
    discord: [
      slashCommand({
        name: "hype_twitch",
        description: "Send hype to linked Twitch chats.",
        action: "integration.hype.publish.v1"
      })
    ]
  }
});
```

The normative contract favors explicit, easily tested results over hidden side
effects: actions return output and effect envelopes, and the framework submits
validated effects afterward.

Features would be installed explicitly:

```js
export const installedFeatures = [
  aliveFeature,
  announcementFeature,
  streamOnlineFeature
];
```

The framework would validate and aggregate feature declarations into the
existing command, action, route, event, scheduler-handler, and effect
registries. Explicit installation is deterministic, works with Worker bundling,
and makes review easier than runtime filesystem discovery.

An intended source layout is:

```text
src/
  framework/
    define-feature.js
    feature-registry.js
    command-context.js
    argument-schema.js
    access-policies.js
    routing.js
    scheduling.js
    testing.js
  features/
    alive/
      feature.js
      feature.spec.js
    announcements/
      feature.js
      feature.spec.js
    stream-online/
      feature.js
      feature.spec.js
```

Startup must fail for duplicate command names, semantic kinds, route kinds,
incompatible definitions, unknown capabilities, and effects without registered
target adapters.

## Contributor-facing capabilities

### Platform command adapters

Provide helpers for common command shapes, such as `slashCommand()`,
`twitchCommand()`, and `exposeAction()`. They should cover:

- argument extraction and normalization;
- required and optional arguments;
- Discord command registration descriptors;
- Twitch rest-of-message and token parsing;
- deferred Discord responses; and
- common text replies and user-facing validation failures.

Custom platform adapters must remain possible for native behavior that does not
fit these helpers.

### Runtime-validated argument schemas

Keep the project in plain JavaScript while adding runtime schemas and JSDoc.
For example:

```js
args({
  message: text({ required: true, maxLength: 500 }),
  amount: integer({ min: 1, max: 100 }),
  target: user()
});
```

One semantic schema can support validation and tests. Platform adapters may
customize how an argument is displayed or parsed.

### Controlled feature context

Normal feature actions should receive a controlled context instead of raw
Worker bindings:

```js
ctx.source
ctx.actor
ctx.reply
ctx.routes
ctx.effects
ctx.schedule
ctx.config
ctx.state
ctx.log
ctx.correlationId
```

This context should hide secrets, Durable Object names, storage layouts,
external-request timeouts, execution envelopes, and coordinator submission.
Advanced lower-level APIs can remain available through an explicitly separate
interface.

### Permissions and capabilities

Offer reviewed access presets for common features:

```js
access: "everyone"
access: "members"
access: "moderators"
access: "managers"
access: capability("integration.announcement.publish")
```

Platform adapters map these policies to authoritative evidence, such as
Discord permissions and configured roles or Twitch broadcaster and moderator
claims. A feature cannot create an arbitrary authorization function that grants
itself authority. Genuinely new sensitive capabilities require an explicit
central policy addition and review.

### Route catalog

Replace scattered route declarations and management choices with a registered
route catalog:

```js
defineRoute({
  kind: "discord.hype-to-twitch.v1",
  sourcePlatform: "discord",
  targetPlatform: "twitch",
  destination: "none",
  newIntegration: "enabled",
  existingIntegration: "disabled"
});
```

The catalog should drive validation, integration defaults, route-management
choices, documentation, and expected target platforms.

New routes need an explicit existing-integration policy. The safe default is
for newly installed feature routes to remain disabled on existing links until
a manager enables them. A deliberate migration may opt into different behavior.

### Platform-owned effect factories

Most feature authors should use platform-owned factories such as:

```js
ctx.effects.discord.message(...)
ctx.effects.twitch.chat(...)
```

Creative platform operations can add versioned effect kinds such as
`discord.role.assign.v1`, `discord.reaction.add.v1`, `twitch.poll.start.v1`, or
`twitch.announcement.send.v1`. Each new kind retains a target-platform validator
and delivery adapter. Feature authors do not modify coordinator persistence or
retry logic.

### Commands, events, and schedules as triggers

The same action should be invokable from a Discord command, Twitch command,
verified domain event, or scheduled occurrence. This lets one semantic action
support immediate, automatic, and recurring behavior.

The scheduled-action bridge must:

- create a unique stable source ID for every occurrence;
- resolve active routes when that occurrence fires;
- persist the resolved occurrence plan before fan-out;
- replay the immutable plan during retries; and
- hand effects to integration coordinators rather than delivering externally.

A future authoring API could resemble:

```js
await ctx.schedule.action({
  action: "integration.hype.publish.v1",
  args: { message },
  timing: randomInterval({ minSeconds: 900, maxSeconds: 1800 }),
  repeats: true
});
```

### Namespaced configuration, state, and cooldowns

Fun commands commonly need counters, quotes, scores, cooldowns, and per-group
settings. Provide distinct facilities:

- `ctx.config` for operator-controlled settings; and
- `ctx.state` for feature-owned durable state.

Both are automatically scoped by feature and platform group. Storage size and
operation limits prevent one feature from becoming an unbounded shared-state
consumer or reading another feature's data.

Cooldowns should be declarative where possible:

```js
cooldown: {
  scope: "actor",
  seconds: 30
}
```

## Testing and tooling

Provide a feature test harness that runs without deployment and can model
platform actors, permissions, integration routes, effects, schedules, and
events. A conceptual test is:

```js
const runtime = createFeatureTestRuntime(hypeFeature);

const result = await runtime.discord.command("hype_twitch", {
  actor: discordModerator(),
  args: { message: "Let's go!" },
  routes: [linkedTwitchChannel()]
});

expect(result).toReply("Hype queued!");
expect(result).toEmitTwitchChat("Let's go!");
```

The harness should support:

- Discord and Twitch actors;
- allowed and denied capability cases;
- linked and unlinked groups;
- fake schedules and clock advancement;
- EventSub-derived domain events;
- emitted-effect inspection;
- coordinator replay simulations; and
- automatic contract checks for every feature.

A scaffold command such as the following should create a feature module and its
test skeleton:

```text
npm run feature:new -- fun-hype
```

Feature metadata should also become the source for generated Discord
registration descriptors, command documentation, and route-management choices
so those representations cannot silently drift.

## Implementation sequence

1. **Write and approve the framework contract — completed.** The approved
   contract lives in `docs/command-feature-framework-contract.md` and specifies
   the exact `defineFeature()` schema, context API, compatibility policy, and
   three complete example features.
2. **Add the feature registry and installation catalog — completed.** The
   runtime now has a strict `defineFeature()`, an explicit installed-feature
   catalog, immutable action and per-platform command contribution registries,
   and collision-safe merging with legacy action and command sets. The catalog
   began empty so representative features could be migrated deliberately.
3. **Add Discord and Twitch command helpers — completed.** The framework now
   provides runtime argument schemas, reviewed access presets, separate
   action-backed and native command definitions, Twitch parsers, safe text
   renderers, Discord option/registration generation, and composition checks
   tying action commands to installed actions.
4. **Migrate representative local behavior — completed.** The installed
   `core.alive` feature now owns one shared action exposed as Discord `/alive`
   and Twitch `!alive`. The installed `discord.role-access` feature owns the
   Discord-native `/config_allow_role` command and uses a narrow adapter service
   instead of raw Worker bindings. All other commands remain on their legacy
   registrations; this is intentionally not a big-bang conversion.
5. **Add the route catalog and effect helpers — completed.** Installed
   features now contribute validated route definitions, actions declare their
   route and effect dependencies, and controlled context factories construct
   routed Discord-message and Twitch-chat effects. Both announcement commands
   now belong to one installed feature; platform executors submit its results
   through the existing durable coordinator without feature code constructing
   integration envelopes or handling retries.
6. **Add scheduled-action and event-action adapters.** Include immutable
   occurrence planning. Migrate `stream.online` and use a randomly scheduled
   Discord-to-Twitch message as the cross-platform scheduling proof.
7. **Add namespaced configuration, state, and cooldowns.** This enables games,
   counters, quotes, points, and other stateful features safely.
8. **Complete the test kit, scaffold, and contributor guide.** Include
   cookbooks for native, shared, routed, scheduled, event-driven, and stateful
   commands.
9. **Stabilize and version the framework API.** Introduce a framework API
   version and documented deprecation rules. Feature modules must not depend on
   internal persistence layouts.
10. **Consider build-time feature packages.** Only after the API is stable,
    allow separately maintained packages to be added to the explicit installed
    feature catalog.

## Success criteria

The contributor framework is ready for creative feature authors when:

- a simple platform command needs one feature module and one focused test;
- a cross-platform command declares a route and target outcome without manually
  constructing integration execution envelopes;
- scheduled and event-driven triggers can invoke the same actions as commands;
- command registration, route management, and documentation derive from feature
  metadata;
- feature code does not handle OAuth tokens, Durable Object IDs, retry loops,
  raw webhook payloads, or storage table layouts;
- validation errors and authorization denials are safe and understandable;
- platform-native behavior remains easy and first-class; and
- existing low-level contracts remain available for exceptional advanced work.

The recommended proof set is:

1. `alive`, demonstrating one action exposed through both command systems;
2. announcements, demonstrating bidirectional routed actions; and
3. a bounded-random scheduled Discord-to-Twitch message, demonstrating
   authorization, scheduling, route resolution, immutable occurrence planning,
   durable coordinator handoff, and Twitch delivery.

Together, these examples exercise the complete contributor pipeline without
forcing every future command to use every layer.
