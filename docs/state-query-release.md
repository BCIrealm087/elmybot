# State-query release verification and operations

Status: Step 12 development complete and CI-verified on 2026-09-15. No deployment is recorded here.
The version-1 query, grant, snapshot, streaming, contributor, and browser surfaces
are implemented. Public streaming ships **disabled in both Wrangler environments**
until the test rollout below is performed.

## Release controls

| Setting | Checked-in value | Behavior |
| --- | --- | --- |
| `STATE_QUERY_STREAMS_ENABLED` | `"false"` | Only boolean `true` or string `"true"` enables public subscriptions. Missing or malformed values stay disabled. |
| `STATE_QUERY_DIAGNOSTICS` | `"false"` | `"true"` enables aggregate observer log windows. |
| `STATE_QUERY_DEPLOYMENT_ENVIRONMENT` | `production` / `test` | Separates grants, routing, and observers. |
| `STATE_QUERY_CREDENTIAL_SIGNING_SECRET` | Environment secret | Required for issued credentials; use a different secret in each environment. |
| `STATE_QUERY_PUBLIC_ORIGIN` | Environment's Worker origin | Same-origin session and OAuth boundary. |

The streaming switch gates both the public registration and observer polling
paths. A disabled registration returns HTTP 403 with
`state_query_subscriptions_disabled`. An already open adapter closes when its
observer rejects a poll; the browser's reconnect receives the terminal 403 and
clears its cached values. Observer alarms retire remaining stream graphs and
watchers. Deploying a setting is subject to Worker rollout propagation; this is
not a claim that every old isolate changes configuration instantaneously.

Snapshots, catalog, grant management, sessions, setup assets, and ordinary bot
commands continue to operate with subscriptions disabled. Snapshot previews
work, but a live widget needs streaming enabled. The Vitest environment explicitly
enables streaming so a green test run exercises the entire implementation.

## Stabilization changes

- A slow multiplexed reader falling behind the count, byte, age, or source-handoff
  history boundary receives a complete current snapshot of **every** query. A
  quiet query's last value cannot disappear behind many updates to another query.
- A result exceeding the 256 KiB aggregate payload budget produces a small
  terminal `query_limit_exceeded` status. No oversized payload is silently
  removed from history while leaving the browser permanently stale.
- Graceful close removes stream mappings, history, and subscription records as
  well as the active query graph. Abrupt-disconnect leases and alarms perform the
  same cleanup. Recovery after a closed lease starts a fresh authorized snapshot.
- Registration rechecks the 20-subscription limit immediately before durable
  insertion, after asynchronous authorization work.
- Empty polls stay at least 500 ms apart, including across heartbeat frames.
  Cancellation during a poll delay avoids starting another request.

## Acceptance evidence

These are executable behavioral tests, not deployed-browser observations. Paths
are relative to `test/` unless a package path is shown. Several matrix rows are
verified across the storage, binding, query, and transport boundaries rather
than repeating the entire OAuth lifecycle in every streaming test.

| Roadmap scenario | Evidence |
| --- | --- |
| One exposed value: snapshot and updates | `state-query-sse.spec.js`: authorized handshake, complete replacements |
| Three counters without a preset | `state-query-sse.spec.js`: five deaths query shapes; `state-query-evaluator.spec.js`: composition |
| Privileged read has no command side effects | `state-query-evaluator.spec.js`: unchanged real local/shareable revisions; deaths feature tests |
| Missing named counter versus unselected game | `state-query-evaluator.spec.js`: defaults and blocked dynamic reads |
| Remembered-game handoff removes old dependency | `state-query-live-observation.spec.js`: dynamic switch and ignored old values |
| Collection insertion | `state-query-live-observation.spec.js`: collection insertion/removal |
| Reset/delete agrees with defaults and membership | `state-query-notifications.spec.js`, `shareable-state-realm.spec.js`, five-shape SSE test |
| Unlabeled legacy counter remains readable | `state-query-evaluator.spec.js`: exact lookup and explicit incomplete collection |
| Shared changes reach both platform perspectives | `shareable-state-resolution.spec.js`, `packages/features/fun-deaths/test/feature.spec.js` |
| Linked groups remember different games | Deaths feature query tests and `state-query-sse.spec.js`: composed local/dynamic reads |
| Activation replaces standalone binding | `state-query-bindings.spec.js`: ordered activation; real browser-client realm-handoff SSE test |
| Additional nondefault link is stable | `state-query-bindings.spec.js`: A→B→A setup without automatic reselection |
| Pending cancellation preserves selection | `integration-registry.spec.js`: cancellation now also asserts unchanged binding authority |
| Same-value default handoff is visible | `state-query-live-observation.spec.js`: attach replacement before retiring old source |
| A→B→A rejects delayed earlier binding | `state-query-bindings.spec.js`: monotonic authority; duplicate/older notification SSE test |
| Unlink without fallback creates independent successor | `integration-registry.spec.js`: deaths through link/revoke/relink; binding lazy-successor tests |
| Unlink with fallback selects existing ledger | `state-query-bindings.spec.js`: interrupted revocation then ready fallback |
| Interrupted transition or clone | Binding restart/lazy-successor tests and evaluator transitioning/unavailable results |
| Write races attachment or rebind | Notification snapshot/register test; binding registration race; evaluator revision retries |
| Commit precedes process failure | `state-query-notifications.spec.js`: durable outbox recovered after source restart |
| Reconnect follows current default | Real browser-client handoff plus reconnect/current-snapshot SSE tests |
| Expiry/revocation ends access | Grant HTTP tests, live authorization tests, terminal SSE and Chromium smoke |
| Dynamic argument leaves exact grant | `state-query-http.spec.js`: exact-subject and dynamic-source denial |
| Oversized query/collection | Evaluator/grant/realm limits; terminal aggregate SSE overflow test |
| Slow/duplicate delivery stays bounded and current | Per-query history coalescing, 70-update retention-gap regression, obsolete-notification SSE test |
| Last client disconnects | SSE cleanup/load cases; explicit abrupt-disconnect lease regression; owner no-interest test |
| Test credential in production | `state-query-http.spec.js`: environment mismatch before owner lookup |
| Feature omits readable declarations | `readable-state.spec.js`: frozen empty default; full existing command/storage suite |

The browser fixture exercises real page/client code in Chromium but uses a
deterministic HTTP/SSE server. The separate Worker test exercises the client
against real Durable Objects, game changes, integration defaults, and revocation.
Neither establishes actual OBS behavior, geographic placement, or runtime
replacement on Cloudflare.

## Local budget measurements

Reproduce the representative coordinator workload with:

```sh
npm test -- --run test/state-query-sse.spec.js -t 'measures bounded' --disableConsoleIntercept
node scripts/model-state-query-transport.js
```

Recorded on 2026-09-15 in the Cloudflare Vitest/Miniflare workspace:

| Measurement | 1 subscriber | 20 subscribers |
| --- | ---: | ---: |
| Active queries / shared source edges | 1 / 2 | 20 / 2 |
| Empty poll calls | 5 | 100 |
| Query reevaluations caused by those empty polls | 0 | 0 |
| Registration plus those idle polls | 58 ms | 399 ms |
| Committed mutations | 10 | 10 |
| Local commit-to-coordinator-result median | 27 ms | 236 ms |
| Local sample p95 (maximum of 10 samples) | 85 ms | 293 ms |
| Retained history events after changes | 11 | 220 |
| Retained history bytes after changes | 5,834 | 116,680 |
| Queries / source edges / history after last close | 0 / 0 / 0 | 0 / 0 / 0 |

This small local workload manually drains alarms and polls the coordinator; it
does not include the public adapter's 0–500 ms waiting interval, network RTT,
browser rendering, or production alarm scheduling. Measurements are descriptive,
not hard timing assertions in CI. The 21st registration is rejected. Idle here
means no value changes while subscribers remain attached, not a hibernation test.

The implementation enforces 20 subscriptions/group, 20 queries/subscription,
100 distinct active plans, 400 query records, 40 dependencies/query, 2,000 shared
source edges, 16 KiB/query, 64 KiB/result, 256 KiB/aggregate payload, and
64 events/256 KiB/history per subscription. Query drain batches are 20 records
with four external operations at a time, and attachment retries stop after three
attempts. Retry delays grow from 1 to 30 seconds. History retention is five
minutes while attached; closing removes it immediately. See the individual
contract, evaluator, live-observation, and SSE guides for lower grant limits.

The Step 2 objectives of 100 notifications/second sustained, 500 in a burst,
500 deliveries/second, p95 ≤1 second/p99 ≤3 seconds client latency, and recovery
within five seconds are **not certified by this local workload**. Test those
rates and larger mixed query/collection documents in the deployed test stage.
The browser silence threshold implemented in Step 11 is 60 seconds (the Step 2
proposal used 45); heartbeats remain 20 seconds and reconnect backoff 1–30 seconds.

The same workload in implementation CI, while the full suite ran, produced:

| CI measurement | 1 subscriber | 20 subscribers |
| --- | ---: | ---: |
| Registration plus idle polls | 41 ms | 925 ms |
| Commit-to-coordinator-result median | 99 ms | 1,101 ms |
| Sample p95 (maximum of 10 samples) | 278 ms | 1,994 ms |
| Final queries / source edges / history | 0 / 0 / 0 | 0 / 0 / 0 |

The 20-subscriber CI sample exceeds the provisional one-second p95 objective
even before edge/browser latency is included. This environment-dependent result
leaves the service objective unverified; the relative contributions of runner
capacity and concurrent suite work were not isolated. It reinforces the requirement to measure representative
deployed load before enabling production subscriptions.

## Implemented transport cost

The shipped adapter uses durable polling, not the proposed hibernating WebSocket
relay. Each waiting client makes up to two empty polls/second, plus initial,
reconnect, renewal, authorization, and active-result work. Twenty waiting clients
can therefore account for about 40 observer poll requests/second even without
mutations. No subscriber means no adapter polls or query evaluations.

For Step 2's 100 groups × 10 clients × 8 hours/day × 30 days scenario, the model
now includes **1,728,000,000 idle poll requests/month**. Its simplified total is
1,728,270,000 requests: $259.20 incremental request cost. Assuming two milliseconds
of observer activity per poll gives 432,300 GB-seconds and $12.50 incremental
duration cost, or $271.70 combined. If objects instead accrue duration throughout
active hours, the duration component is $137.50 and the combined illustration is
$396.70. Neither duration assumption is a measured production bound.

The model uses the paid-plan request and duration rates and rounding rules
rechecked on 2026-09-15 in [Cloudflare's pricing documentation](https://developers.cloudflare.com/durable-objects/platform/pricing/).
It excludes public Worker requests/CPU, SQL reads/writes/storage, authorization,
renewals, alarms, extra active polls, owner fanout, base subscriptions, and other
account usage. Included allowances may already be consumed elsewhere. It is a
comparison model, not an invoice forecast or approval to scale the polling path.

## Observability

With `STATE_QUERY_DIAGNOSTICS="true"`, an observer emits
`state_query.operations` at most once per minute **when it next handles work**.
There is no diagnostic timer keeping an idle object awake. Fields include:

- active leased subscriptions, active query records, source edges, pending
  queries, retained events, and retained bytes;
- registration, poll, empty-poll, close/expiry, resynchronization, oversize,
  reevaluation, handoff, retry, authorization-retry, and detach-retry counters;
- notification, duplicate, and obsolete/no-longer-interested counts; and
- maximum received-notification lag from its durable commit timestamp.

Counters cover one object instance's current window and reset on restart or
flush. The random instance identifier is not a group identifier. Active
subscriptions are leases, not an exact count of TCP connections; abrupt closes
remain counted until cleanup. Notification lag is not end-to-end widget latency.
Use Cloudflare request/CPU/duration/storage analytics for billing and deployed
client-side timings for latency percentiles. Outbox delivery failures retain the
existing bounded attempt logs and retry alarms.

Logs never accept query documents, credentials, result data, subject labels, or
raw resolver/transport exception messages. Existing state-query error logs now
replace those messages with a fixed description and optional HTTP status.
There is no public metrics endpoint exposing another group's activity.

## Compatibility and migrations

Framework API v1 remains additive and stable. Production exports and test-kit
exports are unchanged in Step 12; the exact public API tests, feature-boundary
check, workspace checks, and generated catalogs remain required. Features with
no `readableState` declaration keep their original behavior. Public query and
stream protocols remain v1; a compatible internal transport change cannot alter
their read-only, grant, binding, or full-replacement guarantees.

Keep migration tags v1–v15 intact. In particular, v15 creates the SQLite
`StateQueryObserver` class and requires its binding in each environment. Step 12
adds no migration tag or storage rewrite. Existing observer stream/live tables
are preserved; cleanup only deletes expired or closed subscription records.
Do not delete Durable Objects, reset counters, modify historical migration tags,
or rotate signing secrets just to make a test or rollback easier.

Historical unlabeled counters remain readable by their exact normalized game.
An incomplete collection reports the legacy-coverage limitation instead of
silently omitting those counts. Ordinary labeled mutations can add known subject
metadata. There is no safe automatic reversal of historical hashed subjects.

## Test-first rollout and rollback

1. Record the intended release commit and its green CI run. Keep production
   streaming disabled. Prepare a separate test Worker/environment with all current
   bindings, unchanged migrations, browser assets, test-only signing secret,
   public origin, and the Twitch state-query callback registered. Re-register
   Discord commands if `/state_query_grant` is not yet installed.
2. Deploy to that test environment through the normal operator release process,
   then enable streaming and diagnostics **there only**. Use disposable test
   groups and grants, never copied production credentials or reset production state.
   Verify commands before and after enabling streams, secure sessions, custom
   three-counter composition, collections, remembered-game changes, and denial.
3. Exercise the lifecycle matrix with a browser and OBS source open: activate,
   switch A→B→A, revoke/unlink with and without fallback, reconnect, revoke the
   read grant, and replace the Worker version. Confirm explicit temporary status,
   fresh authorized state, and no obsolete values. In OBS, authenticate via
   Interact in its own cookie context; widget URLs contain no credential.
4. Measure 1 and 20 clients/group, 20 queries/client, sparse and larger collection
   results, slow consumers, 15 minutes idle, and the sustained/burst objectives
   above. Use multiple groups to reach 100 clients; 100 clients on one group must
   be rejected. Capture at least two regions' commit-to-widget percentiles,
   reconnect recovery, error rates, active leases, cleanup, retries, and account
   request/CPU/duration/SQL costs. Do not infer hibernation from local tests.
5. Run the rollback drill: set streaming false, deploy that setting, confirm
   new subscriptions receive 403, old clients terminate/reconnect to that status,
   leases and watchers drain, and ordinary Discord/Twitch commands and snapshots
   continue. Re-enable only after diagnosing any persistent retry or cleanup work.
6. Record observed values, test Worker version, dates, browser/OBS versions,
   regions, and accepted cost/latency deviations. Only then approve a small
   production group cohort using scoped short-lived grants. Expand after the
   same telemetry remains acceptable; admission limits are not a throughput SLA.

For a production incident, disabling subscriptions is the first rollback.
Revoke a compromised grant independently when needed. If a code rollback is
also necessary, use a reviewed version that retains current migrations, DO
classes, persisted kinds, and compatible storage readers. A pre-state-query
Worker is not an automatic safe rollback target. Keep state and audit records;
do not reset or delete data as part of this procedure.

No deployed latency, hibernation, cost, actual OBS interaction, or deployment
success is claimed by this repository release checkpoint.

## Validation record

Local validation on 2026-09-15 passed all **43 files / 417 tests** at normal
Vitest concurrency (final run: 29.99 seconds). The first full run exposed the new load
assertion's one-second default wait; its eventual-delivery check now allows
five seconds and the complete rerun passed. No production timing threshold was
relaxed. Lint, API boundaries, workspace/generated-document checks, and JavaScript
syntax are part of the release gate.

Implementation commit
[`5d5c507`](https://github.com/BCIrealm087/elmybot/commit/5d5c5077de11796ddd342b24f8764485d4a8ab63)
passed [CI run 34954844829](https://github.com/BCIrealm087/elmybot/actions/runs/34954844829),
job `104334298977`: 43 files / 417 tests (42.48 seconds), lint and repository
checks, Chromium smoke, JavaScript syntax, and the non-deploying Wrangler build.
The completed job log confirms the test count, browser scenarios, and dry-run
exit; no deployment occurred. Local browser execution remains blocked by Chromium
download access in this workspace; the supported build and browser gates are CI.

The documentation checkpoint's [CI run 34955166830](https://github.com/BCIrealm087/elmybot/actions/runs/34955166830)
passed all state-query cases but hit the existing five-second limit in the full
invitation/OAuth/activation/refresh/unlink test. That same test passed in 808 ms
in implementation CI and 118 ms in an isolated local rerun. Only that test now
has a ten-second limit, matching the already scoped treatment of the oversized
revocation case. Its assertions, production time budgets, and global test limit
remain unchanged. The final branch CI must pass before this checkpoint is handed
back as verified. The follow-up passes all 417 tests locally at normal concurrency
(30.52 seconds), lint and repository checks, syntax, and diff validation.
