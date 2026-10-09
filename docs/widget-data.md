# Widget-data durable event guide

The `widget.data` feature lets a Discord or Twitch moderator send one bounded
string to an authorized browser or OBS consumer. Each accepted command becomes
one retained, ordered event. This is an every-trigger surface, not replacement
state.

## Public contract

| Surface | Value |
| --- | --- |
| Discord command | `/widget_data data:<text>` |
| Twitch command | `!widgetdata <text...>` |
| Required capability | Moderator |
| Durable stream | `widget.data:updates:v1` |
| Payload | `{ "data": "...", "origin": "discord" | "twitch" }` |
| Success response | `Widget event queued.` |
| Input bound | 1–400 UTF-16 code units after trimming |
| Cooldown | One second per origin group |

The bot treats `data` as an opaque string. It does not parse JSON, interpolate a
template, execute code, or insert the value into HTML. A consumer may choose its
own parser after receiving the string.

The event envelope supplies `eventId`, `sequence`, `acceptedAt`, `expiresAt`, and
`cursor`. These are framework metadata rather than feature payload fields.
Actor, group, source-event, integration, realm, and credential information is
never included in the feature payload.

## Operator setup

1. Issue an event-consumer grant for `widget.data:updates:v1`:

   ```text
   /event_stream_grant stream:widget.data:updates:v1
   ```

   Twitch broadcasters may use the equivalent authenticated Twitch issuance
   flow.

2. Open `/event-stream/setup` on the same Worker origin and paste the one-time
   credential. The page exchanges it for a secure HttpOnly event session.

3. Confirm the displayed target and stream, then start the live handler test.

4. Copy either the credential-free `/event-stream/widget` OBS URL or the
   generated JavaScript integration snippet.

The copied URL contains no credential or query parameter. OBS uses its own
same-origin session, so do the exchange in the browser context that will consume
the events.

The old state-query grant for `widget.data:latest:v1` is not an event grant and
is not converted. Issue a new event-consumer grant after upgrading.

## Delivery behavior

- A success response means Elmybot durably accepted the event.
- One stream delivers events in ascending sequence order.
- The consumer receives at most one unacknowledged event at a time.
- The maintained client acknowledges only after the handler returns or its
  Promise fulfills.
- A rejected or interrupted handler leaves the event unacknowledged; reconnect
  replays it.
- Delivery is at least once, so handlers must tolerate a duplicate.
- Publication fails safely when no authorized consumer is attached, the stream
  is full, a binding is moving, or storage cannot commit the event.
- Retention is bounded to 1,000 unacknowledged events, 1 MiB, and 30 minutes,
  whichever limit is reached first.

The optional recent-event-ID helper stores only a bounded list of opaque event
IDs. It can suppress common replays, but it cannot promise exactly-once browser
effects: a crash after applying an effect and before recording or acknowledging
the event can repeat that effect.

See [Durable-event browser client and OBS setup](durable-event-browser.md) for
the client API, statuses, reconnection behavior, and deduplication example. See
[Durable event delivery contract](durable-event-contract.md) for the normative
protocol and retention rules.

## Linked and standalone groups

The stream uses effective-shareable ownership:

- an unlinked Discord guild or Twitch channel publishes to its standalone
  stream;
- linked groups whose directional defaults select the same integration publish
  to the same physical stream; and
- a default change or revocation moves new commands to the new selected stream.

Version 1 does not merge independently ordered logs during a binding change.
The old consumer may drain retained old-stream events and then receives
`stream_moved`. The operator issues a new grant for the new stream. Commands for
that stream fail as unavailable until its authorized consumer is attached.

## Contributor implementation

The private package is `packages/features/widget-data`. It uses only stable
`@elmybot/framework` APIs and declares:

```js
eventStreams: [
  defineDurableEventStream({
    id: "updates",
    version: 1,
    platforms: ["discord", "twitch"],
    scope: { kind: "effective_shareable" },
    access: { kind: "operator_grant" },
    payload: {
      schema: {
        type: "object",
        properties: {
          data: { type: "string", minLength: 1, maxLength: 400 },
          origin: { type: "string", minLength: 6, maxLength: 7 }
        },
        required: ["data", "origin"]
      }
    }
  })
]
```

Its action selects the other platform direction and publishes the normalized
payload:

```js
const stream = await ctx.eventStreams.current(otherPlatform, "updates");
await stream.publish({ data, origin: ctx.origin.group.platform });
```

Do not add a readable-state mirror or write to the retired `published_data`
namespace. Old stored `latest` values are intentionally left inert and are not
converted into events or deleted as part of this migration.
