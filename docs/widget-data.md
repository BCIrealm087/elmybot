# Widget data consumer and contributor guide

The `widget.data` feature lets a Discord or Twitch moderator replace one current
string for an authorized widget. It uses the existing state-query snapshot and
hibernating WebSocket interfaces. This is current replacement state. It is not an event stream: clients converge
on the latest accepted value. Rapid updates may be coalesced. The system does not guarantee delivery of every accepted command.

## Contract at a glance

| Item | Version 1 |
| --- | --- |
| Discord command | `/widget_data data:<text>` |
| Twitch command | `!widgetdata <text...>` |
| Writer access | Moderator |
| Input | Trimmed string, 1–400 UTF-16 code units |
| Success response | `Widget data updated.` |
| Readable export | `widget.data:latest:v1` |
| Read access | Operator-issued state-query grant |
| Storage model | One current value per effective `published_data` realm |
| Delivery model | Complete replacement snapshots and updates; coalescing allowed |
| Publication identity | `updateId` |
| Not included | Topics, history, replay, or guaranteed delivery of every command |

The value is deliberately a string. JSON-looking input is stored and returned as
a string; Elmybot does not parse or execute it.

## Publish a value

A Discord moderator uses:

```text
/widget_data data:{"scene":"break","message":"Back soon"}
```

A Twitch broadcaster or moderator uses:

```text
!widgetdata {"scene":"break","message":"Back soon"}
```

Internal spaces need no Twitch quoting. Both commands trim the complete input,
reject empty or over-400-unit values, share a one-second cooldown per origin
group, and return only `Widget data updated.`. The acknowledgement does not echo
the data.

## Grant read access

Writers and readers are authorized separately. Moderator access to the command
does not make the value public.

For a Discord target, the server owner or a member with Administrator or Manage
Server runs:

```text
/state_query_grant exports:widget.data:latest:v1
```

The optional `duration_hours` option can shorten the credential lifetime.
Discord returns the read grant ephemerally.

For a Twitch target, the broadcaster opens
`https://<worker-host>/state-query/operator/twitch`, selects
`widget.data:latest:v1`, and completes the Twitch identity flow.

Treat the returned grant as a secret. A non-browser client sends it in the
`Authorization: Bearer <state-query-grant>` header. A same-origin browser or OBS
page should exchange it once through `POST /state-query/session`, then rely on
the secure HttpOnly session cookie. The setup page at `/state-query/setup` does
this exchange. Never put a grant in a widget URL, WebSocket URL, query document,
fragment, or subprotocol.

A grant selects exactly one Discord guild or Twitch channel. Fetch
`GET /state-query/catalog` after authentication and use its `target` object in
the query rather than hard-coding a different group.

## Query document

This ordinary version-1 query selects the complete publication object:

```json
{
  "version": 1,
  "target": { "platform": "twitch", "groupId": "141981764" },
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

Replace `target` with the authenticated catalog target. To select only the
string, use `"widget": { "ref": "widget", "path": ["data"] }`. Selecting the
complete object is usually preferable because it keeps `updateId` available for
de-duplication.

## Snapshot read

Save the query as `widget-query.json`. A non-browser client can perform a
one-time read without placing either the grant or query in the URL:

```sh
curl --request POST "https://<worker-host>/state-query/snapshot" \
  --header "Authorization: Bearer <state-query-grant>" \
  --header "Content-Type: application/json" \
  --data-binary @widget-query.json
```

The transport-neutral ready envelope has this shape:

```json
{
  "protocolVersion": 1,
  "queryDigest": "opaque-base64url-digest",
  "status": "ready",
  "reason": "initial",
  "bindingRevision": "opaque",
  "resultRevision": "opaque",
  "observedAt": "2026-09-23T12:00:00.000Z",
  "data": {
    "widget": {
      "state": "present",
      "value": {
        "updateId": "wdu1.0000000000000000000000000000000000000000000",
        "data": "{\"scene\":\"break\",\"message\":\"Back soon\"}",
        "origin": "twitch"
      }
    }
  }
}
```

Before the first publication, the ready result is:

```json
{
  "status": "ready",
  "data": {
    "widget": { "state": "absent" }
  }
}
```

The shortened example omits the other required envelope fields shown above.
`absent` is different from an empty string: commands reject empty data.

The exact present publication object is:

```json
{
  "updateId": "wdu1.<43 base64url characters>",
  "data": "consumer-defined text",
  "origin": "discord"
}
```

`origin` is exactly `discord` or `twitch`. The object does not expose the
writer, raw platform event, group, integration, realm, storage key, or command
time.

## WebSocket subscription

Connect to the same-origin `/state-query/socket` route after establishing a
session, or supply the Bearer header from a non-browser WebSocket library. The
URL has no query parameters. The first application frame registers the same
query document:

```json
{
  "protocol": "state-query-socket/v1",
  "type": "register",
  "queries": [
    {
      "id": "widget",
      "query": {
        "version": 1,
        "target": { "platform": "twitch", "groupId": "141981764" },
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
    }
  ]
}
```

The first successful server event is a complete `snapshot`. Later `update`
events also contain complete query-result replacements, not patches. After
applying an event, acknowledge its opaque cursor:

```json
{
  "protocol": "state-query-socket/v1",
  "type": "ack",
  "cursor": "sq1.opaque"
}
```

At most one event is outstanding. While it is unacknowledged, newer results may
be coalesced. A reconnect registers recovery hints in the JSON frame when
available, then waits for a newly authorized complete snapshot. Cursors belong
in protocol frames only, never in URLs.

Use `state-query-ping/v1` and expect `state-query-pong/v1` for protocol
heartbeats. The maintained browser client already implements registration,
heartbeats, bounded reconnects, complete-snapshot gating, cursor recovery, and
acknowledgements.

## Minimal custom browser and OBS widget

A custom widget must be served from the Worker origin because browser state-query
access is same-origin. Establish the OBS session once with **Interact**, just as
for the built-in widget. Then serve a page containing elements named `status`
and `value` plus this module:

```js
import { createStateQueryClient } from "/state-query/client.js";
import { createStateQueryTools } from "/state-query/query.js";

const statusElement = document.querySelector("#status");
const valueElement = document.querySelector("#value");
const client = createStateQueryClient();
const catalog = await client.catalog();

const query = createStateQueryTools().compose(catalog.target, [{
  name: "widget",
  read: { feature: "widget.data", export: "latest", version: 1 }
}]);

let lastUpdateId = null;

function applyReplacement(delivery) {
  const envelope = delivery.result;

  if (delivery.status !== "ready" || envelope?.status !== "ready") {
    statusElement.textContent = delivery.status ?? "unavailable";
    valueElement.dataset.stale = "true";
    return;
  }

  const cell = envelope.data.widget;
  if (cell.state === "absent") {
    lastUpdateId = null;
    valueElement.textContent = "";
    valueElement.dataset.stale = "false";
    statusElement.textContent = "Waiting for widget data";
    return;
  }

  if (cell.state !== "present") {
    statusElement.textContent = cell.state;
    valueElement.dataset.stale = "true";
    return;
  }

  const publication = cell.value;
  if (publication.updateId !== lastUpdateId) {
    valueElement.textContent = publication.data;
    lastUpdateId = publication.updateId;
  }
  valueElement.dataset.stale = "false";
  statusElement.textContent = "Live";
}

client.watch(query, {
  onResult(delivery) {
    // Keep this synchronous: the client acknowledges after callbacks return.
    applyReplacement(delivery);
  },
  onStatus({ state, stale, code }) {
    if (state !== "live") statusElement.textContent = code ?? state;
    valueElement.dataset.stale = String(stale);
  }
});

addEventListener("pagehide", () => client.close(), { once: true });
```

`textContent` makes the payload text rather than executable markup. The client
delivers one complete replacement to `onResult`, the handler applies its ready,
absent, or non-ready state synchronously, and only after all handlers return
does the client send the event cursor acknowledgement. Do not start asynchronous
rendering in `onResult` and assume the acknowledgement waits for it; it does
not. Compute and apply the visible state synchronously, or implement the wire
protocol directly when asynchronous application must precede acknowledgement.

The `onStatus` callback reports transport state such as `connecting`,
`reconnecting`, `live`, `ended`, or `closed`. Query `transitioning` and
`unavailable` states arrive through `onResult` and omit `data`.

If `data` is meant to contain JSON, parse it as untrusted input and validate the
consumer's own schema:

```js
let parsed;
try {
  parsed = JSON.parse(publication.data);
} catch {
  statusElement.textContent = "Widget data is not valid JSON";
  return;
}
```

Do not assign `data` to `innerHTML`, execute it as JavaScript, inject it into CSS,
or place it in a URL without application-specific validation.

## State handling checklist

| Input | Widget behavior |
| --- | --- |
| `ready` + `present` | Apply the complete object; use `data` and remember `updateId` |
| `ready` + `absent` | Clear the current publication and show an empty/waiting state |
| `transitioning` | Do not treat an old value as current; clear it or visibly mark it stale |
| `unavailable` | Show unavailable/stale state and wait for a fresh replacement |
| Reconnecting | Retain a value only if visibly stale; accept the next complete snapshot |
| Duplicate `updateId` | Do not repeat publication-specific effects |
| New `updateId` | Treat as a new logical publication, but not proof that none were skipped |
| Grant ended | Clear private data, stop retrying, and obtain a new grant if appropriate |

A source handoff can produce a new result revision even when the publication
object is byte-for-byte equal. Apply the replacement status and lifecycle
change; use `updateId` only to avoid repeating publication-specific work.

## Coalescing example

Suppose a slow widget has one unacknowledged result and moderators publish:

1. A: `Starting soon`
2. B: `Starting now`
3. C: `Live`

The next delivered replacement may be C only. The widget must converge on
`Live`. It must not wait for A or B, infer that they were rejected, or trigger
an action once per command. A new subscriber also receives only the current
value C. Reconnect may produce a fresh current snapshot instead of replaying A
and B.

Distinct accepted commands have distinct `updateId` values even when their
`data` strings match. A retry of the same source command derives the same ID.

## Which identity to use

| Identity | Purpose | Publication identity? |
| --- | --- | --- |
| `updateId` | Logical widget-data publication; stable for one source-command retry | Yes |
| WebSocket cursor | Transport acknowledgement and bounded recovery hint | No |
| Event or result sequence | Ordering within one transport/subscription context | No |
| `resultRevision` | Change to data, status, or effective binding | No |
| `bindingRevision` | Effective source/dependency identity | No |
| `queryDigest` | Canonical query identity | No |
| Subscription ID | One live subscription/recovery context | No |

None of the non-publication identities proves exhaustive command delivery.

## Standalone and linked ownership

The command and query both resolve the target group's current effective
`published_data` realm.

| Situation | Selected value |
| --- | --- |
| No active directional default | That platform group's standalone current value |
| Discord and Twitch directions select the same integration | Both origins replace and read one shared current value |
| A nondefault link activates | The existing selected value remains current |
| Directional default changes | Later commands and subscriptions follow the newly selected realm |
| Selected link revokes with a fallback | The subscription follows the fallback integration's existing value |
| Selected link revokes without a fallback | The copied standalone successor retains the final shared value |
| Activation or revocation is in progress | Writes fail retryably; queries report a safe non-ready state |

A Discord and Twitch group share this value only when their directional defaults
select the same integration. Link-time unequal nonempty candidates require an
explicit Discord, Twitch, reset, or cancel choice; version 1 does not merge them
or choose by timestamp.

## Contributor notes

The public identities and semantics are frozen in
[`widget-data-contract.md`](widget-data-contract.md). The installed package is
`packages/features/widget-data` and uses only `@elmybot/framework` APIs.

When changing this feature:

- preserve the `widget.data:latest:v1` schema and `published_data/latest`
  persisted identity unless a compatibility plan explicitly versions them;
- keep the write atomic: `updateId`, `data`, and `origin` are one stored value;
- keep command input, acknowledgement, errors, and logs bounded and free of
  payload reflection;
- keep writers moderator-only and readers operator-grant-only;
- test last-current convergence rather than requiring every intermediate
  publication;
- test both origins and effective-shareable lifecycle handoffs; and
- do not describe topics, queues, replay, history, alternate transports, or
  guaranteed per-command delivery as implemented.

Run `npm run feature:workspaces`, `npm run lint`, and `npm test -- --run` for
feature changes. Regenerate [`feature-catalog.md`](feature-catalog.md) with
`npm run feature:docs` when registry metadata changes. The broader
[state-query browser guide](state-query-browser.md), [HTTP/grant
guide](state-query-http.md), and [WebSocket contract](state-query-websocket.md)
remain authoritative for transport details.
