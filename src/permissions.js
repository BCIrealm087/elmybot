// Permission bit flags (BigInt)
const PERMS = {
  KICK_MEMBERS:       0x0000000000000002n, // (1 << 1) :contentReference[oaicite:1]{index=1}
  BAN_MEMBERS:        0x0000000000000004n, // (1 << 2) :contentReference[oaicite:2]{index=2}
  ADMINISTRATOR:      0x0000000000000008n, // (1 << 3) :contentReference[oaicite:3]{index=3}
  MANAGE_GUILD:       0x0000000000000020n, // (1 << 5) :contentReference[oaicite:4]{index=4}
  MANAGE_MESSAGES:    0x0000000000002000n, // (1 << 13) :contentReference[oaicite:5]{index=5}
  MANAGE_ROLES:       0x0000000010000000n, // (1 << 28) :contentReference[oaicite:6]{index=6}
  MODERATE_MEMBERS:   0x0000010000000000n, // (1 << 40) :contentReference[oaicite:7]{index=7}
};

// Define what "moderator" means for *your* server.
// Tweak this list if you want stricter/looser behavior.
const MODERATOR_ANY_OF = [
  PERMS.ADMINISTRATOR,
  PERMS.MANAGE_GUILD,
  PERMS.MANAGE_MESSAGES,
  PERMS.MODERATE_MEMBERS,
  PERMS.KICK_MEMBERS,
  PERMS.BAN_MEMBERS,
  PERMS.MANAGE_ROLES,
];

function hasAnyPerm(permsStr, flags) {
  if (!permsStr) return false;
  const p = BigInt(permsStr); // permissions are serialized as strings :contentReference[oaicite:8]{index=8}
  return flags.some((f) => (p & f) === f);
}

async function fetchGuildOwnerId(env, guildId) {
  // Guild object includes owner_id :contentReference[oaicite:9]{index=9}
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!res.ok) return null;
  const guild = await res.json();
  return guild.owner_id ?? null;
}

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