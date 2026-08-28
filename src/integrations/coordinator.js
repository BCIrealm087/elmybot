import { jsonResponse, logError } from "../common.js";
import {
  createIntegrationExecution,
  IntegrationContractError
} from "./contracts.js";
import {
  getIntegrationById,
  IntegrationRegistryError
} from "./registry.js";

export const INTEGRATION_COORDINATOR_SCHEMA_VERSION = 1;

const EFFECT_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
const MAX_EFFECTS_PER_ALARM = 20;
const COMPLETED_EXECUTION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DELIVERY_RESULT_BYTES = 32 * 1024;

export class IntegrationCoordinatorError extends Error {
  constructor(message, {
    status = 400,
    code = "integration_coordinator_error"
  } = {}) {
    super(message);
    this.name = "IntegrationCoordinatorError";
    this.status = status;
    this.code = code;
  }
}

export class IntegrationEffectDeliveryError extends Error {
  constructor(message, {
    retryable = false,
    code = "integration_effect_delivery_failed",
    metadata = {},
    cause
  } = {}) {
    super(message, { cause });
    this.name = "IntegrationEffectDeliveryError";
    this.retryable = retryable;
    this.code = code;
    this.metadata = metadata;
  }
}

export function createEffectHandlerRegistry(...handlerSets) {
  const registry = Object.create(null);
  for (const handlerSet of handlerSets) {
    for (const [kind, handler] of Object.entries(handlerSet)) {
      if (registry[kind]) {
        throw new Error(`Duplicate integration effect kind: \`${kind}\`.`);
      }
      if (!EFFECT_KIND_PATTERN.test(kind)) {
        throw new Error(
          `Integration effect kind must be namespaced and versioned: \`${kind}\`.`
        );
      }
      if (
        typeof handler?.platform !== "string" ||
        !PLATFORM_PATTERN.test(handler.platform) ||
        !kind.startsWith(`${handler.platform}.`) ||
        typeof handler?.validateEffect !== "function" ||
        typeof handler?.deliver !== "function"
      ) {
        throw new Error(`Invalid integration effect handler: \`${kind}\`.`);
      }
      registry[kind] = Object.freeze({
        platform: handler.platform,
        validateEffect: handler.validateEffect,
        deliver: handler.deliver
      });
    }
  }
  return Object.freeze(registry);
}

function noStoreJson(value, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])])
    );
  }
  return value;
}

async function executionFingerprint(execution) {
  const canonical = JSON.stringify(stableJsonValue(execution));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function initializeCoordinatorTables(state) {
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

function retryDelayMs(attempts) {
  return Math.min(
    RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1)),
    RETRY_MAX_DELAY_MS
  );
}

function deliveryFailure(error) {
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

function publicEffect(row) {
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

function executionStatus(sql, sourceEventId) {
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

function updateExecutionState(sql, sourceEventId, nowMs = Date.now()) {
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

function firstDueEffect(sql, nowMs) {
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

async function setNextAlarm(state) {
  const next = state.storage.sql.exec(
    `SELECT next_attempt_at_ms
     FROM integration_effects
     WHERE state IN ('pending', 'retry_wait', 'attempting')
       AND next_attempt_at_ms IS NOT NULL
     ORDER BY next_attempt_at_ms, created_at_ms, effect_id
     LIMIT 1`
  ).toArray()[0];
  if (next) await state.storage.setAlarm(next.next_attempt_at_ms);
  else await state.storage.deleteAlarm();
}

function pruneCompletedExecutions(sql, nowMs) {
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

function checkedDeliveryResult(result) {
  let serialized;
  try {
    serialized = JSON.stringify(result ?? null);
  } catch {
    throw new IntegrationEffectDeliveryError(
      "The effect adapter returned a non-serializable result.",
      { retryable: false, code: "invalid_effect_delivery_result" }
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_DELIVERY_RESULT_BYTES) {
    throw new IntegrationEffectDeliveryError(
      "The effect adapter returned an oversized result.",
      { retryable: false, code: "invalid_effect_delivery_result" }
    );
  }
  return serialized;
}

export function integrationCoordinatorObjectName(integrationId) {
  return `integration-coordinator:${integrationId}`;
}

export function integrationCoordinatorStub(env, integrationId) {
  if (!env.INTEGRATION_COORDINATOR) {
    throw new IntegrationCoordinatorError(
      "The integration coordinator is not configured.",
      { status: 503, code: "integration_coordinator_not_configured" }
    );
  }
  if (typeof integrationId !== "string" || integrationId.length === 0) {
    throw new IntegrationCoordinatorError("The integration ID is invalid.", {
      status: 422,
      code: "integration_identity_invalid"
    });
  }
  return env.INTEGRATION_COORDINATOR.get(
    env.INTEGRATION_COORDINATOR.idFromName(
      integrationCoordinatorObjectName(integrationId)
    )
  );
}

async function checkedCoordinatorResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw new IntegrationCoordinatorError(
      result?.error || "The integration coordinator request failed.",
      {
        status: response.status,
        code: result?.code || "integration_coordinator_request_failed"
      }
    );
  }
  return result;
}

export async function submitIntegrationExecution(env, input) {
  const integrationId = input?.integration?.id;
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch("https://integration-coordinator/executions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }));
}

export async function getIntegrationExecution(env, integrationId, sourceEventId) {
  const url = new URL("https://integration-coordinator/executions");
  url.searchParams.set("sourceEventId", sourceEventId);
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch(url));
}

export async function retryIntegrationEffect(env, integrationId, idempotencyKey) {
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch("https://integration-coordinator/effects/retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ integrationId, idempotencyKey })
  }));
}

export class IntegrationCoordinatorBackend {
  constructor(state, env, effectHandlers) {
    this.state = state;
    this.env = env;
    this.effectHandlers = effectHandlers;
    initializeCoordinatorTables(state);
  }

  validateExecution(input) {
    if (input?.schemaVersion !== INTEGRATION_COORDINATOR_SCHEMA_VERSION) {
      throw new IntegrationCoordinatorError(
        "Unsupported integration execution schema version.",
        { status: 422, code: "integration_execution_schema_unsupported" }
      );
    }
    let execution;
    try {
      execution = createIntegrationExecution(input);
    } catch (error) {
      if (error instanceof IntegrationContractError) {
        throw new IntegrationCoordinatorError(error.message, {
          status: 422,
          code: error.code
        });
      }
      throw error;
    }
    for (const effect of execution.effects) {
      const handler = this.effectHandlers[effect.kind];
      if (!handler) {
        throw new IntegrationCoordinatorError(
          `No integration effect handler is registered for \`${effect.kind}\`.`,
          { status: 422, code: "integration_effect_kind_unknown" }
        );
      }
      if (handler.platform !== effect.target.group.platform) {
        throw new IntegrationCoordinatorError(
          "The integration effect kind does not match its target platform.",
          { status: 422, code: "integration_effect_platform_mismatch" }
        );
      }
      const adapterError = handler.validateEffect(effect);
      if (adapterError) {
        throw new IntegrationCoordinatorError(String(adapterError).slice(0, 500), {
          status: 422,
          code: "integration_effect_invalid"
        });
      }
    }
    return execution;
  }

  async requireActiveMembership(execution) {
    let result;
    try {
      result = await getIntegrationById(this.env, execution.integration.id);
    } catch (error) {
      if (error instanceof IntegrationRegistryError && error.status === 404) {
        throw new IntegrationCoordinatorError("The integration was not found.", {
          status: 404,
          code: "integration_not_found"
        });
      }
      throw error;
    }
    const integration = result.integration;
    if (integration.status !== "active") {
      throw new IntegrationCoordinatorError("The integration is not active.", {
        status: 409,
        code: "integration_inactive"
      });
    }
    const memberKeys = new Set(integration.members.map((member) => member.group.key));
    if (!memberKeys.has(execution.source.group.key)) {
      throw new IntegrationCoordinatorError(
        "The execution source does not belong to the integration.",
        { status: 403, code: "integration_source_not_member" }
      );
    }
    for (const effect of execution.effects) {
      if (!memberKeys.has(effect.target.group.key)) {
        throw new IntegrationCoordinatorError(
          "An effect target does not belong to the integration.",
          { status: 403, code: "integration_target_not_member" }
        );
      }
    }
    return integration;
  }

  replayIfPresent(execution, fingerprint) {
    const meta = this.state.storage.sql.exec(
      "SELECT integration_id FROM integration_coordinator_meta WHERE singleton = 1"
    ).toArray()[0];
    if (meta && meta.integration_id !== execution.integration.id) {
      throw new IntegrationCoordinatorError(
        "This coordinator belongs to a different integration.",
        { status: 409, code: "integration_coordinator_identity_mismatch" }
      );
    }
    const existing = this.state.storage.sql.exec(
      `SELECT request_fingerprint FROM integration_executions
       WHERE source_event_id = ?`,
      execution.sourceEventId
    ).toArray()[0];
    if (!existing) return null;
    if (existing.request_fingerprint !== fingerprint) {
      throw new IntegrationCoordinatorError(
        "The execution source event was already used with different effects.",
        { status: 409, code: "integration_execution_conflict" }
      );
    }
    return {
      ...executionStatus(this.state.storage.sql, execution.sourceEventId),
      replayed: true
    };
  }

  async submit(input) {
    const execution = this.validateExecution(input);
    this.state.storage.transactionSync(() => {
      pruneCompletedExecutions(this.state.storage.sql, Date.now());
    });
    const fingerprint = await executionFingerprint(execution);
    const replay = this.replayIfPresent(execution, fingerprint);
    if (replay) return replay;

    await this.requireActiveMembership(execution);
    const acceptedAtMs = Date.now();

    const result = this.state.storage.transactionSync(() => {
      const concurrentReplay = this.replayIfPresent(execution, fingerprint);
      if (concurrentReplay) return concurrentReplay;
      const meta = this.state.storage.sql.exec(
        "SELECT integration_id FROM integration_coordinator_meta WHERE singleton = 1"
      ).toArray()[0];
      if (!meta) {
        this.state.storage.sql.exec(
          `INSERT INTO integration_coordinator_meta (singleton, integration_id)
           VALUES (1, ?)`,
          execution.integration.id
        );
      }

      for (const effect of execution.effects) {
        const conflict = this.state.storage.sql.exec(
          `SELECT source_event_id FROM integration_effects
           WHERE idempotency_key = ?`,
          effect.idempotencyKey
        ).toArray()[0];
        if (conflict) {
          throw new IntegrationCoordinatorError(
            "An effect idempotency key has already been used.",
            { status: 409, code: "integration_effect_idempotency_conflict" }
          );
        }
      }

      const state = execution.effects.length === 0 ? "completed" : "pending";
      this.state.storage.sql.exec(
        `INSERT INTO integration_executions
          (source_event_id, integration_id, source_group_key, correlation_id,
           request_fingerprint, state, accepted_at_ms, completed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        execution.sourceEventId,
        execution.integration.id,
        execution.source.group.key,
        execution.correlationId,
        fingerprint,
        state,
        acceptedAtMs,
        state === "completed" ? acceptedAtMs : null
      );
      for (const effect of execution.effects) {
        this.state.storage.sql.exec(
          `INSERT INTO integration_effects
            (effect_id, source_event_id, idempotency_key, kind,
             target_group_key, effect_json, state, attempts,
             next_attempt_at_ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          crypto.randomUUID(),
          execution.sourceEventId,
          effect.idempotencyKey,
          effect.kind,
          effect.target.group.key,
          JSON.stringify(effect),
          acceptedAtMs,
          acceptedAtMs
        );
      }
      return { ...executionStatus(this.state.storage.sql, execution.sourceEventId), replayed: false };
    });

    await setNextAlarm(this.state);
    return result;
  }

  retryEffect(input) {
    if (
      typeof input?.integrationId !== "string" ||
      typeof input?.idempotencyKey !== "string" ||
      input.idempotencyKey.length === 0
    ) {
      throw new IntegrationCoordinatorError("The retry request is invalid.", {
        status: 422,
        code: "integration_effect_retry_invalid"
      });
    }
    const nowMs = Date.now();
    return this.state.storage.transactionSync(() => {
      const meta = this.state.storage.sql.exec(
        "SELECT integration_id FROM integration_coordinator_meta WHERE singleton = 1"
      ).toArray()[0];
      if (!meta || meta.integration_id !== input.integrationId) {
        throw new IntegrationCoordinatorError("The integration was not found.", {
          status: 404,
          code: "integration_not_found"
        });
      }
      const effect = this.state.storage.sql.exec(
        `SELECT effect_id, source_event_id, state FROM integration_effects
         WHERE idempotency_key = ?`,
        input.idempotencyKey
      ).toArray()[0];
      if (!effect) {
        throw new IntegrationCoordinatorError("The integration effect was not found.", {
          status: 404,
          code: "integration_effect_not_found"
        });
      }
      if (effect.state !== "dead_letter") {
        throw new IntegrationCoordinatorError(
          "Only dead-lettered integration effects can be retried.",
          { status: 409, code: "integration_effect_not_dead_lettered" }
        );
      }
      this.state.storage.sql.exec(
        `UPDATE integration_effects
         SET state = 'pending', attempts = 0, next_attempt_at_ms = ?,
             last_attempt_at_ms = NULL, last_error_json = NULL
         WHERE effect_id = ?`,
        nowMs,
        effect.effect_id
      );
      updateExecutionState(this.state.storage.sql, effect.source_event_id, nowMs);
      return executionStatus(this.state.storage.sql, effect.source_event_id);
    });
  }

  claimEffect(effect, attemptedAtMs) {
    return this.state.storage.transactionSync(() => {
      const current = this.state.storage.sql.exec(
        `SELECT effect_id, source_event_id, idempotency_key, kind,
                target_group_key, effect_json, state, attempts,
                next_attempt_at_ms
         FROM integration_effects WHERE effect_id = ?`,
        effect.effect_id
      ).toArray()[0];
      if (!current || !["pending", "retry_wait", "attempting"].includes(current.state)) {
        return null;
      }
      const attempts = current.attempts + 1;
      this.state.storage.sql.exec(
        `UPDATE integration_effects
         SET state = 'attempting', attempts = ?, next_attempt_at_ms = ?,
             last_attempt_at_ms = ?
         WHERE effect_id = ?`,
        attempts,
        attemptedAtMs,
        attemptedAtMs,
        current.effect_id
      );
      return { ...current, attempts, effect: JSON.parse(current.effect_json) };
    });
  }

  completeEffect(effect, resultJson) {
    const deliveredAtMs = Date.now();
    this.state.storage.transactionSync(() => {
      const current = this.state.storage.sql.exec(
        "SELECT state FROM integration_effects WHERE effect_id = ?",
        effect.effect_id
      ).toArray()[0];
      if (current?.state !== "attempting") return;
      this.state.storage.sql.exec(
        `UPDATE integration_effects
         SET state = 'delivered', next_attempt_at_ms = NULL,
             delivered_at_ms = ?, last_error_json = NULL, result_json = ?
         WHERE effect_id = ?`,
        deliveredAtMs,
        resultJson,
        effect.effect_id
      );
      updateExecutionState(this.state.storage.sql, effect.source_event_id, deliveredAtMs);
    });
  }

  failEffect(effect, error) {
    const failedAtMs = Date.now();
    const failure = deliveryFailure(error);
    logError("integration.effect_delivery_failed", {
      platform: effect.effect?.target?.group?.platform ?? "shared",
      correlationId: effect.effect?.correlationId ?? effect.source_event_id,
      groupId: effect.effect?.target?.group?.id ?? null,
      integrationId: effect.effect?.integration?.id ?? null,
      effectKind: effect.kind,
      idempotencyKey: effect.idempotency_key,
      attempt: effect.attempts,
      retryable: failure.retryable
    }, error);

    this.state.storage.transactionSync(() => {
      const current = this.state.storage.sql.exec(
        "SELECT state, attempts FROM integration_effects WHERE effect_id = ?",
        effect.effect_id
      ).toArray()[0];
      if (current?.state !== "attempting") return;
      const lastError = JSON.stringify({
        code: failure.code,
        message: failure.message,
        metadata: failure.metadata,
        failedAtMs
      });
      if (failure.retryable && current.attempts < MAX_DELIVERY_ATTEMPTS) {
        this.state.storage.sql.exec(
          `UPDATE integration_effects
           SET state = 'retry_wait', next_attempt_at_ms = ?, last_error_json = ?
           WHERE effect_id = ?`,
          failedAtMs + retryDelayMs(current.attempts),
          lastError,
          effect.effect_id
        );
      } else {
        this.state.storage.sql.exec(
          `UPDATE integration_effects
           SET state = 'dead_letter', next_attempt_at_ms = NULL,
               last_error_json = ?
           WHERE effect_id = ?`,
          lastError,
          effect.effect_id
        );
        updateExecutionState(this.state.storage.sql, effect.source_event_id, failedAtMs);
      }
    });
  }

  deadLetterRemaining(code, message) {
    const failedAtMs = Date.now();
    this.state.storage.transactionSync(() => {
      const rows = this.state.storage.sql.exec(
        `SELECT DISTINCT source_event_id FROM integration_effects
         WHERE state IN ('pending', 'retry_wait', 'attempting')`
      ).toArray();
      this.state.storage.sql.exec(
        `UPDATE integration_effects
         SET state = 'dead_letter', next_attempt_at_ms = NULL,
             last_error_json = ?
         WHERE state IN ('pending', 'retry_wait', 'attempting')`,
        JSON.stringify({ code, message, metadata: {}, failedAtMs })
      );
      for (const row of rows) {
        updateExecutionState(this.state.storage.sql, row.source_event_id, failedAtMs);
      }
    });
  }

  async integrationForDelivery(integrationId) {
    try {
      const result = await getIntegrationById(this.env, integrationId);
      return result.integration;
    } catch (error) {
      if (error instanceof IntegrationRegistryError && error.status === 404) return null;
      throw error;
    }
  }

  async alarm() {
    const meta = this.state.storage.sql.exec(
      "SELECT integration_id FROM integration_coordinator_meta WHERE singleton = 1"
    ).toArray()[0];
    if (!meta) {
      await this.state.storage.deleteAlarm();
      return;
    }

    let resetAlarmFromOutbox = true;
    try {
      const integration = await this.integrationForDelivery(meta.integration_id);
      if (!integration || integration.status !== "active") {
        this.deadLetterRemaining(
          "integration_inactive",
          "The integration is no longer active."
        );
        return;
      }
      const memberKeys = new Set(integration.members.map((member) => member.group.key));

      for (let processed = 0; processed < MAX_EFFECTS_PER_ALARM; processed++) {
        const due = firstDueEffect(this.state.storage.sql, Date.now());
        if (!due) break;
        const claimed = this.claimEffect(due, Date.now());
        if (!claimed) continue;

        const handler = this.effectHandlers[claimed.kind];
        try {
          if (!memberKeys.has(claimed.target_group_key)) {
            throw new IntegrationEffectDeliveryError(
              "The effect target no longer belongs to the integration.",
              { retryable: false, code: "integration_target_not_member" }
            );
          }
          if (!handler) {
            throw new IntegrationEffectDeliveryError(
              "No delivery handler is registered for this effect type.",
              { retryable: false, code: "integration_effect_kind_unknown" }
            );
          }
          const result = await handler.deliver(this.env, claimed.effect);
          this.completeEffect(claimed, checkedDeliveryResult(result));
        } catch (error) {
          this.failEffect(claimed, error);
        }
      }
      this.state.storage.transactionSync(() => {
        pruneCompletedExecutions(this.state.storage.sql, Date.now());
      });
    } catch (error) {
      logError("integration.coordinator_alarm_failed", {
        platform: "shared",
        correlationId: `integration:${meta.integration_id}`,
        integrationId: meta.integration_id
      }, error);
      resetAlarmFromOutbox = false;
      await this.state.storage.setAlarm(Date.now() + RETRY_BASE_DELAY_MS);
      return;
    } finally {
      if (resetAlarmFromOutbox) await setNextAlarm(this.state);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/executions") {
        let input;
        try {
          input = await request.json();
        } catch {
          throw new IntegrationCoordinatorError("Request body must be valid JSON.");
        }
        const result = await this.submit(input);
        return noStoreJson(result, result.replayed ? 200 : 202);
      }
      if (request.method === "GET" && url.pathname === "/executions") {
        const sourceEventId = url.searchParams.get("sourceEventId");
        if (!sourceEventId) {
          throw new IntegrationCoordinatorError("A source event ID is required.", {
            status: 422,
            code: "integration_execution_id_required"
          });
        }
        const result = executionStatus(this.state.storage.sql, sourceEventId);
        if (!result) {
          throw new IntegrationCoordinatorError("The execution was not found.", {
            status: 404,
            code: "integration_execution_not_found"
          });
        }
        return noStoreJson(result);
      }
      if (request.method === "GET" && url.pathname === "/dead-letters") {
        const rows = this.state.storage.sql.exec(
          `SELECT effect_id, source_event_id, idempotency_key, kind,
                  target_group_key, state, attempts, next_attempt_at_ms,
                  last_attempt_at_ms, delivered_at_ms, last_error_json,
                  result_json
           FROM integration_effects
           WHERE state = 'dead_letter'
           ORDER BY last_attempt_at_ms DESC, created_at_ms DESC
           LIMIT 25`
        ).toArray();
        const total = this.state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_effects
           WHERE state = 'dead_letter'`
        ).one().total;
        return noStoreJson({ total, effects: rows.map(publicEffect) });
      }
      if (request.method === "POST" && url.pathname === "/effects/retry") {
        let input;
        try {
          input = await request.json();
        } catch {
          throw new IntegrationCoordinatorError("Request body must be valid JSON.");
        }
        const result = this.retryEffect(input);
        await setNextAlarm(this.state);
        return noStoreJson(result);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof IntegrationCoordinatorError) {
        return noStoreJson({ error: error.message, code: error.code }, error.status);
      }
      if (error instanceof IntegrationRegistryError) {
        return noStoreJson({ error: error.message, code: error.code }, error.status);
      }
      const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
      logError("integration.coordinator_request_failed", {
        platform: "shared",
        correlationId,
        method: request.method,
        route: url.pathname
      }, error);
      return noStoreJson({ error: "The integration coordinator failed.", correlationId }, 500);
    }
  }
}
