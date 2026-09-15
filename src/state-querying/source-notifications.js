import { logError } from "../common.js";
import { stateQueryErrorForLog } from "./operations.js";
import { createPlatformGroupRef } from "../integrations/contracts.js";
import { stateQueryEnvironment } from "./grant-client.js";

const WATCHER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const SOURCE_KEY_PATTERN = /^\S{1,500}$/;
const FEATURE_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const NAMESPACE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 5 * 60;
const DEFAULT_LEASE_SECONDS = 2 * 60;
const MAX_WATCHERS_PER_SOURCE = 2_000;
const MAX_WATCHERS_PER_OWNER = 5_000;
const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_CONCURRENCY = 4;
const ATTEMPT_LEASE_MS = 30 * 1000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30 * 1000;

export const STATE_QUERY_SOURCE_WATCH_PATH = "/internal/state-query/source-watch/";

export const STATE_QUERY_NOTIFICATION_LIMITS = Object.freeze({
  minLeaseSeconds: MIN_LEASE_SECONDS,
  maxLeaseSeconds: MAX_LEASE_SECONDS,
  defaultLeaseSeconds: DEFAULT_LEASE_SECONDS,
  maxWatchersPerSource: MAX_WATCHERS_PER_SOURCE,
  maxWatchersPerOwner: MAX_WATCHERS_PER_OWNER,
  deliveryBatchSize: DELIVERY_BATCH_SIZE
});

export class StateQueryNotificationError extends Error {
  constructor(message, { status = 422, code = "state_query_notification_invalid" } = {}) {
    super(message);
    this.name = "StateQueryNotificationError";
    this.status = status;
    this.code = code;
  }
}

function fail(message, options) {
  throw new StateQueryNotificationError(message, options);
}

function requiredString(value, pattern, label, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function normalizedNamespaceId(value, sourceKind) {
  if (sourceKind === "group_local") {
    if (value !== undefined && value !== null && value !== "") {
      fail("A group-local watcher cannot select a namespace.");
    }
    return "";
  }
  return requiredString(value, NAMESPACE_ID_PATTERN, "Watcher namespace", 64);
}

function normalizedTarget(value) {
  try {
    const group = createPlatformGroupRef({
      platform: value?.platform,
      kind: value?.platform === "discord" ? "guild" : "channel",
      id: value?.groupId ?? value?.id
    });
    return Object.freeze({ platform: group.platform, groupId: group.id, key: group.key });
  } catch {
    fail("Watcher target is invalid.");
  }
}

function normalizedWatcher(env, input, expectedSource) {
  const sourceKind = input?.source?.kind;
  if (!new Set(["group_local", "shareable"]).has(sourceKind)) {
    fail("Watcher source kind is invalid.");
  }
  const sourceKey = requiredString(
    input?.source?.key,
    SOURCE_KEY_PATTERN,
    "Watcher source key",
    500
  );
  if (
    sourceKind !== expectedSource.kind ||
    sourceKey !== expectedSource.key
  ) {
    fail("Watcher source does not match this state owner.", {
      status: 409,
      code: "state_query_notification_source_mismatch"
    });
  }
  const featureId = requiredString(
    input?.featureId,
    FEATURE_ID_PATTERN,
    "Watcher feature ID",
    100
  );
  const namespaceId = normalizedNamespaceId(input?.namespaceId, sourceKind);
  const watcherId = requiredString(
    input?.watcherId,
    WATCHER_ID_PATTERN,
    "Watcher ID",
    120
  );
  const environment = stateQueryEnvironment(env);
  if (input?.environment !== environment) {
    fail("Watcher environment does not match this deployment.", {
      status: 403,
      code: "state_query_notification_environment_mismatch"
    });
  }
  const target = normalizedTarget(input?.target);
  const expectedRevision = input?.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail("Watcher expected revision is invalid.");
  }
  const leaseSeconds = input?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < MIN_LEASE_SECONDS ||
    leaseSeconds > MAX_LEASE_SECONDS
  ) {
    fail(`Watcher lease must be between ${MIN_LEASE_SECONDS} and ` +
      `${MAX_LEASE_SECONDS} seconds.`);
  }
  return Object.freeze({
    sourceKind,
    sourceKey,
    featureId,
    namespaceId,
    watcherId,
    environment,
    target,
    expectedRevision,
    leaseSeconds
  });
}

export function stateQueryObserverObjectName(environment, target) {
  const normalized = normalizedTarget(target);
  return `state-query-observer:${environment}:${normalized.key}`;
}

function createNotificationTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS state_query_source_watchers (
      source_kind TEXT NOT NULL CHECK (source_kind IN ('group_local', 'shareable')),
      source_key TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      watcher_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      target_group_id TEXT NOT NULL,
      observer_key TEXT NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      renewed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_kind, source_key, feature_id, namespace_id, watcher_id)
    );

    CREATE INDEX IF NOT EXISTS state_query_source_watchers_expiry
      ON state_query_source_watchers(lease_expires_at_ms);

    CREATE TABLE IF NOT EXISTS state_query_notification_outbox (
      notification_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      watcher_id TEXT NOT NULL,
      environment TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      target_group_id TEXT NOT NULL,
      observer_key TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
      committed_at_ms INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL,
      UNIQUE (source_kind, source_key, feature_id, namespace_id, watcher_id)
    );

    CREATE INDEX IF NOT EXISTS state_query_notification_outbox_due
      ON state_query_notification_outbox(next_attempt_at_ms);
  `);
}

export function stateQueryNotificationTablesExist(state) {
  return Boolean(state.storage.sql.exec(
    `SELECT 1 AS found FROM sqlite_master
     WHERE type = 'table' AND name = 'state_query_source_watchers'`
  ).toArray()[0]);
}

export function initializeLocalStateNotificationTables(state) {
  createNotificationTables(state);
  state.storage.sql.exec(`
    DROP TRIGGER IF EXISTS state_query_local_revision_insert;
    DROP TRIGGER IF EXISTS state_query_local_revision_update;

    CREATE TRIGGER IF NOT EXISTS state_query_local_revision_insert_v2
    AFTER INSERT ON framework_feature_state_versions
    BEGIN
      INSERT INTO state_query_notification_outbox
        (notification_id, source_kind, source_key, feature_id, namespace_id,
         watcher_id, environment, target_platform, target_group_id, observer_key,
         source_revision, committed_at_ms, lease_expires_at_ms, attempt_count,
         next_attempt_at_ms)
      SELECT lower(hex(randomblob(16))), watcher.source_kind, watcher.source_key,
             NEW.feature_id, '', watcher.watcher_id, watcher.environment,
             watcher.target_platform, watcher.target_group_id, watcher.observer_key,
             NEW.mutation_version,
             CAST(strftime('%s', 'now') AS INTEGER) * 1000,
             watcher.lease_expires_at_ms, 0, 0
      FROM state_query_source_watchers AS watcher
      WHERE watcher.source_kind = 'group_local'
        AND watcher.feature_id = NEW.feature_id
        AND watcher.namespace_id = ''
        AND watcher.lease_expires_at_ms >
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ON CONFLICT(source_kind, source_key, feature_id, namespace_id, watcher_id)
      DO UPDATE SET notification_id = excluded.notification_id,
                    source_revision = excluded.source_revision,
                    committed_at_ms = excluded.committed_at_ms,
                    lease_expires_at_ms = excluded.lease_expires_at_ms,
                    attempt_count = 0,
                    next_attempt_at_ms = 0;
    END;

    CREATE TRIGGER IF NOT EXISTS state_query_local_revision_update_v2
    AFTER UPDATE OF mutation_version ON framework_feature_state_versions
    WHEN NEW.mutation_version > OLD.mutation_version
    BEGIN
      INSERT INTO state_query_notification_outbox
        (notification_id, source_kind, source_key, feature_id, namespace_id,
         watcher_id, environment, target_platform, target_group_id, observer_key,
         source_revision, committed_at_ms, lease_expires_at_ms, attempt_count,
         next_attempt_at_ms)
      SELECT lower(hex(randomblob(16))), watcher.source_kind, watcher.source_key,
             NEW.feature_id, '', watcher.watcher_id, watcher.environment,
             watcher.target_platform, watcher.target_group_id, watcher.observer_key,
             NEW.mutation_version,
             CAST(strftime('%s', 'now') AS INTEGER) * 1000,
             watcher.lease_expires_at_ms, 0, 0
      FROM state_query_source_watchers AS watcher
      WHERE watcher.source_kind = 'group_local'
        AND watcher.feature_id = NEW.feature_id
        AND watcher.namespace_id = ''
        AND watcher.lease_expires_at_ms >
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ON CONFLICT(source_kind, source_key, feature_id, namespace_id, watcher_id)
      DO UPDATE SET notification_id = excluded.notification_id,
                    source_revision = excluded.source_revision,
                    committed_at_ms = excluded.committed_at_ms,
                    lease_expires_at_ms = excluded.lease_expires_at_ms,
                    attempt_count = 0,
                    next_attempt_at_ms = 0;
    END;
  `);
}

export function initializeShareableStateNotificationTables(state) {
  createNotificationTables(state);
  state.storage.sql.exec(`
    DROP TRIGGER IF EXISTS state_query_shareable_revision_update;

    CREATE TRIGGER IF NOT EXISTS state_query_shareable_revision_update_v2
    AFTER UPDATE OF mutation_version ON shareable_state_realm_namespaces
    WHEN NEW.mutation_version > OLD.mutation_version
    BEGIN
      INSERT INTO state_query_notification_outbox
        (notification_id, source_kind, source_key, feature_id, namespace_id,
         watcher_id, environment, target_platform, target_group_id, observer_key,
         source_revision, committed_at_ms, lease_expires_at_ms, attempt_count,
         next_attempt_at_ms)
      SELECT lower(hex(randomblob(16))), watcher.source_kind, watcher.source_key,
             NEW.feature_id, NEW.namespace_id, watcher.watcher_id,
             watcher.environment, watcher.target_platform, watcher.target_group_id,
             watcher.observer_key, NEW.mutation_version,
             CAST(strftime('%s', 'now') AS INTEGER) * 1000,
             watcher.lease_expires_at_ms, 0, 0
      FROM state_query_source_watchers AS watcher
      WHERE watcher.source_kind = 'shareable'
        AND watcher.feature_id = NEW.feature_id
        AND watcher.namespace_id = NEW.namespace_id
        AND watcher.lease_expires_at_ms >
          CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ON CONFLICT(source_kind, source_key, feature_id, namespace_id, watcher_id)
      DO UPDATE SET notification_id = excluded.notification_id,
                    source_revision = excluded.source_revision,
                    committed_at_ms = excluded.committed_at_ms,
                    lease_expires_at_ms = excluded.lease_expires_at_ms,
                    attempt_count = 0,
                    next_attempt_at_ms = 0;
    END;
  `);
}

function pruneExpired(sql, nowMs) {
  sql.exec(
    "DELETE FROM state_query_notification_outbox WHERE lease_expires_at_ms <= ?",
    nowMs
  );
  sql.exec(
    "DELETE FROM state_query_source_watchers WHERE lease_expires_at_ms <= ?",
    nowMs
  );
}

function sourceRevision(sql, source) {
  if (source.sourceKind === "group_local") {
    const row = sql.exec(
      `SELECT mutation_version FROM framework_feature_state_versions
       WHERE feature_id = ?`,
      source.featureId
    ).toArray()[0];
    return Number(row?.mutation_version ?? 0);
  }
  const row = sql.exec(
    `SELECT mutation_version FROM shareable_state_realm_namespaces
     WHERE feature_id = ? AND namespace_id = ?`,
    source.featureId,
    source.namespaceId
  ).toArray()[0];
  return Number(row?.mutation_version ?? 0);
}

async function scheduleNextAlarm(state, { immediate = false, nowMs = Date.now() } = {}) {
  pruneExpired(state.storage.sql, nowMs);
  let nextAlarm = immediate ? nowMs + RETRY_BASE_MS : null;
  if (!immediate) {
    const due = state.storage.sql.exec(
      `SELECT MIN(next_at) AS next_at FROM (
         SELECT MIN(next_attempt_at_ms) AS next_at
         FROM state_query_notification_outbox
         UNION ALL
         SELECT MIN(lease_expires_at_ms) AS next_at
         FROM state_query_source_watchers
       ) WHERE next_at IS NOT NULL`
    ).toArray()[0]?.next_at;
    nextAlarm = due === null || due === undefined
      ? null
      : Math.max(nowMs, Number(due));
  }
  const current = await state.storage.getAlarm();
  if (nextAlarm === null) {
    if (current !== null) await state.storage.deleteAlarm();
    return;
  }
  if (current === null || current > nextAlarm) {
    await state.storage.setAlarm(nextAlarm);
  }
}

export async function recoverStateQueryNotificationDelivery(state) {
  await scheduleNextAlarm(state);
}

export async function prepareStateQueryMutation(state, source) {
  if (!stateQueryNotificationTablesExist(state)) return false;
  const nowMs = Date.now();
  pruneExpired(state.storage.sql, nowMs);
  const active = state.storage.sql.exec(
    `SELECT 1 AS active FROM state_query_source_watchers
     WHERE source_kind = ? AND feature_id = ? AND namespace_id = ?
       AND (? IS NULL OR source_key = ?) AND lease_expires_at_ms > ?
     LIMIT 1`,
    source.kind,
    source.featureId,
    source.namespaceId ?? "",
    source.key ?? null,
    source.key ?? null,
    nowMs
  ).toArray()[0];
  if (active) await scheduleNextAlarm(state, { immediate: true, nowMs });
  return Boolean(active);
}

export async function registerStateQuerySourceWatcher(
  state,
  env,
  input,
  expectedSource
) {
  const watcher = normalizedWatcher(env, input, expectedSource);
  const nowMs = Date.now();
  const leaseExpiresAtMs = nowMs + watcher.leaseSeconds * 1000;
  const result = state.storage.transactionSync(() => {
    pruneExpired(state.storage.sql, nowMs);
    const existing = state.storage.sql.exec(
      `SELECT observer_key FROM state_query_source_watchers
       WHERE source_kind = ? AND source_key = ? AND feature_id = ?
         AND namespace_id = ? AND watcher_id = ?`,
      watcher.sourceKind,
      watcher.sourceKey,
      watcher.featureId,
      watcher.namespaceId,
      watcher.watcherId
    ).toArray()[0];
    if (!existing) {
      const ownerTotal = Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_source_watchers"
      ).one().total);
      if (ownerTotal >= MAX_WATCHERS_PER_OWNER) {
        fail("This state owner has too many active watchers.", {
          status: 429,
          code: "state_query_notification_capacity"
        });
      }
      const total = state.storage.sql.exec(
        `SELECT COUNT(*) AS total FROM state_query_source_watchers
         WHERE source_kind = ? AND source_key = ? AND feature_id = ?
           AND namespace_id = ?`,
        watcher.sourceKind,
        watcher.sourceKey,
        watcher.featureId,
        watcher.namespaceId
      ).one().total;
      if (Number(total) >= MAX_WATCHERS_PER_SOURCE) {
        fail("The selected state source has too many active watchers.", {
          status: 429,
          code: "state_query_notification_capacity"
        });
      }
    } else if (existing.observer_key !== stateQueryObserverObjectName(
      watcher.environment,
      watcher.target
    )) {
      fail("Watcher identity is already attached to another observer.", {
        status: 409,
        code: "state_query_notification_watcher_conflict"
      });
    }
    const observerKey = stateQueryObserverObjectName(watcher.environment, watcher.target);
    state.storage.sql.exec(
      `INSERT INTO state_query_source_watchers
        (source_kind, source_key, feature_id, namespace_id, watcher_id,
         environment, target_platform, target_group_id, observer_key,
         lease_expires_at_ms, created_at_ms, renewed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_kind, source_key, feature_id, namespace_id, watcher_id)
       DO UPDATE SET lease_expires_at_ms = excluded.lease_expires_at_ms,
                     renewed_at_ms = excluded.renewed_at_ms`,
      watcher.sourceKind,
      watcher.sourceKey,
      watcher.featureId,
      watcher.namespaceId,
      watcher.watcherId,
      watcher.environment,
      watcher.target.platform,
      watcher.target.groupId,
      observerKey,
      leaseExpiresAtMs,
      nowMs,
      nowMs
    );
    state.storage.sql.exec(
      `UPDATE state_query_notification_outbox
       SET lease_expires_at_ms = ?
       WHERE source_kind = ? AND source_key = ? AND feature_id = ?
         AND namespace_id = ? AND watcher_id = ?`,
      leaseExpiresAtMs,
      watcher.sourceKind,
      watcher.sourceKey,
      watcher.featureId,
      watcher.namespaceId,
      watcher.watcherId
    );
    const currentRevision = sourceRevision(state.storage.sql, watcher);
    return {
      watcherId: watcher.watcherId,
      currentRevision,
      revisionMatched: currentRevision === watcher.expectedRevision,
      leaseExpiresAtMs
    };
  });
  await scheduleNextAlarm(state);
  return result;
}

export async function unregisterStateQuerySourceWatcher(
  state,
  env,
  input,
  expectedSource
) {
  const watcher = normalizedWatcher(env, {
    ...input,
    expectedRevision: input?.expectedRevision ?? 0,
    leaseSeconds: input?.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  }, expectedSource);
  const observerKey = stateQueryObserverObjectName(watcher.environment, watcher.target);
  const deleted = state.storage.transactionSync(() => {
    const before = state.storage.sql.exec(
      `SELECT 1 AS found FROM state_query_source_watchers
       WHERE source_kind = ? AND source_key = ? AND feature_id = ?
         AND namespace_id = ? AND watcher_id = ? AND observer_key = ?`,
      watcher.sourceKind,
      watcher.sourceKey,
      watcher.featureId,
      watcher.namespaceId,
      watcher.watcherId,
      observerKey
    ).toArray()[0];
    state.storage.sql.exec(
      `DELETE FROM state_query_source_watchers
       WHERE source_kind = ? AND source_key = ? AND feature_id = ?
         AND namespace_id = ? AND watcher_id = ? AND observer_key = ?`,
      watcher.sourceKind,
      watcher.sourceKey,
      watcher.featureId,
      watcher.namespaceId,
      watcher.watcherId,
      observerKey
    );
    state.storage.sql.exec(
      `DELETE FROM state_query_notification_outbox
       WHERE source_kind = ? AND source_key = ? AND feature_id = ?
         AND namespace_id = ? AND watcher_id = ? AND observer_key = ?`,
      watcher.sourceKind,
      watcher.sourceKey,
      watcher.featureId,
      watcher.namespaceId,
      watcher.watcherId,
      observerKey
    );
    return Boolean(before);
  });
  await scheduleNextAlarm(state);
  return { removed: deleted };
}

function claimDue(state, nowMs) {
  return state.storage.transactionSync(() => {
    pruneExpired(state.storage.sql, nowMs);
    const rows = state.storage.sql.exec(
      `SELECT notification_id, source_kind, source_key, feature_id, namespace_id,
              watcher_id, environment, target_platform, target_group_id,
              observer_key, source_revision, committed_at_ms,
              lease_expires_at_ms, attempt_count
       FROM state_query_notification_outbox
       WHERE next_attempt_at_ms <= ?
       ORDER BY next_attempt_at_ms, committed_at_ms
       LIMIT ?`,
      nowMs,
      DELIVERY_BATCH_SIZE
    ).toArray();
    for (const row of rows) {
      state.storage.sql.exec(
        `UPDATE state_query_notification_outbox
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
  return {
    version: 1,
    id: row.notification_id,
    watcherId: row.watcher_id,
    observer: {
      environment: row.environment,
      target: { platform: row.target_platform, groupId: row.target_group_id }
    },
    source: {
      kind: row.source_kind,
      key: row.source_key,
      featureId: row.feature_id,
      ...(row.namespace_id ? { namespaceId: row.namespace_id } : {})
    },
    revision: Number(row.source_revision),
    committedAtMs: Number(row.committed_at_ms)
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
    logError("state_query.notification_delivery_failed", {
      platform: "shared",
      correlationId: `state-query-notification:${row.notification_id}`,
      sourceKind: row.source_kind,
      attempt: Number(row.attempt_count) + 1
    }, stateQueryErrorForLog(error));
  }
  state.storage.transactionSync(() => {
    if (delivered) {
      state.storage.sql.exec(
        "DELETE FROM state_query_notification_outbox WHERE notification_id = ?",
        row.notification_id
      );
      return;
    }
    const attempt = Number(row.attempt_count) + 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(5, attempt - 1)));
    state.storage.sql.exec(
      `UPDATE state_query_notification_outbox
       SET next_attempt_at_ms = ?
       WHERE notification_id = ?`,
      nowMs + delay,
      row.notification_id
    );
  });
}

export async function drainStateQueryNotifications(state, env) {
  const nowMs = Date.now();
  const rows = claimDue(state, nowMs);
  for (let index = 0; index < rows.length; index += DELIVERY_CONCURRENCY) {
    await Promise.all(rows.slice(index, index + DELIVERY_CONCURRENCY).map((row) =>
      deliverOne(state, env, row, nowMs)
    ));
  }
  await scheduleNextAlarm(state, {
    immediate: rows.length === DELIVERY_BATCH_SIZE,
    nowMs: Date.now()
  });
  return { attempted: rows.length };
}

export async function handleLocalStateQuerySourceWatchRequest(
  state,
  env,
  request,
  pathname
) {
  if (!pathname.startsWith(STATE_QUERY_SOURCE_WATCH_PATH)) return null;
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  initializeLocalStateNotificationTables(state);
  const operation = pathname.slice(STATE_QUERY_SOURCE_WATCH_PATH.length);
  const input = await request.json();
  const sourceGroup = normalizedTarget(input?.source?.target);
  const expectedSource = { kind: "group_local", key: sourceGroup.key };
  let result;
  if (operation === "register") {
    result = await registerStateQuerySourceWatcher(state, env, {
      ...input,
      source: expectedSource
    }, expectedSource);
  } else if (operation === "unregister") {
    result = await unregisterStateQuerySourceWatcher(state, env, {
      ...input,
      source: expectedSource
    }, expectedSource);
  } else {
    return new Response("Not Found", { status: 404 });
  }
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
