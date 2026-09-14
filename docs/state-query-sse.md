# Public state-query SSE delivery

Status: implemented for state-querying roadmap step 9 on 2026-09-14.

The supported browser client, query setup page, and OBS widget are documented
in [state-query-browser.md](state-query-browser.md).

## Public surface

`POST /state-query/stream` accepts the same Bearer credential or secure
same-origin session cookie as the snapshot API. Its JSON body contains one to
20 independently named version-1 queries:

```json
{
  "queries": [
    {
      "id": "deaths",
      "query": {
        "version": 1,
        "target": { "platform": "twitch", "groupId": "141981764" },
        "bindings": {
          "count": {
            "read": { "feature": "fun.deaths", "export": "count", "version": 1 },
            "arguments": { "game": { "literal": "Hades" } }
          }
        },
        "select": { "deaths": { "ref": "count", "path": ["count"] } }
      }
    }
  ]
}
```

The response is UTF-8 `text/event-stream`. The first `snapshot` event and every
later `update` contain complete results, not patches. A terminal `status` event
reports grant expiry or revocation and closes the stream. Idle streams receive
SSE comment heartbeats every 20 seconds.

Each event has an opaque `sq1` cursor and a payload shaped as:

```json
{
  "protocol": "state-query-stream/v1",
  "subscriptionId": "opaque subscription identity",
  "results": [
    {
      "queryId": "deaths",
      "status": "ready",
      "reason": "initial",
      "sequence": 1,
      "result": { "protocolVersion": 1, "status": "ready", "data": {} }
    }
  ]
}
```

Reasons are `initial`, `resynchronized`, `value_change`,
`dependency_change`, `source_change`, or a terminal grant code. A reconnect may
send the prior `subscriptionId` in the JSON body or the last cursor in the
`Last-Event-ID` header. Reconnection always authenticates again and reattaches
the current query graph before sending a `resynchronized` snapshot. It never
replays a result from an obsolete effective-state realm.

This endpoint uses POST because query documents and Bearer credentials must not
be placed in URLs. Browser clients use `fetch()` and parse SSE framing rather
than constructing a native `EventSource`; cookie sessions remain `HttpOnly`,
`Secure`, and same-origin.

## Delivery topology

The public Worker authenticates and preauthorizes the registration, then asks
the target group's `StateQueryObserver` to perform Step 8's atomic
evaluate-and-attach handshake. The observer persists:

- the active query graph and current complete result;
- a subscription identity and canonical query-set digest;
- a monotonically increasing result-event sequence; and
- at most 64 events and 256 KiB of recovery history per subscription.

The Worker adapter polls this durable history only while its response reader is
requesting another SSE chunk. A slow reader therefore creates no unbounded
in-memory queue. When it resumes, the observer coalesces bounded history by
client query ID and returns the newest retained complete replacement for every
changed query. Intermediate values are discarded without allowing a newer
event for one multiplexed query to hide another query's latest value.

This is a bounded durable-polling fallback, not the provisional
hibernating-WebSocket relay. Actual streaming
tests showed that the local Cloudflare runtime delivered the initial relay
message but did not reliably deliver later observer WebSocket messages through
the regular Worker's returned SSE stream. The fallback is selected so Step 9
does not certify an unproven relay. It keeps the same public SSE contract and
bounds polling to at most two short observer requests per second while a client
is actively waiting for data, but it can consume materially more requests than
the proposed hibernating relay. A separately deployed experiment may replace
the internal adapter with hibernating WebSockets or direct observer-owned SSE
without changing clients.

## Recovery and cleanup

Recovery cursors are scoped to the observer generation, subscription, and event
sequence. They are ordering hints, never credentials. Invalid, unknown,
expired, wrong-query, wrong-grant, or obsolete-source recovery input produces a
new authorized subscription and a `resynchronized` snapshot.

Graceful cancellation requests immediate observer cleanup. If the client or
runtime disappears before that request completes, the active query's durable
lease expires within 120 seconds; the observer alarm removes its graph edges
and unregisters orphaned owner watchers. Polling renews a healthy subscription
before half of that lease has elapsed. Grant authorization is independently
rechecked every 30 seconds and on reevaluation.

Duplicate and out-of-order owner notifications do not advance a live query.
Source changes discard prior recovery history. Restart recovery uses persisted
queries, events, source revisions, leases, and the observer alarm; no correctness
state is held only in the public Worker.

## Limits

| Dimension | Limit |
| --- | ---: |
| Retained subscriptions per logical group | 20 |
| Queries per subscription | 20 |
| Client query ID | 1–64 safe identifier characters |
| Recovery events per subscription | 64 |
| Recovery bytes per subscription | 256 KiB |
| Event retention | 5 minutes |
| Buffered public output | No more than one requested complete event |
| Query lease | 120 seconds, renewed before 60 seconds remain |
| Heartbeat | 20 seconds |
| Empty-result polling interval | 500 ms |

Step 8's query-plan, dependency-edge, result-size, authorization, and observer
capacity limits also apply. A limit failure is explicit; it never silently
drops part of a query.

## Verification boundary

`test/state-query-sse.spec.js` exercises the real Worker route and Durable
Object bindings for initial attachment, complete updates, reconnect after a
disconnected state change, duplicate and older notification suppression,
revocation status and closure, multiplexing, admission limits, slow-reader
coalescing, per-query multiplex recovery, the five composed deaths query shapes,
and lease cleanup.

Local tests cannot establish edge proxy buffering, browser/OBS behavior,
geographic latency, actual Durable Object duration, or behavior across a
deployed runtime replacement. Those remain deployment-gate measurements, not
claims made by this implementation.
