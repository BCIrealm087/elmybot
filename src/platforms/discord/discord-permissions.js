/**
 * Internal permission groups used by the command router. These are not Discord
 * permission bitfields; they are the higher-level access groups the bot checks.
 */

import { withExternalRequestTimeout } from "../../common.js";
import { discordGroupConfigFetch } from "./group-config.js";

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

export const CAPABILITIES = Object.freeze({
  CONFIG_MANAGE: "config.manage",
  SCHEDULE_CREATE: "schedule.create",
  SCHEDULE_VIEW: "schedule.view",
  SCHEDULE_CANCEL: "schedule.cancel"
});

const CAPABILITY_POLICIES = Object.freeze({
  [CAPABILITIES.CONFIG_MANAGE]: Object.freeze([
    PERMS.OWNER,
    PERMS.MODERATORS
  ]),
  [CAPABILITIES.SCHEDULE_CREATE]: Object.freeze([
    PERMS.OWNER,
    PERMS.MODERATORS,
    PERMS.GUILD_ALLOWED_ROLES
  ]),
  [CAPABILITIES.SCHEDULE_VIEW]: Object.freeze([
    PERMS.OWNER,
    PERMS.MODERATORS,
    PERMS.GUILD_ALLOWED_ROLES
  ]),
  [CAPABILITIES.SCHEDULE_CANCEL]: Object.freeze([
    PERMS.OWNER,
    PERMS.MODERATORS,
    PERMS.GUILD_ALLOWED_ROLES
  ])
});

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
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, withExternalRequestTimeout({
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
  }));
  if (!res.ok) return null;
  const guild = await res.json();
  return guild.owner_id ?? null;
}

async function hasConfiguredRole(interaction, env) {
  const memberRoles = interaction.member?.roles ?? [];
  if (memberRoles.length === 0) return false;
  // Guild-specific allowlisted roles live in the GroupConfig Durable Object.
  const r = await discordGroupConfigFetch(env, interaction.guild_id, "https://config/get", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": `discord:${interaction.id ?? "unknown"}`
    },
    body: JSON.stringify({
      key: "allowedRoles"
    })
  });

  if (!r.ok) {
    await r.text();
    const error = new Error("Group configuration service returned an unexpected response.");
    error.status = r.status;
    throw error;
  }
  const data = await r.json();
  if (!Array.isArray(data.value) || data.value.length === 0) return false;

  const allowedRoles = new Set(data.value);
  return memberRoles.some(role => allowedRoles.has(role));
}

export async function checkPermissions(interaction, env, commandInfo) {
  const allowedGroups = CAPABILITY_POLICIES[commandInfo.capability];
  if (!Array.isArray(allowedGroups) || allowedGroups.length === 0) {
    return { allowedGroups: [], configured: false, ok: false };
  }
  if (allowedGroups.some(perm => perm === PERMS.ANY || perm === PERMS.MEMBERS)) {
    return { allowedGroups, configured: true, ok: true };
  }
  if (!interaction.guild_id || !interaction.member) {
    return { allowedGroups, configured: true, ok: false };
  }

  if (
    allowedGroups.includes(PERMS.MODERATORS) &&
    hasAnyIntrinsicPerm(interaction.member.permissions, MODERATOR_ANY_OF)
  ) {
    return { allowedGroups, configured: true, ok: true };
  }

  if (
    allowedGroups.includes(PERMS.GUILD_ALLOWED_ROLES) &&
    await hasConfiguredRole(interaction, env)
  ) {
    return { allowedGroups, configured: true, ok: true };
  }

  if (allowedGroups.includes(PERMS.OWNER)) {
    const ownerId = await fetchGuildOwnerId(env, interaction.guild_id);
    const userId = interaction.member?.user?.id ?? interaction.user?.id ?? null;
    if (ownerId && userId && ownerId === userId) {
      return { allowedGroups, configured: true, ok: true };
    }
  }

  return { allowedGroups, configured: true, ok: false };
}
