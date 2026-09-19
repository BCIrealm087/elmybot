# State-query release verification and operations

Status: roadmap step 18 completed on 2026-09-19. Direct hibernating
WebSockets are the only live state-query transport in both checked-in
environments. The former polling/SSE adapter, routes, counters, tests, and cost
model have been removed.

## Release controls

| Setting | Checked-in value | Behavior |
| --- | --- | --- |
| `STATE_QUERY_STREAMS_ENABLED` | production/test: `"true"` | Master switch for public live subscriptions. False, missing, or malformed values reject new upgrades and cause observer alarms to terminate existing sockets and remove their live query graphs. |
| `STATE_QUERY_DIAGNOSTICS` | production: `"false"`; test: `"true"` | `"true"` enables aggregate observer log windows. |
| `STATE_QUERY_DEPLOYMENT_ENVIRONMENT` | `production` / `test` | Separates grants, routing, and observers. |
| `STATE_QUERY_CREDENTIAL_SIGNING_SECRET` | Environment secret | Required for issued credentials; use a different secret in each environment. |
| `STATE_QUERY_PUBLIC_ORIGIN` | Environment's Worker origin | Same-origin session and WebSocket security boundary. |

`GET /state-query/socket` is the sole public live-subscription route. There is
no transport selector or polling fallback. `POST /state-query/stream` and the
former internal poll routes return 404.

The master switch is the operational rollback. Disabling it does not affect
catalog, snapshot, setup, session, grant-management, or ordinary bot-command
routes. Deployment propagation still applies: disabling the setting does not
instantaneously replace every old Worker isolate.

The accepted socket contract and lifecycle are documented in
[`state-query-websocket.md`](state-query-websocket.md).

## Security and recovery

- Browser and OBS clients exchange a read grant for a secure same-site session
  before upgrading. Raw credentials, query documents, targets, subscription
  IDs, and recovery cursors are never placed in the URL.
- Cookie-authenticated upgrades require an exact configured `Origin`. Supported
  non-browser clients may use the existing Bearer credential header.
- The public Worker verifies the credential and routes by its authenticated
  target. The observer stores only the grant reference and trusted target data.
- Revocation commits durable invalidation intent with the grant change. Exact
  expiry is also an observer alarm deadline, so routine lease maintenance does
  not poll grant storage.
- Reconnect is authorized again and resolves current bindings. A valid retained
  cursor may recover bounded history; otherwise the client receives a complete
  current resynchronization.

## Bounded behavior

The implementation permits at most 20 socket subscriptions per logical group
and 20 named queries per socket. Registration frames are limited to 384 KiB,
later control frames to 1 KiB, and cursors to 256 bytes. Only one event may be
unacknowledged per socket; newer committed state is durably coalesced until the
client acknowledges or reconnects.

Per-query and aggregate query limits remain defined by the public contract.
Retained socket history is bounded to 64 events and 256 KiB per subscription.
Close, error, revocation, expiry, lost-interest cleanup, and the disabled master
switch all release query/source interest idempotently.

## Automated verification

The full suite covers the public HTTP and socket boundaries plus the underlying
query, notification, binding, and shareable-state behavior. Key transport
evidence includes:

| Scenario | Primary evidence |
| --- | --- |
| Authenticated upgrade, snapshot, update, and acknowledgement | `test/state-query-websocket.spec.js` |
| Real browser client, remembered-game update, realm handoff, shared update, and grant revocation | `test/state-query-browser-integration.spec.js` |
| Hibernatable restart, reconnect, and current resynchronization | `test/state-query-websocket.spec.js` |
| Slow/no-ack coalescing and bounded expiry | `test/state-query-websocket.spec.js` |
| Durable revocation retry and exact grant expiry | `test/state-query-websocket.spec.js` |
| Connection cap, frame limits, origin/authentication failures, and terminal cleanup | `test/state-query-websocket.spec.js` |
| Removed polling endpoint and master-switch rejection | `test/state-query-stream-contract.spec.js` |
| Dynamic dependency and binding handoff correctness | `test/state-query-live-observation.spec.js`, `test/state-query-bindings.spec.js` |
| Recoverable owner notification delivery | `test/state-query-notifications.spec.js` |
| Catalog/snapshot/grant behavior independent of subscriptions | `test/state-query-http.spec.js` |

Run the repository checks with:

```sh
npm ci
npm run lint
npm test -- --run
```

The GitHub Actions workflow is the authoritative clean-run check. It repeats
the full tests and lint, checks JavaScript syntax, and performs a non-deploying
Wrangler dry run.

## Observability

With `STATE_QUERY_DIAGNOSTICS="true"`, an observer emits
`state_query.operations` at most once per minute when it next handles work.
There is no diagnostic timer keeping an idle object awake. Fields include:

- active leased subscriptions, query records, source edges, pending queries,
  retained events, and retained bytes;
- registration, close/expiry, resynchronization, oversize, reevaluation,
  handoff, retry, authorization-retry, and detach-retry counters;
- notification, duplicate, and obsolete/no-longer-interested counts; and
- maximum received-notification lag from its durable commit timestamp.

Counters cover one object instance's current window and reset on restart or
flush. The random instance identifier is not a group identifier. Active
subscriptions are leases rather than an exact TCP-connection count. Use
Cloudflare request, CPU, duration, storage, and WebSocket analytics for deployed
resource behavior and client-side timings for end-to-end latency.

Logs never accept query documents, credentials, result data, subject labels, or
raw resolver/transport exception messages. There is no public metrics endpoint
exposing another group's activity.

## Operational rollback

If live delivery must be stopped, set `STATE_QUERY_STREAMS_ENABLED` to false and
deploy the configuration. New upgrades fail closed. Observer alarms send a
bounded terminal error where possible, close attached sockets before renewal,
and remove their live graphs. Confirm the drain using aggregate diagnostics and
platform analytics.

There is no in-place SSE or polling fallback. A code rollback, if ever required,
is a normal reviewed repository rollback. Snapshot reads and bot commands remain
available while subscriptions are disabled.

## Deployed acceptance evidence

Step 17 established the critical runtime boundary in the isolated test Worker:
Chrome and a current OBS Browser Source received Discord-driven updates, and OBS
was already current after roughly 30 minutes idle. The approximately 74-minute
Durable Object window recorded 10 hibernatable and zero non-hibernatable inbound
messages, 113 requests, 97 alarms, 1.47 GB-seconds, 5k rows read, and 580 rows
written. The only reported invocation errors were two client disconnects; there
were no internal, exception, CPU-limit, or memory-limit errors, and the live tail
contained no polling route.

For Step 18, the operator completed and accepted the production rollout and soak
on 2026-09-19. That acceptance authorized removal of the temporary polling path.
Routine deployment management and additional live-cloud validation remain an
operator responsibility rather than a repository completion gate unless a
critical risk specifically requires manual evidence.
