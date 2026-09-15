# Live state-query dependency coordination

Status: implemented for state-querying roadmap step 8 on 2026-09-13.
Public delivery is implemented in the [SSE layer](state-query-sse.md).

## Boundary

`StateQueryObserver` now owns the durable runtime for active composed queries.
It evaluates the same version-1 query document used by snapshots, persists the
complete result and exact dependencies, and attaches leased interest to the
group-local, shareable, and effective-binding sources that can invalidate that
result.

The coordinator is internal infrastructure. Its attach, renew, remove, and get
operations are available only through Durable Object bindings. The Step 9 layer
owns the public HTTP subscription endpoint, cursor contract, SSE framing, and
connection buffering and exposes these persisted results to browsers.

## Persisted graph

Each logical Discord guild or Twitch channel has one observer object with three
SQLite tables:

| Table | Purpose |
| --- | --- |
| `state_query_observer_queries` | Canonical query, grant reference, latest envelope, exact dependencies, result sequence, authorization deadline, retry state, and client lease |
| `state_query_observer_sources` | One shared physical or binding watcher per deterministic source edge, including its expected revision and lease |
| `state_query_observer_query_sources` | Many-to-many edges from active queries to shared source watchers, annotated with dependency kinds |

The browser credential secret is never copied into the observer. An attached
query stores only its grant ID. Trusted observer-to-group calls revalidate that
reference against the issuing group's durable grant record, exact target, and
deployment environment.

Source-edge identity includes the logical target and complete internal watcher
descriptor. Equivalent observations in one group therefore share one owner
watcher, while each query retains its own grant, authorization schedule, result,
sequence, and lease. Revoking one grant denies only its query and removes only
its graph edges; a shared watcher remains while another authorized query uses it.

## Evaluation and attachment handshake

Initial attachment and every invalidated reevaluation use the same bounded
sequence:

1. Canonicalize the query and revalidate its grant reference.
2. Authorize the complete plan and each normalized dynamic argument.
3. Evaluate against the currently selected sources and capture exact value,
   counter-subject, and collection dependencies.
4. Derive group-local, shareable namespace, and directional binding watcher
   descriptors with the revisions observed by evaluation.
5. Register or renew every new descriptor and compare its current revision with
   the observed revision.
6. If any revision changed, discard the candidate and retry the complete
   sequence, up to three attempts.
7. In one observer transaction, store the new result, replace the query's graph
   edges, and mark newly orphaned sources for cleanup.
8. Unregister orphaned sources only after the replacement graph is durable.

This is attach-new-before-detach-old. A remembered-game change can therefore
move from the old counter subject to the newly selected subject without a gap.
A binding handoff likewise attaches the replacement realm and its current
binding revision before retiring the old realm.

If cleanup races with another query reusing an orphan, the observer repairs the
owner registration from the current graph. A revision change during that repair
marks only the referencing queries pending again.

## Invalidation and collection membership

State owners continue to emit coarse, coalesced invalidations per local feature
or shareable feature namespace. The observer maps a watcher ID through its
persisted graph and marks only related queries pending; it never scans stored
groups or all queries globally. Multiple mutations before an alarm coalesce into
one current-state reevaluation.

The evaluator's exact dependency list is replaced after each successful result.
For a dynamic lookup it records the remembered value and the selected counter
subject. For a collection it records collection membership even when the
materialized array is empty, so later insertion, reset, or deletion invalidates
the query without a feature-authored preset.

Because source delivery is namespace-granular, a later mutation to an obsolete
subject can conservatively cause reevaluation while another active edge shares
that namespace. It cannot restore the obsolete value: evaluation resolves the
current dynamic argument, and an equal `resultRevision` does not advance the
query sequence or create a user-visible update.

## Authorization, leases, and recovery

Authorization is checked during every evaluation and independently every 30
seconds. The periodic check validates only the stored grant reference; it does
not reevaluate an unchanged query. Expired or revoked grants move that query to
`denied`, preserve a safe error code for the future transport, and release its
source relationships. Dynamic values are authorized again after every change,
so a newly selected argument outside the grant policy cannot be delivered.

Client query leases last 30–300 seconds and default to 120 seconds. Renewal also
renews every underlying source watcher. A shared watcher is renewed through the
latest lease required by any referencing query, so a short renewal cannot cut
off a longer-lived client. Expired queries are deleted and orphaned owner
interest is unregistered. Constructor and alarm scheduling derive the next due
time from persisted query expiry, authorization checks, reevaluation retries,
and detach retries, which provides restart recovery without an in-memory graph.

Failures use a 30-second attempt lease and exponential retry from one to 30
seconds. A drain handles at most 20 queries or authorization checks at a time and
runs four external calls concurrently. Current-state reevaluation means retry
does not replay obsolete intermediate values.

## Initial limits

| Limit | Value |
| --- | ---: |
| Query lease | 30–300 seconds; default 120 |
| Retained query records per group observer | 400 |
| Distinct canonical plans per group observer | 100 |
| Source edges per query | 40 |
| Shared source edges per group observer | 2,000 |
| Attach/version-check attempts | 3 |
| Alarm batch | 20 records |
| External-call concurrency | 4 |
| Attempt lease | 30 seconds |
| Retry delay | 1–30 seconds |
| Independent grant check | Every 30 seconds or at grant expiry |

Query-parser, evaluator, result-size, collection-size, grant-permission, and
source-owner watcher limits continue to apply in addition to this table. Limit
violations return explicit `query_limit_exceeded` or
`state_query_live_capacity` errors rather than silently dropping dependencies.

## Verification

`test/state-query-live-observation.spec.js` covers:

- an initially unselected remembered game becoming selected and attaching its
  counter;
- a remembered-game handoff followed by an old-subject mutation that cannot
  contaminate or advance the result, then a current-subject update;
- empty collection observation followed by insertion and reset removal;
- shared underlying interest with independent grant revocation;
- a same-value effective-source handoff that still advances the result revision
  and removes obsolete realm interest;
- query-lease expiry and orphan watcher cleanup; and
- explicit admission failure at the retained-query budget.

The earlier evaluator, source-notification, binding-lifecycle, and authorized
HTTP snapshot suites remain the lower-level coverage for exact dependencies,
registration races, restart recovery, permissions, and query semantics.
