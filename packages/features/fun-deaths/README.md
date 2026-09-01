# `@elmybot/feature-fun-deaths`

Tracks one non-negative death count per game in the active integration selected
by a Discord server's or Twitch channel's directional default. Both directions
share counts when they select the same integration. Each platform group keeps
its own remembered game.

Ordinary members can read a count. Broadcasters, moderators, Discord owners,
intrinsic Discord moderators, and configured trusted Discord roles can use the
`plus`, `minus`, and `reset` operations or supply a non-negative integer to set
the count exactly.

Using a named game updates the remembered game only for a moderator. An
ordinary member may check a named game once without changing what a later
argument-free command checks. The command requires an active default link.

## Commands

- Discord: `/deaths [operation:check|plus|minus|reset|<count>] [game:<game>]`
- Twitch: `!deaths [check|plus|minus|reset|<count>] [<game>]`

The game argument requires an operation. Quote a multi-word Twitch game name,
for example `!deaths plus "Dark Souls"`. Omitting both arguments, or using
`check` without a game, checks the locally remembered game. `minus` stops at
zero. A count must contain decimal digits only and be no larger than
`Number.MAX_SAFE_INTEGER`. To check a game whose name is numeric, keep the
operation explicit, for example `!deaths check 1999`.
