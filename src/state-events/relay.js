import { configureStateEventDiagnostics, stateEventDiagnosticsEnabled, traceStateEvent, traceStateEventRow } from "./diagnostics.js";
import { initializeStateEventOutbox, maintainStateEventOutbox, stateEventOutboxExists } from "./outbox.js";
import { canonicalJson, recoveryError } from "./identity.js";
import { scheduleStorageAlarmInTransaction } from "../storage-alarm.js";
import { relayStreamRequest, boundedStateEventRequest, stateEventRetryDelay } from "./relay-client.js";
import { retireStoredStateEventOwner } from "./storage.js";

export const STATE_EVENT_RELAY_LIMITS = Object.freeze({ batch: 20, concurrency: 4, workMs: 5000, leaseMs: 30_000,
  scheduledAttempts: 12, totalAttempts: 20, wakeCoalesceMs: 1000 });
const one = (state, sql, ...args) => state.storage.sql.exec(sql, ...args).toArray()[0];
const backoff = stateEventRetryDelay;
const control = (row) => ["retiring", "gap_recorded", "reset_discarded"].includes(row.state);
// A verified append no longer holds the ordered publication head. Its outcome
// confirmation/ACK retirement may wait independently without blocking new
// publication. Claims serialize within each lane; all live leases still share
// the existing four-record owner limit.
const cleanupStates = "('appended', 'retiring', 'gap_recorded', 'reset_discarded')";
const cleanupLane = (row) => ["appended", "retiring", "gap_recorded", "reset_discarded"].includes(row.state);
function current(state, id) { return one(state, "SELECT * FROM state_event_outbox WHERE operation_id = ?", id); }
function replaceIntent(state, row, intent) {
  const json = canonicalJson(intent), bytes = new TextEncoder().encode(json).byteLength;
  const budget = one(state, "SELECT bytes FROM state_event_outbox_budget");
  if (budget.bytes + bytes - row.intent_bytes > 512 * 1024) throw recoveryError("outbox_capacity", 503);
  state.storage.sql.exec("UPDATE state_event_outbox SET intent_json = ?, intent_bytes = ? WHERE operation_id = ?", json, bytes, row.operation_id);
  state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = bytes + ?", bytes - row.intent_bytes);
}
function selectedOwner(intent) { return { kind: intent.route.kind, key: intent.route.key }; }
function resumeBusyStreams(state, nowMs) {
  const live = Number(one(state, "SELECT COUNT(*) AS total FROM state_event_outbox WHERE lease_until_ms > ?", nowMs).total);
  if (live < 4) state.storage.sql.exec("UPDATE state_event_outbox SET owner_busy = 0, next_wakeup_at_ms = ? WHERE owner_busy = 1 AND (lease_until_ms IS NULL OR lease_until_ms <= ?)", nowMs, nowMs);
}
async function interest(state, env, row, intent, deadline) {
  const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", row.stream_route_id);
  if (stream.registered_epoch === stream.interest_epoch) return;
  await relayStreamRequest(env, row.stream_route_id, "interest", {
    owner: selectedOwner(intent), operationId: row.operation_id, epoch: stream.interest_epoch
  }, deadline);
  state.storage.sql.exec("UPDATE state_event_source_streams SET registered_epoch = ? WHERE route_id = ? AND interest_epoch = ?", stream.interest_epoch, row.stream_route_id, stream.interest_epoch);
}
async function cleanup(state, env, row, intent, deadline) {
  traceStateEventRow(env, "cleanup.start", row);
  // A gap is cached before confirmation. A crash at that boundary must not
  // retire its proof while the destination still holds an unprunable receipt.
  if (row.state === "gap_recorded" && !row.destination_confirmed) {
    const outcome = await relayStreamRequest(env, row.stream_route_id, "confirm", {
      owner: selectedOwner(intent), operationId: row.operation_id
    }, deadline);
    if (outcome?.confirmed !== true) throw recoveryError("outcome_unknown", 503);
    state.storage.sql.exec("UPDATE state_event_outbox SET destination_confirmed = 1 WHERE operation_id = ? AND lease_token = ?", row.operation_id, row.lease_token);
  }
  if (row.state !== "retiring") {
    await state.storage.transaction(async () => {
      const active = current(state, row.operation_id);
      if (active?.lease_token !== row.lease_token) throw recoveryError("attempt_in_progress", 409);
      const delivery = row.state === "reset_discarded" ? { state: "reset_discarded", terminal: "reset", operationId: row.operation_id }
        : { ...intent.delivery, terminal: intent.delivery?.terminal ?? intent.delivery?.reason };
      const identity = retireStoredStateEventOwner(state, row.operation_id, delivery);
      intent = { ...intent, delivery, retirementSourceKey: identity.sourceKey };
      replaceIntent(state, active, intent);
      state.storage.sql.exec("UPDATE state_event_outbox SET state = 'retiring' WHERE operation_id = ?", row.operation_id);
    });
  }
  if (intent.route.kind === "effective_shareable") {
    const acknowledged = await boundedStateEventRequest(() => env.CONFIG.get(env.CONFIG.idFromName(intent.originGroupKey)).fetch("https://origin/internal/state-events/origin/retire", {
      method: "POST", headers: { "x-elmybot-state-event-delivery": "v1" }, body: JSON.stringify({ sourceKey: intent.retirementSourceKey, operationId: row.operation_id, ownerKey: intent.route.key })
    }), deadline, { env, operationId: row.operation_id, routeId: row.stream_route_id, rpc: "origin.retire" });
    if (acknowledged.retired !== true) throw recoveryError("outcome_unknown", 503);
  }
  const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", row.stream_route_id);
  const count = Number(one(state, "SELECT COUNT(*) AS total FROM state_event_outbox WHERE stream_route_id = ?", row.stream_route_id).total);
  if (count === 1 && stream.registered_epoch) await relayStreamRequest(env, row.stream_route_id, "interest-release", {
    owner: selectedOwner(intent), epoch: stream.registered_epoch
  }, deadline);
  await state.storage.transaction(async () => {
    const active = current(state, row.operation_id);
    if (active?.lease_token !== row.lease_token) return;
    state.storage.sql.exec("DELETE FROM state_event_outbox WHERE operation_id = ?", row.operation_id);
    state.storage.sql.exec("UPDATE state_event_outbox_budget SET rows = rows - 1, bytes = bytes - ?", active.intent_bytes);
    resumeBusyStreams(state, Date.now());
    if (count === 1) state.storage.sql.exec("UPDATE state_event_source_streams SET registered_epoch = 0 WHERE route_id = ? AND interest_epoch = ?", row.stream_route_id, stream.interest_epoch);
    await scheduleStorageAlarmInTransaction(state);
  });
  traceStateEventRow(env, "cleanup.finish", row);
}
async function claim(state, env, { onlyOperationId = null, manual = false, nowMs = Date.now(), remaining = 20 } = {}) {
  return state.storage.transaction(async () => {
    const active = Number(one(state, "SELECT COUNT(*) AS total FROM state_event_outbox WHERE lease_until_ms > ?", nowMs).total);
    if (active >= STATE_EVENT_RELAY_LIMITS.concurrency) {
      const lease = Number(one(state, "SELECT MIN(lease_until_ms) AS due FROM state_event_outbox WHERE lease_until_ms > ?", nowMs).due);
      if (stateEventDiagnosticsEnabled(env)) {
        const blocker = one(state, "SELECT * FROM state_event_outbox WHERE lease_until_ms > ? ORDER BY lease_until_ms LIMIT 1", nowMs);
        for (const row of state.storage.sql.exec("SELECT * FROM state_event_outbox WHERE next_wakeup_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?) LIMIT 20", nowMs, nowMs).toArray()) {
          traceStateEventRow(env, "relay.blocked", row, { reason: "owner_capacity", activeLeases: active,
            blockerOperationId: blocker?.operation_id, blockerState: blocker?.state, leaseUntilMs: lease });
        }
      }
      state.storage.sql.exec(`UPDATE state_event_outbox SET owner_busy = 1,
        next_wakeup_at_ms = CASE WHEN state IN ('pending', 'parked') AND deadline_ms > ? THEN MIN(deadline_ms, ?) ELSE ? END
        WHERE next_wakeup_at_ms <= ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?)`, nowMs, lease, lease, nowMs, nowMs);
      await scheduleStorageAlarmInTransaction(state, { nowMs });
      return [];
    }
    const candidates = state.storage.sql.exec(`SELECT outbox.*, stream.wake_generation, stream.reset_id FROM state_event_outbox outbox
      JOIN state_event_source_streams stream ON stream.route_id = outbox.stream_route_id
      WHERE (outbox.lease_until_ms IS NULL OR outbox.lease_until_ms <= ?)
        AND (? IS NULL OR outbox.operation_id = ?) AND (? OR outbox.next_wakeup_at_ms <= ?)
      ORDER BY stream.last_served_ms, COALESCE(outbox.next_wakeup_at_ms, 0), outbox.operation_sequence LIMIT 100`,
    nowMs, onlyOperationId, onlyOperationId, manual ? 1 : 0, nowMs).toArray();
    const result = [], streams = new Set();
    for (const row of candidates) {
      if (row.reset_id) {
        state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = NULL WHERE operation_id = ?", row.operation_id);
        continue;
      }
      const cleanup = cleanupLane(row), lane = `${row.stream_route_id}:${cleanup ? "cleanup" : "append"}`;
      if (streams.has(lane)) continue;
      if (row.deadline_ms > nowMs && ["pending", "parked"].includes(row.state)) {
        const head = one(state, `SELECT operation_id, state, lease_until_ms, next_wakeup_at_ms, deadline_ms FROM state_event_outbox WHERE stream_route_id = ?
          AND operation_sequence < ? AND state IN ('pending', 'parked', 'gap_pending') ORDER BY operation_sequence LIMIT 1`, row.stream_route_id, row.operation_sequence);
        if (head) {
          traceStateEventRow(env, "relay.blocked", row, { reason: "ordered_head", blockerOperationId: head.operation_id,
            blockerState: head.state, leaseUntilMs: head.lease_until_ms, nextWakeupAtMs: head.next_wakeup_at_ms });
          if (manual) throw recoveryError("delivery_order", 409);
          state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = ? WHERE operation_id = ?", head.next_wakeup_at_ms ?? head.deadline_ms, row.operation_id);
          continue;
        }
      }
      const leased = one(state, `SELECT MIN(lease_until_ms) AS due, operation_id, state FROM state_event_outbox
        WHERE stream_route_id = ? AND lease_until_ms > ? AND (state IN ${cleanupStates}) = ?`,
      row.stream_route_id, nowMs, cleanup ? 1 : 0);
      if (leased?.due != null) {
        traceStateEventRow(env, "relay.blocked", row, { reason: "lane_lease", blockerOperationId: leased.operation_id,
          blockerState: leased.state, leaseUntilMs: leased.due });
        state.storage.sql.exec("UPDATE state_event_outbox SET owner_busy = 1, next_wakeup_at_ms = ? WHERE operation_id = ?", row.deadline_ms > nowMs ? Math.min(row.deadline_ms, leased.due) : leased.due, row.operation_id);
        continue;
      }
      const isControl = control(row), used = isControl ? row.control_attempts : row.attempts;
      const scheduled = isControl ? row.control_scheduled : row.scheduled_attempts;
      const expired = row.deadline_ms <= nowMs;
      if (used >= 20 || (!isControl && !expired && used >= 19)) {
        traceStateEventRow(env, "relay.blocked", row, { reason: "attempt_budget" });
        state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = ? WHERE operation_id = ?", !isControl && !expired ? row.deadline_ms : null, row.operation_id);
        continue;
      }
      // Once automatic retries are exhausted, only a recorded useful wakeup,
      // explicit recovery or the original expiry may start another attempt.
      if (!manual && scheduled >= 12 && (isControl || !expired) && row.last_error !== "useful_wakeup") {
        traceStateEventRow(env, "relay.blocked", row, { reason: "automatic_budget" });
        state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = ? WHERE operation_id = ?", isControl ? null : row.deadline_ms, row.operation_id);
        continue;
      }
      state.storage.sql.exec("UPDATE state_event_source_streams SET last_served_ms = ? WHERE route_id = ?", nowMs, row.stream_route_id);
      if (row.last_error === "useful_wakeup") state.storage.sql.exec("UPDATE state_event_source_streams SET last_wake_ms = ? WHERE route_id = ?", nowMs, row.stream_route_id);
      const token = crypto.randomUUID();
      state.storage.sql.exec(`UPDATE state_event_outbox SET owner_busy = 0, lease_token = ?, lease_until_ms = ?, next_wakeup_at_ms = ?,
        attempts = attempts + ?, scheduled_attempts = scheduled_attempts + ?, control_attempts = control_attempts + ?, control_scheduled = control_scheduled + ? WHERE operation_id = ?`,
      token, nowMs + 30_000, nowMs + 30_000, isControl ? 0 : 1, !isControl && !manual ? 1 : 0, isControl ? 1 : 0, isControl && !manual ? 1 : 0, row.operation_id);
      const claimed = { ...current(state, row.operation_id), wake_generation: row.wake_generation };
      result.push(claimed); streams.add(lane);
      traceStateEventRow(env, "relay.claim", claimed, { ownerId: state.id.toString(), activeLeases: active + result.length });
      if (result.length >= Math.min(remaining, 4 - active)) break;
    }
    await scheduleStorageAlarmInTransaction(state, { nowMs });
    return result;
  });
}
async function finish(state, env, row, error = null, terminalDelivery = false) {
  await state.storage.transaction(async () => {
    const active = current(state, row.operation_id);
    if (!active || active.lease_token !== row.lease_token) return;
    const now = Date.now(), isControl = control(active), used = isControl ? active.control_attempts : active.attempts;
    const scheduled = isControl ? active.control_scheduled : active.scheduled_attempts;
    const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", row.stream_route_id);
    const useful = stream.wake_generation !== row.wake_generation;
    const uncertain = Boolean(error) && (!error.code || error.code === "state_event_outcome_unknown");
    const parked = ["durable_event_stream_full", "durable_event_gap_requires_reset", "durable_event_consumer_unavailable", "state_event_attempt_limit", "state_event_stream_blocked", "state_event_service_unavailable"].includes(error?.code) && !error?.retryAfterMs;
    let due;
    if (used >= 20) due = null;
    else if (terminalDelivery) due = now;
    else if (!error && active.state === "appended") due = Math.max(now, active.deadline_ms);
    else if (parked || scheduled >= 12) due = isControl ? null : Math.max(now, active.deadline_ms);
    else due = now + (error?.retryAfterMs ?? backoff(scheduled));
    if (!isControl && active.deadline_ms > now && used >= 19) due = active.deadline_ms;
    if (!isControl && active.deadline_ms <= now && error && (parked || scheduled >= 12)) due = null;
    if (useful && used < (isControl || active.deadline_ms <= now ? 20 : 19)) due = Math.min(due ?? Infinity, now + 1000);
    if (!isControl && active.deadline_ms > now && due !== null) due = Math.min(due, active.deadline_ms);
    if (uncertain && due !== null) due = Math.max(due, Number(active.lease_until_ms));
    state.storage.sql.exec(`UPDATE state_event_outbox SET lease_token = ?, lease_until_ms = ?, next_wakeup_at_ms = ?,
      last_error = ?, uncertain = ? WHERE operation_id = ?`, uncertain ? row.lease_token : null,
    uncertain ? active.lease_until_ms : null, due, useful ? "useful_wakeup" : error?.code ?? (error ? "state_event_outcome_unknown" : null), uncertain ? 1 : 0, row.operation_id);
    if (parked && !isControl && !useful) state.storage.sql.exec(`UPDATE state_event_outbox SET next_wakeup_at_ms = deadline_ms
      WHERE stream_route_id = ? AND operation_id <> ? AND lease_token IS NULL AND state IN ('pending', 'parked') AND deadline_ms > ?`, row.stream_route_id, row.operation_id, now);
    traceStateEventRow(env, "relay.finish", active, { code: error?.code ?? (error ? "state_event_outcome_unknown" : "ok"),
      reason: uncertain ? "uncertain" : parked ? "parked" : "completed", nextWakeupAtMs: due,
      leaseUntilMs: uncertain ? active.lease_until_ms : undefined });
    resumeBusyStreams(state, now);
    await scheduleStorageAlarmInTransaction(state);
  });
}
export async function runStateEventRelay(state, env, reconcile, options = {}) {
  configureStateEventDiagnostics(state, env);
  if (!stateEventOutboxExists(state)) return { attempted: 0 };
  initializeStateEventOutbox(state);
  if (stateEventDiagnosticsEnabled(env)) {
    const snapshot = one(state, `SELECT MIN(next_wakeup_at_ms) AS due,
      SUM(lease_until_ms > ?) AS active, SUM(lease_until_ms > ? AND state IN ${cleanupStates}) AS cleanup FROM state_event_outbox`, Date.now(), Date.now());
    traceStateEvent(env, "relay.start", { ownerId: state.id.toString(), dueAtMs: snapshot.due,
      activeLeases: Number(snapshot.active ?? 0), cleanupLeases: Number(snapshot.cleanup ?? 0) });
  }
  await observeStateEventRelayMode(state, env);
  const started = Date.now();
  const expired = await maintainStateEventOutbox(state, Date.now(), options.onlyOperationId ?? null);
  const batch = 20 - expired.examined;
  let attempted = 0, lastResult;
  const work = async (row) => {
    const intent = JSON.parse(row.intent_json), owner = selectedOwner(intent), deadline = Date.now() + 5000;
    try {
      if (env.DURABLE_EVENT_STREAMS_ENABLED !== "true" && row.deadline_ms > Date.now() && !control(row)) throw recoveryError("service_unavailable", 503);
      let result;
      if (control(row)) {
        await cleanup(state, env, row, intent, deadline);
        return row.state === "reset_discarded" ? { state: "reset_discarded", terminal: "reset", operationId: row.operation_id }
          : intent.delivery ?? { state: "retired" };
      }
      if (row.deadline_ms <= Date.now()) await maintainStateEventOutbox(state, Date.now(), row.operation_id);
      await interest(state, env, row, intent, deadline);
      result = await reconcile(state, env, owner, row.operation_id, row.stream_route_id, { leaseToken: row.lease_token, deadline });
      const active = current(state, row.operation_id);
      if (active && result.terminal) {
        await cleanup(state, env, active, { ...JSON.parse(active.intent_json), delivery: result }, deadline);
      } else await finish(state, env, row);
      return result;
    } catch (error) {
      await finish(state, env, row, error);
      if (options.onlyOperationId) throw error;
      return { state: "pending", code: error.code ?? "state_event_outcome_unknown" };
    }
  };
  while (attempted < batch && Date.now() - started < 5000) {
    const rows = await claim(state, env, { ...options, manual: Boolean(options.onlyOperationId), nowMs: Date.now(), remaining: batch - attempted });
    if (!rows.length) break;
    const outcomes = await Promise.allSettled(rows.slice(0, batch - attempted).map(work));
    attempted += outcomes.length;
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
      lastResult = outcome.value;
    }
    if (options.onlyOperationId) break;
  }
  if (options.onlyOperationId && !attempted) throw recoveryError("attempt_in_progress", 409);
  return options.onlyOperationId ? lastResult : { attempted };
}
export async function wakeStateEventRelay(state, routeId, version, nowMs = Date.now()) {
  if (!stateEventOutboxExists(state)) return { accepted: true, pending: false };
  initializeStateEventOutbox(state);
  return state.storage.transaction(async () => {
    const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", routeId);
    if (!stream) return { accepted: true, pending: false };
    if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw recoveryError("invalid_request", 422);
    if (version === null || version > stream.last_wake_version) {
      const due = Math.max(nowMs, Number(stream.last_wake_ms) + 1000);
      state.storage.sql.exec(`UPDATE state_event_source_streams SET last_wake_version = MAX(last_wake_version, ?),
        wake_generation = wake_generation + 1 WHERE route_id = ?`, version ?? 0, routeId);
      state.storage.sql.exec(`UPDATE state_event_outbox SET next_wakeup_at_ms = CASE WHEN lease_until_ms > ? THEN lease_until_ms ELSE ? END,
        last_error = 'useful_wakeup' WHERE stream_route_id = ? AND
        ((state IN ('retiring', 'gap_recorded', 'reset_discarded') AND control_attempts < 20) OR
        (state NOT IN ('retiring', 'gap_recorded', 'reset_discarded') AND attempts < CASE WHEN deadline_ms <= ? THEN 20 ELSE 19 END))`, nowMs, due, routeId, nowMs);
    }
    await scheduleStorageAlarmInTransaction(state);
    return { accepted: true, pending: Boolean(one(state, "SELECT 1 FROM state_event_outbox WHERE stream_route_id = ? LIMIT 1", routeId)) };
  });
}

// Observing an actual enable transition is a useful wakeup. This never searches
// for inactive owners: grant/registration, a request or an existing alarm touches
// only its already addressed owner, whose queue is capped at one hundred rows.
export async function observeStateEventRelayMode(state, env) {
  if (!stateEventOutboxExists(state)) return;
  state.storage.sql.exec("CREATE TABLE IF NOT EXISTS state_event_relay_mode (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), enabled INTEGER NOT NULL)");
  const enabled = env.DURABLE_EVENT_STREAMS_ENABLED === "true" ? 1 : 0;
  const old = one(state, "SELECT enabled FROM state_event_relay_mode");
  if (old?.enabled === enabled) return;
  await state.storage.transaction(async () => {
    state.storage.sql.exec("INSERT INTO state_event_relay_mode VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET enabled = excluded.enabled", enabled);
    if (old?.enabled === 0 && enabled) {
      const now = Date.now();
      state.storage.sql.exec("UPDATE state_event_source_streams SET wake_generation = wake_generation + 1");
      state.storage.sql.exec(`UPDATE state_event_outbox SET next_wakeup_at_ms = CASE WHEN lease_until_ms > ? THEN lease_until_ms ELSE ? END,
        last_error = 'useful_wakeup' WHERE attempts < 20`, now, now);
    }
    await scheduleStorageAlarmInTransaction(state);
  });
}
