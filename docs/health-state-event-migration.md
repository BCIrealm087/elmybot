# Authoritative health v2 migration

Roadmap step 9 moves the installed `fun.health` command to atomic shared health
and per-operation events. The implementation is opt-in: both production and test
Wrangler configurations explicitly leave `STATE_EVENT_OPERATIONS_ENABLED` at
`"false"`. No deployment or live migration is performed by this change. The
failure matrix, cost measurements and final rollout review remain steps 10–12.

## Versioned behavior

| Surface | Before | After |
| --- | --- | --- |
| Command syntax | `/health operation:damage amount:15`; `!health damage 15` | Unchanged |
| Permission/default/cooldown | Moderator; amount 10 by default, accepted range 1–100; one second per origin group | Unchanged |
| Action | `fun.health.impact.v1` | `fun.health.impact.v2` |
| Event stream | `fun.health:impacts:v1`: requested `operation`, `amount` | `fun.health:impacts:v2`: committed `operation`, `requestedAmount`, `appliedAmount`, `before`, `after`, `changed` |
| Current health | Browser-local arithmetic/storage | Shared `health` namespace, schema 1, `health/current` bounded counter, initially 100, bounds 0–100 |
| Readable export | None | `fun.health:current:v1`, an integer and owner-partition `stateEvent` watermark |
| Success reply | “Health event queued.” | “Health saved and impact queued.” |

Each accepted command atomically saves the counter, readable revision, original
receipt and durable event intent. No consumer needs to be connected. Damage at
3 with amount 10 applies 3; healing at 100 applies zero but still creates one
accepted impact, sequence and revision. The reply confirms source acceptance;
it does not promise that an animation has already played.

Directional defaults choose the same effective shareable realm used by readable
state and existing lifecycle controls. Symmetric Discord/Twitch defaults share
health; standalone groups and asymmetric selections remain isolated. No browser
value is uploaded, inferred as initial state, or copied into the new namespace.
Existing collision/revocation/successor rules apply to authoritative health.

## New command runtime and safeguards

`ctx.stateEvents.local()` and `.current()` now use a private framework runtime.
Authorization and command argument validation still precede execution. An
injected service or an arbitrary context flag cannot bypass the action boundary.
The action context allows one commit attempt and only its declared operations.

The runtime derives immutable platform source identity, looks up the original
origin/owner outcome before reading configuration or selecting a new owner, and
prepares the frozen request and cooldown durably at the origin. Saved preparation
wins across retries. An already accepted retry returns its original result even
after later healing, changed defaults, disabled acceptance, or an origin restart;
it cannot consume a second cooldown or create another impact. New-source cooldown
errors retain the existing Discord/Twitch cooldown response.

Local commits use the local atomic adapter. Shared commits use registry authority
and its durable uncertainty barrier. A proven stale binding can be repinned only
after fencing the old attempt; the saved request remains unchanged. Ambiguous
transport failures retain recoverable authority and report
`state_event_outcome_unknown`, never a claim that the state stayed unchanged.
Binding RPCs have five-second deadlines. The relay, original thirty-minute event
deadline, queue/receipt caps and bounded cleanup from steps 3–8 remain in force.

`STATE_EVENT_OPERATIONS_ENABLED === "true"` and
`DURABLE_EVENT_STREAMS_ENABLED === "true"` are both required for fresh acceptance.
Missing values, booleans and different casing fail closed. Owner adapters check
the switches after original receipt lookup and before mutation. Disabling new
acceptance preserves saved receipts and permits recovery; keep the event master
enabled to drain accepted events normally. Turning off the master also stops new
appends/sockets while retaining expiry/gap authority. Do not remove the tables,
handlers or semantic versions needed by existing obligations.

## Widget and one-time transition

`/health-widget/` is the v2 widget. It needs **two separately scoped grants for
the same group**: a read grant for `fun.health:current:v1` and an event grant for
`fun.health:impacts:v2`. Its credential form exchanges them into the existing
separate same-origin sessions. Credentials are cleared from the fields and never
placed in the OBS URL. An event grant does not confer read access.

The widget obtains a fresh snapshot/watch through `watchStateEvents`, draws only
bot health, and awaits one animation per live impact before acknowledgement.
Events already covered by its initial/recovery baseline are historical and do
not replay startup animations. Snapshot-first/event-first arrival, accepted
zero-applied impacts and duplicate delivery never apply another health delta.
Clearing browser storage loses optional handled-ID history; a new authorized
snapshot still recovers the current number. Exactly-once visible animation across
crashes is not promised.

Old `elmybot.health.v1:*` numeric storage is ignored by v2. The new widget stores
only a bounded recent-ID list under `elmybot.health.impact-ids.v2:*`. It rejects a
v1 event grant with an explicit migration message and link to the legacy view.
It also rejects read/event catalogs targeting different groups.

For an operator-selected transition after the remaining verification stages:

1. Preserve/finish the existing v1 backlog using the current v1 grant and
   `/health-widget/legacy.html`. This explicit compatibility view retains the old
   delta payload and browser-local number; it labels that number as legacy.
2. Issue separate v2 event and current-health read grants for the same group.
   They neither reinterpret nor transfer the v1 grant/backlog/cursor.
3. Switch the OBS source to `/health-widget/` and authorize both sessions there.
   Authoritative health starts at its documented 100; legacy browser numbers
   remain local. Enable fresh combined acceptance explicitly in the intended
   environment only when ready for that transition.
4. Drain/acknowledge retained v1 events, or use the existing operator backlog-reset
   flow if a v1 retention gap prevents drain. Revoke the old grant afterward.

The installed registry retains the exact v1 stream schema for old grants and
backlog delivery; new `/health`/`!health` commands produce v2 only. The old action
kind is retired rather than redirected: an unaccepted stored v1 command cannot
silently become a new state mutation. Retained accepted v1 events remain on their
original physical stream under existing drain/expiry rules. No automatic grant
replacement, backlog reset, browser import or migration-tag change is performed.

## Automated evidence and contributor tooling

`packages/features/fun-health/test/feature.spec.js` covers both command adapters,
standalone/shared selection, offline acceptance, permissions, amount validation,
cooldown, clamping, retry identity and distinct v1 compatibility. Opt into the
contributor simulator with `createFeatureTestRuntime(feature, {
stateEventsEnabled: true })`. Its combined path shares the readable in-memory
state, emits versioned correlation, deduplicates sources, supports offline events
and limits retained combined source work. Direct `eventStreams.publish()` cannot
write a combined stream. The existing pure `stateEvents.preview()` stays pure.
This simulator is not crash/SQLite/lifecycle proof; the real integration tests are.

`test/health-state-event.spec.js` executes the installed feature with real Durable
Object SQLite and binding forwarding: shared/asymmetric/standalone behavior,
original results after later updates, offline append through native alarms,
eviction, lost acceptance replies, disabled-switch recovery, source conflicts,
capacity rollback, authorization and clamped no-op receipts.

`scripts/smoke-health-widget-browser.js`, included in `npm run test:browser`, uses
the actual health UI and shipped clients in Chromium. It verifies state recovery
after cleared/old storage, separate sessions and target checks, both arrival
orders, per-impact/clamped animations, duplicate suppression, v1-grant rejection
and explicit legacy backlog handling. Existing framework, event-only, state-only,
shared-lifecycle and browser suites remain compatibility gates.
