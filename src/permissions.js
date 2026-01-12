/**
 * Permission bit flags (BigInt) from Discord's permissions model.
 * Only the subset used by this bot is listed here.
 */
const PERMS = {
  KICK_MEMBERS: 0x0000000000000002n, // (1 << 1)
  BAN_MEMBERS: 0x0000000000000004n, // (1 << 2)
  ADMINISTRATOR: 0x0000000000000008n, // (1 << 3)
  MANAGE_GUILD: 0x0000000000000020n, // (1 << 5)
  MANAGE_MESSAGES: 0x0000000000002000n, // (1 << 13)
  MANAGE_ROLES: 0x0000000010000000n, // (1 << 28)
  MODERATE_MEMBERS: 0x0000010000000000n, // (1 << 40)
};

/**
 * Define what "moderator" means for *your* server.
 * Tweak this list if you want stricter/looser behavior.
 */
const MODERATOR_ANY_OF = [
  PERMS.ADMINISTRATOR,
  PERMS.MANAGE_GUILD,
  PERMS.MANAGE_MESSAGES,
  PERMS.MODERATE_MEMBERS,
  PERMS.KICK_MEMBERS,
  PERMS.BAN_MEMBERS,
  PERMS.MANAGE_ROLES,
];

/**
 * Returns true if the permissions string contains any of the provided flags.
 * Discord serializes permissions as a stringified integer.
 */
function hasAnyPerm(permsStr, flags) {
  if (!permsStr) return false;
  const p = BigInt(permsStr); // permissions are serialized as strings
  return flags.some((f) => (p & f) === f);
}

/**
 * Fetches the guild owner id so we can allow the server owner.
 * Falls back to null when the Discord API call fails.
 */
async function fetchGuildOwnerId(env, guildId) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!res.ok) return null;
  const guild = await res.json();
  return guild.owner_id ?? null;
}

/**
 * Checks whether the invoking user is a moderator (by permission) or the guild owner.
 */
export async function isModeratorOrOwner(interaction, env) {
  if (!interaction.guild_id || !interaction.member) return false;

  // 1) If they have a “moderator-like” permission in THIS channel, allow.
  const permsStr = interaction.member.permissions;
  if (hasAnyPerm(permsStr, MODERATOR_ANY_OF)) return true;

  // 2) Otherwise, fallback to explicit server-owner check.
  // (This avoids extra API calls for mods/admins.)
  const ownerId = await fetchGuildOwnerId(env, interaction.guild_id);
  const userId =
    interaction.member?.user?.id ??
    interaction.user?.id ?? // sometimes present
    null;

  return !!ownerId && !!userId && ownerId === userId;
}
