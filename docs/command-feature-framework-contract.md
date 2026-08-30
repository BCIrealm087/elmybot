# Command and feature framework contract

## Status

**Framework API v1 approved on 2026-08-30; implementation steps 1–5 complete.**

This document is the normative contract approved in step 1 of
`docs/command-feature-framework.md`. It fixes the intended public shapes and
semantics during staged implementation. Examples use the approved public API;
they are not executable until the corresponding implementation steps are
complete.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe requirements
on the eventual implementation.

## Decisions

1. Features are trusted, reviewed source modules bundled with the Worker.
   Runtime loading of user-supplied code is out of scope.
2. Feature installation is explicit and static. There is no filesystem or
   package auto-discovery at runtime.
3. Actions return explicit semantic output and effect envelopes. Context
   helpers may construct effects, but MUST NOT secretly deliver them.
4. The framework submits returned routed effects through the existing durable
   integration coordinators.
5. Platform adapters continue to own authentication, wire parsing,
   authorization evidence, native response rendering, and delivery APIs.
6. Platform-native commands are supported deliberately. A feature is not
   required to expose the same behavior on every platform.
7. Feature code receives controlled services. The normal author API does not
   expose raw Worker bindings, OAuth credentials, Durable Object stubs, or
   persistence tables.
8. The current versioned integration contracts remain the durable wire and
   persistence boundary. The feature framework is an authoring layer over
   those contracts, not a replacement for them.

## Public module boundary

Ordinary feature modules MUST import authoring APIs only from:

```js
import { /* public helpers */ } from "../../framework/index.js";
```

Platform-native feature adapters MAY additionally import from a documented
public platform SDK:

```js
import { /* Discord helpers */ } from "../../framework/discord.js";
import { /* Twitch helpers */ } from "../../framework/twitch.js";
```

Imports from integration coordinator storage, Durable Object backends,
platform authentication modules, or internal registry implementations are not
part of the feature API and MUST fail the contribution review checklist.

## Identifiers and versions

### Framework API version

Every feature declares:

```js
apiVersion: 1
```

The runtime MUST reject an unsupported API version during composition. It MUST
NOT attempt best-effort execution of an incompatible feature.

### Feature IDs

Feature IDs MUST:

- match `^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$`;
- contain at least one namespace separator;
- be no longer than 100 characters; and
- remain stable after release.

Examples are `core.alive`, `integration.announcements`, and
`fun.channel-points`. A retired ID MUST NOT later be reused for unrelated
behavior.

### Semantic kinds

Action, route, event, effect, and schedule kinds MUST use the existing
versioned-kind convention and end in `.vN`, where `N` starts at 1. Their
semantic namespace and version are independent of `apiVersion`.

A semantic breaking change requires a new kind, for example
`integration.announcement.publish.v2`. Old kinds MAY coexist while persisted
work drains or callers migrate.

## `FeatureDefinition`

`defineFeature()` accepts exactly this top-level shape:

```js
defineFeature({
  apiVersion: 1,
  id: "namespace.feature-name",
  description: "Human-readable feature description.",
  actions: [],
  commands: {
    discord: [],
    twitch: []
  },
  routes: [],
  events: [],
  schedules: [],
  effectAdapters: {
    discord: [],
    twitch: []
  }
});
```

Only `apiVersion`, `id`, and `description` are required. Missing collections
normalize to the empty values shown above. Unknown fields are rejected so a
misspelling cannot silently disable part of a feature.

`description` MUST be a non-empty string of at most 200 characters.
`defineFeature()` MUST copy and deeply freeze the manifest collections. Runtime
functions are retained by reference and are never serialized.

`effectAdapters` is an advanced, platform-owned extension point. Ordinary
command features SHOULD use already registered effect factories.

## Installation and composition

All features are installed through one explicit catalog:

```js
export const installedFeatures = Object.freeze([
  aliveFeature,
  announcementsFeature,
  scheduledTwitchAnnouncementsFeature
]);
```

The composition root MUST build immutable snapshots for commands, actions,
routes, events, schedules, and effect adapters. Startup MUST fail before any
request is handled when it finds:

- duplicate feature IDs;
- duplicate command names on the same platform;
- duplicate semantic kinds in the same registry;
- a registry key that differs from its definition kind;
- an action command referring to an uninstalled action;
- an event or schedule referring to an uninstalled action;
- an unknown capability or access preset;
- a route whose source or target platform is invalid;
- a returned-effect kind without a target-platform adapter; or
- a feature definition whose API version is unsupported.

Legacy command and registry sets MAY coexist during migration. The composition
root MUST apply the same duplicate checks across legacy and feature-provided
definitions.

## Argument schemas

Actions and native commands use runtime schemas created by the public `schema`
helpers:

```js
schema.object({
  message: schema.string({ minLength: 1, maxLength: 500 }),
  count: schema.integer({ min: 1, max: 100, optional: true }),
  enabled: schema.boolean({ optional: true })
});
```

Framework API v1 defines these primitives:

| Helper | Normalized value | Supported constraints |
| --- | --- | --- |
| `schema.string()` | string | `minLength`, `maxLength`, `trim`, `optional`, `default` |
| `schema.integer()` | safe integer | `min`, `max`, `optional`, `default` |
| `schema.number()` | finite number | `min`, `max`, `optional`, `default` |
| `schema.boolean()` | boolean | `optional`, `default` |
| `schema.enum(values)` | one listed string | `optional`, `default` |
| `schema.object(fields)` | frozen plain object | rejects unknown keys by default |

Platform-specific identifiers such as a Discord role or user are normalized to
strings by the platform command adapter and then validated as strings. They do
not become a new cross-platform identity merely because they entered an action
argument.

Schemas MUST:

- reject unknown object keys unless explicitly configured otherwise;
- return deeply frozen JSON-safe values;
- reject non-finite numbers and unsafe integers;
- report a bounded user-facing validation message; and
- execute before action authorization or feature code.

Custom schema functions are not part of Framework API v1. New reusable schema
types belong in the public framework after review.

## Access presets and capabilities

The public `access` helper normalizes contributor-friendly presets to reviewed
capability policies:

| Expression | Meaning |
| --- | --- |
| `access.everyone` | Public action or command; normalizes to `null` |
| `access.members` | Any authenticated actor in the source group |
| `access.moderators` | Discord owner, intrinsic moderator, or configured trusted role; Twitch broadcaster or moderator |
| `access.managers` | Discord owner or server manager; Twitch broadcaster |
| `access.capability(name)` | An explicitly registered project capability |

Presets normalize to stable framework-owned capability strings. Platform policy
owns the mapping from authoritative platform evidence to those capabilities.
Feature code receives neither the policy function nor a way to replace it.

Actions and native commands MAY use either a registered capability string or a
value returned by `access`. Action-backed commands inherit their action's
capability and cannot declare a different preset.

## `FeatureActionDefinition`

`defineAction()` accepts:

```js
defineAction({
  kind: "integration.example.run.v1",
  capability: null,
  supportedOrigins: ["discord", "twitch"],
  input: schema.object({}),
  uses: {
    routes: [],
    effects: [],
    services: []
  },
  execute
});
```

Requirements:

- `kind` is a versioned semantic kind.
- `capability` is either `null` or a registered namespaced capability.
- `supportedOrigins` contains at least one unique platform.
- `input` defaults to `schema.object({})`.
- `uses` defaults to empty arrays.
- `execute` is `async (ctx, args) => ActionResult` or its synchronous
  equivalent.

`uses.routes` lists route kinds the action may resolve. `uses.effects` lists
effect kinds it may return. `uses.services` lists optional context services it
requires, chosen from `config`, `state`, and `random` in API v1.

The runtime MUST reject an undeclared route resolution or returned effect kind.
This makes dependencies visible to startup validation, documentation, and
tests. An action may declare several possible routes and effects without using
all of them during every invocation.

The action executor receives already normalized `args`. It MUST return a value
accepted by the existing `createActionResult()` contract:

```js
{
  output: { message: "Semantic response" },
  effects: []
}
```

The framework normalizes and freezes the result. A command adapter renders
`output`; the framework submits routed effects only after successful result
normalization.

## `FeatureActionContext`

The action context has this exact API v1 surface:

```js
{
  apiVersion: 1,
  featureId,
  trigger: {
    kind: "command" | "event" | "schedule"
  },
  origin: {
    group,
    actor
  },
  sourceEventId,
  correlationId,
  clock: {
    now(): Date
  },
  random: {
    integer({ min, max }): number
  },
  routes: {
    resolve(routeKind): Promise<readonly RouteSnapshot[]>
  },
  effects: {
    routedMessage(route, { message }): Effect,
    discord: {
      message(route, { content }): Effect
    },
    twitch: {
      chat(route, { message }): Effect
    }
  },
  config: {
    get(key): Promise<JSONValue | null>
  },
  state: {
    get(key): Promise<JSONValue | null>,
    set(key, value): Promise<void>,
    delete(key): Promise<boolean>,
    increment(key, amount = 1): Promise<number>
  },
  log: {
    debug(event, metadata = {}): void,
    info(event, metadata = {}): void,
    warn(event, metadata = {}): void
  }
}
```

Context and service objects are frozen. Service methods enforce the current
feature ID and origin group; callers cannot select another feature namespace or
arbitrary storage object.

Rules:

- `clock.now()` returns a new `Date` and is injectable in tests.
- `random.integer()` returns an integer in the inclusive `[min, max]` range and
  is injectable in tests.
- `routes.resolve()` accepts only a kind declared in `uses.routes` and resolves
  from `origin.group`.
- Effect factories accept only validated route snapshots targeting the
  factory's platform. They derive integration, correlation, causation, and
  stable idempotency metadata from the current invocation.
- `routedMessage()` selects the registered Discord-message or Twitch-chat
  effect from the route target and applies the target platform's length limit.
- `config`, `state`, and `random` may be used only when declared in
  `uses.services`. Undeclared access is a framework error. The namespace shape
  remains stable so feature code does not branch on service presence.
- Keys match `^[a-z][a-z0-9_-]{0,63}$`; the runtime automatically namespaces
  them by feature ID and origin group.
- Each state operation is atomic by itself. API v1 does not promise a
  multi-operation transaction.
- Log metadata is bounded, JSON-safe, and automatically receives feature,
  action, platform, group, and correlation fields. Secrets and complete raw
  payloads MUST NOT be logged.
- Actions receive no raw `env`, `fetch`, request, interaction, EventSub payload,
  OAuth token, or Durable Object stub.

Although `config`, `state`, and `random` are part of the approved v1 surface,
the composition runtime MAY initially implement only the services required by
installed features. A feature declaring an unavailable service MUST fail at
composition rather than later during execution.

## Command definitions

Commands have two explicit modes: action-backed and native. A definition MUST
use the corresponding helper; there is no object union where both `actionKind`
and `execute` can appear.

Discord and Twitch command names match
`^[a-z][a-z0-9_-]{0,31}$`, are normalized to lowercase, and are unique within
their platform. Descriptions are non-empty strings no longer than 100
characters.

### Discord action command

```js
discordActionCommand({
  name,
  description,
  availability: "global" | "guild",
  deferred: false,
  actionKind,
  options: [],
  render: discordTextResult
});
```

`options` contains Discord presentation metadata plus an `arg` field naming
the semantic action argument:

```js
discordOption({
  arg: "message",
  name: "message",
  description: "Message to publish.",
  type: "string",
  required: true
});
```

Framework API v1 option types are `string`, `integer`, `number`, `boolean`,
`user`, `role`, and `channel`. The adapter generates Discord's numeric option
types and registration payload. `user`, `role`, and `channel` normalize to
their opaque ID strings.

The installed action owns capability authorization. A command cannot weaken or
override it. `availability: "guild"` rejects DM use before action execution.

`render` receives the normalized `ActionResult` and a controlled Discord
rendering context. It defaults to `discordTextResult`, which requires a
non-empty `output.message` and disables automatic mentions.

### Twitch action command

```js
twitchActionCommand({
  name,
  description,
  actionKind,
  parse: twitchNoArgs(),
  render: twitchTextResult
});
```

API v1 provides:

- `twitchNoArgs()`;
- `twitchRestText({ arg, minLength, maxLength })`; and
- `twitchTokens([{ arg, type, optional, default }])`, where type is `string`,
  `integer`, `number`, or `boolean`.

The parser produces semantic arguments which are then validated by the action
input schema. Command names are case-insensitive and stored lowercase.

The installed action owns capability authorization. Twitch platform policy
maps authenticated EventSub actor claims to that capability. The default
renderer requires a non-empty `output.message` no longer than the Twitch chat
limit.

### Native commands

Advanced platform-only commands use:

```js
discordNativeCommand({
  name,
  description,
  availability,
  deferred,
  capability,
  options,
  input,
  execute
});

twitchNativeCommand({
  name,
  description,
  capability,
  parse,
  input,
  execute
});
```

`capability` follows the same registered policy rules as actions. The executor
receives normalized arguments plus a controlled platform context. The platform
context MAY expose documented native response builders and platform operations,
but MUST NOT expose credentials or raw Worker bindings.

Native commands are appropriate when the behavior is inherently tied to one
platform or requires native response features. They SHOULD NOT be used merely
to bypass action validation, authorization, routing, or durable effects.

## Route definitions

`defineRoute()` accepts:

```js
defineRoute({
  kind,
  sourcePlatform,
  targetPlatform,
  destination: "none" | "link-channel",
  newIntegration: "enabled" | "disabled",
  existingIntegration: "disabled"
});
```

API v1 intentionally allows only `"disabled"` for automatic behavior on
existing integrations. Enabling a new route on existing links requires an
explicit, separately reviewed migration or manager action.

This policy applies when an installed route kind is missing from an existing
integration. If an integration already stores that route kind, composition
preserves its enabled state and destination; installing the feature manifest
does not rewrite authoritative route records.

`destination: "none"` stores an empty destination object. It is appropriate
when the target group itself is sufficient, as with Twitch chat.
`destination: "link-channel"` requires the linking flow to supply the selected
channel within the target group, as with Discord message delivery.

A route definition declares availability; an integration stores its enabled
state and concrete destination. Resolving a route returns immutable snapshots
of current integration state.

## Event definitions

Feature-level event bindings use:

```js
defineEventAction({
  eventKind,
  actionKind,
  mapPayload
});
```

`mapPayload(event)` maps an already authenticated, normalized `DomainEvent` to
action arguments. It cannot receive raw webhook headers or payloads. Event
subscription admission, signature verification, inbox persistence, and
transport-to-domain-event conversion remain platform responsibilities.

The action runs with `trigger.kind === "event"`, the event source group and
actor, and the event's stable source and correlation IDs. Capability-protected
actions cannot be triggered by actorless events unless their capability policy
explicitly supports trusted system-event authorization.

## Scheduled action definitions

`defineScheduledAction()` accepts:

```js
defineScheduledAction({
  kind,
  sourcePlatform,
  actionKind,
  timing: "timestamp" | "daily" | "bounded-random",
  authorization: "grant-at-creation"
});
```

Framework API v1 supports only `grant-at-creation`. The authenticated command
or native adapter authorizes the referenced action before the scheduler accepts
the job. The stored grant contains the action capability, origin group, actor,
and acceptance time. It contains no platform credential or interaction token.

At occurrence time, the runner MUST fail closed if:

- the installed action kind no longer exists;
- the action's current capability differs from the stored grant;
- the action no longer supports the stored origin platform; or
- the stored job or grant fails validation.

It does not re-fetch the creator's current Discord roles or Twitch badges.
Authorization therefore has the same semantics as other accepted scheduled
work: changing a creator's later platform role does not silently rewrite an
already accepted schedule. Cancelling the job or revoking/disabling its route
stops future useful delivery.

`discordScheduledActionCommand()` is the API v1 command adapter:

```js
discordScheduledActionCommand({
  name,
  description,
  availability: "guild",
  deferred: true,
  scheduleKind,
  options,
  mapSchedule
});
```

`mapSchedule(args)` returns:

```js
{
  actionArgs: {},
  timing: {
    type: "bounded-random",
    minSeconds: 900,
    maxSeconds: 1800
  },
  repeats: true
}
```

The scheduler creates a stable job identity from the originating command
source event. Every occurrence receives:

```text
<source-platform>:schedule:<job-id>:occurrence:<scheduled-unix-seconds>
```

Before coordinator fan-out, the scheduler MUST persist an immutable occurrence
plan containing the normalized action arguments, resolved routes, resulting
effects, source ID, correlation ID, and action kind. A retry replays this plan
instead of resolving routes again. A later occurrence resolves current routes
and receives a new plan.

An occurrence with no enabled routes is a successful no-op. A registry or
coordinator outage is retryable. Once an integration coordinator accepts an
effect, that coordinator owns external delivery retries and dead letters.

## Effect and submission rules

The framework processes a successful action result in this order:

1. Normalize the action result through `createActionResult()`.
2. Confirm every returned effect kind was declared by the action.
3. Confirm every effect's target, integration, causation, and correlation data
   match the current route and invocation.
4. Group routed effects by integration.
5. Submit one `IntegrationExecution` per integration.
6. Return the semantic output to the source adapter after all coordinator
   submissions have been accepted or replayed.

No effects means a valid completed action. Partial coordinator submission is
retried with the same source event and immutable effect plan. Existing
coordinators replay identical submissions and reject conflicting fingerprints.

External delivery remains at least once. The framework does not claim
exactly-once delivery across Discord or Twitch APIs.

## Compatibility policy

### Backward-compatible changes within API v1

The framework MAY make these changes without incrementing `apiVersion`:

- add a new optional manifest field with a default;
- add a new context service that features must explicitly declare;
- add a new schema or command helper;
- add a new platform adapter or effect factory; or
- improve validation messages without changing accepted values.

### Changes requiring Framework API v2

The framework MUST increment `apiVersion` to remove or rename a public field,
change executor arguments, change a method's return semantics, make an optional
field required, weaken isolation, or change when authorization occurs.

API versions MAY coexist during a bounded migration period. New features use
the newest stable version; existing features are migrated explicitly.

### Changes requiring a new semantic `.vN` kind

A new semantic kind is required when persisted input, output, routing meaning,
authorization meaning, effect outcome, or event interpretation changes
incompatibly. Refactoring implementation without changing the contract does not
require a new kind.

Removing a kind is prohibited while persisted jobs, inbox entries, executions,
or dead letters may still reference it. Removal requires a documented drain,
migration, or terminal-handling policy.

Command display text and aliases may change without a new action kind when the
semantic input and behavior remain compatible.

## Complete example 1: shared `alive`

```js
import {
  defineAction,
  defineFeature,
  discordActionCommand,
  discordTextResult,
  schema,
  twitchActionCommand,
  twitchNoArgs,
  twitchTextResult
} from "../../framework/index.js";

const HEALTH_CHECK = "core.health.check.v1";

export default defineFeature({
  apiVersion: 1,
  id: "core.alive",
  description: "A shared responsiveness check.",

  actions: [
    defineAction({
      kind: HEALTH_CHECK,
      capability: null,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({}),
      execute: () => ({
        output: { message: "I'm here!!1" },
        effects: []
      })
    })
  ],

  commands: {
    discord: [
      discordActionCommand({
        name: "alive",
        description: "Replies if alive.",
        availability: "global",
        deferred: false,
        actionKind: HEALTH_CHECK,
        options: [],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "alive",
        description: "Replies if alive.",
        actionKind: HEALTH_CHECK,
        parse: twitchNoArgs(),
        render: twitchTextResult
      })
    ]
  }
});
```

This feature has one semantic action, two platform command presentations, no
integration requirement, and no durable effects.

## Complete example 2: bidirectional announcements

```js
import {
  defineAction,
  defineFeature,
  defineRoute,
  discordActionCommand,
  discordOption,
  discordTextResult,
  schema,
  twitchActionCommand,
  twitchRestText,
  twitchTextResult
} from "../../framework/index.js";

const PUBLISH = "integration.announcement.publish.v1";
const CAPABILITY = "integration.announcement.publish";
const DISCORD_TO_TWITCH = "discord.announce-to-twitch.v1";
const TWITCH_TO_DISCORD = "twitch.announce-to-discord.v1";

export default defineFeature({
  apiVersion: 1,
  id: "integration.announcements",
  description: "Publishes announcements between linked platform groups.",

  routes: [
    defineRoute({
      kind: DISCORD_TO_TWITCH,
      sourcePlatform: "discord",
      targetPlatform: "twitch",
      destination: "none",
      newIntegration: "enabled",
      existingIntegration: "disabled"
    }),
    defineRoute({
      kind: TWITCH_TO_DISCORD,
      sourcePlatform: "twitch",
      targetPlatform: "discord",
      destination: "link-channel",
      newIntegration: "enabled",
      existingIntegration: "disabled"
    })
  ],

  actions: [
    defineAction({
      kind: PUBLISH,
      capability: CAPABILITY,
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        message: schema.string({ minLength: 1, maxLength: 2_000, trim: true })
      }),
      uses: {
        routes: [DISCORD_TO_TWITCH, TWITCH_TO_DISCORD],
        effects: ["discord.message.send.v1", "twitch.chat.send.v1"]
      },
      async execute(ctx, { message }) {
        const routeKind = ctx.origin.group.platform === "discord"
          ? DISCORD_TO_TWITCH
          : TWITCH_TO_DISCORD;
        const routes = await ctx.routes.resolve(routeKind);
        const effects = routes.map((route) =>
          ctx.effects.routedMessage(route, { message })
        );
        const targetName = ctx.origin.group.platform === "discord"
          ? "Twitch"
          : "Discord";
        return {
          output: {
            message: routes.length === 0
              ? `No ${targetName} announcement route is configured.`
              : `Announcement queued for ${routes.length} ${targetName} ` +
                `${routes.length === 1 ? "channel" : "channels"}.`
          },
          effects
        };
      }
    })
  ],

  commands: {
    discord: [
      discordActionCommand({
        name: "integration_announce_twitch",
        description: "Publish an announcement to linked Twitch channels.",
        availability: "guild",
        deferred: true,
        actionKind: PUBLISH,
        options: [
          discordOption({
            arg: "message",
            name: "message",
            description: "Message to send to linked Twitch chats.",
            type: "string",
            required: true,
            maxLength: 500
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "announce",
        description: "Publish an announcement to linked Discord channels.",
        actionKind: PUBLISH,
        parse: twitchRestText({
          arg: "message",
          minLength: 1,
          maxLength: 2_000
        }),
        render: twitchTextResult
      })
    ]
  }
});
```

The Discord adapter enforces Twitch's smaller command-input limit. The action
and effect factory validate the actual target again. Authorization remains one
semantic capability with platform-specific policy evidence.

## Complete example 3: bounded-random Discord-to-Twitch schedule

This feature reuses the announcement action and route installed by the previous
feature. It adds only the schedule definition and Discord command presentation.

```js
import {
  defineFeature,
  defineScheduledAction,
  discordOption,
  discordScheduledActionCommand
} from "../../framework/index.js";

const PUBLISH = "integration.announcement.publish.v1";
const SCHEDULE = "discord.integration.announce-twitch-random.v1";

export default defineFeature({
  apiVersion: 1,
  id: "integration.scheduled-twitch-announcements",
  description: "Schedules recurring announcements to linked Twitch chats.",

  schedules: [
    defineScheduledAction({
      kind: SCHEDULE,
      sourcePlatform: "discord",
      actionKind: PUBLISH,
      timing: "bounded-random",
      authorization: "grant-at-creation"
    })
  ],

  commands: {
    discord: [
      discordScheduledActionCommand({
        name: "integration_schedule_twitch",
        description: "Schedule a recurring message in linked Twitch chats.",
        availability: "guild",
        deferred: true,
        scheduleKind: SCHEDULE,
        options: [
          discordOption({
            arg: "message",
            name: "message",
            description: "Message to send.",
            type: "string",
            required: true,
            maxLength: 500
          }),
          discordOption({
            arg: "min_interval",
            name: "min_interval",
            description: "Minimum interval in seconds.",
            type: "integer",
            required: false
          }),
          discordOption({
            arg: "max_interval",
            name: "max_interval",
            description: "Maximum interval in seconds.",
            type: "integer",
            required: false
          })
        ],
        mapSchedule(args) {
          return {
            actionArgs: { message: args.message },
            timing: {
              type: "bounded-random",
              minSeconds: args.min_interval ?? 7_200,
              maxSeconds: args.max_interval ?? 21_600
            },
            repeats: true
          };
        }
      })
    ],
    twitch: []
  }
});
```

The schedule adapter validates the chosen action input and capability before
acceptance. The bounded-random policy requires integer limits, a minimum of 600
seconds, a maximum of 86,400 seconds, and `minSeconds <= maxSeconds`.

At each occurrence it invokes `integration.announcement.publish.v1` with the
stored Discord origin and a new occurrence source ID. It resolves the current
`discord.announce-to-twitch.v1` routes, persists the immutable occurrence plan,
and submits `twitch.chat.send.v1` effects. Cancellation prevents later
occurrences but does not retract coordinator work already accepted.

## Approved decisions

The project owner approved these decisions before step 2 began:

- one explicit installed-feature catalog;
- separate action-backed and native command helpers;
- explicit action outputs and effects rather than hidden delivery;
- dependency declarations through `uses`;
- reviewed capability presets and no feature-provided authorizer functions;
- route defaults enabled only for new links, with existing links disabled
  unless explicitly migrated;
- authorization grants captured when scheduled work is accepted;
- immutable per-occurrence plans before coordinator fan-out;
- controlled namespaced config/state instead of raw Durable Object access; and
- Framework API versioning independent from semantic `.vN` kinds.

Approval authorizes the staged implementation sequence. It does not commit the
project to runtime third-party plugin loading or to migrating all existing
commands at once.
