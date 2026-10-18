# Shared atomic state/event storage and lifecycle authority

Roadmap step 5 implements the private `ShareableStateRealm` adapter. Production
combined commands still fail with `state_event_not_implemented`; deferred stream
admission is implemented in [step 6](state-event-delivery.md), and
[bounded relay/cleanup](state-event-relay.md) in step 7. Command integration remains later. No health feature, stream version or credential is migrated here. These modules are private
framework implementation, not supported feature imports.

## Acceptance and owner identity

The origin `GroupConfig` must durably prepare the immutable operation before
forwarding it through the integration registry. The saved route includes the
physical realm, directional target platform, binding revision, feature namespace,
namespace schema version and associated stream route. Repinning cannot change
the namespace/schema, scope kind or target platform of an existing operation.

The registry rechecks the current selected source and binding revision while
holding the same authority queue used by lifecycle mutations, event admission
and grant issuance. The realm then verifies its physical identity, the declared
operation/action/stream, frozen request fingerprint and pinned schema version.
A static internal protocol header identifies this binding-only path; it is not
a public credential or an authorization surface for feature code.

Inside one owner transaction, the adapter checks active seals and freeze state,
initializes or compatibly upgrades the namespace, calculates the deterministic
result and validates its payload, changes the actual feature state, advances its
normal readable revision, records notification work, allocates its operation
watermark, saves the original receipt and inserts the bounded event intent.
Durable scheduling shares the outer storage transaction with these writes.
Any validation, capacity or scheduling failure rolls the acceptance back.

Watermarks are partitioned by feature and namespace, with a random scope token
per partition. Distinct namespaces share the physical owner's finite receipt and
outbox budgets. Clamped/no-op operations still get their own event, operation
sequence and readable revision. Existing state-only operations retain their
behavior. Counter reset still deletes subject metadata through the existing
shared adapter. Namespaces requiring legacy integration adoption must complete
the existing ordinary adoption path first; combined acceptance never performs a
remote migration that could leave a partial rejected operation.

## Lifecycle serialization and uncertain calls

The registry holds its authority queue through owner acceptance. A default move,
link activation/collision choice, revocation, fallback or successor resolution
cannot overtake that call. The realm also checks its own seal/freeze inside the
write transaction, so an earlier route resolution alone cannot permit a write.

Before issuing the owner mutation RPC, the registry durably stores a small
uncertain-call barrier. A lost reply, timeout or registry restart retains that
record. Before an affected lifecycle change, recovery asks the original owner
for its receipt; if absent, it durably fences the old attempt. Only a committed
receipt or fence permits proceeding. A timeout never proves that a mutation did
not happen. A definite owner validation rejection is fenced before releasing its
registry locator, so repeated invalid operations do not consume uncertainty
capacity indefinitely. The fence is recovery metadata, not an accepted receipt.
Late RPCs cannot execute after their attempt has been fenced.

Recovery returns an original committed result even after movement, revocation or
feature removal. A proven uncommitted old attempt can be repinned using the
existing origin CAS protocol. Receipt lookup/fencing precede namespace creation,
adoption and writable/declaration checks. They can therefore run against frozen
or no-longer-installed namespaces without changing feature state.

Existing successor snapshots copy feature values and counter-subject metadata.
They exclude operation receipts, outbox obligations, partition tokens and
sequences. An accepted old intent stays on its original owner and stream route;
new successors begin their own operation watermark. Delivery permission for
archived intents is part of the later deferred-admission work.

## Bounds and additional work

| Resource | Bound or behavior |
| --- | --- |
| Owner storage | Existing shared limits: 100 pending events / 512 KiB; 100,000 receipt/route records / 16 MiB. |
| Registry uncertainty storage | 100 locators / 512 KiB total, at most 8 KiB each; no payload copy. |
| Owner RPC | Five-second deadline; timeout retains its durable barrier. |
| Lifecycle recovery | At most 20 affected locators within a five-second deadline; return `state_event_recovery_pending` and retry if more remain. |
| Unreachable owner | Return `state_event_outcome_unknown`; leave the affected lifecycle mutation unchanged. |
| Full registry budget | Reject new admission with `state_event_authority_capacity` before owner mutation. |
| Idle work | No polling, periodic producer scans or uncertainty-expiry assumptions. |

Fresh shared acceptance adds origin → registry → owner forwarding, a durable
registry locator write/delete, origin receipt caching and owner confirmation.
Uncertain retries add indexed owner lookup/fencing. Affected-source joins start
from the bounded barrier table; unrelated default changes can proceed even when
another source's owner is unreachable. The registry authority queue serializes
active calls globally, so an in-flight unavailable owner can delay other queued
work until its timeout. Cost measurement and tuning remain roadmap step 11.
Owner alarms reuse the bounded maintenance/scheduling foundation from
[state-event-local-storage.md](state-event-local-storage.md); private delivery from step 6 is now automatically reconciled by the
[step-7 relay](state-event-relay.md).

## Verification

`test/state-event-shareable-commit.spec.js` uses actual Durable Object SQLite
storage and real origin/registry/realm forwarding. It covers standalone
isolation, symmetric/asymmetric defaults, concurrent Discord/Twitch calls,
namespace partitions and compatible upgrades, payload/capacity rollback,
clamped no-ops and watcher delivery, stale schemas and physical-owner rejection,
seals/freezes, collision selection, revocation, fallback and relinking. Fault
injection covers lost replies, registry eviction, an actual RPC deadline,
delayed execution after fencing, owner eviction/alarm recovery without watchers, affected-peer group revocation and bounded
multi-request recovery. Successor assertions check that old event obligations
and receipts are never cloned.
