# Twitch EventSub subscriptions and durable inbox

Twitch EventSub ingress is split into three explicit responsibilities:

1. The Worker verifies Twitch's HMAC signature and callback challenge.
2. The subscription registry defines which Twitch event types the deployment
   owns and how each type is processed.
3. A `TwitchEventSubInbox` Durable Object persists notifications and
   revocations before the Worker acknowledges them.

This boundary prevents a verified notification from being marked as seen
before its work has been recorded. It also gives future cross-platform events a
stable place to enter the platform-neutral pipeline.

## Subscription definitions

`createTwitchEventSubRegistry` builds one immutable registry in
`src/index.js`. Each definition declares:

- a versioned semantic kind, such as `twitch.chat.message.v1`;
- Twitch's subscription `type` and `version`;
- whether its condition requires the bot user ID;
- a condition builder;
- a notification handler; and
- an optional revocation handler.

Duplicate semantic kinds and duplicate Twitch type/version pairs fail during
Worker startup. Subscription lifecycle and ingress dispatch therefore use the
same definition rather than maintaining separate type switches.

Two definitions are registered:

- `twitch.chat.message.v1` preserves Twitch-native commands and now exposes the
  authorized `!announce` cross-platform action.
- `twitch.stream.online.v1` creates a platform-neutral domain event and routes a
  Discord stream notice through every enabled
  `twitch.stream-online-to-discord.v1` link route.

To add an EventSub type:

1. Add its stable kind to `eventsub-kinds.js`.
2. Add a definition to `twitchEventSubDefinitions` with its condition and
   handlers.
3. Add focused registry, reconciliation, inbox, and behavior tests.
4. Use a new `.vN` kind when the event semantics change.

Configured channel managers reconcile every definition currently installed in
the registry. The EventSub service lists the channel's subscriptions once,
keeps one healthy exact match per definition, removes stale managed matches,
and creates missing subscriptions. Deconfiguration removes every registered
type owned by the bot. The protected manual creation endpoint accepts an
optional `kind` and defaults to the existing chat definition for compatibility.

## Durable acceptance

After signature verification, notifications and revocations are submitted to
one inbox Durable Object per Twitch broadcaster. The inbox validates the
registered subscription type, broadcaster identity, timestamp, message ID, and
payload size. It then writes the message and arms an alarm before the Worker
returns `204` to Twitch.

The message ID is the durable deduplication key. An identical replay returns the
existing record, even if its delivery timestamp differs. Reusing an ID with a
different message type, semantic kind, or payload is a conflict. Unsupported
signed subscription types are acknowledged and logged rather than retried
forever by Twitch.

Inbox messages move through these states:

| State | Meaning |
| --- | --- |
| `pending` | Persisted and ready for its first handler attempt |
| `attempting` | Claimed by the active drain invocation |
| `retry_wait` | A retryable failure is waiting for backoff |
| `completed` | Its registered handler completed successfully |
| `dead_letter` | A terminal failure occurred or five attempts were exhausted |

The request execution context starts an immediate best-effort drain, while the
Durable Object alarm is the recovery mechanism if that work is interrupted.
Drains process at most 20 due messages. Retry delays start at 30 seconds and cap
at 30 minutes. An `attempting` claim has a one-minute lease; its recovery alarm
returns an interrupted attempt to the retry queue. Completed and dead-letter
records are retained for 14 days and pruned opportunistically.

The internal inbox exposes bounded message-status and dead-letter interfaces
for later management tooling. They are not public Worker routes.

## Delivery guarantee

The inbox provides durable, at-least-once handler execution. A crash after an
external platform accepts an operation but before the inbox records completion
can still repeat that operation. Cross-platform handlers should therefore
convert events into stable `IntegrationExecution` values and rely on the
integration coordinator's source-event and effect idempotency keys wherever
possible.

The `!announce` and stream-online handlers use the inbox message ID as their
source event ID. Each integration coordinator therefore deduplicates EventSub
replays before its Discord effect reaches the external API.

## Deployment notes

Wrangler migration `v13` creates `TwitchEventSubInbox`, with production and test
bindings. It uses the existing Twitch application and EventSub configuration;
no new secret is required.
