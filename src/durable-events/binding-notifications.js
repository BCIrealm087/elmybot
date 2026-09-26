import { logError } from "../common.js";
import { createPlatformGroupRef } from "../integrations/contracts.js";
import { validatedPlatform } from "../integrations/registry-validation.js";
import {
  DURABLE_EVENT_BINDING_PATH,
  durableEventInternalHeaders
} from "./stream.js";

const ROUTE_ID_PATTERN = /^des1\.[A-Za-z0-9_-]{43}$/;
const MIN_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_WATCHERS_PER_BINDING = 2_000;
const MAX_WATCHERS_PER_REGISTRY = 20_000;
const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_CONCURRENCY = 4;
const ATTEMPT_LEASE_MS = 30 * 1_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30 * 1_000;

export class DurableEventBindingError extends Error {
  constructor(message, {
    status = 422,
    code = "durable_event_binding_invalid"
  } = {}) {
    super(message);
    this.name = "DurableEventBindingError";
    this.status = status;
    this.code = code;
  }
}

function fail(message, options) {
  throw new DurableEventBindingError(message, options);
}

function direction(sourceGroupInput, targetPlatformInput) {
  let sourceGroup;
  try {
    sourceGroup = createPlatformGroupRef(sourceGroupInput);
  } catch {
    fail("Durable event binding group is invalid.");
  }
  const targetPlatform = validatedPlatform(
    targetPlatformInput,
    "Durable event binding target platform"
  );
  if (sourceGroup.platform === targetPlatform) {
    fail("A durable event binding must target another platform.");
  }
  return { sourceGroup, targetPlatform };
}

function environment(env) {
  const value = env?.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT;
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,40}$/.test(value)) {
    fail("Durable event binding environment is unavailable.", {
      status: 503,
      code: "durable_event_service_unavailable"
    });
  }
  return value;
}

function normalizedRegistration(env, input, nowMs) {
  const normalizedDirection = direction(input?.sourceGroup, input?.targetPlatform);
  if (!ROUTE_ID_PATTERN.test(input?.routeId ?? "")) {
    fail("Durable event binding route is invalid.");
  }
  if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) {
    fail("Durable event binding revision is invalid.");
  }
  if (
    typeof input?.expectedSourceKey !== "string" ||
    input.expectedSourceKey.length === 0 ||
    input.expectedSourceKey.length > 500
  ) {
    fail("Durable event binding source is invalid.");
  }
  if (
    !Number.isSafeInteger(input?.expiresAtMs) ||
    input.expiresAtMs < nowMs + MIN_LIFETIME_MS ||
    input.expiresAtMs > nowMs + MAX_LIFETIME_MS
  ) {
    fail("Durable event binding expiry is invalid.");
  }
  if (input?.environment !== environment(env)) {
    fail("Durable event binding environment does not match this deployment.", {
      status: 403,
      code: "durable_event_binding_environment_mismatch"
    });
  }
  return {
    ...normalizedDirection,
    routeId: input.routeId,
    expectedRevision: input.expectedRevision,
    expectedSourceKey: input.expectedSourceKey,
    expiresAtMs: input.expiresAtMs,
    environment: input.environment
  };
}

export function pruneDurableEventBindingNotifications(sql, nowMs = Date.now()) {
  sql.exec(
    "DELETE FROM durable_event_binding_outbox WHERE expires_at_ms <= ?",
    nowMs
  );
  sql.exec(
    "DELETE FROM durable_event_binding_watchers WHERE expires_at_ms <= ?",
    nowMs
  );
}

export function registerDurableEventBindingWatcher(
  state,
  env,
  input,
  currentBinding,
  nowMs = Date.now()
) {
  const watcher = normalizedRegistration(env, input, nowMs);
  const revisionMatched = currentBinding?.status === "ready" &&
    currentBinding.revision === watcher.expectedRevision &&
    currentBinding.sourceKey === watcher.expectedSourceKey;
  if (!revisionMatched) {
    return {
      registered: false,
      revisionMatched: false,
      current: currentBinding
    };
  }
  return state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    pruneDurableEventBindingNotifications(sql, nowMs);
    const existing = sql.exec(
      `SELECT expected_source_key FROM durable_event_binding_watchers
       WHERE source_group_key = ? AND target_platform = ? AND route_id = ?`,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.routeId
    ).toArray()[0];
    if (!existing) {
      const total = Number(sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_binding_watchers"
      ).one().total);
      const bindingTotal = Number(sql.exec(
        `SELECT COUNT(*) AS total FROM durable_event_binding_watchers
         WHERE source_group_key = ? AND target_platform = ?`,
        watcher.sourceGroup.key,
        watcher.targetPlatform
      ).one().total);
      if (total >= MAX_WATCHERS_PER_REGISTRY ||
          bindingTotal >= MAX_WATCHERS_PER_BINDING) {
        fail("Durable event binding watcher capacity is exhausted.", {
          status: 429,
          code: "durable_event_stream_full"
        });
      }
    }
    sql.exec(
      `INSERT INTO durable_event_binding_watchers
       (source_group_key, target_platform, route_id, environment,
        expected_revision, expected_source_key, expires_at_ms,
        created_at_ms, renewed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_group_key, target_platform, route_id) DO UPDATE SET
         environment = excluded.environment,
         expected_revision = excluded.expected_revision,
         expected_source_key = excluded.expected_source_key,
         expires_at_ms = excluded.expires_at_ms,
         renewed_at_ms = excluded.renewed_at_ms`,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.routeId,
      watcher.environment,
      watcher.expectedRevision,
      watcher.expectedSourceKey,
      watcher.expiresAtMs,
      nowMs,
      nowMs
    );
    return {
      registered: true,
      revisionMatched: true,
      current: currentBinding
    };
  });
}

export function advanceDurableEventBindings(state, input, revision) {
  const normalized = direction(input.sourceGroup, input.targetPlatform);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("Durable event binding revision is invalid.");
  }
  pruneDurableEventBindingNotifications(state.storage.sql, nowMs);
  state.storage.sql.exec(
    `INSERT INTO durable_event_binding_outbox
     (notification_id, source_group_key, target_platform, route_id,
      environment, previous_revision, previous_source_key, binding_revision,
      binding_status, source_key, reason, committed_at_ms, expires_at_ms,
      attempt_count, next_attempt_at_ms)
     SELECT lower(hex(randomblob(16))), watcher.source_group_key,
            watcher.target_platform, watcher.route_id, watcher.environment,
            watcher.expected_revision, watcher.expected_source_key,
            ?, ?, ?, ?, ?, watcher.expires_at_ms, 0, 0
     FROM durable_event_binding_watchers watcher
     WHERE watcher.source_group_key = ? AND watcher.target_platform = ?
       AND watcher.expires_at_ms > ? AND watcher.expected_revision < ?
     ON CONFLICT(source_group_key, target_platform, route_id) DO UPDATE SET
       notification_id = excluded.notification_id,
       binding_revision = excluded.binding_revision,
       binding_status = excluded.binding_status,
       source_key = excluded.source_key,
       reason = excluded.reason,
       committed_at_ms = excluded.committed_at_ms,
       attempt_count = 0,
       next_attempt_at_ms = 0`,
    revision,
    input.status,
    input.sourceKey,
    input.reason,
    nowMs,
    normalized.sourceGroup.key,
    normalized.targetPlatform,
    nowMs,
    revision
  );
}

function claimDue(state, nowMs) {
  return state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    pruneDurableEventBindingNotifications(sql, nowMs);
    const rows = sql.exec(
      `SELECT * FROM durable_event_binding_outbox
       WHERE next_attempt_at_ms <= ?
       ORDER BY next_attempt_at_ms, committed_at_ms
       LIMIT ?`,
      nowMs,
      DELIVERY_BATCH_SIZE
    ).toArray();
    for (const row of rows) {
      sql.exec(
        `UPDATE durable_event_binding_outbox
         SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?
         WHERE notification_id = ? AND next_attempt_at_ms <= ?`,
        nowMs + ATTEMPT_LEASE_MS,
        row.notification_id,
        nowMs
      );
    }
    return rows;
  });
}

async function deliverOne(state, env, row, nowMs) {
  let delivered = false;
  try {
    if (!env?.DURABLE_EVENT_STREAM) throw new Error("Stream binding is unavailable.");
    const response = await env.DURABLE_EVENT_STREAM.get(
      env.DURABLE_EVENT_STREAM.idFromName(row.route_id)
    ).fetch(`https://durable-event-stream${DURABLE_EVENT_BINDING_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...durableEventInternalHeaders
      },
      body: JSON.stringify({
        notificationId: row.notification_id,
        routeId: row.route_id,
        environment: row.environment,
        sourceGroupKey: row.source_group_key,
        targetPlatform: row.target_platform,
        previousRevision: Number(row.previous_revision),
        previousSourceKey: row.previous_source_key,
        revision: Number(row.binding_revision),
        status: row.binding_status,
        sourceKey: row.source_key,
        reason: row.reason,
        committedAtMs: Number(row.committed_at_ms)
      })
    });
    if (!response.ok) {
      await response.text();
      throw new Error(`Stream rejected binding notification: ${response.status}.`);
    }
    await response.text();
    delivered = true;
  } catch (error) {
    logError("durable_event.binding_notification_delivery_failed", {
      platform: "shared",
      correlationId: `durable-event-binding:${row.notification_id}`,
      attempt: Number(row.attempt_count) + 1
    }, error);
  }
  state.storage.transactionSync(() => {
    if (delivered) {
      state.storage.sql.exec(
        "DELETE FROM durable_event_binding_outbox WHERE notification_id = ?",
        row.notification_id
      );
      state.storage.sql.exec(
        `DELETE FROM durable_event_binding_watchers
         WHERE source_group_key = ? AND target_platform = ? AND route_id = ?
           AND expected_revision = ? AND expected_source_key = ?`,
        row.source_group_key,
        row.target_platform,
        row.route_id,
        Number(row.previous_revision),
        row.previous_source_key
      );
      return;
    }
    const attempt = Number(row.attempt_count) + 1;
    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * (2 ** Math.min(5, attempt - 1))
    );
    state.storage.sql.exec(
      `UPDATE durable_event_binding_outbox SET next_attempt_at_ms = ?
       WHERE notification_id = ?`,
      nowMs + delay,
      row.notification_id
    );
  });
}

export async function drainDurableEventBindingNotifications(state, env) {
  const nowMs = Date.now();
  const rows = claimDue(state, nowMs);
  for (let index = 0; index < rows.length; index += DELIVERY_CONCURRENCY) {
    await Promise.all(rows.slice(index, index + DELIVERY_CONCURRENCY).map((row) =>
      deliverOne(state, env, row, nowMs)
    ));
  }
  return { attempted: rows.length };
}

export async function prepareDurableEventBindingMutation(state) {
  const nowMs = Date.now();
  pruneDurableEventBindingNotifications(state.storage.sql, nowMs);
  const active = state.storage.sql.exec(
    `SELECT 1 AS active FROM durable_event_binding_watchers
     WHERE expires_at_ms > ? LIMIT 1`,
    nowMs
  ).toArray()[0];
  if (!active) return false;
  const current = await state.storage.getAlarm();
  const next = nowMs + RETRY_BASE_MS;
  if (current === null || current > next) await state.storage.setAlarm(next);
  return true;
}
