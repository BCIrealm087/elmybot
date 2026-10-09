# Durable feature-event delivery contract

Status: approved version-1 contract.
Approved: 2026-09-23.
Applies to: declared durable feature-event streams and the `widget.data`
migration on Discord and Twitch.
Implementation status: not implemented by this document.

This contract defines the authoring, publication, persistence, authorization,
WebSocket, acknowledgement, replay, retention, lifecycle, and failure meaning
for Elmybot's first durable event-delivery mode. It is normative for steps 2–10
of [the durable event transport roadmap](durable-event-transport-roadmap.md).

The existing state-query system remains authoritative for readable current
state. Durable feature events are a separate application-level delivery mode.
Both may use hibernating WebSockets, but they do not share grants, cursors,
history, or semantics.

## Product contract

A feature author selects the surface that matches the product meaning:

| Product meaning | Framework surface | Delivery contract |
| --- | --- | --- |
| What is true now? | `readableState` plus feature state | Complete current replacements; intermediate results may coalesce |
| Handle every accepted trigger | `eventStreams` plus the event-stream service | Ordered, bounded, at-least-once delivery |

All currently installed features retain their existing current-state behavior.
The first durable-event feature is `widget.data`, using the existing Discord
`/widget_data` and Twitch `!widgetdata` commands.

A feature may declare readable state and durable event streams for separate
product surfaces. In version 1, one action must not combine `eventStreams` with
`state`, `shareableState`, or `integrationState`, and an event-publishing action
must return no routed effects. The framework cannot atomically commit unrelated
state, event, and effect owners, so implicit dual publication is rejected.

## Stable version-1 identities

These identities are fixed:

| Surface | Identity |
| --- | --- |
| Feature declaration field | `eventStreams` |
| Declaration helper | `defineDurableEventStream` |
| Action service | `eventStreams` |
| Local accessor | `ctx.eventStreams.local(streamId)` |
| Effective-shareable accessor | `ctx.eventStreams.current(targetPlatform, streamId)` |
| Publish operation | `stream.publish(payload)` |
| Durable Object class | `DurableEventStream` |
| Wrangler binding | `DURABLE_EVENT_STREAM` |
| Public catalog route | `GET /event-stream/catalog` |
| Session route | `POST` or `DELETE /event-stream/session` |
| Grant revocation route | `DELETE /event-stream/grant` |
| Socket route | `GET /event-stream/socket` |
| Setup route | `GET /event-stream/setup` |
| Twitch operator route | `GET /event-stream/operator/twitch` |
| Discord grant command | `/event_stream_grant` |
| Socket protocol | `durable-event-socket/v1` |
| Heartbeat request | `durable-event-ping/v1` |
| Heartbeat response | `durable-event-pong/v1` |
| Event ID prefix | `dev1.` |
| Acknowledgement cursor prefix | `dec1.` |
| Grant credential prefix | `elmybot-deg-v1` |
| Session cookie | `elmybot_durable_event` with path `/event-stream` |
| Credential-signing secret | `DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET` |

Renaming or changing the meaning of one of these public or persisted identities
requires an explicit compatibility decision. Labels, descriptions, and safe
human-facing guidance may be corrected without changing identity when their
behavior remains equivalent.

## Feature-authoring contract

### Declaration

The approved declaration shape is:

```js
defineDurableEventStream({
  id: "updates",
  version: 1,
  label: "Widget events",
  description: "Commands delivered to an authorized widget.",
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
```

The supported version-1 scopes are:

- `{ kind: "group_local" }`, owned by the command's exact platform group; and
- `{ kind: "effective_shareable" }`, resolved through the selected directional
  default for an explicitly supplied other platform, or through the origin
  group's current standalone generation when no selected integration exists.

The framework validates and freezes declarations. Stream IDs use the same safe
lowercase identifier family as shareable namespace IDs and are unique by
`(feature ID, stream ID, version)`. Version 1 supports at most ten event streams
per feature. A description is required, public schemas remain value-free, and a
serialized payload may not exceed 4 KiB even when its declared schema permits a
larger theoretical value.

Only `access: { kind: "operator_grant" }` is supported in version 1. Public,
member, moderator-derived read access and arbitrary feature-owned authorization
callbacks are deferred.

### Runtime service

An action declares `uses: { services: ["eventStreams"] }` and obtains a
feature-bound handle:

```js
const stream = await ctx.eventStreams.current(
  otherPlatform(ctx.origin.group.platform),
  "updates"
);
const receipt = await stream.publish({
  data,
  origin: ctx.origin.group.platform
});
```

`local(streamId)` is valid only for a declared group-local stream.
`current(targetPlatform, streamId)` is valid only for a declared
effective-shareable stream and a platform allowed by that declaration. A handle
is bound to the invoking feature, origin, source event, deployment environment,
and resolved stream. It is not serializable or reusable by another invocation.

Feature code supplies only the payload. The framework owns event identity,
canonical serialization, source retry handling, realm routing, sequence,
timestamps, retention, authorization, and safe failures. Direct Durable Object,
SQL, integration-registry, grant, or WebSocket access is outside the stable
feature API.

Version 1 supports durable publication only from command-triggered feature
actions. Such an action must:

- declare a group cooldown of at least one second;
- publish at most once to a particular stream per source invocation;
- produce the same canonical payload when the same source invocation is retried;
- not request `state`, `shareableState`, or `integrationState` services;
- return `effects: []`; and
- treat a successful `publish()` as its final externally observable operation.

Calling `publish()` twice for the same invocation and stream returns the same
receipt when the canonical payload is equal. A different payload for the same
source identity fails with `durable_event_source_conflict`; it never overwrites
or appends another event.

### Public catalog

The installed value-free event catalog exposes:

```json
{
  "feature": "widget.data",
  "stream": "updates",
  "version": 1,
  "label": "Widget events",
  "description": "Commands delivered to an authorized widget.",
  "platforms": ["discord", "twitch"],
  "scope": { "kind": "effective_shareable" },
  "access": { "kind": "operator_grant" },
  "payload": { "schema": {} },
  "delivery": {
    "kind": "bounded_at_least_once",
    "consumers": 1,
    "retentionSeconds": 1800,
    "maxRetainedEvents": 1000,
    "maxRetainedBytes": 1048576
  }
}
```

The actual schema occupies `payload.schema`; it is abbreviated above. The
catalog never includes payloads, physical stream IDs, integration IDs, realm
generations, binding revisions, grant records, consumer position, event IDs, or
storage metadata.

## Widget-data version-2 contract

The existing commands remain:

```text
/widget_data data:<text>
!widgetdata <text...>
```

Their writer contract remains:

- moderator capability on Discord and Twitch;
- Discord guild-only availability;
- one required `data` string;
- ECMAScript `String.prototype.trim()` normalization;
- 1–400 UTF-16 code units after trimming;
- internal whitespace and quote characters preserved;
- one-second cooldown per origin group; and
- no JSON parsing, template interpolation, or code execution.

These new identities are fixed:

| Surface | Identity |
| --- | --- |
| Feature ID | `widget.data` |
| Action kind | `widget.data.emit.v2` |
| Stream ID | `updates` |
| Stream version | `1` |
| Public stream identity | `widget.data:updates:v1` |
| Payload fields | `data`, `origin` |
| Success acknowledgement | `Widget event queued.` |

The event envelope owns `eventId`, `sequence`, `acceptedAt`, `expiresAt`, and
`cursor`. The feature payload contains exactly:

```json
{
  "data": "consumer-defined text",
  "origin": "twitch"
}
```

`origin` is exactly `discord` or `twitch`. Actor IDs, display names, group IDs,
raw source-event IDs, correlation IDs, integration IDs, realm IDs, storage
identities, credentials, and command timestamps are not payload fields.

`widget.data:latest:v1`, the `published_data` namespace, and the `latest` state
key cease to be installed product surfaces when the migration step completes.
No durable event is synthesized from an old stored value, and an existing
state-query grant is not converted into an event grant. Old inert state is not
deleted automatically.

The package may retain pure compatibility code only while the staged migration
requires it. The completed feature must not dual-publish current state and an
event from one command.

## Logical event identity

### Platform source stability

The existing action adapters supply:

- Discord: `discord:interaction:<interaction-id>`; and
- Twitch: `twitch:eventsub:<EventSub-message-id>`.

Discord retries retain the interaction ID. Twitch's durable EventSub inbox uses
the message ID as its primary identity, rejects reuse with different content,
and retains completed entries for fourteen days. Its action retry schedule
finishes within the event-publication receipt window. The same logical platform
event therefore retains one source identity across supported retries.

### Event-ID derivation

The framework constructs this exact JSON array in the listed order:

```json
[
  "elmybot.durable-event.v1",
  "<feature ID>",
  "<stream ID>",
  1,
  "<origin group key>",
  "<source event ID>"
]
```

The fourth element is the numeric stream version. Serialization uses ordinary
`JSON.stringify` with no whitespace. The framework UTF-8 encodes that string,
computes SHA-256, encodes the 32 digest bytes as unpadded base64url, and prefixes
`dev1.`. The result is exactly 48 ASCII characters and matches
`^dev1\.[A-Za-z0-9_-]{43}$`.

The event ID is collision-resistant and hides raw identifiers from ordinary
inspection. It is unkeyed and is not a secret, credential, chronological value,
or acknowledgement cursor.

The physical realm is deliberately absent from the logical event ID. A source
retry remains the same logical event if the effective binding changes. The
source publication ledger described below prevents that identity from being
committed into two physical streams.

## Source publication ledger

Each origin group's existing `GroupConfig` object owns a durable publication
ledger keyed by event ID. It closes the cross-object and binding-handoff retry
window without exposing this mechanism to feature code.

On the first attempt, the service records:

- event ID and canonical payload fingerprint;
- feature, stream, and version;
- the resolved physical stream route and binding revision;
- a bounded pending payload only while delivery outcome is unknown;
- state `pending`, `committed`, or `rejected`;
- the committed sequence and acceptance time when known; and
- bounded creation, retry, and expiry metadata.

The first attempt pins its route before calling the stream object. Later retries
use that route rather than re-resolving blindly. The outcomes are:

| Outcome | Ledger behavior | Command behavior |
| --- | --- | --- |
| Stream confirms commit | Store receipt, erase pending payload | Success |
| Response is lost after possible commit | Keep pending route and retry idempotently | Retryable failure until resolved |
| Stream proves stale binding before commit | Re-resolve and repin only after proving no append | Continue bounded attempt |
| Consumer absent, stream full, gap-blocked, or invalid payload | Store terminal rejection without payload | Stable bounded failure |
| Canonical payload differs on retry | Keep original record unchanged | `durable_event_source_conflict` |

A retry can therefore discover an event that committed before an interrupted
response, but it cannot append the event to a new realm merely because the
default changed afterward.

Committed and rejected receipt tombstones remain for two hours. Pending rows
retain payloads only for bounded retry work and expire terminally after two
hours. A group stores at most 100,000 receipt rows, 100 pending rows, and 512 KiB
of pending payload. Expired rows are pruned before admission. If preserving the
identity guarantee would exceed a bound, new publication fails safely rather
than evicting a live receipt or accepting an event ambiguously.

The two-hour window exceeds the supported in-process Discord retry lifetime and
the Twitch inbox action-retry schedule. Twitch's longer completed-message
retention prevents a completed EventSub message from re-entering the action
after the receipt expires.

## Physical stream ownership

The framework derives an internal physical identity from this canonical tuple:

```json
[
  "elmybot.durable-event-stream.v1",
  "<deployment environment>",
  "<scope kind>",
  "<canonical standalone or integration realm identity>",
  "<feature ID>",
  "<stream ID>",
  1
]
```

It hashes the canonical JSON to an opaque route ID. Public grants contain only
that signed opaque route, never the realm tuple. One `DurableEventStream` object
owns one physical stream.

For group-local scope, the canonical owner is the exact origin group. For
effective-shareable scope, ordinary directional-default resolution applies:

| Integration state | Selected physical stream |
| --- | --- |
| No selected active integration | Origin group's current standalone generation |
| Selected active integration | That integration generation |
| Additional nondefault integration | Existing selected stream remains |
| Asymmetric defaults | Each direction may select a different stream |
| Transition in progress | Publication fails retryably before acceptance |

Discord and Twitch commands share one physical widget stream only when their
directional defaults resolve to the same active integration generation.

### Binding movement

Activation, default switching, revocation, fallback promotion, and standalone
successor readiness create ordered binding revisions through the existing
integration registry. An event grant pins the binding selected at issuance and
registers durable lifecycle interest.

When that binding stops being current:

1. The old stream becomes drain-only for the affected grant.
2. It accepts no new publication resolved through the obsolete binding.
3. It continues delivering already accepted retained events in order.
4. After the backlog is acknowledged, it sends terminal `stream_moved` and
   closes.
5. The operator issues a grant for the group's new current stream.
6. Commands resolving to that new stream fail as consumer-unavailable until the
   new consumer completes registration.

An old physical stream is not copied, concatenated, timestamp-sorted, or merged
with the new stream. Sequences restart independently. Delayed older lifecycle
notifications cannot move a stream backward or close a grant registered against
a newer binding.

If an old unacknowledged event expires before drain completes, the old stream
records a retention gap and terminates with `retention_gap`; it never reports a
complete drain. The new stream remains independent and still requires its own
grant and consumer.

## Durable stream storage and bounds

The SQLite-backed stream stores:

- stream metadata and next sequence;
- retained event payload rows;
- event-ID receipt tombstones;
- the cumulative consumer acknowledgement position;
- the one current grant and its secret digest/status;
- binding and movement authority;
- gap state;
- bounded retry/cleanup intent; and
- no raw credential.

The initial limits are:

| Limit | Value |
| --- | ---: |
| Active durable consumers | 1 |
| Ready sockets | 1 |
| Unacknowledged server events in flight | 1 |
| Retained unacknowledged events | 1,000 |
| Retained serialized event bytes | 1 MiB |
| Serialized payload per event | 4 KiB |
| Event retention from acceptance | 30 minutes |
| Accepted event ingress | 10 per second per physical stream |
| Event receipt tombstone retention | 2 hours |
| Event receipt tombstones | 100,000 |
| Event receipt metadata bytes | 16 MiB |
| Registration frame | 1 KiB |
| Later client control frame | 1 KiB |
| Server event frame | 8 KiB |

All applicable bounds are enforced together. Sequence values are strictly
increasing positive JavaScript-safe integers, but they need not be contiguous.
Sequence exhaustion rejects publication permanently for that stream rather than
wrapping.

An insert transaction allocates sequence, stores payload and receipt, advances
byte/count accounting, and records the original acceptance/expiry times as one
commit. The server never acknowledges the command before that transaction
commits. A same-event retry returns the original receipt without advancing
sequence or expiry.

Acknowledging an event advances the cumulative position and deletes acknowledged
payload rows transactionally. Minimal receipt tombstones remain for the two-hour
idempotency window. Deletes, expiry, and reset update accounting in the same
transaction.

No active consumer means no accepted event. A ready attached consumer may still
accumulate a bounded backlog while processing one event. Reaching count, byte,
rate, gap, or sequence capacity rejects the new command and preserves every
previously accepted unacknowledged event.

## Command acceptance state machine

A consumer is viable only after:

1. the public Worker and stream object validate its live grant;
2. the socket sends one valid registration frame;
3. the stream durably records the current socket attachment epoch; and
4. the stream sends `ready`.

The stream checks for a viable hibernating socket during publication. A socket
that has upgraded but not registered, an expired/revoked/moved grant, a stale
attachment epoch, or an already closed socket is not viable.

Publication and close events serialize at the stream object. If a disconnect is
not yet observable and an event commits, that event remains retained for replay.
Failure of `send()` after commit does not undo acceptance. If absence is known
before commit, publication is rejected and no event row is created.

The widget command responses are:

| Condition | Safe response meaning |
| --- | --- |
| Durable append confirmed or same-source commit recovered | `Widget event queued.` |
| No viable consumer | `No widget event consumer is connected.` |
| Retained capacity or rate exhausted | `The widget event stream is temporarily full.` |
| Binding transition or retryable service failure | Existing bounded retryable error path |
| Invalid command data | Existing bounded command-input error |
| Unauthorized writer | Existing authorization-denied response |

The command response never claims that the browser-side effect completed. It
claims only that Elmybot durably accepted the event under this contract.

## Event grants

### Issuance

The Discord management command is:

```text
/event_stream_grant stream:widget.data:updates:v1
```

It has optional `duration_hours` and `reset_backlog` fields. Discord issuance
requires Administrator or Manage Server for the exact guild and returns the
credential ephemerally.

For Twitch, the broadcaster opens `/event-stream/operator/twitch`, selects an
installed stream for that channel, and completes the identity-only OAuth flow.
The reset choice is shown only when the selected stream is gap-blocked.

Grant lifetimes range from five minutes through 30 days and default to 24 hours.
One physical stream has one current grant. Issuing a replacement grant for a
healthy stream preserves the acknowledgement position and retained backlog,
revokes the previous grant atomically at the stream owner, sends terminal
`grant_replaced` to its socket, and returns the new credential once.

If the stream is gap-blocked, ordinary issuance fails with
`durable_event_gap_requires_reset`. Explicit `reset_backlog:true` discards all
remaining retained payloads, advances the consumer to the current tail, clears
the gap, records an audit-safe reset marker, and then issues the replacement
grant. This is an explicit loss acknowledgement, not successful delivery.

### Credential

The credential has this exact field order:

```text
elmybot-deg-v1.<environment>.<platform>.<group-id>.<route-id>.<grant-uuid>.<secret>.<routing-mac>
```

The environment uses `[a-z0-9_-]{1,40}`. Discord and Twitch group IDs use their
decimal platform IDs. The route ID, random 256-bit secret, and HMAC-SHA-256
routing MAC are each 43-character unpadded base64url values. The grant ID is a
lowercase UUID.

The routing MAC covers the exact preceding routing fields, including the grant
ID and opaque route ID, using `DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET`. The
stream stores only SHA-256 of the random grant secret. Routing authentication
prevents arbitrary Durable Object selection; the stream's constant-time secret
check and grant record provide access authorization.

Consumers treat the complete credential as opaque. It must not appear in a URL,
query string, fragment, WebSocket subprotocol, event payload, log, metric, or
diagnostic record.

### Session and revocation

Non-browser clients may send `Authorization: Bearer <event-grant>` during the
catalog request or WebSocket upgrade. Same-origin browser and OBS clients
exchange the credential once with `POST /event-stream/session`. The Worker sets:

```text
elmybot_durable_event=<credential>; Path=/event-stream; HttpOnly; Secure; SameSite=Strict
```

Its maximum age does not exceed grant expiry. Cookie-authenticated mutating
requests and WebSocket upgrades require an exact `Origin` match with the
configured public origin. `DELETE /event-stream/session` clears only the local
cookie. `DELETE /event-stream/grant` authenticates the credential, revokes it
durably, closes its socket through event-driven invalidation, and clears the
local cookie when present.

Durable event grants and sessions are rejected by state-query routes. State-query
grants and sessions are rejected by event routes. Stream route IDs, event IDs,
sequences, cursors, and binding revisions never authorize access.

## WebSocket protocol

### Upgrade and registration

The public route is:

```http
GET /event-stream/socket
Connection: Upgrade
Upgrade: websocket
```

The URL has no query parameters. The Worker validates the credential signature,
environment, target, route, expiry, and current grant before selecting the
stream object. It forwards trusted bounded metadata but not the raw credential.
The stream independently validates the grant secret/reference before accepting
registration.

The first non-heartbeat client frame is exactly:

```json
{
  "protocol": "durable-event-socket/v1",
  "type": "register"
}
```

No query document, target, consumer ID, subscription ID, or recovery cursor is
needed. The stream's durable acknowledgement position is authoritative. A new
socket using the same current grant supersedes an older socket by advancing the
attachment epoch; messages from the old epoch cannot acknowledge work. The old
socket receives `consumer_replaced` when possible and closes.

After durable attachment the server sends:

```json
{
  "protocol": "durable-event-socket/v1",
  "type": "ready",
  "stream": {
    "feature": "widget.data",
    "stream": "updates",
    "version": 1
  },
  "delivery": {
    "kind": "bounded_at_least_once",
    "retentionSeconds": 1800,
    "maxRetainedEvents": 1000,
    "maxRetainedBytes": 1048576
  }
}
```

Only after attachment and this ready transition may a command accept a new
event for that consumer.

### Event frame

The server sends one event at a time:

```json
{
  "protocol": "durable-event-socket/v1",
  "type": "event",
  "stream": {
    "feature": "widget.data",
    "stream": "updates",
    "version": 1
  },
  "eventId": "dev1.0000000000000000000000000000000000000000000",
  "sequence": 42,
  "cursor": "dec1.0000000000000000000000000000000000000000000",
  "acceptedAt": "2026-09-23T18:00:00.000Z",
  "expiresAt": "2026-09-23T18:30:00.000Z",
  "payload": {
    "data": "play-intro",
    "origin": "twitch"
  }
}
```

Acceptance and expiry timestamps are server times from the original insert.
They are not platform command time and do not define order across streams.
`sequence` is the ordering authority within this physical stream.

The cursor consists of `dec1.` plus 43 base64url characters generated from 32
random bytes at the original event insert. It is stored with that event and is
stable across replay. It is an opaque acknowledgement selector, not a credential
or sequence encoding.

### Acknowledgement

After successfully applying an event, the client sends:

```json
{
  "protocol": "durable-event-socket/v1",
  "type": "ack",
  "cursor": "dec1.0000000000000000000000000000000000000000000"
}
```

The exact outstanding cursor advances the cumulative acknowledgement and allows
the next retained event to be sent. A duplicate cursor for an already
acknowledged event is a no-op. A malformed, unknown, wrong-stream, unsent, or
future cursor never advances delivery and closes as a protocol-policy failure.

The maintained browser client invokes the registered handler with the event
frame and awaits its returned Promise. It acknowledges only if that Promise
fulfills. A synchronous throw, rejected Promise, page termination, or connection
loss leaves the event unacknowledged for replay.

The server cannot atomically couple a browser side effect to this acknowledgement.
If the page applies an effect and crashes before acknowledgement, the event may
be replayed. Consumers use `eventId` and application-specific idempotence when a
duplicate effect is unacceptable.

### Heartbeat and hibernation

Heartbeat frames are the exact non-JSON strings:

```text
durable-event-ping/v1
durable-event-pong/v1
```

Cloudflare WebSocket auto-response handles them without waking a hibernated
object. The maintained client initially pings every 30 seconds and treats 90
seconds without a pong as stale.

The stream uses `state.acceptWebSocket()` and reconstructs from
`state.getWebSockets()` plus bounded serialized attachments. It has no
`setTimeout`, `setInterval`, standard accepted WebSocket, outbound WebSocket,
unfinished idle fetch, in-memory-only correctness state, or polling work merely
because a consumer is connected.

Alarms are scheduled only for the next actual event expiry, grant expiry,
receipt cleanup, lifecycle/revocation retry, or lost-attachment cleanup
deadline. Empty periodic alarm turns are forbidden.

### Status, error, and close behavior

Post-registration terminal status frames use:

```json
{
  "protocol": "durable-event-socket/v1",
  "type": "status",
  "code": "grant_revoked",
  "terminal": true
}
```

The stable terminal codes are:

- `grant_expired`;
- `grant_revoked`;
- `grant_replaced`;
- `consumer_replaced`;
- `stream_moved`;
- `retention_gap`;
- `service_disabled`; and
- `internal_error`.

Pre-registration failures use a bounded `error` frame when an application frame
can still be sent. It contains only protocol code and safe generic message.

Close codes are:

| Code | Meaning |
| ---: | --- |
| `1000` | Normal acknowledged completion or client cleanup |
| `1008` | Authentication, authorization, target, grant, or protocol policy failure |
| `1009` | Frame exceeds its bound |
| `1011` | Sanitized unexpected internal failure |
| `1012` | Consumer replacement or service restart; reconnect if still authorized |
| `1013` | Temporary capacity, transition, or service unavailability |

Close/error cleanup is idempotent. A delayed close from a superseded attachment
epoch cannot detach the current consumer.

## Retention gaps and reset

Every event expires exactly 30 minutes after its original durable acceptance.
Expiry does not extend on send, reconnect, duplicate delivery, handler failure,
or source retry.

If an unacknowledged event expires, the stream transaction:

1. records the first and last missing sequence in a value-free gap marker;
2. removes expired payload bytes and updates accounting;
3. marks the consumer position gap-blocked;
4. rejects later publication; and
5. sends terminal `retention_gap` when a socket is available.

The client must not automatically reconnect past a gap. Ordinary replacement
grant issuance also refuses to hide it. An authorized operator must explicitly
choose `reset_backlog`, which discards any remaining retained payload, advances
to the current tail, clears the marker, and issues a replacement grant. The
reset record contains stream identity, sequence range, actor, and time but no
payload.

This preserves a bounded guarantee without silently presenting a later event as
the successor to a completely delivered prefix. A reset acknowledges loss; it
does not report expired events as delivered.

## Retry, duplicate, and ordering examples

### Ordinary connected delivery

The widget registers and receives `ready`. A moderator sends
`!widgetdata play-intro`. The command appends sequence 7 and returns `Widget
event queued.`. The server sends sequence 7. The handler fulfills and the client
acknowledges its `dec1` cursor. The payload row is pruned.

### Same-source retry

The stream commits the event, but the Worker response is interrupted before the
platform acknowledgement. The same Discord interaction or Twitch EventSub
message retries. Its source ledger selects the original route, the stream finds
the `dev1` receipt, and the command returns ordinary success without creating a
new sequence.

### Same text, distinct commands

Two source events both publish `play-intro`. Their source IDs differ, so their
event IDs and sequences differ. Both retained events must be delivered in order;
they cannot coalesce merely because their payloads are equal.

### Handler failure

The browser handler rejects while applying sequence 9. No acknowledgement is
sent. The server keeps sequence 9 outstanding and does not send sequence 10.
After reconnect, sequence 9 is sent again with the same event ID, sequence,
cursor, and timestamps.

### Consumer disconnect after acceptance

The command commits while the socket is viable, then the connection closes
before delivery or acknowledgement. The accepted event remains retained. A
same-grant reconnect receives it before newer events, subject to expiry.

### No consumer

No ready authorized socket exists. The command returns `No widget event
consumer is connected.` and records a terminal source rejection. It does not
create an event that appears later when a widget connects.

### Full stream

A slow attached consumer leaves one event unacknowledged while the bounded
backlog reaches a count or byte limit. Previously accepted events remain. The
next command fails with the bounded full-stream response and is not silently
queued, coalesced, or substituted for an older event.

### Default switch

The current grant is pinned to integration A. The group switches its directional
default to integration B. A's retained backlog drains, then its socket receives
`stream_moved`. B has an independent empty sequence and accepts no commands
until an operator issues a B grant and its consumer reaches `ready`.

### Retention gap

Sequence 12 remains unacknowledged for 30 minutes. The stream records a gap and
terminates. It does not send sequence 13 as though delivery were complete. The
operator explicitly resets the backlog and obtains a replacement grant before
new commands can be accepted.

## Errors, diagnostics, and untrusted data

Expected command/service failures use these stable internal codes:

| Condition | Code |
| --- | --- |
| No ready consumer | `durable_event_consumer_unavailable` |
| Count/byte/rate capacity reached | `durable_event_stream_full` |
| Retention gap requires reset | `durable_event_gap_requires_reset` |
| Binding changed before acceptance | `durable_event_stream_transition` |
| Invalid declared/runtime payload | `durable_event_payload_invalid` |
| Same source with different payload | `durable_event_source_conflict` |
| Service/storage unavailable | `durable_event_service_unavailable` |

Platform responses remain bounded and sanitized. No acknowledgement, failure,
log, metric, trace, correlation field, grant diagnostic, reset audit, or close
reason may contain the payload, raw source event, credential, secret digest, or
physical realm identity.

Aggregate diagnostics may report counts and bounded dimensions such as feature,
stream, platform, status code, retained-event bucket, byte bucket, lag bucket,
retry count, alarm count, and hibernatable message classification. Event IDs,
cursors, group IDs, grant IDs, and payload-derived labels are excluded from
ordinary metrics.

The authorized event frame intentionally contains the feature payload.
Consumers treat it as untrusted input. Browser code must not assign it to
`innerHTML`, evaluate it as JavaScript, interpolate it into CSS, or place it in
a URL without application-specific validation. JSON-looking widget data remains
a string until the consumer parses and validates it.

## Compatibility and rollout

Adding `eventStreams` and `defineDurableEventStream` is additive to Framework API
v1. Existing feature definitions, registries, state services, readable-state
catalogs, state-query grants, snapshots, clients, and sockets normalize and
behave as before.

The event system has its own operational master switch,
`DURABLE_EVENT_STREAMS_ENABLED`. False, missing, or malformed configuration
rejects new event grants, registrations, and publication safely without
disabling commands that do not use event streams or any state-query route.

Before widget migration, the switch and event implementation may coexist with
the current widget state export for staged automated verification. The completed
migration has one authoritative event surface and removes the widget readable
export from the installed catalog. There is no runtime fallback that changes an
event command back into coalescing state.

## Explicitly deferred work

Version 1 does not implement:

- exactly-once browser-side effects;
- more than one durable consumer per physical stream;
- named topics within a stream;
- event query composition, projection, or collection lookup;
- automatic log/cursor merging across realm changes;
- seamless migration of an old grant to a new physical stream;
- indefinite offline command acceptance or retention;
- accepting commands during consumer grace periods;
- feature-authored limits above the framework bounds;
- arbitrary binary payloads;
- event search, history browsing, or audit-log APIs;
- global ordering or timestamps across streams;
- public/member publication or consumption;
- non-command action publication;
- atomic state-plus-event or event-plus-routed-effect actions;
- Cloudflare Queues or another interchangeable backend;
- external webhook delivery; or
- reinterpretation of state-query grants, result history, update IDs, revisions,
  or `sq1` cursors as durable event authority.

Those capabilities require separate product, authorization, quota, cost,
failure, and compatibility decisions. They must not weaken version 1's bounded
at-least-once contract.

## Implementation acceptance

This contract is implemented only when roadmap steps 2–10 provide framework
code, Durable Object storage, lifecycle invalidation, grants, the hibernating
protocol, the maintained browser client, widget migration, contributor tooling,
behavioral tests, security/resource evidence, documentation, and passing
authoritative CI.

Approval of this document alone does not make durable event delivery available,
does not alter the currently deployed widget command, and does not authorize a
deployment.
