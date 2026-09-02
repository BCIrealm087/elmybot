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

## Deliberately deferred behavior

The completed effective-resolution step now exposes declared namespaces through
`ctx.shareableState.current(otherPlatform, namespaceId)`. The remaining stages
still do not:

- snapshot, fingerprint, seal, clone, freeze, or enumerate realm contents;
- change invitation activation or collision handling; or
- migrate `fun.deaths` from its current integration-owned ledger.

Resolution pins either generation 1 of the origin group's standalone realm or
generation 1 of the active default integration's realm. Snapshot and transition
primitives follow next, before any integration lifecycle begins moving declared
state.
