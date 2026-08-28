# Cross-platform interaction contracts

This document defines the platform-neutral boundary for interactions between
Elmybot platforms. It deliberately does not require every command to be shared.
Discord and Twitch retain their own ingress rules, rendering, permissions, and
native actions while opting into common actions where the behavior is genuinely
the same.

The runtime-checked factories live in `src/integrations/contracts.js`. Identity
and envelope objects are immutable, JSON-safe snapshots suitable for Durable
Object messages and persistence. Action definitions are immutable runtime
registrations and contain an executor function, so they are not persisted.

## Design rules

1. Platform adapters own wire protocols. Discord interactions, Twitch EventSub
   notifications, Discord response tokens, Twitch badges, and message rendering
   do not enter the shared domain as raw transport objects.
2. Actions describe intent. An action kind is not coupled to the platform that
   invoked it. `integration.announcement.publish.v1` can be invoked from Twitch
   or Discord, while `twitch.poll.start.v1` can remain Twitch-only.
3. Effects describe requested outcomes. An effect's target platform can differ
   from the platform that caused it. Adapters validate and deliver their own
   effect kinds.
4. Authority remains explicit. Actor claims are verified by the source adapter
   and namespaced to that platform. A later policy layer maps those claims to an
   action capability; display names never grant authority.
5. Envelope schema versions and semantic kind versions are separate. The
   envelope `schemaVersion` changes only when its structure changes. A `.v2`
   action, event, or effect kind represents changed semantics.
6. Source identity and target identity stay separate. Source event IDs are
   namespaced to their source platform; effect idempotency keys identify the
   particular routed outcome.

## Identity contracts

### `PlatformGroupRef`

Identifies a platform-owned group:

```js
{
  platform: "discord",
  kind: "guild",
  id: "123",
  key: "discord:guild:123"
}
```

The same shape represents a Twitch channel with `platform: "twitch"` and
`kind: "channel"`. Platform, kind, and ID are separate fields so routing does
not need to parse the key.

### `PlatformActorRef`

Identifies an authenticated platform actor and the authoritative claims supplied
by that platform adapter:

```js
{
  platform: "twitch",
  id: "456",
  claims: ["twitch.broadcaster", "twitch.moderator"]
}
```

Claims are evidence, not Elmybot capabilities. For example, the future policy
layer may allow `twitch.broadcaster` to satisfy
`integration.announcement.publish`. Cross-platform user identity must never be
inferred from IDs or display names.

### `IntegrationRef`

An integration is an opaque relationship identity:

```js
{ id: "01J...", key: "integration:01J..." }
```

Membership and link lifecycle belong to `IntegrationRegistry`; routing
configuration will build on that registry in a later step. This reference
intentionally does not impose one-to-one cardinality. See
`docs/integration-linking.md` for the authenticated Discord–Twitch link flow.

## Behavior contracts

### `ActionDefinition`

An action definition declares semantic behavior, its required Elmybot
capability, its allowed ingress platforms, and its executor:

```js
createActionDefinition({
  kind: "integration.announcement.publish.v1",
  capability: "integration.announcement.publish",
  supportedOrigins: ["discord", "twitch"],
  execute
});
```

Platform-unique behavior is represented without special cases:

```js
createActionDefinition({
  kind: "twitch.poll.start.v1",
  capability: "twitch.poll.manage",
  supportedOrigins: ["twitch"],
  execute
});
```

Supporting an origin means that an adapter may expose the action. It does not
bypass actor authorization or integration routing policy.

An action may use `capability: null` when it is intentionally public, such as a
health check. The action executor is runtime behavior and is never serialized.

### `CommandInvocation`

An ingress adapter parses a platform command into an invocation:

```js
{
  schemaVersion: 1,
  kind: "integration.announcement.publish.v1",
  origin: {
    group: { platform: "twitch", kind: "channel", id: "123", key: "twitch:channel:123" },
    actor: { platform: "twitch", id: "456", claims: ["twitch.moderator"] }
  },
  args: { message: "Starting soon" },
  sourceEventId: "twitch:eventsub:message-id",
  correlationId: "twitch:eventsub:message-id"
}
```

The source adapter acknowledges or defers the native interaction. Raw response
tokens are intentionally excluded from the durable shared contract.

### `DomainEvent`

An authenticated platform notification becomes a domain event. Automatic events
need no actor:

```js
{
  schemaVersion: 1,
  kind: "twitch.stream.online.v1",
  source: {
    group: { platform: "twitch", kind: "channel", id: "123", key: "twitch:channel:123" },
    actor: null
  },
  occurredAt: "2026-08-28T12:00:00.000Z",
  payload: { streamId: "789" },
  sourceEventId: "twitch:eventsub:notification-id",
  correlationId: "twitch:eventsub:notification-id"
}
```

### `Effect`

An action or event route produces an effect for a target adapter:

```js
{
  schemaVersion: 1,
  kind: "discord.message.send.v1",
  target: {
    group: { platform: "discord", kind: "guild", id: "321", key: "discord:guild:321" },
    destination: { channelId: "654" }
  },
  payload: { content: "The stream is live" },
  integration: { id: "01J...", key: "integration:01J..." },
  idempotencyKey: "twitch:event-id:integration:01J:route:stream-online",
  correlationId: "twitch:event-id",
  causationId: "twitch:eventsub:notification-id"
}
```

The shared contract checks the envelope and JSON safety. The effect adapter owns
platform-specific validation such as Discord channel IDs, allowed mentions, and
Twitch chat limits.

## Extension policy

- Use `core.*` for behavior that is meaningful without a platform or link.
- Use `integration.*` for behavior whose semantics concern linked groups.
- Use `discord.*` and `twitch.*` for genuinely platform-native behavior.
- Prefer a new versioned kind when semantics change; do not branch on hidden
  payload shapes under the same kind.
- Add a shared action only when the intent is shared. Similar command names do
  not by themselves justify a common implementation.
- Keep platform-specific parsing and presentation in adapters, even when the
  semantic action is shared.

These rules allow new platforms and creative integrations to compose actions and
effects without reducing Discord and Twitch to the same feature set.
