import { logError } from "../common.js";
import { stateQueryErrorForLog } from "./operations.js";
import { createPlatformGroupRef } from "../integrations/contracts.js";
import {
  parseGroupKey,
  validatedPlatform
} from "../integrations/registry-validation.js";
import { stateQueryEnvironment } from "./grant-client.js";
import {
  StateQueryNotificationError,
  stateQueryObserverObjectName
} from "./source-notifications.js";

const WATCHER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 5 * 60;
const DEFAULT_LEASE_SECONDS = 2 * 60;
const MAX_WATCHERS_PER_BINDING = 2_000;
const MAX_WATCHERS_PER_REGISTRY = 20_000;
const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_CONCURRENCY = 4;
const ATTEMPT_LEASE_MS = 30 * 1000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30 * 1000;
const BINDING_STATUSES = new Set(["ready", "transitioning", "unavailable"]);

export const STATE_QUERY_BINDING_LIMITS = Object.freeze({
  minLeaseSeconds: MIN_LEASE_SECONDS,
  maxLeaseSeconds: MAX_LEASE_SECONDS,
  defaultLeaseSeconds: DEFAULT_LEASE_SECONDS,
  maxWatchersPerBinding: MAX_WATCHERS_PER_BINDING,
  maxWatchersPerRegistry: MAX_WATCHERS_PER_REGISTRY,
  deliveryBatchSize: DELIVERY_BATCH_SIZE
});

function fail(message, options) {
  throw new StateQueryNotificationError(message, options);
}

function normalizedGroup(value) {
  try {
    return createPlatformGroupRef(value);
  } catch {
    fail("Binding watcher group is invalid.");
  }
}

function normalizedDirection(sourceGroupInput, targetPlatformInput) {
  const sourceGroup = normalizedGroup(sourceGroupInput);
  const targetPlatform = validatedPlatform(
    targetPlatformInput,
    "State-query binding target platform"
  );
  if (sourceGroup.platform === targetPlatform) {
    fail("A state-query binding must target another platform.");
  }
  return { sourceGroup, targetPlatform };
}

function normalizedWatcher(env, input) {
  const { sourceGroup, targetPlatform } = normalizedDirection(
    input?.sourceGroup,
    input?.targetPlatform
  );
  const watcherId = input?.watcherId;
  if (
    typeof watcherId !== "string" ||
    watcherId.length > 120 ||
    !WATCHER_ID_PATTERN.test(watcherId)
  ) {
    fail("Binding watcher ID is invalid.");
  }
  const expectedRevision = input?.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail("Binding watcher expected revision is invalid.");
  }
  const leaseSeconds = input?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < MIN_LEASE_SECONDS ||
    leaseSeconds > MAX_LEASE_SECONDS
  ) {
    fail(
      `Binding watcher lease must be between ${MIN_LEASE_SECONDS} and ` +
      `${MAX_LEASE_SECONDS} seconds.`
    );
  }
  const environment = stateQueryEnvironment(env);
  if (input?.environment !== environment) {
    fail("Binding watcher environment does not match this deployment.", {
      status: 403,
      code: "state_query_notification_environment_mismatch"
    });
  }
  return Object.freeze({
    sourceGroup,
    targetPlatform,
    watcherId,
    expectedRevision,
    leaseSeconds,
    environment,
    observerKey: stateQueryObserverObjectName(environment, sourceGroup)
  });
}

function normalizedBindingState(value) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0) {
    fail("State-query binding revision is invalid.");
  }
  if (!BINDING_STATUSES.has(value?.status)) {
    fail("State-query binding status is invalid.");
  }
  if (
    value.sourceKey !== null &&
    value.sourceKey !== undefined &&
    (typeof value.sourceKey !== "string" || /^\S{1,500}$/.test(value.sourceKey) === false)
  ) {
    fail("State-query binding source is invalid.");
  }
  if (
    typeof value?.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 80 ||
    !/^[a-z][a-z0-9_]*$/.test(value.reason)
  ) {
    fail("State-query binding reason is invalid.");
  }
  return {
    revision: value.revision,
    status: value.status,
    sourceKey: value.sourceKey ?? null,
    reason: value.reason
  };
}

export function stateQueryBindingSourceKey(sourceGroupInput, targetPlatformInput) {
  const { sourceGroup, targetPlatform } = normalizedDirection(
    sourceGroupInput,
    targetPlatformInput
  );
  return `effective-shareable:${sourceGroup.key}:${targetPlatform}`;
}

export function pruneStateQueryBindingNotifications(sql, nowMs = Date.now()) {
  sql.exec(
    "DELETE FROM state_query_binding_outbox WHERE lease_expires_at_ms <= ?",
    nowMs
  );
  sql.exec(
    "DELETE FROM state_query_binding_watchers WHERE lease_expires_at_ms <= ?",
    nowMs
  );
}

export function advanceStateQueryBinding(
  state,
  {
    sourceGroup,
    targetPlatform,
    status,
    sourceKey = null,
    reason,
    nowMs = Date.now()
  }
) {
  const direction = normalizedDirection(sourceGroup, targetPlatform);
  const descriptor = normalizedBindingState({
    revision: 0,
    status,
    sourceKey,
    reason
  });
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail("State-query binding time is invalid.");
  }
  pruneStateQueryBindingNotifications(state.storage.sql, nowMs);
  state.storage.sql.exec(
    `INSERT INTO state_query_binding_revisions
      (source_group_key, target_platform, binding_revision, binding_status,
       source_key, reason, updated_at_ms)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(source_group_key, target_platform) DO UPDATE SET
       binding_revision = state_query_binding_revisions.binding_revision + 1,
       binding_status = excluded.binding_status,
       source_key = excluded.source_key,
       reason = excluded.reason,
       updated_at_ms = excluded.updated_at_ms`,
    direction.sourceGroup.key,
    direction.targetPlatform,
    descriptor.status,
    descriptor.sourceKey,
    descriptor.reason,
    nowMs
  );
  const revision = Number(state.storage.sql.exec(
    `SELECT binding_revision FROM state_query_binding_revisions
     WHERE source_group_key = ? AND target_platform = ?`,
    direction.sourceGroup.key,
    direction.targetPlatform
  ).one().binding_revision);
  state.storage.sql.exec(
    `INSERT INTO state_query_binding_outbox
      (notification_id, source_group_key, target_platform, watcher_id,
       environment, observer_key, binding_revision, binding_status, source_key,
       reason, committed_at_ms, lease_expires_at_ms, attempt_count,
       next_attempt_at_ms)
     SELECT lower(hex(randomblob(16))), watcher.source_group_key,
            watcher.target_platform, watcher.watcher_id, watcher.environment,
            watcher.observer_key, ?, ?, ?, ?, ?, watcher.lease_expires_at_ms,
            0, 0
     FROM state_query_binding_watchers watcher
     WHERE watcher.source_group_key = ? AND watcher.target_platform = ?
       AND watcher.lease_expires_at_ms > ?
     ON CONFLICT(source_group_key, target_platform, watcher_id) DO UPDATE SET
       notification_id = excluded.notification_id,
       binding_revision = excluded.binding_revision,
       binding_status = excluded.binding_status,
       source_key = excluded.source_key,
       reason = excluded.reason,
       committed_at_ms = excluded.committed_at_ms,
       lease_expires_at_ms = excluded.lease_expires_at_ms,
       attempt_count = 0,
       next_attempt_at_ms = 0`,
    revision,
    descriptor.status,
    descriptor.sourceKey,
    descriptor.reason,
    nowMs,
    direction.sourceGroup.key,
    direction.targetPlatform,
    nowMs
  );
  return revision;
}

export function registerStateQueryBindingWatcher(state, env, input, bindingState) {
  const watcher = normalizedWatcher(env, input);
  const current = normalizedBindingState(bindingState);
  const nowMs = Date.now();
  const leaseExpiresAtMs = nowMs + watcher.leaseSeconds * 1000;
  return state.storage.transactionSync(() => {
    pruneStateQueryBindingNotifications(state.storage.sql, nowMs);
    const existing = state.storage.sql.exec(
      `SELECT observer_key FROM state_query_binding_watchers
       WHERE source_group_key = ? AND target_platform = ? AND watcher_id = ?`,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.watcherId
    ).toArray()[0];
    if (!existing) {
      const registryTotal = Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_binding_watchers"
      ).one().total);
      if (registryTotal >= MAX_WATCHERS_PER_REGISTRY) {
        fail("The integration registry has too many active binding watchers.", {
          status: 429,
          code: "state_query_notification_capacity"
        });
      }
      const bindingTotal = Number(state.storage.sql.exec(
        `SELECT COUNT(*) AS total FROM state_query_binding_watchers
         WHERE source_group_key = ? AND target_platform = ?`,
        watcher.sourceGroup.key,
        watcher.targetPlatform
      ).one().total);
      if (bindingTotal >= MAX_WATCHERS_PER_BINDING) {
        fail("The selected state binding has too many active watchers.", {
          status: 429,
          code: "state_query_notification_capacity"
        });
      }
    } else if (existing.observer_key !== watcher.observerKey) {
      fail("Binding watcher identity is already attached to another observer.", {
        status: 409,
        code: "state_query_notification_watcher_conflict"
      });
    }
    state.storage.sql.exec(
      `INSERT INTO state_query_binding_watchers
        (source_group_key, target_platform, watcher_id, environment,
         observer_key, lease_expires_at_ms, created_at_ms, renewed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_group_key, target_platform, watcher_id) DO UPDATE SET
         lease_expires_at_ms = excluded.lease_expires_at_ms,
         renewed_at_ms = excluded.renewed_at_ms`,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.watcherId,
      watcher.environment,
      watcher.observerKey,
      leaseExpiresAtMs,
      nowMs,
      nowMs
    );
    state.storage.sql.exec(
      `UPDATE state_query_binding_outbox SET lease_expires_at_ms = ?
       WHERE source_group_key = ? AND target_platform = ? AND watcher_id = ?`,
      leaseExpiresAtMs,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.watcherId
    );
    return {
      watcherId: watcher.watcherId,
      currentRevision: current.revision,
      revisionMatched: current.revision === watcher.expectedRevision,
      status: current.status,
      sourceKey: current.sourceKey,
      reason: current.reason,
      leaseExpiresAtMs
    };
  });
}

export function unregisterStateQueryBindingWatcher(state, env, input) {
  const watcher = normalizedWatcher(env, {
    ...input,
    expectedRevision: input?.expectedRevision ?? 0,
    leaseSeconds: input?.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  });
  return state.storage.transactionSync(() => {
    const before = state.storage.sql.exec(
      `SELECT 1 AS found FROM state_query_binding_watchers
       WHERE source_group_key = ? AND target_platform = ? AND watcher_id = ?
         AND observer_key = ?`,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.watcherId,
      watcher.observerKey
    ).toArray()[0];
    state.storage.sql.exec(
      `DELETE FROM state_query_binding_watchers
       WHERE source_group_key = ? AND target_platform = ? AND watcher_id = ?
         AND observer_key = ?`,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.watcherId,
      watcher.observerKey
    );
    state.storage.sql.exec(
      `DELETE FROM state_query_binding_outbox
       WHERE source_group_key = ? AND target_platform = ? AND watcher_id = ?
         AND observer_key = ?`,
      watcher.sourceGroup.key,
      watcher.targetPlatform,
      watcher.watcherId,
      watcher.observerKey
    );
    return { removed: Boolean(before) };
  });
}

function claimDue(state, nowMs) {
  return state.storage.transactionSync(() => {
    pruneStateQueryBindingNotifications(state.storage.sql, nowMs);
    const rows = state.storage.sql.exec(
      `SELECT notification_id, source_group_key, target_platform, watcher_id,
              environment, observer_key, binding_revision, binding_status,
              source_key, reason, committed_at_ms, lease_expires_at_ms,
              attempt_count
       FROM state_query_binding_outbox
       WHERE next_attempt_at_ms <= ?
       ORDER BY next_attempt_at_ms, committed_at_ms
       LIMIT ?`,
      nowMs,
      DELIVERY_BATCH_SIZE
    ).toArray();
    for (const row of rows) {
      state.storage.sql.exec(
        `UPDATE state_query_binding_outbox
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

function notificationFor(row) {
  const sourceGroup = parseGroupKey(row.source_group_key);
  return {
    version: 1,
    id: row.notification_id,
    watcherId: row.watcher_id,
    observer: {
      environment: row.environment,
      target: { platform: sourceGroup.platform, groupId: sourceGroup.id }
    },
    source: {
      kind: "binding",
      key: stateQueryBindingSourceKey(sourceGroup, row.target_platform)
    },
    revision: Number(row.binding_revision),
    committedAtMs: Number(row.committed_at_ms),
    binding: {
      status: row.binding_status,
      ...(row.source_key ? { sourceKey: row.source_key } : {}),
      reason: row.reason
    }
  };
}

async function deliverOne(state, env, row, nowMs) {
  let delivered = false;
  try {
    if (!env?.STATE_QUERY_OBSERVER) throw new Error("Observer binding is unavailable.");
    const response = await env.STATE_QUERY_OBSERVER.get(
      env.STATE_QUERY_OBSERVER.idFromName(row.observer_key)
    ).fetch("https://state-query-observer/internal/state-query/notifications/deliver", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notificationFor(row))
    });
    if (!response.ok) {
      await response.text();
      throw new Error(`Observer rejected notification with status ${response.status}.`);
    }
    await response.text();
    delivered = true;
  } catch (error) {
    logError("state_query.binding_notification_delivery_failed", {
      platform: "shared",
      correlationId: `state-query-binding:${row.notification_id}`,
      sourceGroupKey: row.source_group_key,
      targetPlatform: row.target_platform,
      attempt: Number(row.attempt_count) + 1
    }, stateQueryErrorForLog(error));
  }
  state.storage.transactionSync(() => {
    if (delivered) {
      state.storage.sql.exec(
        "DELETE FROM state_query_binding_outbox WHERE notification_id = ?",
        row.notification_id
      );
      return;
    }
    const attempt = Number(row.attempt_count) + 1;
    const delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * (2 ** Math.min(5, attempt - 1))
    );
    state.storage.sql.exec(
      `UPDATE state_query_binding_outbox SET next_attempt_at_ms = ?
       WHERE notification_id = ?`,
      nowMs + delay,
      row.notification_id
    );
  });
}

export async function drainStateQueryBindingNotifications(state, env) {
  const nowMs = Date.now();
  const rows = claimDue(state, nowMs);
  for (let index = 0; index < rows.length; index += DELIVERY_CONCURRENCY) {
    await Promise.all(rows.slice(index, index + DELIVERY_CONCURRENCY).map((row) =>
      deliverOne(state, env, row, nowMs)
    ));
  }
  return { attempted: rows.length };
}

export async function prepareStateQueryBindingMutation(state) {
  const nowMs = Date.now();
  pruneStateQueryBindingNotifications(state.storage.sql, nowMs);
  const active = state.storage.sql.exec(
    `SELECT 1 AS active FROM state_query_binding_watchers
     WHERE lease_expires_at_ms > ? LIMIT 1`,
    nowMs
  ).toArray()[0];
  if (!active) return false;
  const nextAlarm = nowMs + RETRY_BASE_MS;
  const current = await state.storage.getAlarm();
  if (current === null || current > nextAlarm) {
    await state.storage.setAlarm(nextAlarm);
  }
  return true;
}
