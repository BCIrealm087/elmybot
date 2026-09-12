import { jsonResponse, logError } from "../common.js";
import { createPlatformGroupRef } from "../integrations/contracts.js";

const DELIVERY_PATH = "/internal/state-query/notifications/deliver";
const LIST_PATH = "/internal/state-query/notifications/list";
const ACK_PATH = "/internal/state-query/notifications/ack";
const NOTIFICATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const WATCHER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const FEATURE_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const MAX_INBOX_NOTIFICATIONS = 2_000;
const MAX_ACK_IDS = 100;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class StateQueryObserverError extends Error {
  constructor(message, { status = 422, code = "state_query_observer_invalid" } = {}) {
    super(message);
    this.name = "StateQueryObserverError";
    this.status = status;
    this.code = code;
  }
}

function fail(message, options) {
  throw new StateQueryObserverError(message, options);
}

function requireString(value, pattern, label, maxLength) {
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

function normalizeTarget(value) {
  try {
    const group = createPlatformGroupRef({
      platform: value?.platform,
      kind: value?.platform === "discord" ? "guild" : "channel",
      id: value?.groupId
    });
    return { platform: group.platform, groupId: group.id };
  } catch {
    fail("Notification observer target is invalid.");
  }
}

function normalizeNotification(input) {
  if (input?.version !== 1) fail("Notification version is unsupported.");
  const sourceKind = input?.source?.kind;
  if (!new Set(["group_local", "shareable"]).has(sourceKind)) {
    fail("Notification source kind is invalid.");
  }
  const namespaceId = input?.source?.namespaceId;
  if (
    (sourceKind === "group_local" && namespaceId !== undefined) ||
    (sourceKind === "shareable" && (
      typeof namespaceId !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(namespaceId)
    ))
  ) {
    fail("Notification namespace is invalid.");
  }
  const environment = requireString(
    input?.observer?.environment,
    /^[a-z0-9_-]{1,40}$/,
    "Notification environment",
    40
  );
  const target = normalizeTarget(input?.observer?.target);
  const revision = input?.revision;
  const committedAtMs = input?.committedAtMs;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    fail("Notification revision is invalid.");
  }
  if (!Number.isSafeInteger(committedAtMs) || committedAtMs < 0) {
    fail("Notification commit time is invalid.");
  }
  return {
    id: requireString(input?.id, NOTIFICATION_ID_PATTERN, "Notification ID", 32),
    watcherId: requireString(
      input?.watcherId,
      WATCHER_ID_PATTERN,
      "Notification watcher ID",
      120
    ),
    environment,
    target,
    source: {
      kind: sourceKind,
      key: requireString(
        input?.source?.key,
        /^\S{1,500}$/,
        "Notification source key",
        500
      ),
      featureId: requireString(
        input?.source?.featureId,
        FEATURE_ID_PATTERN,
        "Notification feature ID",
        100
      ),
      namespaceId: namespaceId ?? ""
    },
    revision,
    committedAtMs
  };
}

function initializeTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS state_query_observer_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      environment TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      target_group_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS state_query_observer_notifications (
      notification_id TEXT PRIMARY KEY,
      watcher_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      committed_at_ms INTEGER NOT NULL,
      received_at_ms INTEGER NOT NULL,
      UNIQUE (watcher_id, source_kind, source_key, feature_id, namespace_id)
    );

    CREATE INDEX IF NOT EXISTS state_query_observer_notifications_received
      ON state_query_observer_notifications(received_at_ms);
  `);
}

function bindIdentity(sql, notification, nowMs) {
  const existing = sql.exec(
    `SELECT environment, target_platform, target_group_id
     FROM state_query_observer_meta WHERE singleton = 1`
  ).toArray()[0];
  if (existing && (
    existing.environment !== notification.environment ||
    existing.target_platform !== notification.target.platform ||
    existing.target_group_id !== notification.target.groupId
  )) {
    fail("Notification does not belong to this observer.", {
      status: 409,
      code: "state_query_observer_identity_mismatch"
    });
  }
  if (!existing) {
    sql.exec(
      `INSERT INTO state_query_observer_meta
        (singleton, environment, target_platform, target_group_id, created_at_ms)
       VALUES (1, ?, ?, ?, ?)`,
      notification.environment,
      notification.target.platform,
      notification.target.groupId,
      nowMs
    );
  }
}

function receiveNotification(state, input) {
  const notification = normalizeNotification(input);
  const nowMs = Date.now();
  return state.storage.transactionSync(() => {
    bindIdentity(state.storage.sql, notification, nowMs);
    state.storage.sql.exec(
      `DELETE FROM state_query_observer_notifications
       WHERE received_at_ms < ?`,
      nowMs - RETENTION_MS
    );
    const existing = state.storage.sql.exec(
      `SELECT 1 AS found FROM state_query_observer_notifications
       WHERE notification_id = ?`,
      notification.id
    ).toArray()[0];
    if (existing) return { accepted: true, duplicate: true };
    const existingSource = state.storage.sql.exec(
      `SELECT 1 AS found FROM state_query_observer_notifications
       WHERE watcher_id = ? AND source_kind = ? AND source_key = ?
         AND feature_id = ? AND namespace_id = ?`,
      notification.watcherId,
      notification.source.kind,
      notification.source.key,
      notification.source.featureId,
      notification.source.namespaceId
    ).toArray()[0];
    const total = Number(state.storage.sql.exec(
      "SELECT COUNT(*) AS total FROM state_query_observer_notifications"
    ).one().total);
    if (!existingSource && total >= MAX_INBOX_NOTIFICATIONS) {
      state.storage.sql.exec(
        `DELETE FROM state_query_observer_notifications
         WHERE notification_id IN (
           SELECT notification_id FROM state_query_observer_notifications
           ORDER BY received_at_ms, notification_id
           LIMIT ?
         )`,
        total - MAX_INBOX_NOTIFICATIONS + 1
      );
    }
    state.storage.sql.exec(
      `INSERT INTO state_query_observer_notifications
        (notification_id, watcher_id, source_kind, source_key, feature_id,
         namespace_id, source_revision, committed_at_ms, received_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(watcher_id, source_kind, source_key, feature_id, namespace_id)
       DO UPDATE SET notification_id = excluded.notification_id,
                     source_revision = excluded.source_revision,
                     committed_at_ms = excluded.committed_at_ms,
                     received_at_ms = excluded.received_at_ms
       WHERE excluded.source_revision >
         state_query_observer_notifications.source_revision`,
      notification.id,
      notification.watcherId,
      notification.source.kind,
      notification.source.key,
      notification.source.featureId,
      notification.source.namespaceId,
      notification.revision,
      notification.committedAtMs,
      nowMs
    );
    return { accepted: true, duplicate: false };
  });
}

function listNotifications(state, input) {
  const limit = input?.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail("Notification list limit is invalid.");
  }
  return {
    notifications: state.storage.sql.exec(
      `SELECT notification_id, watcher_id, source_kind, source_key, feature_id,
              namespace_id, source_revision, committed_at_ms, received_at_ms
       FROM state_query_observer_notifications
       ORDER BY received_at_ms, notification_id
       LIMIT ?`,
      limit
    ).toArray().map((row) => ({
      id: row.notification_id,
      watcherId: row.watcher_id,
      source: {
        kind: row.source_kind,
        key: row.source_key,
        featureId: row.feature_id,
        ...(row.namespace_id ? { namespaceId: row.namespace_id } : {})
      },
      revision: Number(row.source_revision),
      committedAtMs: Number(row.committed_at_ms),
      receivedAtMs: Number(row.received_at_ms)
    }))
  };
}

function acknowledgeNotifications(state, input) {
  if (
    !Array.isArray(input?.ids) ||
    input.ids.length === 0 ||
    input.ids.length > MAX_ACK_IDS
  ) {
    fail("Notification acknowledgement IDs are invalid.");
  }
  const ids = [...new Set(input.ids.map((id) =>
    requireString(id, NOTIFICATION_ID_PATTERN, "Notification ID", 32)
  ))];
  let removed = 0;
  state.storage.transactionSync(() => {
    for (const id of ids) {
      const before = state.storage.sql.exec(
        `SELECT 1 AS found FROM state_query_observer_notifications
         WHERE notification_id = ?`,
        id
      ).toArray()[0];
      if (!before) continue;
      state.storage.sql.exec(
        `DELETE FROM state_query_observer_notifications
         WHERE notification_id = ?`,
        id
      );
      removed += 1;
    }
  });
  return { removed };
}

function noStoreJson(value, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

export class StateQueryObserverBackend {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    initializeTables(state);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });
    try {
      let input;
      try {
        input = await request.json();
      } catch (cause) {
        throw new StateQueryObserverError("Request body must be valid JSON.", { cause });
      }
      if (url.pathname === DELIVERY_PATH) {
        return noStoreJson(receiveNotification(this.state, input));
      }
      if (url.pathname === LIST_PATH) {
        return noStoreJson(listNotifications(this.state, input));
      }
      if (url.pathname === ACK_PATH) {
        return noStoreJson(acknowledgeNotifications(this.state, input));
      }
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      if (error instanceof StateQueryObserverError) {
        return noStoreJson({ error: error.message, code: error.code }, error.status);
      }
      const correlationId = `state-query-observer:${crypto.randomUUID()}`;
      logError("state_query.observer_request_failed", {
        platform: "shared",
        correlationId,
        route: url.pathname
      }, error);
      return noStoreJson({ error: "Unknown error.", correlationId }, 500);
    }
  }
}

export const STATE_QUERY_OBSERVER_PATHS = Object.freeze({
  deliver: DELIVERY_PATH,
  list: LIST_PATH,
  acknowledge: ACK_PATH
});
