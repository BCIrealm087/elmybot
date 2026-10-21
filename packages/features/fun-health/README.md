# `@elmybot/feature-fun-health`

Authoritative shared health (initially 100, bounded 0–100) and one durable impact
per accepted damage/heal command. `/health` and `!health` keep their moderator
permission, optional amount (default 10, range 1–100), and one-second group cooldown.

The action is `fun.health.impact.v2`; new commands atomically commit through
`stateEvents`. `fun.health:current:v1` exposes readable health, and
`fun.health:impacts:v2` reports requested/applied amounts and before/after values,
including accepted zero-applied impacts. Symmetric directional defaults share
health; otherwise the normal selected/standalone realm applies.

Fresh acceptance requires both event switches; checked-in Wrangler environments
now set `STATE_EVENT_OPERATIONS_ENABLED` and the event master to `"true"` after
successful operator live testing. Deployment and
rollout remain operator-controlled; [release guidance](../../../docs/state-event-release.md)
summarizes completed verification, measured costs and safe drain/rollback.

The v2 widget at `/health-widget/` needs separate current-health read and v2 event
grants for the same group. It ignores old browser-local numeric health. The
original v1 stream remains available for legacy backlog/grant compatibility at
`/health-widget/legacy.html`; it is never reinterpreted as committed bot state.
See [health migration](../../../docs/health-state-event-migration.md) for the
version transition, disabled-mode recovery and drain/retirement path.

Run `npm run feature:check -- fun-health`. Feature tests use
`createFeatureTestRuntime(feature, { stateEventsEnabled: true })`; real SQLite,
command integration and browser evidence live in the repository-wide suites.
