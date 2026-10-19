# Flattened publication and lifecycle requests

Latency roadmap step 4 removes redundant owner callbacks from normal relay
publication, confirmation and confirmed-origin retirement. It uses the existing
owners and persisted outcomes; no coordinator, broker, schema migration or new
secret is required. Step 3's conservative call reservations and small publication
quantum remain unchanged, including headroom for legacy recovery.

## Call paths

Depth here counts awaited application binding calls from the relay entry point,
not Cloudflare's runtime request-context counter.

| Work | Before | Current normal path |
| --- | --- | --- |
| Interest / local append / confirm | Owner → destination → owner proof | Owner → destination with a locally validated snapshot. |
| Shared append | Owner → registry → destination → owner proof, plus a registry → owner proof | Owner → registry → destination; registry checks live binding authority and forwards the snapshot. |
| Shared append recovery/fencing | Additional destination → owner proof callbacks | Registry → destination with the current source snapshot; original durable call tokens remain fenced. |
| Confirmed origin retirement | Owner → origin → owner lookup | Owner → origin's already confirmed original receipt cache. |
| Old unconfirmed origin retirement | Owner → origin → owner lookup/confirmation | Existing recovery remains; each owner callback has depth two from relay entry. |

The normal shared publication path has depth two, and local publication has
depth one. The previous eight-call old-barrier/append-rejection recovery case
now makes four application requests without source-proof callbacks. These are
structural bounds verified in the injected test harness. The raw-binding health
harness also passes; it still does not reproduce production depth exhaustion.

## Snapshot trust and freshness

Snapshots are private framework messages, constructed only by the actual state
owner from its local outbox and original acceptance receipt. Construction checks
the physical binding-derived owner identity, operation/event identity, readable
marker, commit time and fixed expiry. Receivers validate the version, selected
owner, operation, route and snapshot shape, followed by the existing declaration,
identity, payload, fingerprint and destination checks.

The `snapshot-v1` source marker identifies this framework-owned binding path.
It is **not** a signature, public bearer token or authentication for an arbitrary
caller. The trust boundary remains trusted framework code with binding access;
the public Worker does not route these internal requests and the stable feature
API cannot construct them. Unmarked requests containing a snapshot are rejected.
Legacy requests without one still obtain proof from the actual source owner.
An already in-flight old-format owner-to-registry request can therefore retain
the former deeper chain. A retry from the upgraded owner reconstructs a snapshot;
the two-level structural guard applies to the current owner-initiated paths.

| Fact | Authority |
| --- | --- |
| Original operation/event identity, payload, commit time and retention deadline | Immutable committed owner receipt/outbox, carried in the snapshot; destination checks identities, installed schema and original deadline. |
| Source head, state and interest epoch | Snapshot of the owner's local state when dispatching; not a claim that mutable state remains current forever. The source's durable claims/order and interest-epoch CAS remain enforced. Confirmation gets a new snapshot after source caching. |
| Current directional binding / revocation | Fresh registry state under the existing serialized binding-authority queue; a source snapshot cannot authorize an old binding. |
| Append attempt fencing, reset checkpoint, retained capacity and gap state | Destination's current local data, including transaction-time guards; stale snapshots cannot bypass these checks. |
| Duplicate delivery | Existing destination receipt/fingerprint and original event ID; a replay returns the original result instead of appending again. |
| Terminal origin housekeeping | Owner retires its receipt first. An origin can reuse only its matching original committed cache already acknowledged by that owner; unconfirmed/prepared old caches retain owner lookup/confirmation recovery. |

Moving proof across the trusted binding path does not introduce a public
payload-supplied append API. It replaces the former response carrying the same
owner information with an owner-generated request snapshot. An untrusted caller
must never be allowed to enter this path merely by copying the marker header.

## Bounded transport and durable recovery

The private delivery request ceiling is 24 KiB, with a snapshot ceiling of
16 KiB. The event payload ceiling remains 4 KiB. Snapshots are transient: the
registry strips them before persisting its existing 8-KiB authority locator.
Locators retain only owner, operation, route, call token and binding authority;
no event payload or snapshot is duplicated in durable registry storage.

Old locators need no conversion. An owner retry rebuilds a snapshot from its
original durable receipt/outbox, including after eviction. Registry lifecycle
recovery without a carried snapshot retains the old source-proof fallback.
An append reply lost before source caching still retains its uncertainty lease
and original destination receipt. Lost confirmation and terminal cleanup still
resume through existing `appended`, `gap_recorded` and `retiring` states. No new
phase metadata is needed to achieve the verified two-level structure.

## Verification and limits

The work-budget harness now rejects nesting beyond two for bursts, lost replies,
registry fencing and ACK cleanup, and asserts normal publication makes no source
proof requests. A deliberately too-small one-level guard fails the shared path
and preserves recovery authority. Snapshot tests cover unmarked/public requests,
physical-owner and identity mismatch, ordered heads, stale reset/expiry, a queued
linked-owner revocation, a near-4-KiB payload with lost reply, and old unconfirmed
origin recovery. Existing tests retain delayed-append/default-movement fencing,
owner restart and lost-confirmation coverage.

This removes normal owner-proof reentry, but cannot establish the actual
production depth counter or eliminate platform alarm dispatch variability.
If production still exhausts depth on the new path, use the existing diagnostics
to locate the remaining lineage before considering a dedicated coordinator.
