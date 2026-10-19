import { createPlatformGroupRef } from "../integrations/contracts.js";
import { deliverySourceRequest } from "./delivery-source.js";
import { canonicalJson, recoveryError } from "./identity.js";
import { initializeStateEventBarriers, removeStateEventBarrier, resolveStateEventBarrier, STATE_EVENT_BARRIER_LIMITS } from "./binding-authority.js";
import { boundedStateEventRequest } from "./relay-client.js";
import { readSourceSnapshot, sourceSnapshotHeaders, STATE_EVENT_DELIVERY_REQUEST_BYTES } from "./delivery-snapshot.js";

export function callCombinedStream(env, input, operation, deadline, sourceSnapshot) {
  return boundedStateEventRequest(() => env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(input.routeId)).fetch(`https://stream/internal/events/combined/${operation}`, {
    method: "POST", headers: { "x-elmybot-durable-event-internal": "v1", "x-elmybot-state-event-delivery": "v1", ...sourceSnapshotHeaders(sourceSnapshot) },
    body: JSON.stringify({ ...input, ...(sourceSnapshot ? { sourceSnapshot } : {}), authority: "registry-v1" })
  }), deadline);
}
export async function resolveCombinedAppendBarrier(registry, input, deadline, sourceSnapshot) {
  const outcome = await callCombinedStream(registry.env, input, "fence", deadline, sourceSnapshot);
  if (!["appended", "gap", "fenced"].includes(outcome.state) || outcome.operationId !== input.operationId) throw recoveryError("outcome_unknown", 503);
  return outcome;
}
export async function appendWithStateEventBindingAuthority(registry, raw, { trustedSnapshot = false } = {}) {
  const received = JSON.parse(canonicalJson(raw, STATE_EVENT_DELIVERY_REQUEST_BYTES));
  const { sourceSnapshot } = received;
  const input = { owner: received.owner, operationId: received.operationId, routeId: received.routeId };
  if (input.owner?.kind !== "effective_shareable") throw recoveryError("invalid_route", 422);
  const proof = readSourceSnapshot(received, trustedSnapshot) ?? await deliverySourceRequest(registry.env, input.owner, "proof", input);
  const intent = proof.intent;
  if (intent.route.key !== input.owner.key || intent.operationId !== input.operationId || intent.route.streamRouteId !== input.routeId) throw recoveryError("wrong_owner", 422);
  const [platform, kind, id] = intent.originGroupKey.split(":");
  const source = createPlatformGroupRef({ platform, kind, id });
  initializeStateEventBarriers(registry.state);
  const old = registry.state.storage.sql.exec("SELECT * FROM state_event_commit_barriers WHERE operation_id = ?", input.operationId).toArray()[0];
  if (old) {
    const prior = await resolveStateEventBarrier(registry, old, undefined, sourceSnapshot);
    if (["appended", "gap"].includes(prior.state)) return prior;
  }
  const current = registry.stateQueryBinding(source, intent.route.targetPlatform);
  if (current.status !== "ready" || current.revision !== intent.route.bindingRevision || current.sourceKey !== input.owner.key) {
    return callCombinedStream(registry.env, input, "gap", undefined, sourceSnapshot);
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
  try { result = await callCombinedStream(registry.env, call, "append", undefined, sourceSnapshot); }
  catch (error) {
    if (error.status >= 400 && error.status < 500) await resolveStateEventBarrier(registry, { operation_id: input.operationId, attempt_json: json }, undefined, sourceSnapshot);
    throw error;
  }
  removeStateEventBarrier(registry.state, { operation_id: input.operationId });
  return result;
}
