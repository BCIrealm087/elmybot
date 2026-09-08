# Shareable-state lifecycle verification

Step 11 closes the planned lifecycle, security, concurrency, and many-link test
matrix before any installed feature migrates to `shareableState`. The suite
tests observable ownership and transition behavior across the framework test
runtime, real registry persistence, protected realm operations, and the Twitch
browser adapter. No single test double is treated as proof of the whole system.

## Coverage matrix

| Required behavior | Primary verification |
| --- | --- |
| No-link operation | `shareable-state-resolution.spec.js` runs the same action for isolated Discord groups and preserves a standalone ledger across link selection changes. `integration-registry.spec.js` verifies production resolution chooses standalone generation 1. |
| One-sided state | `integration-state-discovery.spec.js` classifies Discord-only and Twitch-only namespaces and verifies the selected contents in the finalized integration realm. |
| Two-sided different state | Discovery reports only unequal, nonempty namespaces as collisions and requires one explicit decision per collision. |
| Identical-state optimization | Discovery automatically selects one equivalent snapshot and finalization verifies the selected fingerprint and content. |
| Discord, Twitch, and reset choices | Finalization tests copy a Discord collision, copy a Twitch collision, and initialize a genuinely nonempty collision empty without changing either source candidate. |
| Cancellation and expiry | Registry and browser tests cover same-origin cancellation, cancellation after a saved state decision, idempotent refresh, invitation expiry, pending-resolution expiry, and activation rejection after terminal state. |
| Commands before and during finalization | A candidate mutation after discovery remains allowed and forces rediscovery. Realm tests prove an acquired finalization seal permits reads but returns a retryable error for mutation, so a command is either included or rejected rather than silently omitted. |
| Refresh and resubmission | Verification, discovery, resolution, activation, cancellation, and the Twitch success page are replay-tested. Repeated browser form submission and refresh perform no second resolution or activation. |
| Revocation and divergence | `integration-state-revocation.spec.js` freezes the shared realm, gives both unlinked members independent successors from the same snapshot, and proves a later write diverges. |
| Relinking | Discovery after revocation selects the current successor generation rather than the obsolete pre-link standalone realm. |
| Multiple integrations and default switching | Registry tests cover four many-to-many directional defaults, concurrent first-link selection, authorization, fallback, and replacement races. The feature runtime test proves opposite directions can remain on different integration ledgers and switching back reveals the original ledger without copying. |
| Unauthorized resolution and CSRF | OAuth verification requires the Twitch broadcaster. Browser writes require the exact HTTPS origin and HttpOnly continuation value; missing and foreign continuations fail. Stale discovery versions, incomplete choices, injected feature IDs, foreign groups, and unauthorized default ownership are rejected. |

## Layered concurrency guarantees

The suite deliberately exercises concurrency at three boundaries:

1. **Realm boundary:** temporary seals and permanent freezes arbitrate directly
   against state mutations inside the owning Durable Object.
2. **Registry boundary:** concurrent activation, replay, default repair,
   revocation recovery, and bounded group alarms converge through durable rows,
   synchronous registry transactions, and idempotency keys.
3. **Browser boundary:** duplicate submissions resolve to the already recorded
   state and active integration rather than creating another lifecycle result.

This is stronger than asserting that a lock helper was called. Tests mutate
state on each side of the transition and inspect the authoritative realm,
registry status, defaults, audit counts, and user-visible outcome.

## Security boundary

The resolution page is intentionally a continuation of authenticated Twitch
OAuth rather than a new identity prompt. The random reservation value is held
in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie and acts as the pending-link
bearer capability. State-changing routes additionally require an exact
same-origin `Origin` header.

The browser submits only the discovery revision and indexed decisions. The
server reconstructs feature and namespace IDs from persisted discovery, so an
attacker-controlled identifier cannot select another namespace. The page
renders only declaration-approved presence or entry-count summaries and
escapes labels; raw state keys and values remain protected realm data.

Registry authorization remains defense in depth for integration management:
groups can manage only relationships they belong to, each platform actor can
change only its own outgoing direction, and a selected target must be an active
member of the exact integration.

## Feature proof

The generic matrix is complemented by `fun.deaths` tests that exercise
standalone group isolation, a real death-ledger collision, explicit platform
selection, linked sharing, revocation successors, post-revocation divergence,
relinking, and one-time adoption and sealing of a legacy integration ledger.
