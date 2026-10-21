import { scheduleStorageAlarmInTransaction, storageTableExists } from "../storage-alarm.js";
import { canonicalJson, jsonBytes, recoveryError } from "./identity.js";

export const STATE_EVENT_PUBLICATION_BURST = 3;
export const STATE_EVENT_OUTBOX_LIMITS = Object.freeze({ rows: 100, bytes: 512 * 1024,
  partitions: 100, admissionsPerSecond: 10, retentionMs: 30 * 60 * 1000, batch: 20 });
export function stateEventOutboxExists(state) { return storageTableExists(state, "state_event_outbox"); }
function one(state, query, ...args) { return state.storage.sql.exec(query, ...args).toArray()[0]; }
export function initializeStateEventOutbox(state) {
  state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS state_event_partitions (
    partition_key TEXT PRIMARY KEY, scope_token TEXT NOT NULL, operation_sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state_event_outbox (
      operation_id TEXT PRIMARY KEY, partition_key TEXT NOT NULL, operation_sequence INTEGER NOT NULL,
      state TEXT NOT NULL, deadline_ms INTEGER NOT NULL, next_wakeup_at_ms INTEGER,
      intent_json TEXT NOT NULL, intent_bytes INTEGER NOT NULL, stream_route_id TEXT,
      probe_state INTEGER NOT NULL DEFAULT 0, probe_fallback_ms INTEGER, relay_turn INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS state_event_outbox_due ON state_event_outbox(next_wakeup_at_ms);
    CREATE INDEX IF NOT EXISTS state_event_outbox_order ON state_event_outbox(partition_key, operation_sequence);
    CREATE TABLE IF NOT EXISTS state_event_outbox_budget (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL,
      bytes INTEGER NOT NULL, partitions INTEGER NOT NULL, rate_json TEXT NOT NULL);
    INSERT OR IGNORE INTO state_event_outbox_budget VALUES (1, 0, 0, 0, '[]');
    CREATE TABLE IF NOT EXISTS state_event_relay_schedule (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), turn INTEGER NOT NULL, publication_streak INTEGER NOT NULL);
    INSERT OR IGNORE INTO state_event_relay_schedule VALUES (1, 0, 0);
    CREATE TABLE IF NOT EXISTS state_event_source_streams (
      route_id TEXT PRIMARY KEY, gap_first INTEGER, gap_last INTEGER, blocked INTEGER NOT NULL DEFAULT 0,
      reset_id TEXT, reset_phase TEXT, checkpoint INTEGER NOT NULL DEFAULT 0, completed_reset TEXT);`);
  if (!state.storage.sql.exec("PRAGMA table_info(state_event_outbox)").toArray().some((column) => column.name === "stream_route_id")) {
    state.storage.sql.exec("ALTER TABLE state_event_outbox ADD COLUMN stream_route_id TEXT");
  }
  const columns = new Set(state.storage.sql.exec("PRAGMA table_info(state_event_outbox)").toArray().map((column) => column.name));
  for (const [name, definition] of [
    ["attempts", "INTEGER NOT NULL DEFAULT 0"], ["scheduled_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["control_attempts", "INTEGER NOT NULL DEFAULT 0"], ["control_scheduled", "INTEGER NOT NULL DEFAULT 0"],
    ["lease_token", "TEXT"], ["lease_until_ms", "INTEGER"], ["destination_confirmed", "INTEGER NOT NULL DEFAULT 0"],
    ["probe_state", "INTEGER NOT NULL DEFAULT 0"], ["probe_fallback_ms", "INTEGER"],
    ["relay_turn", "INTEGER NOT NULL DEFAULT 0"],
    ["last_error", "TEXT"], ["uncertain", "INTEGER NOT NULL DEFAULT 0"], ["owner_busy", "INTEGER NOT NULL DEFAULT 0"]
  ]) if (!columns.has(name)) state.storage.sql.exec(`ALTER TABLE state_event_outbox ADD COLUMN ${name} ${definition}`);
  const streamColumns = new Set(state.storage.sql.exec("PRAGMA table_info(state_event_source_streams)").toArray().map((column) => column.name));
  for (const [name, definition] of [
    ["interest_epoch", "INTEGER NOT NULL DEFAULT 1"], ["registered_epoch", "INTEGER NOT NULL DEFAULT 0"],
    ["wake_generation", "INTEGER NOT NULL DEFAULT 0"], ["last_wake_version", "INTEGER NOT NULL DEFAULT 0"],
    ["last_wake_ms", "INTEGER NOT NULL DEFAULT 0"], ["last_sequence", "INTEGER NOT NULL DEFAULT 0"], ["last_served_ms", "INTEGER NOT NULL DEFAULT 0"]
  ]) if (!streamColumns.has(name)) state.storage.sql.exec(`ALTER TABLE state_event_source_streams ADD COLUMN ${name} ${definition}`);
  if (!streamColumns.has("last_sequence")) state.storage.sql.exec(`UPDATE state_event_source_streams SET last_sequence =
    COALESCE((SELECT MAX(operation_sequence) FROM state_event_outbox WHERE stream_route_id = route_id), 0)`);
  for (const row of state.storage.sql.exec("SELECT operation_id, intent_json FROM state_event_outbox WHERE stream_route_id IS NULL LIMIT 100").toArray()) {
    state.storage.sql.exec("UPDATE state_event_outbox SET stream_route_id = ? WHERE operation_id = ?", JSON.parse(row.intent_json).route.streamRouteId, row.operation_id);
  }
  state.storage.sql.exec("CREATE INDEX IF NOT EXISTS state_event_outbox_probe ON state_event_outbox(next_wakeup_at_ms) WHERE probe_state = 1");
  state.storage.sql.exec("CREATE INDEX IF NOT EXISTS state_event_outbox_expiry ON state_event_outbox(state, deadline_ms)");
  state.storage.sql.exec("CREATE INDEX IF NOT EXISTS state_event_outbox_stream ON state_event_outbox(stream_route_id, operation_sequence)");
}
export function allocateStateEventSequence(state, featureId, candidateToken, nowMs) {
  initializeStateEventOutbox(state);
  const budget = one(state, "SELECT * FROM state_event_outbox_budget");
  const recent = JSON.parse(budget.rate_json).filter((time) => time > nowMs - 1000);
  if (recent.length >= STATE_EVENT_OUTBOX_LIMITS.admissionsPerSecond) throw recoveryError("rate_limited", 429);
  const partition = one(state, "SELECT * FROM state_event_partitions WHERE partition_key = ?", featureId);
  if (!partition && budget.partitions >= STATE_EVENT_OUTBOX_LIMITS.partitions) throw recoveryError("partition_capacity", 503);
  const sequence = Number(partition?.operation_sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw recoveryError("sequence_exhausted", 409);
  state.storage.sql.exec(`INSERT INTO state_event_partitions VALUES (?, ?, ?)
    ON CONFLICT(partition_key) DO UPDATE SET operation_sequence = excluded.operation_sequence`,
  featureId, partition?.scope_token ?? candidateToken, sequence);
  state.storage.sql.exec("UPDATE state_event_outbox_budget SET partitions = partitions + ?, rate_json = ?",
    partition ? 0 : 1, JSON.stringify([...recent, nowMs]));
  return { version: 1, scopeToken: partition?.scope_token ?? candidateToken, operationSequence: sequence };
}
export function enqueueStateEventIntent(state, intent) {
  const json = canonicalJson(intent, STATE_EVENT_OUTBOX_LIMITS.bytes);
  const bytes = jsonBytes(json);
  const budget = one(state, "SELECT * FROM state_event_outbox_budget");
  if (budget.rows >= STATE_EVENT_OUTBOX_LIMITS.rows || budget.bytes + bytes + (budget.rows + 1) * 512 > STATE_EVENT_OUTBOX_LIMITS.bytes) {
    throw recoveryError("outbox_capacity", 503);
  }
  const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", intent.route.streamRouteId);
  if (stream?.reset_id || stream?.blocked || stream?.gap_first !== null && stream?.gap_first !== undefined) throw recoveryError("stream_blocked", 409);
  if (!stream) {
    const total = one(state, "SELECT COUNT(*) AS total FROM state_event_source_streams").total;
    if (total >= STATE_EVENT_OUTBOX_LIMITS.partitions) throw recoveryError("partition_capacity", 503);
    state.storage.sql.exec("INSERT INTO state_event_source_streams (route_id) VALUES (?)", intent.route.streamRouteId);
  }
  const current = one(state, "SELECT interest_epoch FROM state_event_source_streams WHERE route_id = ?", intent.route.streamRouteId);
  if (!Number.isSafeInteger(Number(current.interest_epoch) + 1)) throw recoveryError("sequence_exhausted", 409);
  state.storage.sql.exec(`UPDATE state_event_source_streams SET interest_epoch = interest_epoch + 1,
    wake_generation = wake_generation + 1, last_sequence = ? WHERE route_id = ?`, intent.stateEvent.operationSequence, intent.route.streamRouteId);
  // New accepted work is a useful wakeup for the earlier ordered head, within
  // its existing attempt budgets. It never bypasses a live lease or a reset.
  state.storage.sql.exec(`UPDATE state_event_outbox SET next_wakeup_at_ms = MIN(COALESCE(next_wakeup_at_ms, deadline_ms), ?), last_error = 'useful_wakeup'
    WHERE stream_route_id = ? AND (lease_until_ms IS NULL OR lease_until_ms <= ?) AND attempts < 19
      AND state IN ('pending', 'parked', 'gap_pending')`, intent.committedAtMs + 1000, intent.route.streamRouteId, intent.committedAtMs);
  const turn = nextStateEventRelayTurn(state);
  state.storage.sql.exec(`INSERT INTO state_event_outbox
    (operation_id, partition_key, operation_sequence, state, deadline_ms, next_wakeup_at_ms, intent_json, intent_bytes, stream_route_id, relay_turn)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    intent.operationId, intent.partitionKey ?? intent.featureId, intent.stateEvent.operationSequence, intent.expiresAtMs,
    intent.committedAtMs + 1000, json, bytes, intent.route.streamRouteId, turn);
  state.storage.sql.exec("UPDATE state_event_outbox_budget SET rows = rows + 1, bytes = bytes + ?", bytes);
}

// Expiry persists an unresolved gap before removing a payload. It is not proof
// of an absent append; the relay must still recover the original destination.
export async function maintainStateEventOutbox(state, nowMs = Date.now(), operationId = null) {
  if (!stateEventOutboxExists(state)) return { examined: 0 };
  initializeStateEventOutbox(state);
  let examined = 0;
  await state.storage.transaction(async () => {
    const rows = state.storage.sql.exec(`SELECT * FROM state_event_outbox
      WHERE deadline_ms <= ? AND state IN ('pending', 'parked') AND (? IS NULL OR operation_id = ?)
      ORDER BY deadline_ms LIMIT ?`, nowMs, operationId, operationId, STATE_EVENT_OUTBOX_LIMITS.batch).toArray();
    examined = rows.length;
    for (const row of rows) {
      const intent = JSON.parse(row.intent_json); delete intent.payload;
      const json = canonicalJson({ ...intent, gapPending: true }), bytes = jsonBytes(json);
      state.storage.sql.exec(`UPDATE state_event_outbox SET state = 'gap_pending', intent_json = ?, intent_bytes = ?,
        next_wakeup_at_ms = CASE WHEN probe_state = 1 THEN next_wakeup_at_ms WHEN attempts >= 20 THEN NULL WHEN lease_until_ms > ? THEN lease_until_ms ELSE ? END WHERE operation_id = ?`,
      json, bytes, nowMs, nowMs, row.operation_id);
      state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = bytes + ?", bytes - row.intent_bytes);
    }
    await scheduleStorageAlarmInTransaction(state, { nowMs });
  });
  return { examined };
}

// Called only inside the caller's admission/claim transaction. Tickets put new
// records behind already waiting work, including retryable failures. Persisted
// claim turns survive eviction; time stamps cannot provide this under ties.
export function nextStateEventRelayTurn(state, publication = null) {
  const schedule = one(state, "SELECT turn FROM state_event_relay_schedule");
  if (!Number.isSafeInteger(schedule.turn + 1)) throw recoveryError("sequence_exhausted", 409);
  return one(state, `UPDATE state_event_relay_schedule SET turn = turn + 1,
    publication_streak = CASE WHEN ? IS NULL THEN publication_streak WHEN ? THEN MIN(publication_streak + 1, ${STATE_EVENT_PUBLICATION_BURST}) ELSE 0 END
    WHERE singleton = 1 RETURNING turn`, publication === null ? null : publication ? 1 : 0, publication ? 1 : 0).turn;
}
