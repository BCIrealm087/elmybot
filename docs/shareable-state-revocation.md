# Shareable-state revocation and standalone continuation

Step 10 of the shareable-state initiative preserves the final shared ledger
when an active integration is revoked. It is framework infrastructure, not a
feature-facing API: feature actions continue to call
`ctx.shareableState.current(otherPlatform, namespaceId)` without selecting a
realm, generation, snapshot, or recovery policy.

## Observable behavior

Revocation handles each directional default independently:

| Direction after revocation | Effective state for later invocations |
| --- | --- |
| The revoked integration was not selected | The existing selected realm remains current |
| Another active integration can replace it | The deterministic fallback integration's existing realm |
| No active fallback remains | A new standalone generation copied from the revoked integration's final state |

If both former members lose their defaults, each receives an independent
standalone successor initialized from the same final integration snapshot.
Later writes diverge normally. Revocation never makes the two standalone
realms continue sharing and never restores either group's older pre-link
standalone generation.

## Revocation transition

The registry implements revocation as a resumable saga:

1. Atomically change the integration from `active` to `revoking`, write a
   durable recovery job, and record `integration.revocation.started.v1`.
2. Inventory every installed, declared shareable namespace in the integration
   realm and permanently freeze each one with a deterministic transition ID.
3. Persist a metadata-only revocation manifest containing namespace identity,
   schema version, mutation version, fingerprint, and meaningful-state marker.
4. Repair every directional default that selected the integration.
5. For each direction with no fallback, record a pending standalone successor
   generation sourced from the frozen integration realm.
6. Mark the integration `revoked`, record `integration.revoked.v1`, and remove
   the recovery job in the same registry transaction.

An integration in `revoking` is not eligible for commands, routes, default
selection, or integration-owned writes. Effective shareable-state resolution
returns the retryable `shareable_state_transition` result until the registry
has repaired the direction. A failed freeze leaves the durable job in place;
an explicit retry or the registry alarm resumes the same transition. Permanent
freeze IDs, manifest rows, terminal audit events, and the final revoked result
are replay-safe.

Cloudflare Durable Objects do not provide one SQL transaction across the
registry and every realm. The permanent realm freeze closes that gap: a write
that reaches the realm first is included in its final snapshot, while a write
that reaches it after the freeze fails with
`shareable_state_realm_frozen`. Reads and protected snapshots remain available
for recovery, but the archived realm can never become writable again.

## Lazy standalone successors

Revocation records the successor source durably but defers copying its values
until that group next needs standalone shareable state. The pending record
contains only:

- source group and new standalone generation;
- source integration and integration-realm generation;
- pending or ready status and lifecycle timestamps; and
- the separate metadata-only namespace manifest.

The first effective-state resolution snapshots each frozen namespace again,
checks it against the manifest, and clones it into the new standalone realm
with a stable per-namespace idempotency key. It verifies the cloned fingerprint
before atomically changing the successor to `ready` and recording
`integration.state_successor.ready.v1`.

Partial output is unreachable. If a clone fails after some namespaces finish,
the direction remains pending and the caller receives a retryable error. The
next attempt replays completed clones and finishes the remainder. Feature
resolution publishes only the ready generation, never the partially copied
realm or the previous standalone generation.

Each successor increments that group's standalone generation. A later
revocation therefore creates a fresh realm rather than overwriting a previous
standalone history. Relinking discovery resolves a pending successor first and
then compares the resulting current generation with the other platform's
candidate.

## Defaults and many-link behavior

Fallback promotion takes precedence over successor creation. If a selected
integration is revoked while another eligible active link remains, later
invocations immediately select that fallback's existing integration realm;
the registry does not copy the revoked state into it. No successor is created
for that direction.

The opposite direction is evaluated separately. It may have a different
fallback decision and can therefore receive a successor even when the first
direction does not. Nondefault integrations do not affect the currently
selected realm when revoked.

## Storage and privacy boundary

The archived integration realm retains canonical namespace contents because it
is the recovery source. Registry tables store only fingerprints and lifecycle
metadata; raw feature keys and values do not enter registry rows, management
responses, audit entries, or logs. Existing integration members and audit
history remain available after revocation.

The internal `freeze-snapshot`, successor resolution, cloning, and manifest
operations are available only below `src/shareable-state` and
`src/integrations`. Feature packages cannot import them through
`@elmybot/framework`.

## Verification boundary

The focused revocation suite covers:

- permanent freeze behavior and replay ownership;
- independent successor creation and divergence for both former members;
- fallback promotion without an unnecessary successor;
- partial lazy-copy recovery and audit deduplication;
- interrupted archive recovery through the durable revocation job; and
- relinking discovery from the current successor generation.

The broader lifecycle, authorization, CSRF, concurrency, and many-link matrix
is documented in
[`shareable-state-lifecycle-verification.md`](shareable-state-lifecycle-verification.md).
The `fun.deaths` lifecycle test now verifies this continuation with real death
counters through revocation, divergence, and relinking.
