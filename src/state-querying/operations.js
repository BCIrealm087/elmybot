// Internal operational controls; no public route or feature-authoring API.
const windows = new WeakMap();
const COUNTERS = new Set([
  "registrations", "polls", "emptyPolls", "closed", "expired", "resynchronized",
  "oversized", "notifications", "duplicates", "obsolete", "handoffs", "retries",
  "authorizationRetries", "detachRetries", "evaluations"
]);

export function stateQueryStreamsEnabled(env) {
  return env?.STATE_QUERY_STREAMS_ENABLED === true ||
    env?.STATE_QUERY_STREAMS_ENABLED === "true";
}

export function stateQueryErrorForLog(error) {
  // Resolver/transport exceptions may embed arguments or response values.
  const safe = new Error("State-query operation failed.");
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
    safe.status = error.status;
  }
  return safe;
}

export function recordStateQueryMetric(state, name, value = 1) {
  if (!COUNTERS.has(name) || !Number.isFinite(value) || value < 0) return;
  let window = windows.get(state);
  if (!window) {
    window = { startedAtMs: Date.now(), instance: crypto.randomUUID(), counters: {}, maxLagMs: 0 };
    windows.set(state, window);
  }
  window.counters[name] = Math.min(Number.MAX_SAFE_INTEGER, (window.counters[name] ?? 0) + value);
}

export function recordStateQueryLag(state, committedAtMs) {
  recordStateQueryMetric(state, "notifications");
  const window = windows.get(state);
  window.maxLagMs = Math.max(window.maxLagMs, Math.max(0, Date.now() - committedAtMs));
}

export function stateQueryOperationalSnapshot(state) {
  const sql = state.storage.sql;
  const count = (query) => Number(sql.exec(query).one().total);
  return {
    activeSubscriptions: Number(sql.exec(
      "SELECT COUNT(*) AS total FROM state_query_stream_subscriptions WHERE expires_at_ms > ?",
      Date.now()
    ).one().total),
    activeQueries: count("SELECT COUNT(*) AS total FROM state_query_observer_queries WHERE query_state = 'active'"),
    sourceEdges: count("SELECT COUNT(*) AS total FROM state_query_observer_sources"),
    pendingQueries: count("SELECT COUNT(*) AS total FROM state_query_observer_queries WHERE pending_reason IS NOT NULL"),
    historyEvents: count("SELECT COUNT(*) AS total FROM state_query_stream_history"),
    historyBytes: count("SELECT COALESCE(SUM(encoded_bytes), 0) AS total FROM state_query_stream_history"),
    counters: { ...windows.get(state)?.counters },
    maxNotificationLagMs: windows.get(state)?.maxLagMs ?? 0
  };
}

// No timer: logging must never keep an otherwise idle object awake. Counters are
// per-instance windows, not durable/account billing totals. Never accept a query,
// credential, target, source key, error message, or result in this log interface.
export function flushStateQueryMetrics(state, env) {
  const window = windows.get(state);
  if (env?.STATE_QUERY_DIAGNOSTICS !== "true" || !window ||
      Date.now() - window.startedAtMs < 60_000) return;
  console.log(JSON.stringify({
    event: "state_query.operations",
    instance: window.instance,
    windowMs: Date.now() - window.startedAtMs,
    ...stateQueryOperationalSnapshot(state)
  }));
  window.startedAtMs = Date.now();
  window.counters = {};
  window.maxLagMs = 0;
}
