import { jsonResponse } from "./common";

class GuildConfigUserFacingError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const isNotAnArrayMessage = "The provided key does not index a list (array).";

async function getConfig(state, key) {
  const stored = await state.storage.get(key);
  if (stored === null || stored === undefined) throw new GuildConfigUserFacingError("There's no configuration indexed under the provided key.", 422);
  return stored;
}

async function setConfig(state, key, payload) {
  if (payload === null || payload === undefined)
    await state.storage.delete(key);
  else
    await state.storage.put(key, payload);
  return payload;
}

async function addRowToConfig(state, key, payload) {
  if (payload === null || payload === undefined) throw new GuildConfigUserFacingError("Null or undefined values cannot be added to a configuration.", 422)
  return await state.storage.transaction(async (txn) => {
    // create new list under provided key if it's free
    const stored = (await txn.get(key)) ?? [];
    if (!Array.isArray(stored)) throw new GuildConfigUserFacingError(isNotAnArrayMessage, 422);

    if (!stored.includes(payload)) {
      stored.push(payload);
      stored.sort();
      await txn.put("key", stored);
    }

    return stored;
  });
}

async function removeRowFromConfig(state, key, payload) {
  return await state.storage.transaction(async (txn) => {
    const stored = (await txn.get(key)) ?? null;
    if (!Array.isArray(stored)) throw new GuildConfigUserFacingError(isNotAnArrayMessage, 422);

    const idx = stored.indexOf(payload);
    
    if (idx === -1) throw new GuildConfigUserFacingError("The selected configuration does not contain the provided value.", 422);

    stored.splice(idx, 1);
    await txn.put(key, stored);

    return stored;
  });
}

export async function hasEntries(state, key, entries) {
  const stored = await getConfig(state, key);
  if (!Array.isArray(stored)) throw new GuildConfigUserFacingError(isNotAnArrayMessage, 422);
  if (entries.length === 0) return true;
  if (stored.length === 0) return false;
  valueSet = new Set(stored);

  return entries.all((e) => valueSet.has(e));
}

const requestHandlers = {
  "POST": {
    base: async (request, pathHandler) => pathHandler(await request.json()),
    "/list": async (body) => {
      const key = body?.key;
      const config = await getConfig(state, key);

      if (!(Array.isArray(config))) throw new GuildConfigUserFacingError(isNotAnArrayMessage);
      if (config.length === 0) return jsonResponse({ values: [] });

      return jsonResponse({ values: config });
    },
    "/set": async (body) => {
      const key = body?.key;
      const value = body?.value;
      if (value === null) return remove();
      const stored = await setConfig(state, key, body?.value);
      return jsonResponse({ operationPerformed: (stored) ? "set" : "remove" });
    },
    "/append-to": async (body) => {
      const value = body?.value;
      await addRowToConfig(state, key, value);
      return jsonResponse({ ok });
    },
    "/remove-from": async (body) => {
      const key = body?.key;
      const value = body?.value;
      await removeRowFromConfig(state, key, value);

      return jsonResponse({ ok: true });
    },
    "/check": async (body) => {
      const key = body?.key;
      const entries = body?.entries;
      const ok = entries
        ? await hasEntries(state, key, entries)
        : await getConfig(state, key)

      return jsonResponse({ ok });
    }
  }
}

export class GuildConfig {
  /**
   * Durable Object per guild responsible for storing and retrieving per guild configuration.
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    const pathHandlers = requestHandlers[request.method];
    const pathHandler = pathHandlers && pathHandlers[url.pathname];
    if (!pathHandler) return new Response("Not Found", { status: 404 });
    try {
      return pathHandlers.base(request, pathHandler);
    } catch (e) {
      return (e instanceof GuildConfigUserFacingError)
        ? jsonResponse({ userFacingError: e.message }, e.status)
        : jsonResponse({ error: "Unknown error." }, 500);
    }
  }
}