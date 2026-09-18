import { jsonResponse, logError } from "../common.js";
import { createPlatformGroupRef } from "../integrations/contracts.js";
import {
  attachLiveStateQuery,
  drainLiveStateQueries,
  getLiveStateQuery,
  initializeLiveObservationTables,
  invalidateLiveQueriesForNotification,
  removeLiveStateQuery,
  renewLiveStateQuery,
  scheduleLiveObservationAlarm,
  STATE_QUERY_LIVE_PATHS,
  StateQueryLiveError
} from "./live-observation.js";
import { StateQueryCredentialError } from "./grant-client.js";
import { StateQueryError } from "./query.js";
import { flushStateQueryMetrics, recordStateQueryLag, recordStateQueryMetric, stateQueryErrorForLog } from "./operations.js";
import {
  acceptStateQueryStream,
  closeStateQueryStream,
  cleanupExpiredStateQueryStreams,
  handleStateQueryStreamMessage,
  initializeStateQueryStreamTables,
  invalidateStateQueryGrant,
  maintainStateQuerySocketLeases,
  pollStateQueryStream,
  publishStateQueryStreamUpdates,
  registerPolledStateQueryStream,
  removePolledStateQueryStream,
  STATE_QUERY_GRANT_INVALIDATION_PATH,
  STATE_QUERY_SOCKET_INTERNAL_PATH,
  STATE_QUERY_STREAM_CLOSE_PATH,
  STATE_QUERY_STREAM_PATH,
  STATE_QUERY_STREAM_POLL_PATH,
  StateQueryStreamError
} from "./sse.js";
import {
  STATE_QUERY_SOCKET_CLOSE_CODES,
  STATE_QUERY_SOCKET_PING,
  STATE_QUERY_SOCKET_PONG
} from "./stream-contract.js";

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
  if (!new Set(["group_local", "shareable", "binding"]).has(sourceKind)) {
    fail("Notification source kind is invalid.");
  }
  const namespaceId = input?.source?.namespaceId;
  if (
    (new Set(["group_local", "binding"]).has(sourceKind) &&
      namespaceId !== undefined) ||
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
  let binding = null;
  if (sourceKind === "binding") {
    if (
      !new Set(["ready", "transitioning", "unavailable"])
        .has(input?.binding?.status) ||
      typeof input?.binding?.reason !== "string" ||
      input.binding.reason.length === 0 ||
      input.binding.reason.length > 80 ||
      !/^[a-z][a-z0-9_]*$/.test(input.binding.reason) ||
      (input.binding.sourceKey !== undefined && (
        typeof input.binding.sourceKey !== "string" ||
        !/^\S{1,500}$/.test(input.binding.sourceKey)
      ))
    ) {
      fail("Notification binding is invalid.");
    }
    binding = {
      status: input.binding.status,
      sourceKey: input.binding.sourceKey ?? null,
      reason: input.binding.reason
    };
  } else if (input?.binding !== undefined) {
    fail("Only binding notifications may include binding state.");
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
      featureId: sourceKind === "binding" ? "" : requireString(
        input?.source?.featureId,
        FEATURE_ID_PATTERN,
        "Notification feature ID",
        100
      ),
      namespaceId: namespaceId ?? ""
    },
    revision,
    committedAtMs,
    binding
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
      binding_status TEXT,
      binding_source_key TEXT,
      binding_reason TEXT,
      UNIQUE (watcher_id, source_kind, source_key, feature_id, namespace_id)
    );

    CREATE INDEX IF NOT EXISTS state_query_observer_notifications_received
      ON state_query_observer_notifications(received_at_ms);

    CREATE TABLE IF NOT EXISTS state_query_observer_binding_authority (
      watcher_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      binding_revision INTEGER NOT NULL CHECK (binding_revision >= 0),
      binding_status TEXT NOT NULL,
      binding_source_key TEXT,
      binding_reason TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (watcher_id, source_key)
    );

    CREATE INDEX IF NOT EXISTS state_query_observer_binding_authority_updated
      ON state_query_observer_binding_authority(updated_at_ms);
  `);
  initializeLiveObservationTables(state);
  initializeStateQueryStreamTables(state);
  const notificationColumns = new Set(
    state.storage.sql.exec("PRAGMA table_info(state_query_observer_notifications)")
      .toArray()
      .map((column) => column.name)
  );
  for (const [name, type] of [
    ["binding_status", "TEXT"],
    ["binding_source_key", "TEXT"],
    ["binding_reason", "TEXT"]
  ]) {
    if (!notificationColumns.has(name)) {
      state.storage.sql.exec(
        `ALTER TABLE state_query_observer_notifications ADD COLUMN ${name} ${type}`
      );
    }
  }
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
    state.storage.sql.exec(
      `DELETE FROM state_query_observer_binding_authority
       WHERE updated_at_ms < ?`,
      nowMs - RETENTION_MS
    );
    const existing = state.storage.sql.exec(
      `SELECT 1 AS found FROM state_query_observer_notifications
       WHERE notification_id = ?`,
      notification.id
    ).toArray()[0];
    if (existing) {
      recordStateQueryMetric(state, "duplicates");
      return { accepted: true, duplicate: true };
    }
    if (notification.source.kind === "binding") {
      const authority = state.storage.sql.exec(
        `SELECT binding_revision FROM state_query_observer_binding_authority
         WHERE watcher_id = ? AND source_key = ?`,
        notification.watcherId,
        notification.source.key
      ).toArray()[0];
      if (
        authority &&
        Number(authority.binding_revision) >= notification.revision
      ) {
        recordStateQueryMetric(state, "obsolete");
        return { accepted: true, duplicate: false, stale: true };
      }
      if (!authority) {
        const authorityTotal = Number(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM state_query_observer_binding_authority"
        ).one().total);
        if (authorityTotal >= MAX_INBOX_NOTIFICATIONS) {
          state.storage.sql.exec(
            `DELETE FROM state_query_observer_binding_authority
             WHERE rowid IN (
               SELECT rowid
               FROM state_query_observer_binding_authority
               ORDER BY updated_at_ms, watcher_id, source_key
               LIMIT ?
             )`,
            authorityTotal - MAX_INBOX_NOTIFICATIONS + 1
          );
        }
      }
      state.storage.sql.exec(
        `INSERT INTO state_query_observer_binding_authority
          (watcher_id, source_key, binding_revision, binding_status,
           binding_source_key, binding_reason, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(watcher_id, source_key) DO UPDATE SET
           binding_revision = excluded.binding_revision,
           binding_status = excluded.binding_status,
           binding_source_key = excluded.binding_source_key,
           binding_reason = excluded.binding_reason,
           updated_at_ms = excluded.updated_at_ms
         WHERE excluded.binding_revision >
           state_query_observer_binding_authority.binding_revision`,
        notification.watcherId,
        notification.source.key,
        notification.revision,
        notification.binding.status,
        notification.binding.sourceKey,
        notification.binding.reason,
        nowMs
      );
    }
    const existingSource = state.storage.sql.exec(
      `SELECT source_revision FROM state_query_observer_notifications
       WHERE watcher_id = ? AND source_kind = ? AND source_key = ?
         AND feature_id = ? AND namespace_id = ?`,
      notification.watcherId,
      notification.source.kind,
      notification.source.key,
      notification.source.featureId,
      notification.source.namespaceId
    ).toArray()[0];
    const notificationAdvances = !existingSource ||
      notification.revision > Number(existingSource.source_revision);
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
         namespace_id, source_revision, committed_at_ms, received_at_ms,
         binding_status, binding_source_key, binding_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(watcher_id, source_kind, source_key, feature_id, namespace_id)
       DO UPDATE SET notification_id = excluded.notification_id,
                     source_revision = excluded.source_revision,
                     committed_at_ms = excluded.committed_at_ms,
                     received_at_ms = excluded.received_at_ms,
                     binding_status = excluded.binding_status,
                     binding_source_key = excluded.binding_source_key,
                     binding_reason = excluded.binding_reason
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
      nowMs,
      notification.binding?.status ?? null,
      notification.binding?.sourceKey ?? null,
      notification.binding?.reason ?? null
    );
    if (notificationAdvances) {
      recordStateQueryLag(state, notification.committedAtMs);
      const affected = invalidateLiveQueriesForNotification(state, notification, nowMs);
      if (affected === 0) recordStateQueryMetric(state, "obsolete");
    } else {
      recordStateQueryMetric(state, "obsolete");
    }
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
              namespace_id, source_revision, committed_at_ms, received_at_ms,
              binding_status, binding_source_key, binding_reason
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
        ...(row.feature_id ? { featureId: row.feature_id } : {}),
        ...(row.namespace_id ? { namespaceId: row.namespace_id } : {})
      },
      revision: Number(row.source_revision),
      committedAtMs: Number(row.committed_at_ms),
      receivedAtMs: Number(row.received_at_ms),
      ...(row.source_kind === "binding" ? {
        binding: {
          status: row.binding_status,
          ...(row.binding_source_key ? { sourceKey: row.binding_source_key } : {}),
          reason: row.binding_reason
        }
      } : {})
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
    state.setWebSocketAutoResponse(new globalThis.WebSocketRequestResponsePair(
      STATE_QUERY_SOCKET_PING,
      STATE_QUERY_SOCKET_PONG
    ));
    state.blockConcurrencyWhile(async () => {
      await scheduleLiveObservationAlarm(state);
    });
  }

  async alarm() {
    await maintainStateQuerySocketLeases(this.state, this.env);
    await drainLiveStateQueries(this.state, this.env);
    await publishStateQueryStreamUpdates(this.state);
    await cleanupExpiredStateQueryStreams(this.state, this.env);
    flushStateQueryMetrics(this.state, this.env);
  }

  async webSocketMessage(socket, message) {
    try {
      await handleStateQueryStreamMessage(this.state, this.env, socket, message);
    } finally {
      flushStateQueryMetrics(this.state, this.env);
    }
  }

  async webSocketClose(socket, code, reason, wasClean) {
    void code;
    void reason;
    void wasClean;
    try {
      await closeStateQueryStream(this.state, this.env, socket);
    } finally {
      flushStateQueryMetrics(this.state, this.env);
    }
  }

  async webSocketError(socket, error) {
    void error;
    try {
      await closeStateQueryStream(this.state, this.env, socket);
    } finally {
      try {
        socket.close(STATE_QUERY_SOCKET_CLOSE_CODES.internalError,
          "State-query stream unavailable");
      } catch { /* already closed */ }
      flushStateQueryMetrics(this.state, this.env);
    }
  }

  async fetch(request) {
    try {
      return await this.handleRequest(request);
    } catch (error) {
      // Stream routes also need the sanitized error boundary: letting a raw
      // transport exception escape would hand its message to platform logging.
      const correlationId = `state-query-observer:${crypto.randomUUID()}`;
      logError("state_query.observer_request_failed", { platform: "shared", correlationId },
        stateQueryErrorForLog(error));
      return noStoreJson({ error: "State-query service is temporarily unavailable.",
        code: "query_source_unavailable", correlationId }, 503);
    } finally {
      flushStateQueryMetrics(this.state, this.env);
    }
  }

  async handleRequest(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === STATE_QUERY_SOCKET_INTERNAL_PATH) {
      return await acceptStateQueryStream(this.state, this.env, request);
    }
    if (request.method === "POST" && url.pathname === STATE_QUERY_STREAM_PATH) {
      try {
        return noStoreJson(await registerPolledStateQueryStream(
          this.state, this.env, await request.json()
        ), 201);
      } catch (error) {
        if (
          error instanceof StateQueryStreamError ||
          error instanceof StateQueryLiveError ||
          error instanceof StateQueryCredentialError ||
          error instanceof StateQueryError
        ) {
          return noStoreJson({ error: error.message, code: error.code }, error.status);
        }
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === STATE_QUERY_STREAM_POLL_PATH) {
      try {
        return noStoreJson(await pollStateQueryStream(
          this.state, this.env, await request.json()
        ));
      } catch (error) {
        if (error instanceof TypeError) return new Response(null, { status: 499 });
        if (
          error instanceof StateQueryStreamError ||
          error instanceof StateQueryLiveError ||
          error instanceof StateQueryCredentialError ||
          error instanceof StateQueryError
        ) {
          return noStoreJson({ error: error.message, code: error.code }, error.status);
        }
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === STATE_QUERY_STREAM_CLOSE_PATH) {
      try {
        await removePolledStateQueryStream(this.state, this.env, await request.json());
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") return new Response("Not Found", { status: 404 });
    try {
      let input;
      try {
        input = await request.json();
      } catch (cause) {
        throw new StateQueryObserverError("Request body must be valid JSON.", { cause });
      }
      if (url.pathname === DELIVERY_PATH) {
        const result = receiveNotification(this.state, input);
        await scheduleLiveObservationAlarm(this.state);
        return noStoreJson(result);
      }
      if (url.pathname === LIST_PATH) {
        return noStoreJson(listNotifications(this.state, input));
      }
      if (url.pathname === ACK_PATH) {
        return noStoreJson(acknowledgeNotifications(this.state, input));
      }
      if (url.pathname === STATE_QUERY_GRANT_INVALIDATION_PATH) {
        return noStoreJson(await invalidateStateQueryGrant(
          this.state,
          this.env,
          input
        ));
      }
      if (url.pathname === STATE_QUERY_LIVE_PATHS.attach) {
        return noStoreJson(await attachLiveStateQuery(this.state, this.env, input), 201);
      }
      if (url.pathname === STATE_QUERY_LIVE_PATHS.renew) {
        return noStoreJson(await renewLiveStateQuery(this.state, this.env, input));
      }
      if (url.pathname === STATE_QUERY_LIVE_PATHS.remove) {
        return noStoreJson(await removeLiveStateQuery(this.state, this.env, input));
      }
      if (url.pathname === STATE_QUERY_LIVE_PATHS.get) {
        return noStoreJson(getLiveStateQuery(this.state, input));
      }
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      if (
        error instanceof StateQueryObserverError ||
        error instanceof StateQueryLiveError ||
        error instanceof StateQueryStreamError ||
        error instanceof StateQueryCredentialError ||
        error instanceof StateQueryError
      ) {
        return noStoreJson({ error: error.message, code: error.code }, error.status);
      }
      const correlationId = `state-query-observer:${crypto.randomUUID()}`;
      logError("state_query.observer_request_failed", {
        platform: "shared",
        correlationId,
        route: url.pathname
      }, stateQueryErrorForLog(error));
      return noStoreJson({ error: "Unknown error.", correlationId }, 500);
    }
  }
}

export const STATE_QUERY_OBSERVER_PATHS = Object.freeze({
  deliver: DELIVERY_PATH,
  list: LIST_PATH,
  acknowledge: ACK_PATH
});
