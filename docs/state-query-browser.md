# Browser client, query setup, and widgets

Created for roadmap step 11 and migrated to the versioned hibernating WebSocket
protocol in step 15. These pages and assets become available when the Worker is
deployed; implementation and CI do not constitute deployment.

## Setup and OBS workflow

Open `/state-query/setup` on the selected environment's Worker origin. A read
grant selects exactly one Discord guild or Twitch channel. Obtain one through
Discord `/state_query_grant` or the Twitch broadcaster OAuth flow, then enter
it in the setup page. The page exchanges it for the existing secure, HttpOnly,
same-origin session. It neither uses localStorage/sessionStorage for credentials nor
puts it in copied URLs or snippets. Twitch OAuth links directly back to setup.

The setup flow supports:

1. Inspecting the grant's selected platform group and expiry; use another grant
   to choose another group.
2. Browsing the authorized readable-state catalog.
3. Adding named fields with literal arguments or authorized state-derived
   arguments. Object result fields can be projected individually. Dynamic
   sources offered by the form are parameter-free exports with compatible
   result types and explicit grant permission; their object fields may also
   be selected. More elaborate dependency graphs remain available through the
   client and ordinary query documents.
4. Combining fields and previewing the exact query through the snapshot API,
   followed by automatic live updates.
5. Configuring title, text color, and size, and copying a browser-source URL or
   JavaScript snippet. Fixed-game and current-game deaths presets use ordinary
   composition and can be extended with additional fields.

Use the copied `/state-query/widget#…` URL in an OBS browser source. The fragment
contains query and presentation data only; it is not sent to the server. Query
arguments may themselves be personal data, so share these URLs deliberately.
OBS has its own browser session: use **Interact** to enter a read grant there.
No access credential is embedded in the URL. The session expires with the grant;
the widget presents a prompt when access ends. Deleting the local session does
not revoke the grant; the existing grant-revocation API remains available.

The widget has a transparent background, reports an unselected remembered game,
shows connecting/reconnecting and unavailable states, dims stale values, and
clears displayed values when access ends. Counts, labels, collection values,
and titles are rendered with `textContent`; state never becomes executable
markup. Source changes need no widget reconfiguration.

## Developer client

The browser modules are static assets under `/state-query/`. Run the client on
the same origin as the Worker after establishing a read-grant session. The
existing API does not enable cross-origin browser access. Arbitrary external
pages cannot simply import this example and bypass the same-origin policy.

```js
import { createStateQueryClient } from "/state-query/client.js";
import { createStateQueryTools } from "/state-query/query.js";

const client = createStateQueryClient();
// If needed, accept a credential from a password input, exchange it once,
// and immediately clear the input. Do not hardcode it in the page.
// await client.session(credential);
const catalog = await client.catalog();
const query = createStateQueryTools().deaths(catalog.target);
const snapshot = await client.read(query);

const subscription = client.watch(query, {
  onResult({ result, reason }) {
    // Complete replacement data, not a patch. Render values as text.
    console.log(result.data, reason);
  },
  onStatus({ state, stale, code }) {
    // connecting, live, reconnecting, ended, or closed
    console.log(state, stale, code);
  }
});

// Teardown one consumer; the other consumers continue.
subscription.unsubscribe();
// Stop all subscriptions and timers. The returned promise settles cleanup.
await client.close();
```

`read()` returns the snapshot envelope. `watch()` receives a public stream result
with its envelope in `result`. Ready envelopes can still contain `unselected`,
`absent`, or `blocked` cells; inspect cell state before reading `value`.

Reuse one client per page and grant. Identical query documents share registration
and fanout; distinct queries are multiplexed over one connection. Adding or
removing the last consumer for a query rebuilds the registration and receives
new snapshots. Removing the last query closes the stream. One callback throwing
does not interrupt other consumers. A late consumer can receive the latest
cached result; inspect its status because that value may be stale during recovery.

The optional tools expose `compose(target, fields)`, `deaths(target, game?)`, and
`widgetUrl(origin, query, presentation)`. A missing deaths `game` follows the
remembered game. A literal game fixes the lookup. A composed field has a unique
`name`, an export `read`, optional `arguments` (each `{ literal }` or
`{ source: read, path? }`), and an optional result projection `path`.
Server validation and authorization remain authoritative for all documents.

## Recovery, security, and bounds

`watch()` opens one same-origin `/state-query/socket` WebSocket and multiplexes
all distinct query documents over `state-query-socket/v1`. The secure session
cookie accompanies the upgrade automatically; the socket URL, registration,
recovery cursor, widget URL, and copied snippet contain no grant credential.
The client applies only complete versioned results, acknowledges each accepted
event cursor, ignores duplicate or older event/result sequences, and requires a
complete replacement snapshot before accepting updates on every connection.

Incoming text frames are capped at 300 KiB; binary, oversized, malformed, or
invalid protocol data ends the subscription. Client limits remain 20 distinct
query documents (16 KiB each) and 100 listeners per document. Server and grant
limits may be lower and are reported explicitly.

The client sends the protocol heartbeat every 30 seconds. Network loss,
transient server errors, and 90 seconds without any server message trigger
capped exponential reconnect delays (1–30 seconds). A transport reconnect
registers the prior opaque subscription ID and cursor as recovery hints, then
accepts only the server's newly authorized complete snapshot, including after a
realm change or observer restart. The server may replace either hint. Mutating
the subscription set or replacing the browser session discards both hints.
Terminal status clears cached results and stops retrying.

`close()` and unsubscribe close the socket and clear heartbeat, stale-peer, and
reconnect timers. The hosted pages clean up on `pagehide`; a back-forward-cache
restore reloads to establish fresh authorization. `logout()` closes the active
queries and removes the local session. The pages use a restrictive same-origin
CSP, no-referrer policy, and no-store responses. JavaScript/CSS live in
`public/`, served by the Wrangler static-assets binding `BROWSER_ASSETS`; API
and page routes remain in the Worker. No migration tags or platform command
semantics change for this step.

## Verification and deployment boundary

- Vitest exercises socket sharing, acknowledgements, complete-snapshot gating,
  out-of-order suppression, recovery hints, access denial, silent peers,
  callback isolation, and limits.
- A real Worker/DO test drives the browser client through session exchange,
  catalog, snapshot, remembered-game change, standalone-to-integration handoff,
  shared mutations, and grant revocation. Asset-route tests also fetch the
  actual browser modules through the configured Worker asset binding.
- `npm run test:browser` runs Chromium against a deterministic HTTP/WebSocket fixture.
  It exercises the served setup page, custom composition, an isolated widget
  session, count/game/source replacement events, unselected state, hostile text,
  acknowledgements, reconnect, and access termination. This is UI/protocol
  evidence; the real lifecycle is covered by the Worker test above.
- CI installs Chromium, runs the smoke test, and saves a setup screenshot as
  `state-query-browser-preview`. Locally, run `npx playwright install chromium`
  once before `npm run test:browser`.

The Work workspace does not have a Chromium binary, so local browser execution
is not claimed. CI remains the browser gate for this step. Step 11's original
polling-SSE browser evidence is retained in
[CI run 34903068459](https://github.com/BCIrealm087/elmybot/actions/runs/34903068459);
Step 15's WebSocket evidence is recorded after its implementation CI succeeds.
Deployed proxy behavior, actual OBS interaction, cross-region latency,
and deployed load/cost measurements remain rollout gates. Step 12's local
measurements and `STATE_QUERY_STREAMS_ENABLED` switch are documented in the
[release guide](state-query-release.md). Streaming defaults to disabled until
the test rollout enables it. No hosting or
deployment is performed as part of step 11.
