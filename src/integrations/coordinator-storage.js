export const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
const COMPLETED_EXECUTION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function initializeCoordinatorTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS integration_coordinator_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      integration_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_executions (
      source_event_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      source_group_key TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS integration_executions_completed
      ON integration_executions(completed_at_ms, source_event_id);

    CREATE TABLE IF NOT EXISTS integration_effects (
      effect_id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      target_group_key TEXT NOT NULL,
      effect_json TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at_ms INTEGER,
      last_attempt_at_ms INTEGER,
      delivered_at_ms INTEGER,
      last_error_json TEXT,
      result_json TEXT,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS integration_effects_due
      ON integration_effects(state, next_attempt_at_ms, created_at_ms, effect_id);
    CREATE INDEX IF NOT EXISTS integration_effects_execution
      ON integration_effects(source_event_id, created_at_ms, effect_id);
  `);
}

export function retryDelayMs(attempts) {
  return Math.min(
    RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1)),
    RETRY_MAX_DELAY_MS
  );
}

export function deliveryFailure(error) {
  return {
    // Adapter errors can explicitly mark terminal failures. Unexpected errors
    // are retried because they commonly represent transient infrastructure or
    // adapter defects rather than a rejected platform request.
    retryable: error?.retryable !== false,
    code: typeof error?.code === "string"
      ? error.code.slice(0, 100)
      : "unexpected_effect_delivery_error",
    message: (error instanceof Error
      ? error.message
      : "Unknown effect delivery error.").slice(0, 500),
    metadata: error?.metadata && typeof error.metadata === "object"
      ? error.metadata
      : {}
  };
}

function parseJson(value) {
  return typeof value === "string" ? JSON.parse(value) : null;
}

export function publicEffect(row) {
  return {
    id: row.effect_id,
    sourceEventId: row.source_event_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    targetGroupKey: row.target_group_key,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAtMs: row.next_attempt_at_ms,
    lastAttemptAtMs: row.last_attempt_at_ms,
    deliveredAtMs: row.delivered_at_ms,
    lastError: parseJson(row.last_error_json),
    result: parseJson(row.result_json)
  };
}

export function executionStatus(sql, sourceEventId) {
  const execution = sql.exec(
    `SELECT source_event_id, integration_id, source_group_key, correlation_id,
            state, accepted_at_ms, completed_at_ms
     FROM integration_executions WHERE source_event_id = ?`,
    sourceEventId
  ).toArray()[0];
  if (!execution) return null;
  const effects = sql.exec(
    `SELECT effect_id, idempotency_key, kind, target_group_key, state,
            attempts, next_attempt_at_ms, last_attempt_at_ms, delivered_at_ms,
            last_error_json, result_json
     FROM integration_effects
     WHERE source_event_id = ?
     ORDER BY created_at_ms, effect_id`,
    sourceEventId
  ).toArray();
  return {
    sourceEventId: execution.source_event_id,
    integrationId: execution.integration_id,
    sourceGroupKey: execution.source_group_key,
    correlationId: execution.correlation_id,
    state: execution.state,
    acceptedAtMs: execution.accepted_at_ms,
    completedAtMs: execution.completed_at_ms,
    effects: effects.map(publicEffect)
  };
}

export function updateExecutionState(sql, sourceEventId, nowMs = Date.now()) {
  const counts = sql.exec(
    `SELECT
       SUM(CASE WHEN state IN ('pending', 'retry_wait', 'attempting') THEN 1 ELSE 0 END)
         AS nonterminal,
       SUM(CASE WHEN state = 'dead_letter' THEN 1 ELSE 0 END) AS failed
     FROM integration_effects WHERE source_event_id = ?`,
    sourceEventId
  ).toArray()[0];
  if ((counts?.nonterminal ?? 0) > 0) {
    sql.exec(
      `UPDATE integration_executions
       SET state = 'pending', completed_at_ms = NULL
       WHERE source_event_id = ?`,
      sourceEventId
    );
    return;
  }
  sql.exec(
    `UPDATE integration_executions
     SET state = ?, completed_at_ms = ?
     WHERE source_event_id = ?`,
    (counts?.failed ?? 0) > 0 ? "completed_with_failures" : "completed",
    nowMs,
    sourceEventId
  );
}

export function firstDueEffect(sql, nowMs) {
  const row = sql.exec(
    `SELECT effect_id, source_event_id, idempotency_key, kind, target_group_key,
            effect_json, state, attempts, next_attempt_at_ms
     FROM integration_effects
     WHERE state IN ('pending', 'retry_wait', 'attempting')
       AND next_attempt_at_ms <= ?
     ORDER BY next_attempt_at_ms, created_at_ms, effect_id
     LIMIT 1`,
    nowMs
  ).toArray()[0];
  return row ? { ...row, effect: JSON.parse(row.effect_json) } : null;
}

export async function setNextAlarm(state) {
  const next = state.storage.sql.exec(
    `SELECT next_attempt_at_ms
     FROM integration_effects
     WHERE state IN ('pending', 'retry_wait', 'attempting')
       AND next_attempt_at_ms IS NOT NULL
     ORDER BY next_attempt_at_ms, created_at_ms, effect_id
     LIMIT 1`
  ).toArray()[0];
  if (next) {
    await state.storage.setAlarm(Math.max(next.next_attempt_at_ms, Date.now()));
  } else {
    await state.storage.deleteAlarm();
  }
}

export function pruneCompletedExecutions(sql, nowMs) {
  const cutoff = nowMs - COMPLETED_EXECUTION_TTL_MS;
  sql.exec(
    `DELETE FROM integration_effects
     WHERE source_event_id IN (
       SELECT source_event_id FROM integration_executions
       WHERE completed_at_ms IS NOT NULL AND completed_at_ms < ?
     )`,
    cutoff
  );
  sql.exec(
    `DELETE FROM integration_executions
     WHERE completed_at_ms IS NOT NULL AND completed_at_ms < ?`,
    cutoff
  );
}
