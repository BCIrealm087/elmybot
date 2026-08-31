# `@elmybot/feature-fun-deaths`

Tracks a non-negative death count for each game in a Discord server or Twitch
channel. Counts are scoped to the platform group where the command is used, so
a Discord server and a Twitch channel keep independent registries.

Ordinary members can read a count. Broadcasters, moderators, Discord owners,
intrinsic Discord moderators, and configured trusted Discord roles can use the
`plus`, `minus`, and `reset` operations.

## Commands

- Discord: `/deaths game:<game> [operation:plus|minus|reset]`
- Twitch: `!deaths <game> [plus|minus|reset]`

Quote a multi-word Twitch game name, for example `!deaths "Dark Souls" plus`.
Omitting the operation displays the current count. `minus` stops at zero.
