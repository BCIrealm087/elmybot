import { integrationRegistryStub } from "../integrations/registry-client.js";
import { canonicalJson, recoveryError } from "./identity.js";
import { initializeStateEventOutbox, maintainStateEventOutbox, stateEventOutboxExists } from "./outbox.js";
import { scheduleStorageAlarmInTransaction } from "../storage-alarm.js";

export const STATE_EVENT_DELIVERY_PATH = "/internal/state-events/delivery/";
export const STATE_EVENT_DELIVERY_HEADERS = Object.freeze({ "x-elmybot-state-event-delivery": "v1" });
const terminal = new Set(["appended", "gap_recorded", "reset_discarded"]);
const one = (state, sql, ...args) => state.storage.sql.exec(sql, ...args).toArray()[0];
export function deliveryOwnerStub(env, owner) {
  const binding = owner?.kind === "group_local" ? env.CONFIG : owner?.kind === "effective_shareable" ? env.SHAREABLE_STATE_REALM : null;
  if (!binding || typeof owner.key !== "string" || owner.key.length > 300) throw recoveryError("invalid_route", 422);
  return binding.get(binding.idFromName(owner.key));
}
export async function deliverySourceRequest(env, owner, operation, input) {
  let timer;
  try {
    return await Promise.race([(async () => {
      const response = await deliveryOwnerStub(env, owner).fetch(`https://state-owner${STATE_EVENT_DELIVERY_PATH}${operation}`, {
        method: "POST", headers: STATE_EVENT_DELIVERY_HEADERS, body: JSON.stringify({ ...input, owner })
      });
      const result = await response.json();
      if (!response.ok) throw recoveryError("outcome_unknown", 503);
      return result;
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(recoveryError("outcome_unknown", 503)), 5000); })]);
  } finally { clearTimeout(timer); }
}
export function sourceIntentProof(state, operationId, routeId) {
  if (!stateEventOutboxExists(state)) throw recoveryError("missing_intent", 409);
  initializeStateEventOutbox(state);
  const row = one(state, "SELECT * FROM state_event_outbox WHERE operation_id = ? AND stream_route_id = ?", operationId, routeId);
  const receipt = one(state, "SELECT metadata_json FROM state_event_records WHERE record_key = ?", `owner:${operationId}`);
  if (!row || !receipt) throw recoveryError("missing_intent", 409);
  const intent = JSON.parse(row.intent_json), saved = JSON.parse(receipt.metadata_json).receipt;
  if (!saved || saved.eventId !== intent.eventId || canonicalJson(saved.stateEvent) !== canonicalJson(intent.stateEvent) ||
      saved.expiresAtMs !== intent.expiresAtMs || saved.committedAtMs !== intent.committedAtMs) throw recoveryError("invalid_receipt", 503);
  const head = one(state, `SELECT operation_id FROM state_event_outbox WHERE stream_route_id = ?
    AND state NOT IN ('appended', 'gap_recorded', 'reset_discarded') ORDER BY operation_sequence LIMIT 1`, routeId);
  return { intent, state: row.state, head: head?.operation_id ?? null };
}
function streamStatus(state, routeId) {
  if (!stateEventOutboxExists(state)) return { pending: 0, gap: false, reset: false, checkpoint: 0 };
  initializeStateEventOutbox(state);
  const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", routeId);
  const pending = one(state, `SELECT COUNT(*) AS total, COALESCE(MAX(state = 'gap_pending'), 0) AS uncertain
    FROM state_event_outbox WHERE stream_route_id = ? AND state NOT IN ('appended', 'gap_recorded', 'reset_discarded')`, routeId);
  return { pending: Number(pending.total), gap: Boolean(stream?.blocked) || stream?.gap_first !== null && stream?.gap_first !== undefined,
    unresolvedGap: Boolean(pending.uncertain), reset: Boolean(stream?.reset_id),
    checkpoint: Number(stream?.checkpoint ?? 0), resetId: stream?.reset_id ?? null, phase: stream?.reset_phase ?? null };
}
async function confirmDestination(env, owner, operationId, routeId) {
  // Sent only after the source durably saves the verified destination outcome.
  // Until this succeeds the destination must retain its authoritative receipt.
  try {
    await env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(routeId)).fetch("https://stream/internal/events/combined/confirm", {
      method: "POST", headers: { ...STATE_EVENT_DELIVERY_HEADERS, "x-elmybot-durable-event-internal": "v1" }, body: JSON.stringify({ owner, operationId, routeId })
    });
  } catch { /* Retain destination authority; retry confirmation on reconciliation. */ }
}
export async function reconcileStateEventIntent(state, env, owner, operationId, routeId) {
  const proof = sourceIntentProof(state, operationId, routeId);
  if (terminal.has(proof.state)) {
    if (proof.intent.delivery) await confirmDestination(env, owner, operationId, routeId);
    return proof.intent.delivery ?? { state: proof.state };
  }
  const input = { owner, operationId, routeId };
  let response;
  if (owner.kind === "effective_shareable") {
    response = await integrationRegistryStub(env).fetch("https://registry/state-events/append", {
      method: "POST", headers: STATE_EVENT_DELIVERY_HEADERS, body: JSON.stringify(input)
    });
  } else {
    response = await env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(routeId)).fetch("https://stream/internal/events/combined/append", {
      method: "POST", headers: { ...STATE_EVENT_DELIVERY_HEADERS, "x-elmybot-durable-event-internal": "v1" }, body: JSON.stringify(input)
    });
  }
  const outcome = await response.json();
  if (!response.ok) {
    if (outcome.code === "durable_event_gap_requires_reset") state.storage.sql.exec("UPDATE state_event_source_streams SET blocked = 1 WHERE route_id = ?", routeId);
    throw Object.assign(recoveryError("outcome_unknown", response.status), { code: outcome.code });
  }
  if (!["appended", "gap"].includes(outcome.state) || outcome.operationId !== operationId) throw recoveryError("outcome_unknown", 503);
  await state.storage.transaction(async () => {
    const current = sourceIntentProof(state, operationId, routeId);
    if (terminal.has(current.state)) return;
    const intent = current.intent;
    if (outcome.state === "gap") {
      state.storage.sql.exec(`UPDATE state_event_source_streams SET gap_first = MIN(COALESCE(gap_first, ?), ?),
        gap_last = MAX(COALESCE(gap_last, 0), ?) WHERE route_id = ?`, intent.stateEvent.operationSequence,
      intent.stateEvent.operationSequence, intent.stateEvent.operationSequence, routeId);
    }
    const before = one(state, "SELECT intent_bytes FROM state_event_outbox WHERE operation_id = ?", operationId).intent_bytes;
    delete intent.payload;
    const json = canonicalJson({ ...intent, delivery: outcome });
    const bytes = new TextEncoder().encode(json).byteLength;
    state.storage.sql.exec(`UPDATE state_event_outbox SET state = ?, intent_json = ?, intent_bytes = ?, next_wakeup_at_ms = NULL WHERE operation_id = ?`,
      outcome.state === "gap" ? "gap_recorded" : "appended", json, bytes, operationId);
    state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = bytes + ?", bytes - before);
    await scheduleStorageAlarmInTransaction(state);
  });
  await confirmDestination(env, owner, operationId, routeId);
  return outcome;
}
export async function handleStateEventDeliverySource(state, env, request, path, kind) {
  if (!path.startsWith(STATE_EVENT_DELIVERY_PATH)) return null;
  if (request.method !== "POST" || request.headers.get("x-elmybot-state-event-delivery") !== "v1") throw recoveryError("authority_required", 403);
  const input = await request.json(), owner = input?.owner;
  const binding = kind === "group_local" ? env.CONFIG : env.SHAREABLE_STATE_REALM;
  if (owner?.kind !== kind || typeof owner?.key !== "string" || binding.idFromName(owner.key).toString() !== state.id.toString() ||
      !/^des1\.[\w-]{43}$/.test(input.routeId ?? "")) throw recoveryError("wrong_owner", 422);
  const operation = path.slice(STATE_EVENT_DELIVERY_PATH.length);
  if (operation === "proof") {
    const proof = sourceIntentProof(state, input.operationId, input.routeId);
    if (proof.intent.route.key !== owner.key || proof.intent.route.kind !== kind) throw recoveryError("wrong_owner", 422);
    return proof;
  }
  if (operation === "reconcile") return reconcileStateEventIntent(state, env, owner, input.operationId, input.routeId);
  if (operation === "status") {
    await maintainStateEventOutbox(state);
    return streamStatus(state, input.routeId);
  }
  if (!["reset-prepare", "reset-commit", "reset-release"].includes(operation) ||
      !/^[a-f0-9-]{36}$/.test(input.resetId ?? "")) throw recoveryError("invalid_request", 422);
  initializeStateEventOutbox(state);
  return state.storage.transaction(async () => {
    let stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", input.routeId);
    if (!stream) {
      if (Number(one(state, "SELECT COUNT(*) AS total FROM state_event_source_streams").total) >= 100) throw recoveryError("partition_capacity", 503);
      state.storage.sql.exec("INSERT INTO state_event_source_streams (route_id) VALUES (?)", input.routeId);
      stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", input.routeId);
    }
    if (stream.completed_reset === input.resetId) return { checkpoint: Number(stream.checkpoint), completed: true };
    if (stream.reset_id && stream.reset_id !== input.resetId) throw recoveryError("reset_pending", 409);
    if (operation === "reset-prepare") {
      if (!stream.reset_id) {
        const checkpoint = Number(one(state, "SELECT MAX(operation_sequence) AS value FROM state_event_outbox WHERE stream_route_id = ?", input.routeId)?.value ?? stream.checkpoint);
        state.storage.sql.exec("UPDATE state_event_source_streams SET reset_id = ?, reset_phase = 'prepared', checkpoint = ? WHERE route_id = ?", input.resetId, checkpoint, input.routeId);
      }
    } else {
      if (stream.reset_id !== input.resetId) throw recoveryError("reset_pending", 409);
      if (operation === "reset-commit") {
        const rows = state.storage.sql.exec("SELECT * FROM state_event_outbox WHERE stream_route_id = ? AND operation_sequence <= ?", input.routeId, stream.checkpoint).toArray();
        for (const row of rows) {
          const intent = JSON.parse(row.intent_json); delete intent.payload;
          const json = canonicalJson(intent), bytes = new TextEncoder().encode(json).byteLength;
          state.storage.sql.exec("UPDATE state_event_outbox SET state = 'reset_discarded', intent_json = ?, intent_bytes = ?, next_wakeup_at_ms = NULL WHERE operation_id = ?", json, bytes, row.operation_id);
          state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = bytes + ?", bytes - row.intent_bytes);
        }
        state.storage.sql.exec("UPDATE state_event_source_streams SET reset_phase = 'committed', gap_first = NULL, gap_last = NULL, blocked = 0 WHERE route_id = ?", input.routeId);
      } else {
        if (stream.reset_phase !== "committed") throw recoveryError("reset_pending", 409);
        state.storage.sql.exec("UPDATE state_event_source_streams SET reset_id = NULL, reset_phase = NULL, completed_reset = ? WHERE route_id = ?", input.resetId, input.routeId);
      }
    }
    await scheduleStorageAlarmInTransaction(state);
    return streamStatus(state, input.routeId);
  });
}
