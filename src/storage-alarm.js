import { traceStateEventForOwner } from "./state-events/diagnostics.js";

// Every scheduler in an object must consider every durable work source. Keep
// the read/decision/write serialized with admission, including SQL + alarm writes.
export function storageTableExists(state, name) {
  return Boolean(state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray()[0]);
}
export function nextStorageWakeup(state, candidate = null) {
  const candidates = candidate === null ? [] : [candidate];
  const sources = [
    ["state_query_grant_invalidation_outbox", "next_attempt_at_ms"],
    ["state_query_notification_outbox", "next_attempt_at_ms"],
    ["state_query_source_watchers", "lease_expires_at_ms"],
    ["state_event_outbox", "next_wakeup_at_ms"]
  ];
  for (const [table, column] of sources) {
    if (!storageTableExists(state, table)) continue;
    const due = state.storage.sql.exec(`SELECT MIN(${column}) AS due FROM ${table}`).toArray()[0]?.due;
    if (due !== null && due !== undefined) candidates.push(Number(due));
  }
  return candidates.length ? Math.min(...candidates) : null;
}
export async function scheduleStorageAlarmInTransaction(state, { candidate = null, nowMs = Date.now() } = {}) {
  const current = await state.storage.getAlarm();
  const due = nextStorageWakeup(state, candidate);
  if (due === null) {
    if (current !== null) {
      await state.storage.deleteAlarm();
      traceStateEventForOwner(state, "alarm.clear", { previousAlarmMs: current });
    }
  } else {
    const next = Math.max(nowMs, due);
    if (current === null || current > next) await state.storage.setAlarm(next);
    traceStateEventForOwner(state, "alarm.schedule", {
      scheduledAtMs: current === null || current > next ? next : current,
      previousAlarmMs: current, durableDueMs: due
    });
  }
}
export async function recoverStorageAlarm(state, options) {
  return state.storage.transaction(async () => scheduleStorageAlarmInTransaction(state, options));
}
