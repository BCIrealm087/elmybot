// Private, opt-in correlation logs. No payloads, credentials, group/source keys,
// error messages, durable writes, timers or outbound requests. The in-memory
// budget is per environment instance and resets on eviction, not an account cap.
const windows = new WeakMap(), owners = new WeakMap();
export const STATE_EVENT_DIAGNOSTIC_LIMIT = 500;
export const stateEventDiagnosticsEnabled = (env) => env?.STATE_EVENT_DIAGNOSTICS === "true";
const opaque = /^(?:(?:seo1|des1|dev1)\.[\w-]{43}|ses1\.[\w-]{22}|[a-f0-9]{32}|[a-f0-9]{64})$/;
const identifiers = new Set(["operationId", "routeId", "eventId", "ownerId", "scopeToken", "blockerOperationId", "notificationId"]);
const numbers = new Set(["committedAtMs", "scheduledAtMs", "previousAlarmMs", "durableDueMs", "startedAtMs", "durationMs",
  "dueAtMs", "leaseUntilMs", "sequence", "stateRevision", "attempts", "controlAttempts", "activeLeases", "cleanupLeases",
  "version", "acceptedAtMs", "nextWakeupAtMs", "lagMs"]);
const labels = new Set(["state", "lane", "reason", "code", "rpc", "blockerState", "result"]);

export function traceStateEvent(env, stage, fields = {}) {
  if (!stateEventDiagnosticsEnabled(env) || !/^[a-z][a-z0-9_.]{0,63}$/.test(stage)) return;
  try {
    const now = Date.now();
    let window = windows.get(env);
    if (!window || now - window.started >= 60_000) {
      window = { started: now, emitted: 0, dropped: window?.dropped ?? 0 };
      windows.set(env, window);
    }
    if (window.emitted >= STATE_EVENT_DIAGNOSTIC_LIMIT) { window.dropped++; return; }
    const record = { event: "state_event.trace", stage, atMs: now, dropped: window.dropped };
    window.dropped = 0; window.emitted++;
    for (const [key, value] of Object.entries(fields)) {
      if (identifiers.has(key) && typeof value === "string" && opaque.test(value) ||
          numbers.has(key) && Number.isSafeInteger(value) && value >= 0 ||
          labels.has(key) && typeof value === "string" && /^[a-z][a-z0-9_.-]{0,79}$/.test(value)) record[key] = value;
    }
    console.log(JSON.stringify(record));
  } catch { /* Diagnostics must never change acceptance, delivery or recovery. */ }
}

export function traceStateEventRow(env, stage, row, fields = {}) {
  if (!stateEventDiagnosticsEnabled(env) || !row) return;
  try {
    const intent = JSON.parse(row.intent_json);
    traceStateEvent(env, stage, { operationId: row.operation_id, routeId: row.stream_route_id,
      eventId: intent.eventId, scopeToken: intent.stateEvent?.scopeToken,
      sequence: row.operation_sequence, committedAtMs: intent.committedAtMs,
      state: row.state, lane: ["appended", "retiring", "gap_recorded", "reset_discarded"].includes(row.state) ? "cleanup" : "append",
      dueAtMs: row.next_wakeup_at_ms, leaseUntilMs: row.lease_until_ms, attempts: row.attempts,
      controlAttempts: row.control_attempts, ...fields });
  } catch { /* A malformed diagnostic input cannot own the protocol. */ }
}

export function configureStateEventDiagnostics(state, env) {
  if (stateEventDiagnosticsEnabled(env)) owners.set(state, { env, scheduledAtMs: owners.get(state)?.scheduledAtMs });
  else owners.delete(state);
}
export function traceStateEventForOwner(state, stage, fields = {}) {
  const context = owners.get(state);
  if (!context) return;
  if (stage === "alarm.start") {
    fields = { scheduledAtMs: context.scheduledAtMs,
      lagMs: context.scheduledAtMs == null ? undefined : Math.max(0, Date.now() - context.scheduledAtMs), ...fields };
    context.scheduledAtMs = undefined;
  } else if (stage === "alarm.schedule") context.scheduledAtMs = fields.scheduledAtMs;
  else if (stage === "alarm.clear") context.scheduledAtMs = undefined;
  traceStateEvent(context.env, stage, { ownerId: state.id.toString(), ...fields });
}
