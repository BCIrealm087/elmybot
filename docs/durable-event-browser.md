# Durable-event browser client, setup, and OBS widget

## Operator setup

Open `/event-stream/setup` on the selected environment's Worker origin. Enter an
event grant issued by `/event_stream_grant`, or use the Twitch operator flow.
The page exchanges the credential for the event-only `HttpOnly` session cookie;
it never places the credential in a URL, fragment, WebSocket subprotocol, or
generated snippet.

The setup page shows the exact authorized target and stream. **Start live test**
attaches the stream's one consumer and displays incoming payloads as text. Once
the socket is ready, the page also shows the fixed retention, event-count, and
byte limits reported by the server.

Copy the `/event-stream/widget#…` URL into an OBS Browser Source. The fragment
contains presentation configuration only. Use **Interact** in OBS to enter the
event grant once. OBS stores the secure session separately from the setup
browser, so opening the setup preview and the OBS source simultaneously causes
the newer connection to replace the older one by design.

The setup page also produces a minimal JavaScript integration example. Existing
`/state-query/setup`, `/state-query/widget`, and state-query client assets remain
separate and unchanged.

## Client API

The maintained same-origin module is `/event-stream/client.js`:

```js
import {
  createDurableEventClient,
  createRecentEventIdDeduplicator
} from "/event-stream/client.js";

const client = createDurableEventClient();
const recent = createRecentEventIdDeduplicator({ maxEntries: 100 });

const subscription = client.subscribe(async (event) => {
  await recent.handle(event, async ({ payload, eventId, sequence }) => {
    await operateWidget(payload, { eventId, sequence });
  });
}, {
  onStatus(status) {
    console.log(status.state, status.code);
  }
});
```

The handler receives the complete public event frame: `stream`, `eventId`,
`sequence`, opaque `cursor`, `acceptedAt`, `expiresAt`, and `payload`. The client
does not evaluate or execute payload strings.

The client sends the cursor acknowledgement only after the handler returns or
its Promise fulfills. A synchronous throw or rejected Promise closes the socket,
reports `handler_failed`, and reconnects. Because the acknowledgement did not
advance, the server replays that same event before any later retained event.

One client supports one active handler because one grant selects one stream and
the server supports one active consumer. Create separate clients only for
separate event sessions in separate browser contexts. `unsubscribe()` detaches
the handler; `client.close()` tears down the client. `session(credential)`,
`catalog()`, and `logout()` operate only on `/event-stream/*` and never reuse a
state-query session.

## Status states

The `onStatus` callback receives:

| State | Meaning |
| --- | --- |
| `connecting` | Opening and registering the first socket |
| `live` | Ready for the next event |
| `handling` | Awaiting the current handler; no acknowledgement has been sent |
| `handler_failed` | Handler rejected; reconnect and replay are pending |
| `reconnecting` | Recovering an interrupted non-terminal socket |
| `ended` | Terminal grant, consumer, stream, gap, policy, or protocol state |
| `closed` | The application closed the client |

Terminal `code` values include `grant_expired`, `grant_revoked`,
`grant_replaced`, `consumer_replaced`, `stream_moved`, `retention_gap`,
`service_disabled`, and `internal_error`. Terminal statuses do not reconnect
with the same grant.

## Bounded duplicate assistance

`createRecentEventIdDeduplicator()` keeps at most 100 event IDs by default and
at most 1,000 when configured. It uses same-origin `localStorage` when available
and falls back to memory if storage is unavailable. It stores no payload,
credential, cursor, target, or actor data.

`recent.handle(event, handler)` skips the handler when that event ID was already
recorded. Otherwise, it awaits the handler and records the ID immediately after
success, before the transport acknowledgement. This narrows an ordinary crash
window but cannot provide exactly-once external effects:

1. the handler can complete an external side effect;
2. the page can crash before the event ID is recorded; and
3. the unacknowledged event will then replay.

When duplicate effects are unacceptable, the external system should enforce
idempotence using `eventId`. Never record an ID before its effect succeeds,
because doing so could silently skip work after a failure.

## Verification

- Browser-client unit tests cover fulfillment-before-acknowledgement, handler
  rejection and replay, offline reconnection, frame bounds, terminal statuses,
  bounded recent IDs, and event/state session separation.
- Miniflare connects the maintained client to the real Worker and Durable Object
  protocol, proving replay until asynchronous success and durable acknowledgement.
- The Chromium smoke runs both setup and an isolated OBS-style browser context,
  verifies credential-free URLs, arbitrary-string text safety, acknowledgement,
  reconnect, terminal revocation, and teardown.

The lower-level grant/session routes are documented in
[`durable-event-http.md`](durable-event-http.md), and the normative frames and
delivery semantics remain in
[`durable-event-contract.md`](durable-event-contract.md#websocket-protocol).
