# Widget data publication contract

Status: approved version-1 contract.
Approved: 2026-09-19.
Applies to: `widget.data` on Discord and Twitch.
Implementation status: not implemented by this document.

This contract defines the command, persistence, readable-state, identity,
authorization, and delivery meaning for the first widget-data feature. It is
normative for steps 2–8 of
[the widget-data roadmap](widget-data-roadmap.md).

The feature publishes one current bounded string for state-query clients. It
uses the existing current-state query and hibernating WebSocket contracts. It is
not an event queue and does not guarantee observation of every command.

## Product contract

An authorized moderator may replace the current widget-data value from a
Discord guild or Twitch channel. The stored value contains a stable opaque
identity for that source command, the normalized text, and the origin platform.

An authorized query client may:

1. discover the readable export;
2. read the current value in a snapshot;
3. project any declared field; and
4. subscribe to complete replacement results.

The latest accepted publication is authoritative for the selected effective
shareable-state realm. A slow or disconnected client may miss intermediate
publications. On first connection or resynchronization, the client receives the
current value only.

## Stable identities

These version-1 identities are fixed:

| Surface | Identity |
| --- | --- |
| Package directory | `packages/features/widget-data` |
| Package name | `@elmybot/feature-widget-data` |
| Feature ID | `widget.data` |
| Action kind | `widget.data.publish.v1` |
| Shareable namespace | `published_data` |
| Namespace schema version | `1` |
| State key | `latest` |
| Readable export | `latest` |
| Readable export version | `1` |
| Discord command | `widget_data` |
| Twitch command | `widgetdata` |
| Action input field | `data` |
| Result fields | `updateId`, `data`, `origin` |
| Update-ID format | `wdu1.<SHA-256 base64url digest>` |

Renaming or changing the meaning of a persisted or public identity requires an
explicit compatibility decision. Labels, descriptions, and acknowledgement
wording may be corrected without changing identity when their behavior remains
equivalent.

## Commands

### Discord

The Discord command is:

```text
/widget_data data:<text>
```

It is guild-only and has one required string option:

| Option | Type | Required | Normalization | Bound |
| --- | --- | --- | --- | --- |
| `data` | string | yes | ECMAScript `String.prototype.trim()` | 1–400 UTF-16 code units after trimming |

Recommended registration description: “Publish the current widget data.”

### Twitch

The Twitch command is:

```text
!widgetdata <text...>
```

It uses `twitchRestText({ arg: "data", minLength: 1, maxLength: 400 })`.
Internal spaces do not require quoting. The parser trims the complete remainder
before validation, and the action schema applies the same normalization again.

Recommended catalog description: “Publish the current widget data.”

### Shared action definition

The action has:

- `capability: access.moderators`;
- `supportedOrigins: ["discord", "twitch"]`;
- input `schema.object({ data: schema.string({ minLength: 1, maxLength: 400,
  trim: true }) })`;
- `uses.services: ["shareableState"]`; and
- `cooldown: { scope: "group", seconds: 1 }`.

On Twitch, the broadcaster and moderators satisfy the moderator capability. On
Discord, the existing Discord permission service decides moderator capability,
including its configured-role behavior. The feature does not add a parallel
permission list.

The group cooldown bounds accepted command work for one origin group. Discord
and Twitch groups retain separate cooldowns even when their data resolves to the
same integration realm. Concurrent accepted writes therefore remain possible;
the selected realm serializes its individual state operations and the last
committed value is current.

A transition or storage failure uses the existing sanitized platform/framework
error path. The action does not fall back to a different realm.

### Success acknowledgement

After a successful state write, the action output is exactly:

```text
Widget data updated.
```

The response does not echo `data`, the update ID, the source event ID, the
group, the actor, or integration information. Discord uses the ordinary
mention-suppressed action response; Twitch uses the ordinary bounded text
response.

A same-source retry that reaches the action returns the same success response.
Platform deduplication or the group cooldown may stop a duplicate before action
execution. In every case, a retry must not create a new logical publication.

## Payload semantics

The feature accepts text, not an arbitrary JSON value or binary payload.

- Outer whitespace is removed.
- Internal whitespace is preserved.
- Matching quote characters are data. Twitch does not tokenize the remainder.
- An empty result after trimming is rejected.
- More than 400 UTF-16 code units after trimming is rejected.
- Unicode is allowed subject to that bound and the platform's own accepted
  message/option input.
- Elmybot does not parse JSON-looking data, validate a consumer-defined format,
  interpolate templates, or execute code.

The stored `data` equals the normalized action argument. A consumer may parse
it as JSON or another format, but must treat it as untrusted input.

The 400-code-unit bound is a product limit shared by both platforms. It is lower
than the existing 16-KiB feature-state value limit and safely below the
state-query 64-KiB ready-result limit. A later increase is compatible only if
every command, schema, grant, result, and client boundary remains safe.

## Update identity

### Purpose

`updateId` identifies the logical publication caused by one platform source
event. It lets consumers distinguish two accepted commands containing the same
`data` and de-duplicate duplicate delivery of the same publication.

It is not:

- a query digest;
- a binding or result revision;
- a WebSocket event sequence or cursor;
- a global chronological sequence;
- proof that every prior update was observed;
- a credential or authorization grant; or
- a secret.

### Derivation

The action constructs this exact JSON array in the listed order:

```json
[
  "widget.data.update.v1",
  "widget.data.publish.v1",
  "<origin group key>",
  "<source event ID>"
]
```

The JSON serialization uses ordinary `JSON.stringify` on those four strings
with no whitespace. The action UTF-8 encodes the serialized string, computes
SHA-256, encodes the 32 digest bytes as unpadded base64url, and prefixes
`wdu1.`.

The result is exactly 48 ASCII characters: five prefix characters and 43
base64url characters. The digest is collision-resistant and hides the raw
identifiers from ordinary inspection, but it is unkeyed and must not be treated
as confidential or unguessable authorization material.

The group key is the framework-normalized
`<platform>:<kind>:<platform-group-id>`. The source event ID is the existing
framework value:

- Discord: `discord:interaction:<interaction-id>`;
- Twitch: `twitch:eventsub:<EventSub-message-id>`.

Discord retries retain the interaction ID. Twitch's durable EventSub inbox uses
the message ID as its primary identity, rejects reuse with different content,
and retains that ID across processing retries. The same logical platform event
therefore derives the same update ID.

### Idempotence

The complete stored object is deterministic for one action input and source
event. If the same invocation reaches the state write again, serialized equality
makes the existing state `set` a no-op and does not advance its mutation
revision.

Two distinct source events derive different update IDs even when their
normalized `data` and `origin` fields are equal. Their stored objects are
therefore different and each accepted write can invalidate current subscribers.

Version 1 intentionally omits a command-time timestamp. Generating a fresh clock
value during a retry would make the object non-idempotent. Query-envelope
`observedAt` is observation time and must not be presented as publication
time.

## Persisted value and ownership

The action declares shareable namespace `published_data` at schema version 1
with:

```js
collisionSummary: { kind: "presence" }
```

It resolves the other supported platform and calls:

```js
const state = await ctx.shareableState.current(
  otherPlatform,
  "published_data"
);
await state.set("latest", publication);
```

The value written at `latest` is one plain JSON object with exactly:

```json
{
  "updateId": "wdu1.0000000000000000000000000000000000000000000",
  "data": "consumer-defined text",
  "origin": "twitch"
}
```

The fields have these invariants:

| Field | Type | Meaning |
| --- | --- | --- |
| `updateId` | 48-character ASCII string | Deterministic identity defined above |
| `data` | string, 1–400 UTF-16 code units | Normalized command payload |
| `origin` | `discord` or `twitch` | Platform that produced the source command |

The object is written in one state operation. The feature must not store the
fields under separate keys, because that would create unnecessary revisions and
permit partial intermediate observation.

Actor IDs, display names, group IDs, raw source event IDs, correlation IDs,
credentials, integration IDs, realm IDs, and timestamps are not stored in this
namespace.

### Effective shareable behavior

The existing shareable-state contract remains authoritative:

| State | Effective value |
| --- | --- |
| No active directional default | The origin group's standalone namespace |
| Selected active integration | That integration's namespace |
| New nondefault integration | Does not redirect the existing default |
| Default switch | Later commands and queries use the newly selected realm |
| Revocation with fallback | Queries and later commands use the fallback realm |
| Revocation without fallback | The copied standalone successor retains the final object |
| Transition in progress | Writes fail retryably and queries use their safe non-ready status |

Discord and Twitch commands use one authoritative value only when their
directional defaults select the same integration.

### Link-time collisions

An absent `latest` key is empty state. Any stored object is nonempty.

The ordinary namespace-resolution table applies:

- empty plus empty initializes empty;
- nonempty plus empty selects the nonempty candidate automatically;
- identical nonempty snapshots select an equivalent candidate automatically;
- unequal nonempty snapshots require Discord, Twitch, reset, or cancel.

Two independently published values with equal `data` remain unequal when their
update IDs differ. Requiring explicit resolution is correct because they
represent different logical publications. There is no last-write-wins,
timestamp, merge, concatenation, or origin-priority rule.

Reset makes the new integration namespace empty; it does not synthesize a
publication.

## Readable state

The feature declares one readable export:

```js
defineReadableStateExport({
  id: "latest",
  version: 1,
  label: "Latest widget data",
  description: "The current string published for subscribed widgets.",
  kind: "value",
  platforms: ["discord", "twitch"],
  scope: {
    kind: "effective_shareable",
    namespace: "published_data"
  },
  access: { kind: "operator_grant" },
  result: {
    schema: {
      type: "object",
      properties: {
        updateId: { type: "string", minLength: 48, maxLength: 48 },
        data: { type: "string", minLength: 1, maxLength: 400 },
        origin: { type: "string", minLength: 6, maxLength: 7 }
      },
      required: ["updateId", "data", "origin"]
    },
    absence: { kind: "absent" }
  },
  async resolve(ctx) {
    // Read "latest"; return absent when it has not been published.
  }
})
```

The resolver additionally validates that `origin` is exactly `discord` or
`twitch` and that `updateId` matches the `wdu1` format before returning a
present value. An invalid persisted value is an internal/source failure, not
partially repaired public data.

Version 1 has no parameter and no collection export. It provides no topic
lookup, history enumeration, or arbitrary storage read.

The package does not provide a query-builder helper in version 1. The ordinary
query is small and keeps consumers on the public composable query format:

```json
{
  "version": 1,
  "target": {
    "platform": "twitch",
    "groupId": "141981764"
  },
  "bindings": {
    "widget": {
      "read": {
        "feature": "widget.data",
        "export": "latest",
        "version": 1
      }
    }
  },
  "select": {
    "widget": { "ref": "widget" }
  }
}
```

Before publication, a ready result contains:

```json
{
  "widget": { "state": "absent" }
}
```

After publication, it contains:

```json
{
  "widget": {
    "state": "present",
    "value": {
      "updateId": "wdu1.0000000000000000000000000000000000000000000",
      "data": "{\"color\":\"purple\"}",
      "origin": "twitch"
    }
  }
}
```

A client may project `updateId`, `data`, or `origin` through the existing
query language. Grants may authorize this export, but no query identity or
cursor authorizes access by itself.

## Live delivery contract

The existing state-query notification and WebSocket contracts apply unchanged.

- The first successful event is a complete snapshot.
- A relevant accepted mutation eventually produces a complete replacement while
  the client remains authorized and the service is healthy.
- Duplicate delivery is allowed.
- Intermediate results may be coalesced.
- At most the newest necessary complete replacement is sent after
  acknowledgement when backpressure has accumulated.
- Reconnect may resynchronize with the current value instead of replaying prior
  publications.
- Source handoffs are observable even when the visible object is equal.
- Old-source notifications cannot overwrite the current binding.
- A new subscriber receives no publication history.

A widget applies a ready replacement, remembers its last applied `updateId`,
and then acknowledges the transport cursor. Seeing the same update ID again is
a duplicate current publication, not a new command. Seeing a new update ID
means a different logical publication, but does not prove that no intermediate
publication was coalesced.

Example: commands A, B, and C are accepted while a client has one
unacknowledged result. The client may next receive only C. C becomes current;
the absence of B is permitted.

## Errors and safe output

Expected command failures use existing platform/framework responses:

| Condition | Result |
| --- | --- |
| Missing, whitespace-only, or oversized data | Bounded command-input error |
| Non-moderator writer | Existing authorization-denied response |
| Group cooldown active | Existing retry-after response |
| Effective realm transitioning | Existing sanitized retryable state error |
| State unavailable or full | Existing sanitized storage/service error |
| Unexpected failure | Existing correlation-based generic error |

No error, acknowledgement, log entry, metric, or correlation ID may contain the
payload. Existing source/correlation IDs may continue to appear in protected
operational logs as already designed, but the feature must not add `data` to
their metadata.

The readable value intentionally contains `data`; that is the feature's
authorized product output. Consumers must safely parse or render it. In
particular, browser widgets must not insert it into `innerHTML`, executable
JavaScript, CSS, or a URL without application-specific validation.

## Required version-1 examples

### First publication

A moderator sends:

```text
!widgetdata {"color":"purple"}
```

The JSON-looking remainder is stored as a string. An authorized current query
changes from `absent` to a present object whose `data` is
`{"color":"purple"}`.

### Same data, distinct commands

Two different accepted source events both send `ready`. Their `data` and
`origin` may match, but their update IDs differ. If a subscriber observes both,
it can distinguish them. Coalescing may still cause it to observe only the
second.

### Retry of one source event

The same Discord interaction ID or Twitch EventSub message ID is processed
again with the same group and payload. It derives the same update ID and stored
object. If execution reaches `set`, the identical write is a no-op. No new
logical publication is created.

### Invalid input

`!widgetdata`, whitespace-only text, and a trimmed string longer than 400
UTF-16 code units are rejected before shareable-state access.

### Linked origins

Discord and Twitch directions select the same integration. A Discord command
stores `origin: "discord"`; a later Twitch command replaces it with
`origin: "twitch"`. A query targeting either selected group converges on the
same current object.

### Coalesced burst

Several accepted commands replace the same realm value before a slow client
acknowledges its outstanding event. Only the final accepted value is required
to be delivered next. Tests must not require every intermediate update.

## Explicitly deferred work

Version 1 does not implement:

- named topics or multiple independent slots;
- lookup or collection exports;
- actor or author metadata;
- command-time timestamps;
- payload content types;
- JSON validation or typed consumer schemas;
- binary or byte-exact transport;
- public/member writes;
- cross-group queries;
- publication history;
- queue semantics;
- durable per-consumer offsets;
- replay of every command;
- exactly-once or at-least-once publication delivery; or
- an alternate event transport.

Guaranteed event delivery requires a separate contract for retention, ordering,
acknowledgement, replay, expiry, slow consumers, link changes, quotas, and cost.
It must not reinterpret state-query cursors or bounded replacement history as a
durable event log.

## Implementation acceptance

The contract is implemented only when later roadmap steps provide code,
behavioral tests, contributor/consumer documentation, and passing CI. Approval
of this document alone does not make the feature available.
