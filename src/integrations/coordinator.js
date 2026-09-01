import { jsonResponse, logError } from "../common.js";
import { alarmDrainTimeRemaining } from "../alarm-drain.js";
import {
  createIntegrationRef,
  createIntegrationExecution,
  createPlatformGroupRef,
  IntegrationContractError
} from "./contracts.js";
import {
  FeatureStorageUserFacingError,
  handleFeatureStateStorageOperation,
  initializeFeatureStorageTables,
  INTEGRATION_FEATURE_STATE_PATH_PREFIX
} from "../framework/feature-storage.js";
import {
  getIntegrationById,
  IntegrationRegistryError
} from "./registry.js";
import {
  IntegrationCoordinatorError,
  IntegrationEffectDeliveryError
} from "./coordinator-errors.js";
import {
  deliveryFailure,
  executionStatus,
  firstDueEffect,
  initializeCoordinatorTables,
  pruneCompletedExecutions,
  publicEffect,
  RETRY_BASE_DELAY_MS,
  retryDelayMs,
  setNextAlarm,
  updateExecutionState
} from "./coordinator-storage.js";

export {
  getIntegrationCoordinatorStatus,
  getIntegrationDeadLetters,
  getIntegrationExecution,
  integrationCoordinatorObjectName,
  integrationCoordinatorStub,
  retryIntegrationEffect,
  submitIntegrationExecution
} from "./coordinator-client.js";
export {
  IntegrationCoordinatorError,
  IntegrationEffectDeliveryError
} from "./coordinator-errors.js";

export const INTEGRATION_COORDINATOR_SCHEMA_VERSION = 1;

const EFFECT_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_EFFECTS_PER_ALARM = 20;
const MAX_DELIVERY_RESULT_BYTES = 32 * 1024;
const ATTEMPT_LEASE_MS = 30 * 1000;

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

export class IntegrationCoordinatorBackend {
  constructor(state, env, effectHandlers) {
    this.state = state;
    this.env = env;
    this.effectHandlers = effectHandlers;
    initializeCoordinatorTables(state);
    initializeFeatureStorageTables(state);
  }

  ensureCoordinatorIdentity(integrationId) {
    const meta = this.state.storage.sql.exec(
      "SELECT integration_id FROM integration_coordinator_meta WHERE singleton = 1"
    ).toArray()[0];
    if (meta && meta.integration_id !== integrationId) {
      throw new IntegrationCoordinatorError(
        "This coordinator belongs to a different integration.",
        { status: 409, code: "integration_coordinator_identity_mismatch" }
      );
    }
    if (!meta) {
      this.state.storage.sql.exec(
        `INSERT INTO integration_coordinator_meta (singleton, integration_id)
         VALUES (1, ?)`,
        integrationId
      );
    }
  }

  async featureStateRequest(input, operation) {
    let integration;
    let sourceGroup;
    let targetGroup;
    try {
      integration = createIntegrationRef(input?.integration);
      sourceGroup = createPlatformGroupRef(input?.sourceGroup);
      targetGroup = createPlatformGroupRef(input?.targetGroup);
    } catch (error) {
      if (error instanceof IntegrationContractError) {
        throw new IntegrationCoordinatorError(
          "The integration feature-state scope is invalid.",
          { status: 422, code: "integration_feature_state_scope_invalid" }
        );
      }
      throw error;
    }
    if (sourceGroup.platform === targetGroup.platform) {
      throw new IntegrationCoordinatorError(
        "Integration feature state requires groups on different platforms.",
        { status: 422, code: "integration_feature_state_scope_invalid" }
      );
    }

    let result;
    try {
      result = await getIntegrationById(this.env, integration.id);
    } catch (error) {
      if (error instanceof IntegrationRegistryError && error.status === 404) {
        throw new IntegrationCoordinatorError("The integration was not found.", {
          status: 404,
          code: "integration_not_found"
        });
      }
      throw error;
    }
    if (result.integration.status !== "active") {
      throw new IntegrationCoordinatorError("The integration is not active.", {
        status: 409,
        code: "integration_inactive"
      });
    }
    const memberKeys = new Set(
      result.integration.members.map((member) => member.group.key)
    );
    if (!memberKeys.has(sourceGroup.key) || !memberKeys.has(targetGroup.key)) {
      throw new IntegrationCoordinatorError(
        "The integration feature-state scope contains a non-member group.",
        { status: 403, code: "integration_feature_state_member_invalid" }
      );
    }

    this.ensureCoordinatorIdentity(integration.id);
    return await handleFeatureStateStorageOperation(
      this.state,
      operation,
      input?.storage
    );
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
      this.ensureCoordinatorIdentity(execution.integration.id);

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
        attemptedAtMs + ATTEMPT_LEASE_MS,
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
    const startedAtMs = Date.now();
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
        if (!alarmDrainTimeRemaining(startedAtMs, processed)) break;
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
      if (
        request.method === "POST" &&
        url.pathname.startsWith(INTEGRATION_FEATURE_STATE_PATH_PREFIX)
      ) {
        let input;
        try {
          input = await request.json();
        } catch {
          throw new IntegrationCoordinatorError("Request body must be valid JSON.");
        }
        const operation = url.pathname.slice(
          INTEGRATION_FEATURE_STATE_PATH_PREFIX.length
        );
        const result = await this.featureStateRequest(input, operation);
        if (result === null) return new Response("Not found", { status: 404 });
        return noStoreJson(result);
      }
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
      if (request.method === "GET" && url.pathname === "/status") {
        const meta = this.state.storage.sql.exec(
          "SELECT integration_id FROM integration_coordinator_meta WHERE singleton = 1"
        ).toArray()[0];
        if (meta && meta.integration_id !== url.searchParams.get("integrationId") &&
            url.searchParams.has("integrationId")) {
          throw new IntegrationCoordinatorError(
            "This coordinator belongs to a different integration.",
            { status: 409, code: "integration_coordinator_identity_mismatch" }
          );
        }
        const executionRows = this.state.storage.sql.exec(
          "SELECT state, COUNT(*) AS total FROM integration_executions GROUP BY state"
        ).toArray();
        const effectRows = this.state.storage.sql.exec(
          "SELECT state, COUNT(*) AS total FROM integration_effects GROUP BY state"
        ).toArray();
        return noStoreJson({
          initialized: Boolean(meta),
          integrationId: meta?.integration_id ?? null,
          executions: Object.fromEntries(executionRows.map((row) => [row.state, row.total])),
          effects: Object.fromEntries(effectRows.map((row) => [row.state, row.total])),
          alarmAtMs: await this.state.storage.getAlarm()
        });
      }
      if (request.method === "GET" && url.pathname === "/dead-letters") {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 10 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
          throw new IntegrationCoordinatorError("limit must be between 1 and 25.", {
            status: 422,
            code: "integration_dead_letter_limit_invalid"
          });
        }
        const rows = this.state.storage.sql.exec(
          `SELECT effect_id, source_event_id, idempotency_key, kind,
                  target_group_key, state, attempts, next_attempt_at_ms,
                  last_attempt_at_ms, delivered_at_ms, last_error_json,
                  result_json
           FROM integration_effects
           WHERE state = 'dead_letter'
           ORDER BY last_attempt_at_ms DESC, created_at_ms DESC
           LIMIT ?`,
          limit
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
      if (error instanceof FeatureStorageUserFacingError) {
        return noStoreJson({ userFacingError: error.message }, error.status);
      }
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
