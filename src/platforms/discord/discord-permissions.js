/**
 * Internal permission groups used by the command router. These are not Discord
 * permission bitfields; they are the higher-level access groups the bot checks.
 */

export const PERMS = {
  MEMBERS: 3,
  GUILD_ALLOWED_ROLES: 2,
  MODERATORS: 1,
  OWNER: 0, 
  ANY: -1
}

export const PERM_STRINGS = {
  [PERMS.MEMBERS]: "member", 
  [PERMS.GUILD_ALLOWED_ROLES]: "allowed server role", 
  [PERMS.MODERATORS]: "moderator", 
  [PERMS.OWNER]: "server owner"
}

export const WATCHED_COMMAND_PREFIX = "config_";
export const WATCHED_COMMAND_PERMS_OVERLOAD = [PERMS.OWNER, PERMS.MODERATORS];

const DISCORD_PERMS = {
  KICK_MEMBERS: 0x0000000000000002n, // (1 << 1)
  BAN_MEMBERS: 0x0000000000000004n, // (1 << 2)
  ADMINISTRATOR: 0x0000000000000008n, // (1 << 3)
  MANAGE_GUILD: 0x0000000000000020n, // (1 << 5)
  MANAGE_MESSAGES: 0x0000000000002000n, // (1 << 13)
  MANAGE_ROLES: 0x0000000010000000n, // (1 << 28)
  MODERATE_MEMBERS: 0x0000010000000000n, // (1 << 40)
};

/**
 * Defines what "moderator" means.
 */
const MODERATOR_ANY_OF = [
  DISCORD_PERMS.ADMINISTRATOR,
  DISCORD_PERMS.MANAGE_GUILD,
  DISCORD_PERMS.MANAGE_MESSAGES,
  DISCORD_PERMS.MODERATE_MEMBERS,
  DISCORD_PERMS.KICK_MEMBERS,
  DISCORD_PERMS.BAN_MEMBERS,
  DISCORD_PERMS.MANAGE_ROLES,
];

/**
 * Returns true if the permissions string contains any of the provided flags.
 * Discord serializes permissions as a stringified integer.
 */
function hasAnyIntrinsicPerm(permsStr, flags) {
  if (!permsStr) return false;
  const p = BigInt(permsStr); // permissions are serialized as strings
  return flags.some((f) => (p & f) === f);
}

/**
 * Fetch the guild owner id so owner-only/protected commands can be authorized.
 * Falls back to `null` when the Discord API call fails.
 */
async function fetchGuildOwnerId(env, guildId) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
  });
  if (!res.ok) return null;
  const guild = await res.json();
  return guild.owner_id ?? null;
}

export async function getPerms(interaction, env) {
  if (!interaction.guild_id || !interaction.member) return [];
  const perms = [PERMS.MEMBERS];
  const permsStr = interaction.member.permissions;
  if (hasAnyIntrinsicPerm(permsStr, MODERATOR_ANY_OF))
    perms.push(PERMS.MODERATORS);

  const ownerId = await fetchGuildOwnerId(env, interaction.guild_id);
  const userId =
    interaction.member?.user?.id ??
    interaction.user?.id ?? // sometimes present
    null;
  if (!!ownerId && !!userId && ownerId === userId)
    perms.push(PERMS.OWNER);

  const memberRoles = interaction.member?.roles;

  if (!memberRoles) return perms;

  const id = env.CONFIG.idFromName(interaction.guild_id);
  const stub = env.CONFIG.get(id);

  // Guild-specific allowlisted roles live in the GroupConfig Durable Object.
  const r = await stub.fetch("https://config/get", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: "allowedRoles"
    })
  });

  if (!r.ok) throw new Error(`Unknown Guild Configuration Service response error: status: ${r.status}\ncontent:${await r.text()}`);
  const data = await r.json();
  if (Array.isArray(data.value) && data.value.length > 0) {
    const allowedRoles = new Set(data.value);
    const memberRoles = interaction.member?.roles ?? [];
    if (memberRoles.some(role => allowedRoles.has(role)))
      perms.push(PERMS.GUILD_ALLOWED_ROLES);
  }

  return perms;
}

export async function checkPermissions(interaction, env, commandInfo) {
  const allowedGroups = commandInfo.name.toLowerCase().startsWith(WATCHED_COMMAND_PREFIX)
    ? WATCHED_COMMAND_PERMS_OVERLOAD
    : commandInfo.allowedGroups;
  if (allowedGroups.some(perm => perm===PERMS.ANY || perm===PERMS.MEMBERS)) return { allowedGroups, ok: true };
  const perms = new Set(await getPerms(interaction, env));
  const ok = allowedGroups.some(perm => perms.has(perm));
  return { allowedGroups, ok };
}
