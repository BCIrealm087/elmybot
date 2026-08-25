import { jsonResponse, logError } from "./common.js";

class GroupConfigUserFacingError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const CONFIG_KEYS_KEY = "__configKeys";

const isNotAnArrayMessage = "The provided key does not index a list (array).";

// Lightweight per-group configuration storage backed by a Durable Object.
// Today it stores the `allowedRoles` list used by permission checks.

async function getConfig(state, key) {
  return await state.storage.get(key);
}

async function updateConfigKeyIndex(txn, key, shouldExist) {
  if (!key || key === CONFIG_KEYS_KEY) {
    throw new GroupConfigUserFacingError(
      "A valid configuration key is required.",
      422
    );
  }

  const storedKeys = (await txn.get(CONFIG_KEYS_KEY)) ?? [];

  if (!Array.isArray(storedKeys)) {
    throw new Error("The configuration key index is corrupted.");
  }

  const keySet = new Set(storedKeys);

  if (shouldExist) {
    keySet.add(key);
  } else {
    keySet.delete(key);
  }

  await txn.put(CONFIG_KEYS_KEY, [...keySet].sort());
}

async function setConfig(state, key, payload) {
  return await state.storage.transaction(async (txn) => {
    if (payload === null || payload === undefined) {
      await txn.delete(key);
      await updateConfigKeyIndex(txn, key, false);
    } else {
      await txn.put(key, payload);
      await updateConfigKeyIndex(txn, key, true);
    }

    return payload;
  });
}

async function addRowToConfig(state, key, payload) {
  if (payload === null || payload === undefined) {
    throw new GroupConfigUserFacingError(
      "Null or undefined values cannot be added to a configuration.",
      422
    );
  }

  return await state.storage.transaction(async (txn) => {
    const stored = (await txn.get(key)) ?? [];

    if (!Array.isArray(stored)) {
      throw new GroupConfigUserFacingError(isNotAnArrayMessage, 422);
    }

    if (!stored.includes(payload)) {
      stored.push(payload);
      stored.sort();
      await txn.put(key, stored);
    }

    // Bonus side efect: Also repairs the index if this key existed before indexing was added.
    await updateConfigKeyIndex(txn, key, true);

    return stored;
  });
}

async function removeRowFromConfig(state, key, payload) {
  return await state.storage.transaction(async (txn) => {
    const stored = (await txn.get(key)) ?? null;
    if (!Array.isArray(stored)) throw new GroupConfigUserFacingError(isNotAnArrayMessage, 422);

    const idx = stored.indexOf(payload);
    
    if (idx === -1) throw new GroupConfigUserFacingError("The selected configuration does not contain the provided value.", 422);

    stored.splice(idx, 1);
    await txn.put(key, stored);

    return stored;
  });
}

export async function hasEntries(state, key, entries) {
  const stored = await getConfig(state, key);
  if (!Array.isArray(stored)) throw new GroupConfigUserFacingError(isNotAnArrayMessage, 422);
  if (entries.length === 0) return true;
  if (stored.length === 0) return false;
  const valueSet = new Set(stored);

  return entries.every((e) => valueSet.has(e));
}

const requestHandlers = {
  "GET": {
    base: async (state, _, pathHandler) => pathHandler(state),
    "/list": async (state) => {
      const keys = (await getConfig(state, CONFIG_KEYS_KEY)) ?? [];
      return jsonResponse({ totalEntries: keys.length, keys });
    }
  },
  "POST": {
    base: async (state, request, pathHandler) => pathHandler(state, await request.json()),
    "/get": async (state, body) => {
      const key = body?.key;
      const config = await getConfig(state, key);
      return jsonResponse({ value: config ?? null });
    },
    "/set": async (state, body) => {
      const stored = await setConfig(state, body?.key, body?.value);
      return jsonResponse({
        operationPerformed: (stored === null || stored === undefined) ? "remove" : "set"
      });
    },
    "/append-to": async (state, body) => {
      await addRowToConfig(state, body?.key, body?.value);
      return jsonResponse({ ok: true });
    },
    "/remove-from": async (state, body) => {
      const key = body?.key;
      const value = body?.value;
      await removeRowFromConfig(state, key, value);

      return jsonResponse({ ok: true });
    },
    "/check": async (state, body) => {
      const key = body?.key;
      const entries = body?.entries;
      let ok;
      if (entries) {
        ok = await hasEntries(state, key, entries);
      } else {
        const config = await getConfig(state, key);
        ok = (config !== null && config !== undefined);
      }

      return jsonResponse({ ok });
    }
  }
}

export class GroupConfig {
  /**
   * Durable Object per group responsible for storing and retrieving group
   * configuration such as role-based command allowlists.
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
      return await pathHandlers.base(this.state, request, pathHandler);
    } catch (e) {
      if (e instanceof GroupConfigUserFacingError) {
        return jsonResponse({ userFacingError: e.message }, e.status);
      }

      const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
      logError("group_config.request_failed", {
        platform: "shared",
        correlationId,
        method: request.method,
        route: url.pathname
      }, e);
      return jsonResponse({ error: "Unknown error.", correlationId }, 500);
    }
  }
}
