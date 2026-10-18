import { runStateEventRelay, wakeStateEventRelay, observeStateEventRelayMode } from "./relay.js";
import { relayStreamRequest, boundedStateEventRequest } from "./relay-client.js";
import { createStateEventRecovery } from "./recovery.js";
import { createStateEventOwnerClient } from "./owner-client.js";
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
    AND state NOT IN ('appended', 'gap_recorded', 'reset_discarded', 'retiring') ORDER BY operation_sequence LIMIT 1`, routeId);
  const stream = one(state, "SELECT interest_epoch FROM state_event_source_streams WHERE route_id = ?", routeId);
  return { intent, state: row.state, head: head?.operation_id ?? null, interestEpoch: Number(stream?.interest_epoch ?? 1) };
}
function streamStatus(state, routeId) {
  if (!stateEventOutboxExists(state)) return { pending: 0, gap: false, reset: false, checkpoint: 0 };
  initializeStateEventOutbox(state);
  const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", routeId);
  const pending = one(state, `SELECT COUNT(*) AS total, COALESCE(MAX(state = 'gap_pending' OR deadline_ms <= ?), 0) AS uncertain
    FROM state_event_outbox WHERE stream_route_id = ? AND state NOT IN ('appended', 'gap_recorded', 'reset_discarded', 'retiring')`, Date.now(), routeId);
  return { pending: Number(pending.total), gap: Boolean(stream?.blocked) || stream?.gap_first !== null && stream?.gap_first !== undefined,
    unresolvedGap: Boolean(pending.uncertain), reset: Boolean(stream?.reset_id),
    checkpoint: Number(stream?.checkpoint ?? 0), resetId: stream?.reset_id ?? null, phase: stream?.reset_phase ?? null };
}
async function confirmDestination(state, env, owner, operationId, routeId, options) {
  const row = one(state, "SELECT destination_confirmed FROM state_event_outbox WHERE operation_id = ?", operationId);
  if (row?.destination_confirmed) return;
  const outcome = await relayStreamRequest(env, routeId, "confirm", { owner, operationId }, options.deadline);
  if (outcome.confirmed !== true) throw recoveryError("outcome_unknown", 503);
  state.storage.sql.exec("UPDATE state_event_outbox SET destination_confirmed = 1 WHERE operation_id = ?", operationId);
}
export async function reconcileStateEventIntent(state, env, owner, operationId, routeId, options = {}) {
  const proof = sourceIntentProof(state, operationId, routeId);
  if (proof.state === "reset_discarded") return { state: proof.state, terminal: "reset" };
  if (terminal.has(proof.state)) {
    await confirmDestination(state, env, owner, operationId, routeId, options);
    if (proof.state === "appended") {
      return relayStreamRequest(env, routeId, "outcome", { owner, operationId }, options.deadline);
    }
    return { ...proof.intent.delivery, terminal: proof.intent.delivery.reason };
  }
  const input = { owner, operationId, routeId };
  let outcome;
  try {
    outcome = owner.kind === "effective_shareable"
      ? await boundedStateEventRequest(() => integrationRegistryStub(env).fetch("https://registry/state-events/append", {
        method: "POST", headers: STATE_EVENT_DELIVERY_HEADERS, body: JSON.stringify(input)
      }), options.deadline)
      : await relayStreamRequest(env, routeId, "append", input, options.deadline);
  } catch (error) {
    if (error.code === "durable_event_gap_requires_reset") state.storage.sql.exec("UPDATE state_event_source_streams SET blocked = 1 WHERE route_id = ?", routeId);
    throw error;
  }
  if (!["appended", "gap"].includes(outcome.state) || outcome.operationId !== operationId) throw recoveryError("outcome_unknown", 503);
  outcome = { ...outcome, terminal: outcome.state === "gap" ? outcome.reason : null };
  await state.storage.transaction(async () => {
    const active = one(state, "SELECT * FROM state_event_outbox WHERE operation_id = ?", operationId);
    if (!active || options.leaseToken && active.lease_token !== options.leaseToken) throw recoveryError("attempt_in_progress", 409);
    const current = sourceIntentProof(state, operationId, routeId);
    if (terminal.has(current.state)) return;
    const intent = current.intent;
    if (outcome.state === "gap") {
      state.storage.sql.exec(`UPDATE state_event_source_streams SET gap_first = MIN(COALESCE(gap_first, ?), ?),
        gap_last = MAX(COALESCE(gap_last, 0), ?) WHERE route_id = ?`, intent.stateEvent.operationSequence,
      intent.stateEvent.operationSequence, intent.stateEvent.operationSequence, routeId);
    }
    delete intent.payload;
    const json = canonicalJson({ ...intent, delivery: outcome }), bytes = new TextEncoder().encode(json).byteLength;
    const budget = one(state, "SELECT bytes FROM state_event_outbox_budget");
    if (budget.bytes + bytes - active.intent_bytes > 512 * 1024) throw recoveryError("outbox_capacity", 503);
    state.storage.sql.exec(`UPDATE state_event_outbox SET state = ?, intent_json = ?, intent_bytes = ?, next_wakeup_at_ms = ? WHERE operation_id = ?`,
      outcome.state === "gap" ? "gap_recorded" : "appended", json, bytes,
      options.leaseToken ? active.lease_until_ms : outcome.state === "gap" ? Date.now() : intent.expiresAtMs, operationId);
    state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = bytes + ?", bytes - active.intent_bytes);
    await scheduleStorageAlarmInTransaction(state);
  });
  await confirmDestination(state, env, owner, operationId, routeId, options);
  return outcome;
}
export function drainStateEventRelay(state, env, options) { return runStateEventRelay(state, env, reconcileStateEventIntent, options); }
export async function handleStateEventOriginRetirement(state, env, request, path) {
  if (path !== "/internal/state-events/origin/retire") return null;
  if (request.method !== "POST" || request.headers.get("x-elmybot-state-event-delivery") !== "v1") throw recoveryError("authority_required", 403);
  const input = await request.json();
  const row = one(state, "SELECT metadata_json FROM state_event_records WHERE record_key = ?", `origin:${input.sourceKey}`);
  if (!row) return { retired: true };
  const origin = JSON.parse(row.metadata_json);
  if (origin.attempt.identity.operationId !== input.operationId || origin.attempt.route.key !== input.ownerKey ||
      env.CONFIG.idFromName(origin.attempt.identity.originGroupKey).toString() !== state.id.toString()) throw recoveryError("wrong_owner", 422);
  const result = await createStateEventRecovery(state, createStateEventOwnerClient(env)).retire(origin.attempt.identity);
  if (result?.state !== "committed") throw recoveryError("outcome_unknown", 503);
  return { retired: true };
}
export async function handleStateEventDeliverySource(state, env, request, path, kind) {
  if (!path.startsWith(STATE_EVENT_DELIVERY_PATH)) return null;
  if (request.method !== "POST" || request.headers.get("x-elmybot-state-event-delivery") !== "v1") throw recoveryError("authority_required", 403);
  const input = await request.json(), owner = input?.owner;
  const binding = kind === "group_local" ? env.CONFIG : env.SHAREABLE_STATE_REALM;
  if (owner?.kind !== kind || typeof owner?.key !== "string" || binding.idFromName(owner.key).toString() !== state.id.toString() ||
      !/^des1\.[\w-]{43}$/.test(input.routeId ?? "")) throw recoveryError("wrong_owner", 422);
  await observeStateEventRelayMode(state, env);
  const operation = path.slice(STATE_EVENT_DELIVERY_PATH.length);
  if (operation === "proof") {
    const proof = sourceIntentProof(state, input.operationId, input.routeId);
    if (proof.intent.route.key !== owner.key || proof.intent.route.kind !== kind) throw recoveryError("wrong_owner", 422);
    return proof;
  }
  if (operation === "wake") return wakeStateEventRelay(state, input.routeId, input.version ?? null);
  if (operation === "reconcile") {
    if (!stateEventOutboxExists(state)) throw recoveryError("missing_intent", 409);
    const row = one(state, "SELECT operation_id FROM state_event_outbox WHERE operation_id = ?", input.operationId);
    if (!row) {
      const saved = one(state, "SELECT metadata_json FROM state_event_records WHERE record_key = ?", `owner:${input.operationId}`);
      const metadata = saved ? JSON.parse(saved.metadata_json) : null;
      if (metadata?.deliveryOutcome) return metadata.deliveryOutcome;
      throw recoveryError("missing_intent", 409);
    }
    return drainStateEventRelay(state, env, { onlyOperationId: input.operationId });
  }
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
        const checkpoint = Math.max(Number(one(state, "SELECT MAX(operation_sequence) AS value FROM state_event_outbox WHERE stream_route_id = ?", input.routeId)?.value ?? 0), Number(stream.last_sequence ?? 0), Number(stream.checkpoint ?? 0));
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
    if (operation === "reset-release") state.storage.sql.exec(`UPDATE state_event_outbox SET
      next_wakeup_at_ms = CASE WHEN lease_until_ms > ? THEN lease_until_ms ELSE ? END, last_error = 'useful_wakeup'
      WHERE stream_route_id = ?`, Date.now(), Date.now(), input.routeId);
    await scheduleStorageAlarmInTransaction(state);
    return streamStatus(state, input.routeId);
  });
}
