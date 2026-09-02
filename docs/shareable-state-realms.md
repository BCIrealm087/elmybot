# Standalone shareable-state realms

Step 3 of the shareable-state initiative implemented the first concrete realm
owner without changing feature behavior. `ShareableStateRealm` is an internal
SQLite-backed Durable Object. It is not part of Framework API v1 and feature
packages cannot import or address it.

## Ownership and addressing

One initial standalone realm belongs to exactly one normalized platform group:

```text
(platform, group kind, group ID, generation 1) -> standalone realm
```

The internal client derives the Durable Object name from the complete group key
and generation. The object persists that identity on its first valid declared
namespace request and rejects later requests carrying another owner or
generation. Discord and Twitch groups with similar raw IDs therefore remain
distinct, as do different groups on the same platform.

The internal client defaults to generation 1. Later revocation infrastructure
may select and publish a successor generation, but feature code will never
choose generations or receive realm identifiers.

## Namespace persistence

The realm receives the installed feature registry at the Worker composition
root. Every operation must identify a `(feature ID, namespace ID)` pair declared
through `defineFeature({ shareableState: [...] })`. Missing or uninstalled
declarations fail before the object binds an owner.

Each namespace records:

- its installed schema version;
- an atomic mutation version;
- creation and last-change timestamps; and
- canonical JSON values keyed inside that namespace.

Objects are serialized with lexicographically sorted keys, finite JSON values
only, and a maximum nesting depth. The declaration's `maxEntries` and
`maxValueBytes` limits are enforced inside the Durable Object transaction, not
trusted to callers. Reads and no-op writes do not advance the mutation version;
successful content changes and deletions do.

The internal operation set supports `get`, `set`, `delete`, atomic integer
increment, and bounded counters. A bounded-counter reset removes its persisted
entry, so an all-reset namespace can become canonically empty. Counter keys are
derived from a hash of the logical name and subject and never expose that
subject through the physical primary key.

## Schema compatibility

The realm stores both a physical realm-layout version and each namespace's
feature schema version. Reopening a namespace at the same version is a no-op.
An older version listed in the installed declaration's `compatibleVersions`
may be identity-upgraded to the current version. Any incompatible version fails
closed; this step does not run feature code or invent a transformation.

## Protected snapshots and cloning

The realm can capture exactly one declared namespace as a snapshot containing
its current schema version, monotonic mutation version, deterministic SHA-256
content fingerprint, safe collision summary, and canonical entries. Capture is
atomic: the entries and mutation version describe the same point in the
namespace's history. Object key order and write order do not affect the
fingerprint.

A namespace is meaningful precisely when it has at least one persisted entry.
The only presentation-safe summaries are the feature-declared `presence` and
`entry_count` forms. Raw keys and values remain in the protected snapshot
payload used by infrastructure; they must never be rendered or copied into
registry audit metadata.

Infrastructure may compare compatible snapshots by namespace identity, schema
version, and fingerprint. It may clone a verified snapshot into a fresh target
namespace. The target revalidates the installed declaration, entry and value
limits, canonical content, and fingerprint before writing all entries in one
transaction. It rejects stale or previously initialized targets. Successful
initialization advances the target mutation version once, including when the
selected snapshot is empty, while leaving the source realm untouched.

Identity-compatible schema upgrades now also advance the mutation version
because schema identity participates in fingerprints. Every later content
mutation advances from that value; reads and canonical no-op writes do not.

These operations are internal Durable Object capabilities exposed only through
`src/shareable-state`. The feature-facing scope returned by
`ctx.shareableState.current(otherPlatform, namespaceId)` still contains only
`get`, `set`, `delete`, `increment`, and `boundedCounter`; features cannot
enumerate entries, request snapshots, choose realms, or clone state.

The internal client surface is intentionally namespace-specific:

- `snapshotShareableStateNamespace(...)` captures and deeply freezes one
  snapshot;
- `shareableStateSnapshotHasMeaningfulState(...)` evaluates its canonical
  persisted-entry marker;
- `shareableStateSnapshotsEqual(...)` compares compatible identity and content
  while ignoring history-only mutation-version differences; and
- `cloneShareableStateSnapshot(...)` verifies and initializes one fresh target
  namespace with an explicit expected target mutation version.

Cloning accepts only the currently installed schema version. Discovery must
therefore snapshot each candidate through the current realm code first, which
performs only declared identity-compatible upgrades before comparison.

## Deliberately deferred behavior

The remaining stages still do not:

- seal realms against concurrent mutation;
- change invitation activation or perform collision discovery;
- retain lifecycle snapshots or resolution audit records; or
- migrate `fun.deaths` from its current integration-owned ledger.

Resolution continues to pin generation 1 of the origin group's standalone realm
or the active default integration's realm. The pending-integration lifecycle is
the next stage that will orchestrate these protected primitives.
