# State/event latency diagnostics

Private diagnostics distinguish source scheduling, ordered publication,
destination delivery/ACK, and readable-state updates. They do not change leases,
retry budgets, ordering, the one-second initial recovery wakeup, or command success.
No schema migration is required. Step 5 also emits sanitized `activation.start`,
`activation.skipped` and `activation.failed` stages for the publication/relay/producer lanes;
see [immediate activation](state-event-immediate-delivery.md). Step 6 adds
`probe.start` and `probe.finish` with positive/absent/inconclusive reasons; the
original operation ID links them to append and lease traces.

Set the literal Worker variable `STATE_EVENT_DIAGNOSTICS="true"` in the
environment being investigated. Both checked-in environments default to
`"false"`; the existing acceptance and event-stream switches still apply.
Backend records have `event: "state_event.trace"`. Open the existing authorized
widget at `/health-widget/?diagnostics=1` for browser console records with
`event: "health.trace"`. Credentials still go into the separate labeled fields,
never the URL. Existing grants remain usable.

The shortest useful live capture is the already-reported reproduction: after an
idle interval, three commands five seconds apart, with the widget open. Preserve
Worker logs and the browser console from before the first command until the
delayed updates finish. No further spacing survey is required. This capture is
needed to attribute the production fault; local tests cannot measure production
placement, alarm dispatch, or transport failures.

## Correlation and interpretation

| Stages / fields | Interpretation |
| --- | --- |
| `commit` | Successful authoritative transaction returned; original commit time, operation ID, stream route, sequence and readable revision. Retries can return an existing receipt without a new commit record. |
| `alarm.schedule`, `alarm.start`, `alarm.clear` | Source/destination scheduler selection and handler entry. `scheduledAtMs` is the latest observed actual selection, `durableDueMs` is the durable work deadline, and `lagMs` compares handler entry with the remembered selection. |
| `relay.start` | Earliest durable outbox wakeup, live lease total and cleanup lease count, before maintenance/claim. |
| `relay.blocked` | Ordered head, same-lane lease, owner capacity, or attempt budget. Includes the waiting operation and available blocking operation/state/expiry. |
| `relay.claim`, `relay.finish` | Attempt, lane, lease expiry, result/error code, and next wakeup. `reason: "uncertain"` identifies retained uncertainty fencing. |
| `relay.yield` | Invocation publication/record/remote budget prevents claiming another row; includes `reservedCalls` and `remoteCallLimit`. Continuation does not clear an uncertain lease. |
| `rpc.start`, `rpc.finish` | Interest registration/release, authority append, destination append/confirm/outcome, origin retirement, and producer wake. `rpc` identifies the call; finish includes elapsed milliseconds and a sanitized code. |
| `destination.append`, `source.cached` | Actual destination acceptance and subsequent source caching. A destination append without source caching can indicate a lost/failed append response. |
| `socket.send`, `socket.ack` | Destination socket send and successful ACK processing. Event ID joins these to the operation; send is not proof of browser receipt. |
| `wake.queued`, `wake.claim`, `wake.receive`, `wake.finish`, `wake.blocked`, `wake.skipped` | Separate destination-to-producer notification scheduling, lease, coalescing and inactive-interest decisions. |
| `cleanup.start`, `cleanup.finish` | Terminal source housekeeping, separately from publication. |
| `read.notify.start`, `read.notify.receive`, `read.notify.finish` | Readable-state source notification and observer receipt, joined by opaque notification ID; source owner/revision and commit time are available. |
| `read.evaluate` | Correlated state-query evaluation, with scope token, operation watermark and state revision; no state value. |
| Browser `event.receive`, `event.handled`, `event.ack` | Arrival in the shipped event client, completion of the asynchronous widget handler, and ACK send. |
| Browser `snapshot.receive`, `animation.start`, `animation.finish` | Authoritative snapshot applied to the health DOM versus event-driven visual effect. The number/width comes from snapshots, not events. |

Join operations across objects by `operationId`, routes by `routeId`, delivery by
`eventId`, and snapshots by scope token/watermark/revision. `sequence` on a relay
record is the source operation sequence; on destination/socket/client records it
is the physical event sequence. These are distinct counters. `atMs` is wall-clock
time; browser/server clock skew prevents precise one-way latency measurement
without clock calibration. RPC elapsed time and same-side intervals avoid that
comparison. `read.evaluate` is evaluation completion, not socket delivery.

In particular:

- Commit to relay start, plus recorded due times, locates scheduling wait.
- Relay start to destination acceptance, plus blocker and RPC records, locates
  ordering, lease, capacity or remote-call wait.
- Destination acceptance to browser receipt/ACK locates downstream delivery or
  handler delay, subject to clock skew.
- A prompt event alongside a late `snapshot.receive` points toward the readable
  path. A late animation alongside a prompt snapshot points toward event flow.

An unknown append outcome is not proof of non-append. Do not shorten the lease,
clear the outbox, reset backlog, regenerate grants, or reapply the health mutation
to diagnose it. The existing cleanup/append lane split remains in place.

## Bounds, cost and limitations

Backend output is capped at 500 records per 60-second in-memory environment
instance window. Dropped-record counts appear on the next emitted record after
the window resets. Browser output is capped at 200 records per minute per page.
Eviction/reload resets these budgets; they are not account-wide logging limits.
Keep diagnostics enabled only for the investigation. No logging timer, polling,
additional RPC, durable diagnostic table, or diagnostic write is introduced.
Enabled relay snapshots/blocker inspection add bounded SQL reads against the
existing maximum-100-row outbox; disabled diagnostics add no SQL requests.
Logs and enabled reads have operational cost; ordinary cost baselines are
measured with this switch disabled.

Only allowlisted opaque IDs, numeric timing/counter fields and fixed protocol
labels/codes are logged. Payloads, health values, grants/cookies, source/group
keys, query bodies, raw URLs and exception text are excluded. A failed log sink
cannot fail a command, prevent an ACK, or change recovery.

Alarm observations are in memory. After eviction, an older scheduling timestamp
may be unavailable, and constructor recovery may select a new alarm time.
Missing `scheduledAtMs` means unknown, not zero lateness. Durable queue due times
remain visible in `relay.start`. Scheduling/claim/finish records emitted inside
transactions describe the attempted transition and can precede a rollback;
correlate with successful commit/cache/append records and error logs. Capped or
sampled platform logs can be incomplete. Absence of a record alone proves
nothing. These are diagnostic breadcrumbs, not an exactly-once audit log or a
production latency guarantee.

## Automated evidence

See [the step-1 latency investigation](state-event-latency-investigation.md) for
the sanitized production timing fixture, request/reentry map, installed-health
raw-binding tests, controlled failure models and remaining production unknowns.
Step 2 repairs expired shared-source alarms and recomputes all durable work after
each source handler, including exceptional completion. Its tests cover earlier
notification/watcher/invalidation deadlines, concurrent admission, native alarm
rollback, owner eviction and retained uncertainty. This does not guarantee
production alarm dispatch timing or repair the separate request-depth failure.

`test/state-event-latency.spec.js` uses real clocks, native SQLite/alarm/RPC and
WebSocket registration/ACK, with three commands at five-second local/shared and
fifteen-second shared spacing. It does not force due dates, clear leases or
manually drain handlers. The fixture restores injected registry bindings after
idle eviction. This is a scheduling regression, not a Cloudflare scheduler
benchmark. Existing fault tests retain a genuinely uncertain append lease and
now assert that diagnostics identify its ordered successor's exact blocker.
Diagnostic tests cover opt-in behavior, redaction, output caps, unknown alarm
times and log-sink failure. Browser-client tests preserve ACK-after-handler
behavior even when the diagnostic callback throws.
