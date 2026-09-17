import { createPlatformGroupRef } from "../integrations/contracts.js";
import {
  stateQueryEnvironment,
  validateStateQueryGrantReference
} from "./grant-client.js";
import {
  attachLiveStateQuery,
  getLiveStateQuery,
  removeLiveStateQuery,
  renewLiveStateQuery,
  scheduleLiveObservationAlarm,
  STATE_QUERY_LIVE_LIMITS
} from "./live-observation.js";
import { canonicalStateQueryJson, stateQueryDigest } from "./query.js";
import { stateQueryObserverObjectName } from "./source-notifications.js";
import { recordStateQueryMetric, stateQueryStreamsEnabled } from "./operations.js";
import {
  STATE_QUERY_STREAM_TRANSPORTS,
  stateQueryStreamTransport
} from "./stream-contract.js";

const encoder = new TextEncoder();
const CLIENT_QUERY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SUBSCRIPTION_ID = /^[a-f0-9]{32}$/;
const MAX_QUERIES_PER_CONNECTION = 20;
const MAX_CONNECTIONS = 20;
const MAX_HISTORY_EVENTS = 64;
const MAX_HISTORY_BYTES = 256 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
const HISTORY_RETENTION_MS = 5 * 60 * 1000;
const CONNECTION_LEASE_SECONDS = STATE_QUERY_LIVE_LIMITS.defaultLeaseSeconds;

export const STATE_QUERY_STREAM_PATH = "/internal/state-query/stream";
export const STATE_QUERY_STREAM_POLL_PATH = "/internal/state-query/stream/poll";
export const STATE_QUERY_STREAM_CLOSE_PATH = "/internal/state-query/stream/close";

export const STATE_QUERY_SSE_LIMITS = Object.freeze({
  maxQueriesPerConnection: MAX_QUERIES_PER_CONNECTION,
  maxConnections: MAX_CONNECTIONS,
  maxHistoryEvents: MAX_HISTORY_EVENTS,
  maxHistoryBytes: MAX_HISTORY_BYTES,
  maxBufferedBytes: MAX_BUFFERED_BYTES,
  historyRetentionMs: HISTORY_RETENTION_MS,
  pollIntervalMs: 500,
  heartbeatMs: 20_000
});

export class StateQueryStreamError extends Error {
  constructor(message, { status = 422, code = "state_query_stream_invalid" } = {}) {
    super(message);
    this.name = "StateQueryStreamError";
    this.status = status;
    this.code = code;
  }
}

function fail(message, options) {
  throw new StateQueryStreamError(message, options);
}

export function requireStateQueryStreamsEnabled(env) {
  if (!stateQueryStreamsEnabled(env)) {
    fail("Public state-query subscriptions are disabled.", {
      status: 403, code: "state_query_subscriptions_disabled"
    });
  }
}

export function requireStateQueryPollingTransport(env) {
  if (stateQueryStreamTransport(env) !== STATE_QUERY_STREAM_TRANSPORTS.pollingSse) {
    fail("The configured state-query subscription transport is unavailable.", {
      status: 503,
      code: "state_query_transport_unavailable"
    });
  }
}

function target(value) {
  try {
    const group = createPlatformGroupRef({
      platform: value?.platform,
      kind: value?.platform === "discord" ? "guild" : "channel",
      id: value?.groupId
    });
    return { platform: group.platform, groupId: group.id };
  } catch {
    fail("State-query stream target is invalid.");
  }
}

function normalizeQueries(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_QUERIES_PER_CONNECTION) {
    fail(`A stream must contain between 1 and ${MAX_QUERIES_PER_CONNECTION} queries.`, {
      status: 413,
      code: "query_limit_exceeded"
    });
  }
  const ids = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.id !== "string" || !CLIENT_QUERY_ID.test(entry.id) || ids.has(entry.id)) {
      fail("Stream query IDs must be unique valid identifiers.");
    }
    ids.add(entry.id);
    return { id: entry.id, query: entry.query };
  });
}

export function initializeStateQueryStreamTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS state_query_stream_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state_query_stream_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      query_set_digest TEXT NOT NULL,
      next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state_query_stream_queries (
      subscription_id TEXT NOT NULL,
      client_query_id TEXT NOT NULL,
      observer_query_id TEXT NOT NULL UNIQUE,
      last_result_sequence INTEGER NOT NULL CHECK (last_result_sequence >= 1),
      last_binding_revision TEXT NOT NULL,
      PRIMARY KEY (subscription_id, client_query_id)
    );
    CREATE TABLE IF NOT EXISTS state_query_stream_history (
      subscription_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      encoded_bytes INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (subscription_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS state_query_stream_history_created
      ON state_query_stream_history(created_at_ms);
  `);
  let row = state.storage.sql.exec(
    "SELECT generation FROM state_query_stream_meta WHERE singleton = 1"
  ).toArray()[0];
  if (!row) {
    const generation = crypto.randomUUID().replaceAll("-", "");
    state.storage.sql.exec(
      "INSERT INTO state_query_stream_meta (singleton, generation) VALUES (1, ?)",
      generation
    );
    row = { generation };
  }
  return row.generation;
}

function streamSockets(state, direct = []) {
  return [
    ...(typeof state.getWebSockets === "function" ? state.getWebSockets() : []),
    ...direct
  ];
}

function socketAttachment(socket) {
  try {
    return socket.deserializeAttachment?.() ?? null;
  } catch {
    return null;
  }
}

function activeConnectionCount(state, connections) {
  return streamSockets(state, connections)
    .filter((socket) => socketAttachment(socket)?.registered).length;
}

function safeSend(socket, value) {
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    try { socket.close(1011, "State-query stream unavailable"); } catch { /* closed */ }
    return false;
  }
}

function bindingRevision(envelope) {
  return typeof envelope?.bindingRevision === "string" ? envelope.bindingRevision : "";
}

function publicResult(queryId, query, reason) {
  return {
    queryId,
    status: query.state === "denied" ? "denied" : query.envelope.status,
    reason,
    sequence: query.sequence,
    result: query.envelope,
    ...(query.errorCode ? { error: { code: query.errorCode } } : {})
  };
}

function publicReason(query, previousBindingRevision) {
  if (query.state === "denied") return query.errorCode;
  if (bindingRevision(query.envelope) !== previousBindingRevision) return "source_change";
  if (query.envelope?.reason === "source_changed") return "source_change";
  if (new Set(["dependency_changed", "transition_completed"]).has(query.envelope?.reason)) {
    return "dependency_change";
  }
  return "value_change";
}

function pruneHistory(state, nowMs) {
  state.storage.sql.exec(
    "DELETE FROM state_query_stream_history WHERE created_at_ms < ?",
    nowMs - HISTORY_RETENTION_MS
  );
  state.storage.sql.exec(
    `DELETE FROM state_query_stream_subscriptions
     WHERE expires_at_ms <= ? AND subscription_id NOT IN (
       SELECT DISTINCT subscription_id FROM state_query_stream_history
     )`,
    nowMs
  );
}

function storeEvent(state, subscriptionId, eventType, payload, nowMs) {
  let serialized = canonicalStateQueryJson(payload);
  if (encoder.encode(serialized).byteLength > MAX_BUFFERED_BYTES) {
    recordStateQueryMetric(state, "oversized");
    eventType = "status";
    payload = {
      protocol: "state-query-stream/v1",
      subscriptionId,
      results: payload.results.map(({ queryId }) => ({
        queryId, status: "unavailable", reason: "query_limit_exceeded",
        error: { code: "query_limit_exceeded" }
      }))
    };
    serialized = canonicalStateQueryJson(payload);
  }
  const bytes = encoder.encode(serialized).byteLength;
  const row = state.storage.sql.exec(
    `UPDATE state_query_stream_subscriptions
     SET next_sequence = next_sequence + 1, updated_at_ms = ?
     WHERE subscription_id = ? RETURNING next_sequence - 1 AS sequence`,
    nowMs,
    subscriptionId
  ).toArray()[0];
  if (!row) return null;
  const sequence = Number(row.sequence);
  const generation = state.storage.sql.exec(
    "SELECT generation FROM state_query_stream_meta WHERE singleton = 1"
  ).one().generation;
  const cursor = `sq1.${generation}.${subscriptionId}.${sequence}`;
  if (payload.results?.some((result) => result.reason === "source_change")) {
    state.storage.sql.exec(
      "DELETE FROM state_query_stream_history WHERE subscription_id = ?",
      subscriptionId
    );
  }
  state.storage.sql.exec(
    `INSERT INTO state_query_stream_history
      (subscription_id, sequence, event_type, payload_json, encoded_bytes, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    subscriptionId,
    sequence,
    eventType,
    serialized,
    bytes,
    nowMs
  );
  state.storage.sql.exec(
    `DELETE FROM state_query_stream_history
     WHERE subscription_id = ? AND sequence NOT IN (
       SELECT sequence FROM state_query_stream_history
       WHERE subscription_id = ? ORDER BY sequence DESC LIMIT ?
     )`,
    subscriptionId,
    subscriptionId,
    MAX_HISTORY_EVENTS
  );
  const rows = state.storage.sql.exec(
    `SELECT sequence, encoded_bytes FROM state_query_stream_history
     WHERE subscription_id = ? ORDER BY sequence DESC`,
    subscriptionId
  ).toArray();
  let total = 0;
  for (const history of rows) {
    total += Number(history.encoded_bytes);
    if (total > MAX_HISTORY_BYTES) {
      state.storage.sql.exec(
        "DELETE FROM state_query_stream_history WHERE subscription_id = ? AND sequence <= ?",
        subscriptionId,
        history.sequence
      );
      break;
    }
  }
  return { sequence, cursor, eventType, payload };
}

function sendEventToSubscription(state, connections, subscriptionId, event) {
  for (const socket of streamSockets(state, connections)) {
    const attachment = socketAttachment(socket);
    if (attachment?.registered && attachment.subscriptionId === subscriptionId) {
      safeSend(socket, { type: "event", ...event });
    }
  }
}

async function removeSubscriptionQueries(state, env, subscriptionId) {
  const rows = state.storage.sql.exec(
    "SELECT observer_query_id FROM state_query_stream_queries WHERE subscription_id = ?",
    subscriptionId
  ).toArray();
  for (const row of rows) {
    await removeLiveStateQuery(state, env, { queryId: row.observer_query_id });
  }
  state.storage.sql.exec(
    "DELETE FROM state_query_stream_queries WHERE subscription_id = ?",
    subscriptionId
  );
}

async function registerSocket(state, env, socket, input, connections = []) {
  requireStateQueryStreamsEnabled(env);
  await cleanupExpiredStateQueryStreams(state, env);
  const retainedConnections = Number(state.storage.sql.exec(
    `SELECT COUNT(*) AS total FROM state_query_stream_subscriptions
     WHERE expires_at_ms > ? AND subscription_id != ?`,
    Date.now(),
    typeof input?.subscriptionId === "string" ? input.subscriptionId : ""
  ).one().total);
  if (activeConnectionCount(state, connections) + retainedConnections >= MAX_CONNECTIONS) {
    fail("This group observer has too many stream connections.", {
      status: 429,
      code: "state_query_stream_capacity"
    });
  }
  const selectedTarget = target(input?.target);
  const queries = normalizeQueries(input?.queries);
  const grant = await validateStateQueryGrantReference(env, {
    target: selectedTarget,
    grantId: input?.grantId
  });
  for (const entry of queries) {
    const queryTarget = target(entry.query?.target);
    if (queryTarget.platform !== selectedTarget.platform ||
        queryTarget.groupId !== selectedTarget.groupId) {
      fail("Every stream query must use the authorized target.", {
        status: 403,
        code: "query_access_denied"
      });
    }
  }
  const querySetDigest = await stateQueryDigest(queries);
  const nowMs = Date.now();
  pruneHistory(state, nowMs);
  let subscriptionId = input?.subscriptionId;
  const resynchronized = input?.subscriptionId !== undefined;
  const prior = typeof subscriptionId === "string" && SUBSCRIPTION_ID.test(subscriptionId)
    ? state.storage.sql.exec(
      `SELECT grant_id, query_set_digest, expires_at_ms
       FROM state_query_stream_subscriptions WHERE subscription_id = ?`,
      subscriptionId
    ).toArray()[0]
    : null;
  if (!prior || prior.grant_id !== grant.id || prior.query_set_digest !== querySetDigest ||
      Number(prior.expires_at_ms) <= nowMs) {
    subscriptionId = crypto.randomUUID().replaceAll("-", "");
  } else {
    await removeSubscriptionQueries(state, env, subscriptionId);
  }
  const expiresAtMs = Math.min(grant.expiresAtMs, nowMs + CONNECTION_LEASE_SECONDS * 1000);
  // Authorization/digest work yielded to other registrations. Reserve capacity
  // again immediately before insertion, with no await between check and write.
  if (Number(state.storage.sql.exec(
    `SELECT COUNT(*) AS total FROM state_query_stream_subscriptions
     WHERE expires_at_ms > ? AND subscription_id != ?`, nowMs, subscriptionId
  ).one().total) >= MAX_CONNECTIONS) {
    fail("This group observer has too many stream connections.", {
      status: 429, code: "state_query_stream_capacity"
    });
  }
  state.storage.sql.exec(
    `INSERT INTO state_query_stream_subscriptions
      (subscription_id, grant_id, query_set_digest, next_sequence,
       expires_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(subscription_id) DO UPDATE SET expires_at_ms = excluded.expires_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
    subscriptionId,
    grant.id,
    querySetDigest,
    expiresAtMs,
    nowMs,
    nowMs
  );
  const results = [];
  try {
    for (const entry of queries) {
      const observerQueryId = `s:${subscriptionId}:${entry.id}`;
      const attached = await attachLiveStateQuery(state, env, {
        queryId: observerQueryId,
        grantId: grant.id,
        query: entry.query,
        leaseSeconds: CONNECTION_LEASE_SECONDS
      });
      state.storage.sql.exec(
        `INSERT INTO state_query_stream_queries
          (subscription_id, client_query_id, observer_query_id,
           last_result_sequence, last_binding_revision)
         VALUES (?, ?, ?, ?, ?)`,
        subscriptionId,
        entry.id,
        observerQueryId,
        attached.sequence,
        bindingRevision(attached.envelope)
      );
      results.push(publicResult(entry.id, {
        state: "active",
        sequence: attached.sequence,
        envelope: attached.envelope
      }, resynchronized ? "resynchronized" : "initial"));
    }
  } catch (error) {
    await removeSubscriptionQueries(state, env, subscriptionId);
    state.storage.sql.exec(
      "UPDATE state_query_stream_subscriptions SET expires_at_ms = ? WHERE subscription_id = ?",
      Date.now(),
      subscriptionId
    );
    throw error;
  }
  const attachment = {
    registered: true,
    subscriptionId,
    grantId: grant.id,
    target: selectedTarget,
    querySetDigest
  };
  socket.serializeAttachment?.(attachment);
  const event = storeEvent(state, subscriptionId, "snapshot", {
    protocol: "state-query-stream/v1",
    subscriptionId,
    results
  }, nowMs);
  recordStateQueryMetric(state, "registrations");
  safeSend(socket, { type: "ready", subscriptionId, event });
}

export async function acceptStateQueryStream(state, request, connections = []) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  if (activeConnectionCount(state, connections) >= MAX_CONNECTIONS) {
    return new Response("State-query stream capacity reached", { status: 429 });
  }
  const pair = new globalThis.WebSocketPair();
  const [client, server] = Object.values(pair);
  state.acceptWebSocket(server, ["state-query"]);
  return new Response(null, { status: 101, webSocket: client });
}

export async function acceptDirectStateQueryStream(state, env, input, connections) {
  if ([...connections].filter((socket) => socketAttachment(socket)?.registered).length >= MAX_CONNECTIONS) {
    fail("This group observer has too many stream connections.", {
      status: 429,
      code: "state_query_stream_capacity"
    });
  }
  let controller;
  let attachment = null;
  let closed = false;
  let heartbeat = null;
  const socket = {
    readyState: 1,
    serializeAttachment(value) { attachment = value; },
    deserializeAttachment() { return attachment; },
    send(value) {
      if (closed) throw new Error("State-query stream is closed.");
      const message = JSON.parse(value);
      if (message.type === "error") {
        controller.enqueue(encoder.encode(
          `event: status\ndata: ${JSON.stringify({
            protocol: "state-query-stream/v1",
            status: "terminated",
            reason: message.error?.code ?? "query_source_unavailable"
          })}\n\n`
        ));
        this.close();
        return;
      }
      if (!message.event) return;
      const bytes = encodeSse(message.event);
      if (bytes.byteLength > MAX_BUFFERED_BYTES || controller.desiredSize < 0) {
        this.close();
        return;
      }
      controller.enqueue(bytes);
      if (message.event.eventType === "status") this.close();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      connections.delete(socket);
      try { controller.close(); } catch { /* closed */ }
      void closeStateQueryStream(state, env, socket, connections);
    }
  };
  const body = new ReadableStream({
    start(selectedController) { controller = selectedController; },
    cancel() { socket.close(); }
  });
  try {
    await registerSocket(state, env, socket, input, connections);
    connections.add(socket);
    heartbeat = setInterval(() => {
      if (!closed && controller.desiredSize > 0) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }
    }, STATE_QUERY_SSE_LIMITS.heartbeatMs);
  } catch (error) {
    socket.close();
    throw error;
  }
  return new Response(body, {
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    }
  }, { highWaterMark: 0 });
}

export async function registerPolledStateQueryStream(state, env, input) {
  requireStateQueryPollingTransport(env);
  let message = null;
  let attachment = null;
  const socket = {
    serializeAttachment(value) { attachment = value; },
    deserializeAttachment() { return attachment; },
    send(value) { message = JSON.parse(value); },
    close() {}
  };
  await registerSocket(state, env, socket, input);
  if (message?.type !== "ready" || !message.event) {
    fail("State-query stream registration failed.", {
      status: 503,
      code: "query_source_unavailable"
    });
  }
  return { subscriptionId: message.subscriptionId, event: message.event };
}

export async function pollStateQueryStream(state, env, input) {
  requireStateQueryStreamsEnabled(env);
  requireStateQueryPollingTransport(env);
  recordStateQueryMetric(state, "polls");
  const subscriptionId = input?.subscriptionId;
  const afterSequence = input?.afterSequence;
  if (typeof subscriptionId !== "string" || !SUBSCRIPTION_ID.test(subscriptionId) ||
      !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    fail("State-query stream cursor is invalid.");
  }
  const subscription = state.storage.sql.exec(
    `SELECT grant_id, expires_at_ms, next_sequence FROM state_query_stream_subscriptions
     WHERE subscription_id = ?`,
    subscriptionId
  ).toArray()[0];
  if (!subscription) {
    fail("State-query stream was not found.", {
      status: 404,
      code: "state_query_stream_not_found"
    });
  }
  const nowMs = Date.now();
  if (Number(subscription.expires_at_ms) <= nowMs) {
    await removePolledStateQueryStream(state, env, { subscriptionId });
    fail("State-query stream lease expired.", { status: 404, code: "state_query_stream_not_found" });
  }
  if (Number(subscription.expires_at_ms) - nowMs < 60_000) {
    const rows = state.storage.sql.exec(
      `SELECT observer_query_id FROM state_query_stream_queries
       WHERE subscription_id = ?`,
      subscriptionId
    ).toArray();
    for (const row of rows) {
      await renewLiveStateQuery(state, env, {
        queryId: row.observer_query_id,
        leaseSeconds: CONNECTION_LEASE_SECONDS
      });
    }
    state.storage.sql.exec(
      `UPDATE state_query_stream_subscriptions
       SET expires_at_ms = ?, updated_at_ms = ? WHERE subscription_id = ?`,
      nowMs + CONNECTION_LEASE_SECONDS * 1000,
      nowMs,
      subscriptionId
    );
  }
  const events = state.storage.sql.exec(
    `SELECT sequence, event_type, payload_json
     FROM state_query_stream_history
     WHERE subscription_id = ? AND sequence > ?
     ORDER BY sequence ASC`,
    subscriptionId,
    afterSequence
  ).toArray();
  // A cursor behind pruned/cleared history must receive every current query,
  // including quiet queries whose latest event has fallen out of the window.
  if ((events.length > 0 && Number(events[0].sequence) > afterSequence + 1) ||
      (events.length === 0 && Number(subscription.next_sequence) - 1 > afterSequence)) {
    recordStateQueryMetric(state, "resynchronized");
    const results = state.storage.sql.exec(
      `SELECT client_query_id, observer_query_id FROM state_query_stream_queries
       WHERE subscription_id = ? ORDER BY client_query_id`, subscriptionId
    ).toArray().map((row) => {
      const query = getLiveStateQuery(state, { queryId: row.observer_query_id }).query;
      return query ? publicResult(row.client_query_id, query, "resynchronized") : {
        queryId: row.client_query_id, status: "unavailable", reason: "resynchronized"
      };
    });
    const terminal = results.some((result) => !result.result || result.status === "denied");
    return { event: storeEvent(state, subscriptionId, terminal ? "status" : "snapshot", {
      protocol: "state-query-stream/v1", subscriptionId, results
    }, nowMs) };
  }
  if (events.length === 0) {
    recordStateQueryMetric(state, "emptyPolls");
    return { event: null };
  }
  const latest = events.at(-1);
  const latestResults = new Map();
  let eventType = latest.event_type;
  let payload = null;
  for (const event of events) {
    const candidate = JSON.parse(event.payload_json);
    payload = candidate;
    for (const result of candidate.results ?? []) {
      latestResults.set(result.queryId, result);
    }
    if (event.event_type === "status") eventType = "status";
  }
  payload = { ...payload, results: [...latestResults.values()] };
  if (encoder.encode(canonicalStateQueryJson(payload)).byteLength > MAX_BUFFERED_BYTES) {
    return { event: storeEvent(state, subscriptionId, eventType, payload, nowMs) };
  }
  const generation = state.storage.sql.exec(
    "SELECT generation FROM state_query_stream_meta WHERE singleton = 1"
  ).one().generation;
  return {
    event: {
      sequence: Number(latest.sequence),
      cursor: `sq1.${generation}.${subscriptionId}.${latest.sequence}`,
      eventType,
      payload
    }
  };
}

export async function removePolledStateQueryStream(state, env, input) {
  const subscriptionId = input?.subscriptionId;
  if (typeof subscriptionId !== "string" || !SUBSCRIPTION_ID.test(subscriptionId)) return;
  await removeSubscriptionQueries(state, env, subscriptionId);
  state.storage.sql.exec("DELETE FROM state_query_stream_history WHERE subscription_id = ?", subscriptionId);
  state.storage.sql.exec("DELETE FROM state_query_stream_subscriptions WHERE subscription_id = ?", subscriptionId);
  recordStateQueryMetric(state, "closed");
  // Removing the subscription follows per-query cleanup; recompute its alarm
  // after the final durable lease has gone as well.
  await scheduleLiveObservationAlarm(state);
}

export async function cleanupExpiredStateQueryStreams(state, env) {
  const rows = state.storage.sql.exec(
    `SELECT subscription_id FROM state_query_stream_subscriptions
     WHERE expires_at_ms <= ? OR ? = 0 ORDER BY expires_at_ms LIMIT ?`,
    Date.now(), stateQueryStreamsEnabled(env) ? 1 : 0, MAX_CONNECTIONS
  ).toArray();
  for (const row of rows) {
    await removePolledStateQueryStream(state, env, { subscriptionId: row.subscription_id });
    recordStateQueryMetric(state, "expired");
  }
}

export async function handleStateQueryStreamMessage(state, env, socket, message) {
  try {
    if (typeof message !== "string" || encoder.encode(message).byteLength > 64 * 1024) {
      fail("State-query stream registration is invalid.", { status: 413 });
    }
    const attachment = socketAttachment(socket);
    if (attachment?.registered) fail("State-query stream is already registered.", { status: 409 });
    await registerSocket(state, env, socket, JSON.parse(message));
  } catch (error) {
    const code = error?.code ?? "state_query_stream_invalid";
    safeSend(socket, { type: "error", error: { code, message: error.message } });
    try {
      socket.close(error?.status === 401 || error?.status === 403 ? 1008 : 1011, code);
    } catch { /* closed */ }
  }
}

export async function publishStateQueryStreamUpdates(state, connections = []) {
  const subscriptions = new Map();
  const terminated = new Set();
  for (const row of state.storage.sql.exec(
    `SELECT subscription_id, client_query_id, observer_query_id,
            last_result_sequence, last_binding_revision
     FROM state_query_stream_queries ORDER BY subscription_id, client_query_id`
  ).toArray()) {
    const query = getLiveStateQuery(state, { queryId: row.observer_query_id }).query;
    if (!query || query.sequence === Number(row.last_result_sequence) &&
        query.state === "active") continue;
    const reason = query ? publicReason(query, row.last_binding_revision) : "resynchronized";
    const result = query
      ? publicResult(row.client_query_id, query, reason)
      : { queryId: row.client_query_id, status: "unavailable", reason: "resynchronized" };
    if (!subscriptions.has(row.subscription_id)) subscriptions.set(row.subscription_id, []);
    subscriptions.get(row.subscription_id).push(result);
    if (!query || query.state === "denied") terminated.add(row.subscription_id);
    if (query) {
      state.storage.sql.exec(
        `UPDATE state_query_stream_queries
         SET last_result_sequence = ?, last_binding_revision = ?
         WHERE subscription_id = ? AND client_query_id = ?`,
        query.sequence,
        bindingRevision(query.envelope),
        row.subscription_id,
        row.client_query_id
      );
    }
  }
  for (const [subscriptionId, results] of subscriptions) {
    const eventType = terminated.has(subscriptionId) ? "status" : "update";
    const event = storeEvent(state, subscriptionId, eventType, {
      protocol: "state-query-stream/v1",
      subscriptionId,
      results
    }, Date.now());
    if (event) {
      sendEventToSubscription(state, connections, subscriptionId, event);
    }
  }
  pruneHistory(state, Date.now());
  return { subscriptions: subscriptions.size };
}

export async function closeStateQueryStream(state, env, socket, connections = []) {
  const attachment = socketAttachment(socket);
  if (!attachment?.registered) return;
  const stillConnected = streamSockets(state, connections).some((candidate) =>
    candidate !== socket && socketAttachment(candidate)?.subscriptionId === attachment.subscriptionId
  );
  if (!stillConnected) await removeSubscriptionQueries(state, env, attachment.subscriptionId);
}

function encodeSse(event) {
  return encoder.encode(
    `id: ${event.cursor}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`
  );
}

export async function createStateQuerySseResponse(env, grant, input) {
  requireStateQueryStreamsEnabled(env);
  requireStateQueryPollingTransport(env);
  const selectedTarget = target(grant.target);
  const selectedGroup = createPlatformGroupRef({
    platform: selectedTarget.platform,
    kind: selectedTarget.platform === "discord" ? "guild" : "channel",
    id: selectedTarget.groupId
  });
  const name = stateQueryObserverObjectName(stateQueryEnvironment(env), selectedGroup);
  const stub = env.STATE_QUERY_OBSERVER.get(env.STATE_QUERY_OBSERVER.idFromName(name));
  const response = await stub.fetch(`https://state-query-observer${STATE_QUERY_STREAM_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grantId: grant.id,
      target: selectedTarget,
      queries: input.queries,
      ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {})
    })
  });
  if (!response.ok) {
    let error;
    try { error = await response.json(); } catch { error = null; }
    fail(error?.error ?? "State-query stream capacity is unavailable.", {
      status: response.status,
      code: error?.code ?? (response.status === 429
        ? "state_query_stream_capacity"
        : "query_source_unavailable")
    });
  }
  const registered = await response.json();
  let nextEvent = registered.event;
  let afterSequence = 0;
  let lastDeliveryAtMs = Date.now();
  let nextPollAtMs = 0;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await stub.fetch(`https://state-query-observer${STATE_QUERY_STREAM_CLOSE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscriptionId: registered.subscriptionId })
      });
    } catch { /* the durable query lease provides abrupt-disconnect cleanup */ }
  };
  const body = new ReadableStream({
    async pull(controller) {
      while (!closed) {
        if (nextEvent) {
          afterSequence = nextEvent.sequence;
          controller.enqueue(encodeSse(nextEvent));
          const terminal = nextEvent.eventType === "status";
          nextEvent = null;
          lastDeliveryAtMs = Date.now();
          if (terminal) {
            await close();
            controller.close();
          }
          return;
        }
        let polled;
        try {
          const delayMs = nextPollAtMs - Date.now();
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (closed) return;
          polled = await stub.fetch(
            `https://state-query-observer${STATE_QUERY_STREAM_POLL_PATH}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ subscriptionId: registered.subscriptionId, afterSequence })
            }
          );
        } catch {
          if (closed) return;
          await close();
          controller.close();
          return;
        }
        if (closed) return;
        if (!polled.ok) {
          await close();
          controller.close();
          return;
        }
        nextEvent = (await polled.json()).event;
        if (closed) return;
        nextPollAtMs = nextEvent ? 0 : Date.now() + STATE_QUERY_SSE_LIMITS.pollIntervalMs;
        if (!nextEvent && Date.now() - lastDeliveryAtMs >= STATE_QUERY_SSE_LIMITS.heartbeatMs) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
          lastDeliveryAtMs = Date.now();
          return;
        }
      }
    },
    async cancel(reason) {
      void reason;
      await close();
    }
  }, { highWaterMark: 0 });
  return new Response(body, {
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    }
  });
}
