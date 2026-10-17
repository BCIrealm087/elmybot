# Group-local atomic state/event storage

Roadmap step 4 implements the private `GroupConfig` storage adapter. Combined
command execution remains blocked with `state_event_not_implemented`; no feature
or existing stream is migrated. [Shareable acceptance](state-event-shareable-storage.md)
is implemented in step 5; deferred append
and gap transport are step 6, relay is step 7, and operational enablement follows
later. These internals are not stable feature API exports.

## Commit boundary

`commitLocalStateEvent` validates the physical group object, deployment environment,
action allowlist, local operation declaration and pinned stream route. It verifies
the request fingerprint and looks for the original owner receipt before preparing
another mutation. A committed retry can therefore recover after declarations
change, without recalculating from current state or configuration. New acceptance
also requires the matching durable origin preparation from step 3 in the same
local object; calling the internal endpoint cannot skip that record/cooldown.

Saved requests are revalidated against their declaration. Selected configuration
is recovered from their resolved selectors, rather than read live; repeated
uses of a configuration key must agree. Key hashing and event identity derivation
happen before the transaction. No feature callback or external request runs
inside it.

The synchronous owner transaction performs all of the following:

1. Read the authoritative value and calculate the supported mutation result.
2. Validate the saved result and construct/schema-validate the event payload.
3. Enforce owner rate, partition, state value, outbox and sequence capacities.
4. Apply the existing local state mutation and advance its readable revision.
5. Save the producer scope token, operation sequence, event intent and receipt.

Existing revision triggers enqueue/coalesce watcher notifications in that same
transaction. Every accepted combined operation advances the readable revision,
even at a counter floor/ceiling, on a same-value set, or on a missing delete.
Every accepted operation still has its own event. Ordinary state-only no-op
behavior remains unchanged. Existing bounded-counter keys and subject metadata
are reused. Sequence or revision exhaustion rejects instead of wrapping.

An outer SQLite storage transaction includes the synchronous writes and the
alarm update. Failure to persist the alarm rolls back the state, revision,
notification, watermark, receipt and intent. This uses the SQLite storage API's
support for SQL and alarm operations within `storage.transaction`; see
[Cloudflare's storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
An accepted commit therefore does not rely on code running after the transaction
to schedule its first durable wakeup.
The local origin and owner also cache/acknowledge their receipt in this same
transaction, avoiding a separate owner acknowledgement request. If the optional
origin cache cannot grow, the owner receipt and locator retain step-3 recovery
semantics; a proven acceptance is not turned into a rollback claim.

## Storage and limits

The additive `state_event_partitions`, `state_event_outbox` and singleton
`state_event_outbox_budget` tables are created lazily and idempotently. They are
separate from feature values and the coalescing state-query notification outbox.
An ordinary group allocates none of these tables.

| Boundary | Enforcement |
| --- | --- |
| State owner | 100 retained intent records and 512 KiB of complete serialized intents, including payload and routing metadata. |
| Producer partitions | 100 per owner; local partition identity is the feature ID. |
| New acceptance rate | Sliding window of at most 10 operations per second across all local partitions. Duplicate recovery consumes no slot. |
| Payload and result | Existing 4 KiB event payload limit; 4 KiB saved result summary. |
| Receipt and origin metadata | Step-3 shared 100,000-record / 16 MiB owner budget, including local origin/owner records. |
| Feature values | Existing key, counter, safe integer, subject metadata, 100-value and value-byte limits. |
| Maintenance | At most 20 intents per invocation, selected through the due index. |
| Event lifetime | Original commit time plus 30 minutes; retry never extends it. |

The receipt and intent persist matching private `stateEvent` correlation with
version, operation ID, producer scope token, operation sequence and readable
state revision. A scope token is generated once for the local producer incarnation.
This step stores correlation; step 8 will expose it through snapshot/event wire
surfaces. Nothing is added to existing public event frames yet.

Counters bound admission without scanning receipt or outbox history. Pending
byte accounting includes routing and correlation, not just feature payload text.
SQL/index overhead remains additional storage, as described by the contract.

## Wakeup coordination and staged maintenance

`storage-alarm.js` serializes alarm decisions and considers all durable work in
the object: grant invalidations, state-query notifications/watch leases and the
state/event outbox. The existing notification schedulers use that same decision,
so neither can delete an event wakeup or overwrite earlier work. `GroupConfig`
constructor recovery rediscovers outbox work after eviction.

Until the deferred append and relay stages exist, the first durable wakeup parks
an intent at its original event deadline. Deadline maintenance removes its
payload and preserves a bounded `gap_pending` record. It does not declare
successful delivery, release the authoritative receipt, manufacture a stream
sequence, or discard the future gap obligation. Gap records remain charged
against the 100-record/512-KiB outbox ceiling until the later transport/lifecycle
work can resolve them. No repeated presence probe or idle timer is introduced.

The internal `/internal/state-events/owner/commit` binding endpoint uses this
adapter with the installed registry; it is not a public Worker route. The
production command/service guard still prevents invocation through a feature.

## Automated evidence

`test/state-event-local-commit.spec.js` uses actual Durable Object SQLite storage
and the `GroupConfig` handler. It covers mutations and clamping, no-ops, concurrent
and repeated invocation, watcher delivery, frozen configuration, request misuse,
rate/capacity/sequence rejection, invalid and oversized payload/results, rollback
after state writes, an alarm-write failure, eviction immediately after commit,
competing schedulers, bounded maintenance and expiry without polling. Existing
state-only, state-query and step-3 recovery suites remain required regression
checks.
