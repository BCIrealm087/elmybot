# `@elmybot/feature-fun-deaths`

> **Existing-data migration example:** this package's
> `adoptLegacyIntegrationState: true` preserves previously deployed death
> counts. New features must omit it. Start with the `shareable-counter`
> scaffold or the [migration-free namespace example](../../../docs/feature-authoring.md#declare-and-resolve-a-shareable-state-namespace).
> Changes to this adoption path require a
> [maintainer migration handoff](../../../docs/feature-authoring.md#ask-for-framework-help-when);
> keep the existing marker when maintaining `deaths`.

Tracks one non-negative death count per game. An unlinked Discord server or
Twitch channel uses its own standalone ledger. When a directional default link
exists, the selected integration owns the ledger and both directions share
counts when they select that integration. Each platform group always keeps its
own remembered game.

Ordinary members can read a count. Broadcasters, moderators, Discord owners,
intrinsic Discord moderators, and configured trusted Discord roles can use the
`plus`, `minus`, and `reset` operations or supply a non-negative integer to set
the count exactly.

Using a named game updates the remembered game only for a moderator. An
ordinary member may check a named game once without changing what a later
argument-free command checks.

When groups link, empty, one-sided, or identical ledgers reconcile
automatically. Different nonempty ledgers are shown in the integration flow so
the Twitch broadcaster can choose Discord's counts, Twitch's counts, reset the
new shared ledger, or cancel. Revoking the last link gives both groups
independent successors starting from the final shared counts.

## Commands

- Discord: `/deaths [operation:check|plus|minus|reset|<count>] [game:<game>]`
- Twitch: `!deaths [check|plus|minus|reset|<count>] [<game>]`

The game argument requires an operation. Quote a multi-word Twitch game name,
for example `!deaths plus "Dark Souls"`. Omitting both arguments, or using
`check` without a game, checks the locally remembered game. `minus` stops at
zero. A count must contain decimal digits only and be no larger than
`Number.MAX_SAFE_INTEGER`. To check a game whose name is numeric, keep the
operation explicit, for example `!deaths check 1999`.
