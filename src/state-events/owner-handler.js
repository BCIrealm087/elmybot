import { recoveryError } from "./identity.js";
import { confirmStateEventOwner, fenceStateEventOwner, lookupStateEventOwner } from "./storage.js";

// Binding-only endpoint. No Worker route exposes this, and no remote caller can
// manufacture a committed receipt. Actual commits need the state/outbox adapter.
export async function handleLocalStateEventOwnerRequest(state, env, request, path) {
  const prefix = "/internal/state-events/owner/";
  if (!path.startsWith(prefix)) return null;
  if (request.method !== "POST") throw recoveryError("invalid_request", 405);
  const operation = path.slice(prefix.length);
  if (!["lookup", "fence", "confirm"].includes(operation)) throw recoveryError("invalid_request", 404);
  let input;
  try { input = await request.json(); } catch { throw recoveryError("invalid_request", 422); }
  const key = input?.attempt?.route?.key;
  if (input?.attempt?.route?.kind !== "group_local" || typeof key !== "string" || !env?.CONFIG ||
      env.CONFIG.idFromName(key).toString() !== state.id.toString()) throw recoveryError("wrong_owner", 422);
  if (operation === "confirm") return confirmStateEventOwner(state, input.attempt, key);
  return operation === "lookup"
    ? lookupStateEventOwner(state, input.attempt, key)
    : fenceStateEventOwner(state, input.attempt, key);
}
