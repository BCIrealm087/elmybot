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
export async function scheduleStorageAlarmInTransaction(state, { candidate = null, nowMs = Date.now(), recompute = false } = {}) {
  const current = await state.storage.getAlarm();
  const due = nextStorageWakeup(state, candidate);
  if (due === null) {
    if (current !== null) {
      await state.storage.deleteAlarm();
      traceStateEventForOwner(state, "alarm.clear", { previousAlarmMs: current });
    }
  } else {
    const next = Math.max(nowMs, due);
    // An expired selection is not coverage for new work. During a handler,
    // getAlarm() can also expose an alarm rearmed before a claim advanced its
    // durable deadline. Completion recomputes from every durable source, so a
    // provisional alarm cannot strand work or spin a leased-only owner.
    const replace = current === null || current > next || ((current <= nowMs || recompute) && current !== next);
    if (replace) await state.storage.setAlarm(next);
    traceStateEventForOwner(state, "alarm.schedule", {
      scheduledAtMs: replace ? next : current,
      previousAlarmMs: current, durableDueMs: due
    });
  }
}
export async function recoverStorageAlarm(state, options) {
  return state.storage.transaction(async () => scheduleStorageAlarmInTransaction(state, options));
}

// Entry consumes the delivered alarm in native storage. Claims/admissions must
// still save their own SQL + alarm transaction while remote work is in flight.
// Reconcile again on either normal or exceptional completion; a thrown handler
// remains thrown so the runtime retains its retry semantics. Abrupt termination
// instead relies on those durable transitions and constructor recovery.
export async function runStorageAlarm(state, handler) {
  try {
    return await handler();
  } finally {
    await recoverStorageAlarm(state, { recompute: true });
  }
}
