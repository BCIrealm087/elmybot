# Hibernating WebSocket state-query transport

Status: transport contract accepted for state-querying roadmap step 13.
The runtime remains on the tested polling SSE transport until step 14 wires the
socket route and observer lifecycle. Public subscriptions remain disabled by
default in both checked-in environments.

## Decision and scope

The long-term live-query transport is a public WebSocket accepted directly by
the selected logical group's `StateQueryObserver` through Cloudflare's Durable
Object WebSocket Hibernation API. The public Worker authenticates and routes the
upgrade; it does not remain as a long-lived relay. Committed owner notifications
continue to wake the observer, reevaluate affected queries, and publish complete
replacement results.

This change replaces delivery transport only. It does not change:

- version-1 query documents, preparation, evaluation, or result envelopes;
- read-grant permissions, target isolation, catalog, snapshots, or sessions;
- effective-state binding revisions and lifecycle handoffs;
- durable source notification and dependency-graph semantics;
- opaque `sq1` cursor meaning, bounded history, or full-replacement results; or
- the browser client's public `catalog`, `read`, `session`, `watch`, `logout`,
  and `close` interface.

The current polling SSE implementation remains available during the rollout
window. Direct Durable Object-owned SSE is not a target because a long-lived
response prevents the object from hibernating. The earlier Worker SSE relay is
also not the selected target: direct public WebSockets remove that additional
transport and failure boundary.

## Release controls

`STATE_QUERY_STREAMS_ENABLED` remains the master subscription switch. A false,
missing, or malformed value disables every public live transport without
affecting catalog or snapshot reads.

`STATE_QUERY_STREAM_TRANSPORT` selects the enabled implementation:

| Value | Meaning |
| --- | --- |
| `polling_sse` | Existing `POST /state-query/stream` adapter and observer polling |
| `hibernating_websocket` | Planned `GET /state-query/socket` WebSocket upgrade |

An omitted selector preserves `polling_sse` for backward compatibility. Any
other value is invalid and fails closed with
`state_query_transport_unavailable` when subscriptions are enabled. During step
13, selecting `hibernating_websocket` deliberately produces that failure because
the new route is not active yet. Both Wrangler environments explicitly select
`polling_sse` until the step-14 implementation is verified.

The Worker compatibility-date baseline is `2026-09-01`. This is new enough for
the runtime's automatic WebSocket close-frame reply behavior; handlers must
still perform application cleanup and remain correct when close and error events
arrive more than once.

## Public route and security boundary

The new public route is:

```http
GET /state-query/socket
Connection: Upgrade
Upgrade: websocket
```

The URL never contains a read grant, query document, target, subscription ID,
or recovery cursor.

Authentication rules are:

1. The supported browser and OBS clients first exchange a read grant through
   `POST /state-query/session`. Their existing `HttpOnly`, `Secure`,
   `SameSite=Strict`, `/state-query` cookie accompanies the WebSocket upgrade.
2. Cookie-authenticated upgrades require an exact `Origin` match with
   `STATE_QUERY_PUBLIC_ORIGIN`. WebSocket handshakes must not rely on CORS as a
   cross-site request defense.
3. A non-browser WebSocket library may send the existing Bearer credential in
   `Authorization`. Bearer clients without that ability must establish a session;
   raw credentials are never accepted in query parameters or subprotocol names.
4. The public Worker verifies the credential signature, environment, target,
   expiry, and revocation before selecting an observer.
5. The Worker routes by the authenticated target and forwards only the grant ID,
   normalized target, and trusted internal metadata. It does not forward the raw
   credential to the observer or store it in a WebSocket attachment.
6. The observer revalidates the grant reference while atomically registering the
   query graph. Public authentication is not a substitute for observer-side
   authorization.

An unauthorized request never creates an arbitrary observer from untrusted
routing fields. Capacity is checked before expensive query attachment and again
immediately before durable reservation.

## Wire protocol

The transport protocol is `state-query-socket/v1`. JSON messages are UTF-8 text;
binary messages are rejected. Registration is at most 384 KiB, while later
control frames are at most 1 KiB. Existing per-query, grant, result, and
dependency limits remain authoritative within those transport envelopes.

### Registration

The first non-heartbeat client message is exactly one registration:

```json
{
  "protocol": "state-query-socket/v1",
  "type": "register",
  "queries": [
    {
      "id": "deaths",
      "query": {
        "version": 1,
        "target": { "platform": "twitch", "groupId": "141981764" },
        "bindings": {
          "game": {
            "read": {
              "feature": "fun.deaths",
              "export": "remembered_game",
              "version": 1
            }
          }
        },
        "select": { "game": { "ref": "game" } }
      }
    }
  ],
  "subscriptionId": "optional prior subscription identity",
  "cursor": "optional prior sq1 cursor"
}
```

Every query target must equal the authenticated grant target. Query IDs retain
the existing safe-character and uniqueness rules. A connection cannot register
twice. Recovery fields are ordering hints rather than credentials; mismatched,
unknown, expired, wrong-query, wrong-grant, or obsolete-binding recovery input
produces a newly authorized resynchronization.

The observer completes the existing evaluate-and-attach handshake before
sending the initial event. It must attach new dependencies before retiring old
ones, and authorization or revision races restart the handshake without exposing
an intermediate result.

### Server events

The server sends:

```json
{
  "protocol": "state-query-socket/v1",
  "type": "event",
  "event": {
    "sequence": 1,
    "cursor": "sq1.opaque",
    "eventType": "snapshot",
    "payload": {
      "protocol": "state-query-stream/v1",
      "subscriptionId": "opaque",
      "results": []
    }
  }
}
```

`eventType` remains `snapshot`, `update`, or `status`. The first event is always
a complete `snapshot`, except that a terminal registration failure may send a
`status`. Update payloads contain complete replacements for every listed query,
not patches. Existing query result reasons and sequences are unchanged.

Before registration, a sanitized protocol error may be sent as:

```json
{
  "protocol": "state-query-socket/v1",
  "type": "error",
  "error": {
    "code": "state_query_stream_invalid",
    "message": "State-query socket registration is invalid."
  }
}
```

No raw resolver, storage, query, state value, or credential text may appear in
an error. After registration, terminal authorization or query failures use a
bounded `status` event before closure when delivery remains possible.

### Acknowledgement and backpressure

After applying an event, the client acknowledges its opaque cursor:

```json
{
  "protocol": "state-query-socket/v1",
  "type": "ack",
  "cursor": "sq1.opaque"
}
```

At most one event may be unacknowledged per connection. While it is outstanding,
the observer stores and coalesces newer complete results in the existing bounded
history rather than repeatedly calling `send()`. After a valid acknowledgement,
the observer sends the newest necessary complete replacement. Duplicate, old,
future, malformed, and wrong-subscription acknowledgements never advance the
delivery cursor.

History remains bounded to 64 events and 256 KiB per subscription, with a
256-KiB aggregate event limit. Crossing a count, byte, age, binding, or
acknowledgement boundary closes the connection and requires a fresh authorized
snapshot; it never creates an unbounded JavaScript or runtime WebSocket queue.

### Heartbeat

Heartbeat messages use exact non-JSON strings so Cloudflare can answer without
waking a hibernated observer:

```text
state-query-ping/v1
state-query-pong/v1
```

The initial client cadence is 30 seconds and the stale threshold is 90 seconds.
`setWebSocketAutoResponse()` handles the pair. A timer must not be created in
the observer merely to produce a heartbeat.

## Close behavior

The protocol uses standard WebSocket close codes:

| Code | Meaning |
| ---: | --- |
| `1000` | Normal client or server cleanup |
| `1008` | Authentication, authorization, origin, target, or protocol policy failure |
| `1009` | Registration or control message exceeds its bound |
| `1011` | Unexpected internal failure after sanitization |
| `1012` | Service restart; reconnect and reauthorize |
| `1013` | Temporary capacity, dependency, or service unavailability |

The terminal `status` or pre-registration `error` carries the stable application
code; the close reason remains short and contains no private values. Close and
error handlers are idempotent. Graceful cleanup removes the subscription graph
when its final socket disappears. Durable leases and alarms clean up abrupt
disconnects that do not produce a usable close event.

## Hibernation and recovery invariants

The observer uses `state.acceptWebSocket()` and recovers sockets with
`state.getWebSockets()` plus serialized attachments. It does not use the
standard `server.accept()` API.

To remain hibernatable while idle, the observer must have:

- no scheduled `setTimeout` or `setInterval` callback;
- no unfinished request or awaited fetch;
- no standard-API or outbound WebSocket;
- no correctness state held only in memory; and
- no heartbeat, polling, or diagnostic work solely because a socket is open.

Connection attachments contain only bounded identifiers and delivery cursors.
Query documents, dependency graphs, current results, recovery history, grant
expiry, and cleanup intent remain in SQLite. The constructor is idempotent and
may run again before any socket message, owner notification, or alarm event.

Owner notifications, lifecycle invalidations, grant invalidations, client
control messages, and cleanup alarms may wake the observer. Outgoing result
messages are not themselves a reason to keep it active after the event handler
finishes.

Reconnect always validates the current grant and binding, then sends a complete
current snapshot. A cursor can optimize recovery only within the same authorized
subscription and effective binding. A source handoff invalidates earlier realm
history even when the visible value is unchanged.

## Step boundaries

- **Step 13:** freezes this contract, adds the validated dual-transport selector,
  records the compatibility baseline, and keeps polling selected.
- **Step 14:** wires the authenticated upgrade, hibernating observer handlers,
  initial registration, direct event delivery, and focused server tests.
- **Step 15:** moves the browser client, setup page, and widget to the socket
  transport without changing their public JavaScript interface.
- **Step 16:** completes acknowledgement backpressure, socket-aware leases,
  durable grant invalidation, expiry scheduling, and failure cleanup.
- **Step 17:** runs parity, load, actual browser/OBS, hibernation, and Cloudflare
  cost verification in the deployed test environment.
- **Step 18:** selects WebSockets in production, completes a rollback soak, and
  removes the polling endpoints and implementation.

No step may claim actual hibernation from local or CI tests. That requires the
deployed duration and connection evidence specified in step 17.
