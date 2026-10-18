import { scheduleStorageAlarmInTransaction, storageTableExists } from "../storage-alarm.js";
import { canonicalJson, jsonBytes, recoveryError } from "./identity.js";

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
      intent_json TEXT NOT NULL, intent_bytes INTEGER NOT NULL, stream_route_id TEXT);
    CREATE INDEX IF NOT EXISTS state_event_outbox_due ON state_event_outbox(next_wakeup_at_ms);
    CREATE INDEX IF NOT EXISTS state_event_outbox_order ON state_event_outbox(partition_key, operation_sequence);
    CREATE TABLE IF NOT EXISTS state_event_outbox_budget (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL,
      bytes INTEGER NOT NULL, partitions INTEGER NOT NULL, rate_json TEXT NOT NULL);
    INSERT OR IGNORE INTO state_event_outbox_budget VALUES (1, 0, 0, 0, '[]');
    CREATE TABLE IF NOT EXISTS state_event_source_streams (
      route_id TEXT PRIMARY KEY, gap_first INTEGER, gap_last INTEGER, blocked INTEGER NOT NULL DEFAULT 0,
      reset_id TEXT, reset_phase TEXT, checkpoint INTEGER NOT NULL DEFAULT 0, completed_reset TEXT);`);
  if (!state.storage.sql.exec("PRAGMA table_info(state_event_outbox)").toArray().some((column) => column.name === "stream_route_id")) {
    state.storage.sql.exec("ALTER TABLE state_event_outbox ADD COLUMN stream_route_id TEXT");
  }
  for (const row of state.storage.sql.exec("SELECT operation_id, intent_json FROM state_event_outbox WHERE stream_route_id IS NULL LIMIT 100").toArray()) {
    state.storage.sql.exec("UPDATE state_event_outbox SET stream_route_id = ? WHERE operation_id = ?", JSON.parse(row.intent_json).route.streamRouteId, row.operation_id);
  }
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
  if (budget.rows >= STATE_EVENT_OUTBOX_LIMITS.rows || budget.bytes + bytes > STATE_EVENT_OUTBOX_LIMITS.bytes) {
    throw recoveryError("outbox_capacity", 503);
  }
  const stream = one(state, "SELECT * FROM state_event_source_streams WHERE route_id = ?", intent.route.streamRouteId);
  if (stream?.reset_id || stream?.blocked || stream?.gap_first !== null && stream?.gap_first !== undefined) throw recoveryError("stream_blocked", 409);
  if (!stream) {
    const total = one(state, "SELECT COUNT(*) AS total FROM state_event_source_streams").total;
    if (total >= STATE_EVENT_OUTBOX_LIMITS.partitions) throw recoveryError("partition_capacity", 503);
    state.storage.sql.exec("INSERT INTO state_event_source_streams (route_id) VALUES (?)", intent.route.streamRouteId);
  }
  state.storage.sql.exec("INSERT INTO state_event_outbox VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
    intent.operationId, intent.partitionKey ?? intent.featureId, intent.stateEvent.operationSequence, intent.expiresAtMs,
    intent.committedAtMs + 1000, json, bytes, intent.route.streamRouteId);
  state.storage.sql.exec("UPDATE state_event_outbox_budget SET rows = rows + 1, bytes = bytes + ?", bytes);
}

// The bounded automatic relay is step 7. Step 6 provides explicit reconciliation;
// until relay integration the first automatic wake parks at the original deadline.
// Expiry clears payloads and retains bounded gap-pending metadata, never success.
export async function maintainStateEventOutbox(state, nowMs = Date.now()) {
  if (!stateEventOutboxExists(state)) return { examined: 0 };
  let examined = 0;
  await state.storage.transaction(async () => {
    state.storage.transactionSync(() => {
      const rows = state.storage.sql.exec(`SELECT * FROM state_event_outbox
        WHERE next_wakeup_at_ms <= ? ORDER BY next_wakeup_at_ms LIMIT ?`, nowMs, STATE_EVENT_OUTBOX_LIMITS.batch).toArray();
      examined = rows.length;
      for (const row of rows) {
        if (row.deadline_ms > nowMs) {
          state.storage.sql.exec("UPDATE state_event_outbox SET state = 'parked', next_wakeup_at_ms = deadline_ms WHERE operation_id = ?", row.operation_id);
        } else {
          const intent = JSON.parse(row.intent_json);
          delete intent.payload;
          const json = canonicalJson({ ...intent, gapPending: true });
          const bytes = jsonBytes(json);
          state.storage.sql.exec(`UPDATE state_event_outbox SET state = 'gap_pending', next_wakeup_at_ms = NULL,
            intent_json = ?, intent_bytes = ? WHERE operation_id = ?`, json, bytes, row.operation_id);
          state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = bytes + ?", bytes - row.intent_bytes);
        }
      }
    });
    await scheduleStorageAlarmInTransaction(state, { nowMs });
  });
  return { examined };
}
