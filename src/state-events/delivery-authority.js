import { createPlatformGroupRef } from "../integrations/contracts.js";
import { deliverySourceRequest } from "./delivery-source.js";
import { canonicalJson, recoveryError } from "./identity.js";
import { boundedStateEventCall, initializeStateEventBarriers, removeStateEventBarrier, resolveStateEventBarrier, STATE_EVENT_BARRIER_LIMITS } from "./binding-authority.js";

export async function callCombinedStream(env, input, operation) {
  const response = await env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(input.routeId)).fetch(`https://stream/internal/events/combined/${operation}`, {
    method: "POST", headers: { "x-elmybot-durable-event-internal": "v1", "x-elmybot-state-event-delivery": "v1" },
    body: JSON.stringify({ ...input, authority: "registry-v1" })
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(recoveryError("outcome_unknown", response.status), { code: result.code, retryAfterMs: result.retryAfterMs });
  return result;
}
export async function resolveCombinedAppendBarrier(registry, input, deadline) {
  const outcome = await boundedStateEventCall(() => callCombinedStream(registry.env, input, "fence"), deadline);
  if (!["appended", "gap", "fenced"].includes(outcome.state) || outcome.operationId !== input.operationId) throw recoveryError("outcome_unknown", 503);
  return outcome;
}
export async function appendWithStateEventBindingAuthority(registry, raw) {
  const input = JSON.parse(canonicalJson(raw, 8192));
  if (input.owner?.kind !== "effective_shareable") throw recoveryError("invalid_route", 422);
  const proof = await deliverySourceRequest(registry.env, input.owner, "proof", input);
  const intent = proof.intent;
  if (intent.route.key !== input.owner.key || intent.operationId !== input.operationId || intent.route.streamRouteId !== input.routeId) throw recoveryError("wrong_owner", 422);
  const [platform, kind, id] = intent.originGroupKey.split(":");
  const source = createPlatformGroupRef({ platform, kind, id });
  initializeStateEventBarriers(registry.state);
  const old = registry.state.storage.sql.exec("SELECT * FROM state_event_commit_barriers WHERE operation_id = ?", input.operationId).toArray()[0];
  if (old) {
    const prior = await resolveStateEventBarrier(registry, old);
    if (["appended", "gap"].includes(prior.state)) return prior;
  }
  const current = registry.stateQueryBinding(source, intent.route.targetPlatform);
  if (current.status !== "ready" || current.revision !== intent.route.bindingRevision || current.sourceKey !== input.owner.key) {
    return boundedStateEventCall(() => callCombinedStream(registry.env, input, "gap"));
  }
  const call = { ...input, kind: "append", callId: crypto.randomUUID(), binding: {
    sourceGroupKey: source.key, targetPlatform: intent.route.targetPlatform, revision: intent.route.bindingRevision, sourceKey: input.owner.key } };
  const json = canonicalJson(call, 8192), bytes = new TextEncoder().encode(json).byteLength;
  registry.state.storage.transactionSync(() => {
    const budget = registry.state.storage.sql.exec("SELECT * FROM state_event_barrier_budget").one();
    if (budget.rows >= STATE_EVENT_BARRIER_LIMITS.rows || budget.bytes + bytes > STATE_EVENT_BARRIER_LIMITS.bytes) throw recoveryError("authority_capacity", 503);
    registry.state.storage.sql.exec("INSERT INTO state_event_commit_barriers VALUES (?, ?, ?, ?, ?)", input.operationId, source.key, input.owner.key, json, bytes);
    registry.state.storage.sql.exec("UPDATE state_event_barrier_budget SET rows = rows + 1, bytes = bytes + ?", bytes);
  });
  await registry.state.storage.sync();
  let result;
  try { result = await boundedStateEventCall(() => callCombinedStream(registry.env, call, "append")); }
  catch (error) {
    if (error.status >= 400 && error.status < 500) await resolveStateEventBarrier(registry, { operation_id: input.operationId, attempt_json: json });
    throw error;
  }
  removeStateEventBarrier(registry.state, { operation_id: input.operationId });
  return result;
}
