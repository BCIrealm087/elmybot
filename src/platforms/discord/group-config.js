const LEGACY_GROUP_ID_HEADER = "x-group-config-legacy-id";

function validatedGuildId(guildId) {
  if (typeof guildId !== "string" || guildId.length === 0 || guildId.length > 128) {
    throw new Error("A valid Discord guild ID is required.");
  }
  return guildId;
}

export function discordGroupConfigObjectName(guildId) {
  return `discord:guild:${validatedGuildId(guildId)}`;
}

export function discordGroupConfigStub(env, guildId) {
  const id = env.CONFIG.idFromName(discordGroupConfigObjectName(guildId));
  return env.CONFIG.get(id);
}

export function discordGroupConfigFetch(env, guildId, input, init = {}) {
  const validated = validatedGuildId(guildId);
  const headers = new Headers(init.headers);
  headers.set(LEGACY_GROUP_ID_HEADER, validated);
  return discordGroupConfigStub(env, validated).fetch(input, {
    ...init,
    headers
  });
}
