# Readable snapshots and combined-event browser coordination

Roadmap step 8 exposes private combined commits through ordinary readable-state
exports and ships a browser coordinator. [Step 9](health-state-event-migration.md) adds the opt-in health v2 command/widget
migration. This step-8 layer preserves separate grant and credential semantics.

## Readable correlation

Declare readable state normally with `defineReadableStateExport`, using the same
feature and local scope or shareable namespace as the combined operation. Read
its authoritative value using `ctx.state.get()` or `ctx.state.boundedCounter()`.
The framework adds reserved `stateEvent` metadata to each selected result cell
from that partition; a resolver cannot provide or override it. Collections and
projected selections retain their source partition watermark as well.

```js
{
  state: "present",
  value: 90,
  stateEvent: {
    version: 1,
    scopeToken: "ses1.<opaque incarnation>",
    operationSequence: 7,
    stateRevision: 12
  }
}
```

| Field | Snapshot | Associated event |
| --- | --- | --- |
| `version` | Correlation protocol 1 | Correlation protocol 1 |
| `scopeToken` | Opaque owner/feature/namespace partition incarnation | Same incarnation as the original commit |
| `operationSequence` | Latest accepted combined operation in that partition, initially zero | This accepted operation's sequence, at least one |
| `stateRevision` | Observed readable revision, including ordinary state writes | Readable revision at this operation's commit |
| `operationId` | Omitted: the watermark covers multiple operations | Opaque `seo1` identity for this operation |

Transport event sequences and acknowledgement cursors have separate domains.
Different streams in a partition can skip operation sequence numbers; gaps in
those numbers alone do not prove lost events. Revisions and operation sequences
are safe integers, never timestamps. Compare them only within the same scope
token. Ordinary writes may advance the revision without advancing the operation
watermark. An accepted clamped no-op advances both the operation watermark and
readable revision even though its numeric value is unchanged.

Before the first operation, an authorized read initializes a random persisted
partition token with sequence zero. It consumes one of the existing hundred
partition slots, but creates no accepted operation, event, notification or alarm.
The subsequent commit reuses that token. Normal reads without associated combined
declarations do not allocate this infrastructure. Tokens/watermarks survive
outbox and receipt cleanup, and are excluded from successor-state copying.

The internal revision read returns the revision and watermark together. The
query evaluator checks both before and after resolving values and checks shared
lifecycle authority as before. A concurrent change retries the whole evaluation;
watch attachment still checks the same revision to close its setup race.
Correlation participates in the normal result digest and 64-KiB result limit,
so a no-op commit remains observable and can notify an attached widget. No extra
Worker RPC, owner polling or periodic timer is added to evaluation.

## Widget integration

Use separately authorized state and event clients. Choose a readable selection
from the same producer partition as the authorized combined stream, and import:

```js
import { createStateQueryClient } from "/state-query/client.js";
import { createDurableEventClient } from "/event-stream/client.js";
import { watchStateEvents } from "/event-stream/state-event.js";

const stateClient = createStateQueryClient();
const eventClient = createDurableEventClient();
// Each session is established separately by the widget's credential UI.
await stateClient.session(readGrant);
await eventClient.session(eventGrant);

const subscription = watchStateEvents({
  stateClient,
  eventClient,
  query,                 // Ordinary query document with a "health" selection.
  selection: "health",
  storageKey: "my-widget.health-impact-ids.v2",
  onSnapshot(cell) {
    // Keep this callback synchronous; readable state owns the displayed value.
    renderHealth(cell.value);
  },
  async onEvent(event, { stateIncluded }) {
    // Animate the impact. Do not subtract/heal the displayed value again.
    // stateIncluded says whether the latest snapshot already covers this event.
    await animateImpact(event.payload, { stateIncluded });
  },
  onStatus(status) { renderConnection(status); }
});
// Detach the two subscriptions when this widget is removed.
subscription.unsubscribe();
```

The helper registers the event consumer first, then attaches the state watch and
acquires a fresh HTTP snapshot. A watch update received during that read can
supersede an older HTTP response. The original value cannot move backward within
the scope. The snapshot read has a ten-second abort deadline; obsolete reads are
aborted and ignored. `stateClient.read(query, { signal })` also supports an
optional caller abort signal without changing existing calls.

At most one unacknowledged event waits for initialization. Events at/below the
initial snapshot's watermark are historical: remember and acknowledge them
without replaying old animations. Later events invoke `onEvent` even if a newer
live snapshot already includes them. This distinction preserves each live
accepted impact, including zero-applied impacts, while avoiding double arithmetic
and stale absolute event results overwriting newer state.

The existing event client acknowledges only after the async handler completes.
A failed animation is not remembered; ordinary delivery recovery may retry it.
On reconnect, the helper pauses handling and acquires a replacement snapshot;
missed retained impacts covered by that recovery baseline may be deliberately
omitted. No browser-local numeric state is uploaded or treated as authoritative.

A scope-token change, unsupported correlation version, denied read access, ended
subscription or explicit retention/lifecycle gap stops coordination. Neither an
event grant nor a new scope token grants read access. The operator must use the
existing backlog reset/regrant flow when needed; acquire an authorized stream
and fresh snapshot, then create a new subscription. The helper does not reset a
gap, move grants, infer an owner from private IDs or acknowledge mismatched work.

## Bounds and lower-level API

`createStateEventCoordinator` is also exported for custom transports. Call
`pause()` before reconnect/recovery, `update(cell)` for ordinary watch updates,
`initialize(cell)` for the acquired fresh recovery baseline, and pass its async
`handle(event)` to the event client. `close()` rejects pending work and stops
coordination. It enforces one buffered event and an initial snapshot wait of ten
seconds by default (`snapshotTimeoutMs`, 1–30,000 ms).

Handled IDs use `createRecentEventIdDeduplicator`: 1–1,000 IDs (default 1,000),
optional local storage, no payloads, numeric health or credentials. Use an
appropriate widget/stream storage key; pass `storage: null` for memory only.
Storage failure falls back to memory. The in-memory ordered sequence watermark
also suppresses duplicates in the active incarnation. Across a crash, bounded
ID history is an aid, not an exactly-once guarantee: visible effects, ID storage
and server acknowledgement cannot be committed atomically. A new widget may
omit historical startup animations; a crash can repeat an unfinished effect.

The core coordinator validates correlation. The shipped durable-event client
additionally rejects malformed/unsupported optional `stateEvent` before invoking
a handler or acknowledging; ordinary event-only frames need no correlation and
retain their existing semantics. A single selected readable cell can contain a
projection of several values; correlation identifies its owner partition, not a
claim that every event changed that particular value.

## Evidence

`test/state-event-readable.spec.js` uses real local/shared Durable Object SQLite
and binding forwarding for zero-operation tokens, commits, accepted clamped
no-ops, query setup races, eviction and watermark persistence after cleanup.
`test/state-event-browser.spec.js` covers both arrival orders, delayed HTTP
responses, duplicates, rapid updates, no-ops, scope/version rejection, bounded
buffering, failures, reconnect baselines, denied reads and gap teardown.
`test/durable-event-browser-client.spec.js` verifies wire validation before ACK.

`scripts/smoke-state-event-browser.js`, included in `npm run test:browser`, runs
both shipped clients in Chromium over real HTTP/WebSocket fixtures. It exercises
setup buffering, both arrival orders, snapshot-ahead events, rapid updates,
zero-applied events, duplicate ACKs, reconnect, gap teardown and a newly
authorized owner, with separate read/event sessions. Existing grant, state-only,
event-only and browser smokes remain compatibility gates.
