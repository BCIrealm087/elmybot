# State-query live transport decision

Status: accepted for the initial implementation direction on 2026-09-12.
Scope: roadmap step 2; this is a feasibility decision, not a deployment record.

## Decision

Keep server-sent events as the public browser API. Do not make a long-lived SSE
response owned directly by a Durable Object the default production topology.
Instead, use this provisional topology in step 9:

1. A regular Worker authenticates an SSE request and acts as the public SSE
   adapter.
2. The adapter opens one internal WebSocket to a query observer Durable Object
   for the explicitly selected platform group.
3. The observer accepts the server end with the Durable Object WebSocket
   Hibernation API and sends the same full `state-query-result/v1` envelopes
   chosen in step 1.
4. The adapter translates internal WebSocket messages to UTF-8 SSE frames.
   This internal hop is not a second public protocol.
5. Each observer is keyed by environment, platform, and logical group. There is
   no singleton connection registry or global value-traffic object.

This preserves the EventSource-friendly product surface while allowing an idle
observer Durable Object to hibernate. Cloudflare Workers have no billable
duration dimension under Standard pricing; their requests and executed CPU
remain billable. A directly owned Durable Object response stream stays active
for its lifetime and accrues Durable Object duration. Hibernation is available
only when the Durable Object is the WebSocket server.

The SSE adapter topology is provisional until a deployed experiment verifies
that the Worker can reliably bridge an EventSource response to the hibernating
WebSocket across runtime updates, client disconnects, and representative idle
periods. If that experiment fails, direct per-group Durable Object SSE remains
the compatible fallback, with its duration cost made explicit. Replacing the
public SSE API would require a separate product decision.

## Why the observer is group-local

A subscription expresses a Twitch-channel or Discord-guild perspective and
must re-resolve that group's effective standalone or shared state. The observer
therefore follows a logical platform group, not a physical realm. When a Twitch
channel and Discord guild select the same integration, their observers can
receive the same underlying value notifications, but each keeps its own target,
grant, binding revision, and lifecycle decisions.

Sharding by logical group isolates connection limits and failure domains and
keeps live value traffic away from `IntegrationRegistry`. Registry and lifecycle
services notify only affected group observers. Steps 6–8 will define the durable
notification and shared dependency-evaluation path; this decision does not make
the existing registry a fanout broker.

## Bounded SSE proof

[`sse-transport-proof.js`](../src/state-querying/sse-transport-proof.js) is an
in-memory transport experiment, deliberately not a route, binding, authorization
boundary, or production registry. Its Cloudflare-runtime tests cover:

- one observer receiving a full initial snapshot and replacement result;
- multiple observers receiving a replacement from the same source;
- cleanup on reader cancellation and explicit hub shutdown;
- bounded `Last-Event-ID` replay with a current snapshot on invalid, current,
  future, expired, or over-budget cursors;
- one pending full replacement for a slow reader, with intermediate values
  coalesced to the latest committed result;
- comments used as explicit heartbeats without advancing result cursors; and
- connection, result-size, history-count, and replay-byte limits.

The proof attaches the reader before returning the initial snapshot and performs
both operations synchronously in one hub turn. Production code must replace that
in-memory property with the version-checked, durable snapshot-and-attach protocol
from steps 6–9. Replay is only an optimization: reconnect always reauthorizes and
re-resolves the current binding, and a source handoff may discard old history and
send a replacement snapshot.

## Initial budgets

These are conservative admission limits and service objectives for the first
implementation. They are not claims of measured Cloudflare capacity. Exceeding
an admission limit returns an explicit bounded error; backpressure coalesces
current-state results or terminates the stream for a fresh resynchronization.

| Dimension | Initial budget or objective |
| --- | --- |
| Concurrent public SSE connections | 20 per logical group observer |
| Queries per SSE connection | 20, matching the step 1 contract |
| Distinct active query plans | 100 per logical group observer after safe deduplication |
| Dependency edges | 40 per query and 2,000 active edges per group observer |
| Query document | 16 KiB UTF-8 |
| Ready result | 64 KiB UTF-8 before SSE framing |
| Buffered output | Latest replacement only per query; 256 KiB aggregate per connection before reconnect |
| Replay | At most 64 result events and 256 KiB per reconnect; otherwise snapshot |
| State notifications | 100 per second sustained and 500 in a one-second burst per group, with coalescing |
| Result deliveries | 500 per second sustained per group, subject to the output budget |
| Healthy update latency | p95 at most 1 second; p99 at most 3 seconds from committed mutation to client event |
| SSE heartbeat | 20 seconds from the Worker adapter; never wakes the observer merely to keep it alive |
| Stale detection | Mark reconnecting after 45 seconds without an event or heartbeat |
| Healthy recovery | Fresh authorized result within 5 seconds after transport reconnection |
| Reconnect backoff | Jittered exponential delay from 1 to 30 seconds |

The 32,768-WebSocket platform maximum and the roughly 1,000 requests/second
single-object soft limit are ceilings, not suitable initial product budgets.
The lower limits above leave headroom for query evaluation, lifecycle changes,
authentication, and noisy groups.

## Reproducible cost comparison

Run:

```sh
node scripts/model-state-query-transport.js
```

The model uses the Cloudflare Durable Objects paid-plan prices checked on
2026-09-12: 128 MB billed memory, 1 million requests and 400,000 GB-seconds
included monthly, then $0.15 per million requests and $12.50 per million
GB-seconds, with billable usage rounded up to a full unit. It intentionally
excludes the base Workers subscription, storage, the public Worker's request and
CPU usage, and unrelated account usage.

The representative scenario is 100 active group observers, 10 clients each,
8 active hours per day for 30 days, one connection per client per day, 10 state
changes per group per hour, and 10 ms of observer activity per change.

| Model result | Direct DO-owned SSE | SSE adapter + hibernating observer WebSocket |
| --- | ---: | ---: |
| Connection requests | 30,000 | 30,000 |
| Notification requests | 240,000 | 240,000 |
| DO duration | 10,800,000 GB-s | 300 GB-s |
| Incremental DO request cost | $0.00 | $0.00 |
| Incremental DO duration cost | $137.50 | $0.00 |

Direct SSE duration is counted once per active group, not once per viewer,
because overlapping requests share one object's duration. The hibernating case
counts only the assumed notification-handler time. Server-to-client WebSocket
messages are not billed as incoming messages. Real account totals can be higher
when other Durable Objects consume the included allocations or when actual
handler time, reconnects, storage, or Worker CPU exceed these assumptions.

## Connection and recovery rules

1. Authenticate, authorize the complete query, canonicalize it, and resolve the
   selected group's current binding before opening the internal connection.
2. Register the connection and dependency interest with a version-checked
   snapshot handshake. The first public event is always a complete result.
3. Store only bounded identifiers and recovery metadata in the hibernating
   WebSocket attachment. Persist larger query registrations separately; the
   attachment platform limit is 16,384 bytes.
4. Send full replacements. Slow consumers keep only the latest result for each
   query within the aggregate buffer budget. If the budget is exceeded, close
   and require a fresh authorized snapshot.
5. Worker-generated SSE comments provide idle heartbeats without waking the
   observer. Do not use `setTimeout` or `setInterval` in the observer Durable
   Object merely for keepalive, because scheduled callbacks inhibit hibernation.
6. On disconnect, remove in-memory interest immediately. Steps 6 and 9 must add
   bounded durable leases so abrupt termination also expires interest.
7. On reconnect, reauthenticate, reauthorize, and re-resolve. Replay only if the
   cursor belongs to retained history for the current binding; otherwise send a
   `resynchronized` snapshot. Never replay an archived physical realm.
8. Runtime interruption, credential expiry, source transition, or source
   handoff produces an explicit status or a closed stream followed by bounded
   reconnect. A source handoff is visible even if its value is unchanged.

## Evidence and remaining deployed checks

The proof targets the repository's Cloudflare Vitest environment using
`@cloudflare/vitest-plugin` 1.1.x, Wrangler 4.126.x, compatibility date
2026-01-11, and Node 24.19.0 for the standalone cost script. Local and CI tests
can establish Web Streams framing, ordering, cancellation callbacks, replay,
coalescing, and deterministic cost arithmetic.

They cannot establish actual Durable Object eviction or hibernation: Cloudflare
documents that local Miniflare delivers WebSocket events but does not evict the
object. They also cannot establish edge buffering, EventSource behavior through
proxies, geographic placement, runtime-update recovery, real request/CPU/
duration metrics, or latency percentiles.

Before enabling production traffic, deploy a separate test Worker and verify:

- the adapter and hibernating server topology with 1, 20, and 100 connections;
- at least 15 minutes idle with no observer duration growth attributable to
  keepalive and with the connection still usable afterward;
- 20-second SSE comments and disconnect cleanup in Chromium and OBS browser
  sources;
- the sustained and burst budgets, slow-reader termination, and reconnect after
  a binding revision change;
- p50, p95, and p99 commit-to-widget latency from at least two regions; and
- Cloudflare Analytics request, CPU, duration, storage, and error totals against
  this model.

No deployment was performed in step 2.

## Sources checked

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Durable Object State WebSocket limits](https://developers.cloudflare.com/durable-objects/api/state/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
