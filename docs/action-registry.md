# Platform-neutral action registry

The action registry is the semantic boundary between a platform command and
Elmybot behavior. Discord and Twitch still authenticate, parse, acknowledge,
and render their own requests. They pass only a normalized `CommandInvocation`
to the registry.

The registry currently demonstrates both a local action and a routed action:

| Native command | Shared action | Semantic output |
| --- | --- | --- |
| Discord `/alive` | `core.health.check.v1` | `{ message: "I'm here!!1" }` |
| Twitch `!alive` | `core.health.check.v1` | `{ message: "I'm here!!1" }` |
| Twitch `!announce <message>` | `integration.announcement.publish.v1` | Acknowledgement plus one Discord effect per configured route |

This proves that one action can be exposed through different native command
systems without making either platform conform to the other's transport.

## Registry contract

`createActionRegistry` builds an immutable runtime snapshot from one or more
action sets. Startup fails if:

- a kind is registered twice;
- a registry key differs from its action definition's kind; or
- a definition violates the versioned action contract.

`executeAction` then:

1. normalizes and validates the `CommandInvocation`;
2. resolves its versioned action kind;
3. confirms that the source platform is supported;
4. applies the action's capability policy when it has one;
5. executes the action; and
6. normalizes its `ActionResult`.

Unknown actions and unsupported origins fail before executor code runs.

## Authorization behavior

`capability: null` means that the action is intentionally public. The alive
health check uses this form.

A capability-protected action fails closed unless the caller supplies an
`authorize` policy. The policy receives the required capability and normalized
invocation, including the authenticated actor and platform claims. Returning
anything other than `true` denies execution.

The registry does not treat claims as capabilities. The Twitch adapter's
explicit policy permits `integration.announcement.publish` only when the
authenticated EventSub actor has a `twitch.broadcaster` or
`twitch.moderator` claim. Display names and message text never grant authority.

## Action results

Every executor returns a JSON-safe, immutable `ActionResult`:

```js
{
  schemaVersion: 1,
  output: { message: "I'm here!!1" },
  effects: []
}
```

`output` is semantic action output. A platform adapter decides how to render it:
Discord turns the alive message into interaction response data, while Twitch
sends it through the existing chat transport.

`effects` contains normalized effect envelopes when an action requests durable
external work. Alive has no effects and does not require an integration or the
outbox. Announce resolves every enabled `twitch.announce-to-discord.v1` route,
creates a `discord.message.send.v1` effect for each, groups the results by
integration, and submits them to the corresponding durable coordinator.

## Platform adapters

Discord action ingress derives:

- a guild group when the command came from a guild, otherwise a DM channel;
- the authenticated interaction user; and
- `discord:interaction:<interaction ID>` as the source event ID.

Twitch action ingress derives:

- the broadcaster's channel group;
- the EventSub `chatter_user_id`;
- broadcaster and moderator evidence from authoritative IDs and badges; and
- `twitch:eventsub:<notification ID>` as the source event ID.

Raw Discord interaction tokens, Twitch payloads, environment bindings, and
platform response shapes do not enter the action invocation.

## Adding an action

1. Choose a semantic, versioned kind (`core.*`, `integration.*`, or a genuinely
   platform-native namespace).
2. Define supported origins and an explicit capability or `null`.
3. Return a normalized action result with semantic output and/or effects.
4. Register the definition in the appropriate immutable action set.
5. Add small platform command descriptors that build invocations and render the
   result.

Platform-only commands can continue using their existing implementations. They
need to enter the action registry only when the shared semantic boundary is
useful.
