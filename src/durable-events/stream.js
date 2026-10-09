import {
  DURABLE_EVENT_CODES,
  DURABLE_EVENT_LIMITS,
  durableEventError,
  durableEventRouteId,
  DurableEventError,
  serializeDurableEventPayload
} from "./contract.js";
import { logError } from "../common.js";
import {
  DURABLE_EVENT_GRANT_LIMITS,
  DurableEventGrantError
} from "./grants.js";
import {
  DURABLE_EVENT_SOCKET_CLOSE_CODES,
  DURABLE_EVENT_SOCKET_LIMITS,
  DURABLE_EVENT_SOCKET_PING,
  DURABLE_EVENT_SOCKET_PONG,
  DURABLE_EVENT_SOCKET_PROTOCOL,
  DURABLE_EVENT_SOCKET_STATUS,
  DURABLE_EVENT_SOCKET_TYPES
} from "./socket-contract.js";

export const DURABLE_EVENT_APPEND_PATH = "/internal/events/append";
export const DURABLE_EVENT_BINDING_PATH = "/internal/events/binding";
export const DURABLE_EVENT_GRANT_PATH = "/internal/events/grants";
export const DURABLE_EVENT_SOCKET_INTERNAL_PATH = "/internal/events/socket";
export const DURABLE_EVENT_SOCKET_GRANT_HEADER = "x-elmybot-durable-event-grant";
export const DURABLE_EVENT_SOCKET_PLATFORM_HEADER = "x-elmybot-durable-event-platform";
export const DURABLE_EVENT_SOCKET_GROUP_HEADER = "x-elmybot-durable-event-group";
export const DURABLE_EVENT_SOCKET_ROUTE_HEADER = "x-elmybot-durable-event-route";
const INTERNAL_HEADER = "x-elmybot-durable-event-internal";
const INTERNAL_VALUE = "v1";
const EVENT_ID_PATTERN = /^dev1\.[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_ID_PATTERN = /^des1\.[A-Za-z0-9_-]{43}$/;
const NOTIFICATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const ENVIRONMENT_PATTERN = /^[a-z0-9_-]{1,40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CURSOR_PATTERN = /^dec1\.[A-Za-z0-9_-]{43}$/;
const MAX_GRANT_ROWS = 1_000;
const MAX_RESET_AUDIT_ROWS = 100;
const SOCKET_TAG = "durable-event";
const SOCKET_TRANSPORT = "hibernating_websocket";
const encoder = new TextEncoder();

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function one(sql, query, ...bindings) {
  return sql.exec(query, ...bindings).toArray()[0] ?? null;
}

function metadata(sql) {
  return one(sql, "SELECT * FROM durable_event_stream_metadata WHERE singleton = 1");
}

function randomBase64Url() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function streamSockets(state) {
  return typeof state.getWebSockets === "function"
    ? state.getWebSockets(SOCKET_TAG)
    : [];
}

function socketAttachment(socket) {
  try {
    return socket.deserializeAttachment?.() ?? null;
  } catch {
    return null;
  }
}

function closeSocket(socket, code, reason) {
  try { socket.close(code, reason); } catch { /* already closed */ }
}

function safeSend(socket, value) {
  try {
    const message = typeof value === "string" ? value : JSON.stringify(value);
    socket.send(message);
    return true;
  } catch {
    closeSocket(socket, DURABLE_EVENT_SOCKET_CLOSE_CODES.internalError,
      "Durable event stream unavailable");
    return false;
  }
}

function sendStatus(socket, code, closeCode = DURABLE_EVENT_SOCKET_CLOSE_CODES.policyViolation) {
  safeSend(socket, {
    protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
    type: DURABLE_EVENT_SOCKET_TYPES.status,
    code,
    terminal: true
  });
  closeSocket(socket, closeCode, "Durable event stream ended");
}

function terminateSockets(state, code, {
  grantId = null,
  closeCode = DURABLE_EVENT_SOCKET_CLOSE_CODES.policyViolation
} = {}) {
  for (const socket of streamSockets(state)) {
    const attachment = socketAttachment(socket);
    if (!attachment?.registered || (grantId && attachment.grantId !== grantId)) continue;
    detachSocket(state, attachment);
    sendStatus(socket, code, closeCode);
  }
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requireInternal(request) {
  if (request.headers.get(INTERNAL_HEADER) !== INTERNAL_VALUE) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 404 });
  }
}

function declaration(registry, featureId, streamId, version) {
  return registry?.eventStreams?.[`${featureId}:${streamId}:v${version}`]?.definition ?? null;
}

async function validateAppendInput(input, registry) {
  if (
    typeof input !== "object" ||
    input === null ||
    !EVENT_ID_PATTERN.test(input.eventId ?? "") ||
    !FINGERPRINT_PATTERN.test(input.fingerprint ?? "") ||
    !ROUTE_ID_PATTERN.test(input.route?.routeId ?? "") ||
    typeof input.featureId !== "string" ||
    typeof input.streamId !== "string" ||
    !Number.isSafeInteger(input.version) ||
    !Number.isSafeInteger(input.route?.bindingRevision) ||
    input.route.bindingRevision < 0 ||
    (input.recoveryOnly !== undefined && typeof input.recoveryOnly !== "boolean")
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  const stream = declaration(registry, input.featureId, input.streamId, input.version);
  if (!stream || stream.scope.kind !== input.route.descriptor?.scopeKind) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  const descriptor = input.route.descriptor;
  if (
    descriptor.featureId !== input.featureId ||
    descriptor.streamId !== input.streamId ||
    descriptor.version !== input.version ||
    typeof descriptor.deploymentEnvironment !== "string" ||
    typeof descriptor.realmIdentity !== "string" ||
    descriptor.realmIdentity.length === 0 ||
    descriptor.realmIdentity.length > 300 ||
    await durableEventRouteId(descriptor) !== input.route.routeId
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
  }
  let payload;
  try {
    payload = JSON.parse(input.payload);
  } catch {
    throw durableEventError(DURABLE_EVENT_CODES.payloadInvalid, { status: 422 });
  }
  const normalized = serializeDurableEventPayload(payload, stream.payload.schema);
  if (normalized.serialized !== input.payload) {
    throw durableEventError(DURABLE_EVENT_CODES.payloadInvalid, { status: 422 });
  }
  if (stream.scope.kind === "effective_shareable" && input.recoveryOnly !== true) {
    if (
      typeof input.binding?.sourceGroupKey !== "string" ||
      input.binding.sourceGroupKey.length === 0 ||
      !["discord", "twitch"].includes(input.binding?.targetPlatform) ||
      input.binding.targetPlatform === input.binding.sourceGroupKey.split(":")[0] ||
      input.binding.revision !== input.route.bindingRevision ||
      input.binding.sourceKey !== descriptor.realmIdentity
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
  }
  return { ...input, payloadBytes: normalized.bytes, definition: stream };
}

function requireEffectiveBinding(sql, input) {
  if (input.definition.scope.kind !== "effective_shareable") return;
  const existing = one(
    sql,
    `SELECT binding_revision, source_key, status
     FROM durable_event_stream_bindings
     WHERE source_group_key = ? AND target_platform = ?`,
    input.binding.sourceGroupKey,
    input.binding.targetPlatform
  );
  if (!existing) {
    sql.exec(
      `INSERT INTO durable_event_stream_bindings
       (source_group_key, target_platform, binding_revision, source_key,
        status, reason, updated_at_ms)
       VALUES (?, ?, ?, ?, 'active', 'registered', ?)`,
      input.binding.sourceGroupKey,
      input.binding.targetPlatform,
      input.binding.revision,
      input.binding.sourceKey,
      Date.now()
    );
    return;
  }
  const existingRevision = Number(existing.binding_revision);
  if (
    input.binding.revision < existingRevision ||
    (input.binding.revision === existingRevision &&
      (existing.status !== "active" || existing.source_key !== input.binding.sourceKey))
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
  }
  if (input.binding.revision > existingRevision) {
    sql.exec(
      `UPDATE durable_event_stream_bindings
       SET binding_revision = ?, source_key = ?, status = 'active',
           reason = 'registered', updated_at_ms = ?
       WHERE source_group_key = ? AND target_platform = ?`,
      input.binding.revision,
      input.binding.sourceKey,
      Date.now(),
      input.binding.sourceGroupKey,
      input.binding.targetPlatform
    );
    sql.exec(
      "UPDATE durable_event_stream_metadata SET consumer_ready = 0 WHERE singleton = 1"
    );
  }
}

function applyBindingNotification(state, input) {
  if (
    typeof input !== "object" ||
    input === null ||
    !NOTIFICATION_ID_PATTERN.test(input.notificationId ?? "") ||
    !ROUTE_ID_PATTERN.test(input.routeId ?? "") ||
    !ENVIRONMENT_PATTERN.test(input.environment ?? "") ||
    typeof input.sourceGroupKey !== "string" ||
    input.sourceGroupKey.length === 0 ||
    input.sourceGroupKey.length > 500 ||
    !["discord", "twitch"].includes(input.targetPlatform) ||
    !Number.isSafeInteger(input.previousRevision) ||
    input.previousRevision < 0 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision <= input.previousRevision ||
    typeof input.previousSourceKey !== "string" ||
    input.previousSourceKey.length === 0 ||
    input.previousSourceKey.length > 500 ||
    !["ready", "transitioning", "unavailable"].includes(input.status) ||
    (input.status === "ready"
      ? typeof input.sourceKey !== "string" || input.sourceKey.length === 0 ||
        input.sourceKey.length > 500
      : input.sourceKey !== null) ||
    typeof input.reason !== "string" ||
    input.reason.length === 0 ||
    input.reason.length > 100 ||
    !Number.isSafeInteger(input.committedAtMs) ||
    input.committedAtMs < 0
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  return state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const meta = metadata(sql);
    if (meta.route_id !== null && meta.route_id !== input.routeId) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    const row = one(
      sql,
      `SELECT binding_revision, source_key, status
       FROM durable_event_stream_bindings
       WHERE source_group_key = ? AND target_platform = ?`,
      input.sourceGroupKey,
      input.targetPlatform
    );
    if (!row || input.revision <= Number(row.binding_revision)) {
      return { accepted: true, stale: true, moved: row?.status === "moved" };
    }
    if (
      Number(row.binding_revision) !== input.previousRevision ||
      row.source_key !== input.previousSourceKey
    ) {
      return { accepted: true, stale: true, moved: row.status === "moved" };
    }
    const descriptor = meta.descriptor_json === null
      ? null
      : JSON.parse(meta.descriptor_json);
    if (
      descriptor !== null &&
      descriptor.deploymentEnvironment !== input.environment
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    const stillCurrent = input.status === "ready" &&
      input.sourceKey === descriptor?.realmIdentity;
    sql.exec(
      `UPDATE durable_event_stream_bindings
       SET binding_revision = ?, source_key = ?, status = ?, reason = ?,
           updated_at_ms = ?
       WHERE source_group_key = ? AND target_platform = ?`,
      input.revision,
      input.sourceKey,
      stillCurrent ? "active" : "moved",
      input.reason,
      input.committedAtMs,
      input.sourceGroupKey,
      input.targetPlatform
    );
    sql.exec(
      `UPDATE durable_event_stream_metadata
       SET consumer_ready = 0 WHERE singleton = 1`
    );
    return { accepted: true, stale: false, moved: !stillCurrent };
  });
}

function pruneExpired(state, nowMs) {
  return state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const expired = one(
      sql,
      `SELECT MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence,
              COUNT(*) AS total, COALESCE(SUM(payload_bytes), 0) AS bytes
       FROM durable_event_stream_events WHERE expires_at_ms <= ?`,
      nowMs
    );
    if (Number(expired?.total ?? 0) > 0) {
      sql.exec("DELETE FROM durable_event_stream_events WHERE expires_at_ms <= ?", nowMs);
      sql.exec(
        `UPDATE durable_event_stream_metadata
         SET retained_count = retained_count - ?, retained_bytes = retained_bytes - ?,
             gap_first_sequence = COALESCE(gap_first_sequence, ?),
             gap_last_sequence = MAX(COALESCE(gap_last_sequence, 0), ?),
             consumer_ready = 0, consumer_grant_id = NULL
         WHERE singleton = 1`,
        Number(expired.total),
        Number(expired.bytes),
        Number(expired.first_sequence),
        Number(expired.last_sequence)
      );
    }
    sql.exec("DELETE FROM durable_event_stream_receipts WHERE expires_at_ms <= ?", nowMs);
    sql.exec("DELETE FROM durable_event_stream_ingress WHERE accepted_at_ms <= ?", nowMs - 1_000);
    return Number(expired?.total ?? 0);
  });
}

async function scheduleNextAlarm(state) {
  const next = one(
    state.storage.sql,
    `SELECT MIN(deadline) AS deadline FROM (
       SELECT MIN(expires_at_ms) AS deadline FROM durable_event_stream_events
       UNION ALL
       SELECT MIN(expires_at_ms) AS deadline FROM durable_event_stream_receipts
       UNION ALL
       SELECT MIN(expires_at_ms) AS deadline FROM durable_event_stream_grants
       WHERE status = 'active' AND expires_at_ms > ?
     ) WHERE deadline IS NOT NULL`,
    Date.now()
  )?.deadline;
  if (next === null || next === undefined) {
    await state.storage.deleteAlarm();
    return;
  }
  await state.storage.setAlarm(Math.max(Date.now() + 1, Number(next)));
}

function sameSecret(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function grantRow(sql, grantId) {
  return one(sql, "SELECT * FROM durable_event_stream_grants WHERE grant_id = ?", grantId);
}

function publicGrant(row) {
  return {
    id: row.grant_id,
    target: { platform: row.target_platform, groupId: row.target_group_id },
    stream: {
      feature: row.feature_id,
      stream: row.stream_id,
      version: Number(row.stream_version)
    },
    environment: row.environment,
    issuedAtMs: Number(row.issued_at_ms),
    expiresAtMs: Number(row.expires_at_ms)
  };
}

function grantStatus(row, input, nowMs, { secret = true } = {}) {
  if (!row || (secret && !sameSecret(row.secret_digest, input.secretDigest))) {
    return "denied";
  }
  if (
    row.environment !== input.environment ||
    row.target_platform !== input.target.platform ||
    row.target_group_id !== input.target.groupId ||
    row.route_id !== input.routeId
  ) return "denied";
  if (row.status !== "active") return row.status;
  if (Number(row.expires_at_ms) <= nowMs) return "expired";
  return "active";
}

function grantMoved(sql, row) {
  if (!row) return false;
  return Number(one(
    sql,
    `SELECT COUNT(*) AS total FROM durable_event_stream_bindings
     WHERE binding_revision > ? OR status = 'moved'`,
    Number(row.binding_revision)
  )?.total ?? 0) > 0;
}

function currentSocket(state, meta = metadata(state.storage.sql)) {
  const epoch = Number(meta.consumer_epoch ?? 0);
  const grantId = meta.consumer_grant_id;
  if (Number(meta.consumer_ready) !== 1 || epoch < 1 || !grantId) return null;
  return streamSockets(state).find((socket) => {
    const attachment = socketAttachment(socket);
    return attachment?.registered === true && attachment.epoch === epoch &&
      attachment.grantId === grantId;
  }) ?? null;
}

function detachSocket(state, attachment) {
  if (!attachment?.registered || !Number.isSafeInteger(attachment.epoch)) return false;
  const result = state.storage.sql.exec(
    `UPDATE durable_event_stream_metadata
     SET consumer_ready = 0, consumer_grant_id = NULL
     WHERE singleton = 1 AND consumer_epoch = ? AND consumer_grant_id = ?`,
    attachment.epoch,
    attachment.grantId
  );
  return Number(result.rowsWritten ?? 0) > 0;
}

function publicEvent(row, grant) {
  return {
    protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
    type: DURABLE_EVENT_SOCKET_TYPES.event,
    stream: grant.stream,
    eventId: row.event_id,
    sequence: Number(row.sequence),
    cursor: row.cursor,
    acceptedAt: new Date(Number(row.accepted_at_ms)).toISOString(),
    expiresAt: new Date(Number(row.expires_at_ms)).toISOString(),
    payload: JSON.parse(row.payload_json)
  };
}

function terminalGrantStatus(row, nowMs) {
  if (!row) return DURABLE_EVENT_SOCKET_STATUS.grantRevoked;
  if (row.status === "replaced") return DURABLE_EVENT_SOCKET_STATUS.grantReplaced;
  if (row.status === "revoked") return DURABLE_EVENT_SOCKET_STATUS.grantRevoked;
  if (Number(row.expires_at_ms) <= nowMs) return DURABLE_EVENT_SOCKET_STATUS.grantExpired;
  return null;
}

function sendNextEvent(state, socket) {
  const attachment = socketAttachment(socket);
  if (!attachment?.registered) return false;
  const sql = state.storage.sql;
  const meta = metadata(sql);
  if (Number(meta.consumer_epoch) !== attachment.epoch ||
      meta.consumer_grant_id !== attachment.grantId) {
    sendStatus(socket, DURABLE_EVENT_SOCKET_STATUS.consumerReplaced,
      DURABLE_EVENT_SOCKET_CLOSE_CODES.replaced);
    return false;
  }
  if (meta.gap_first_sequence !== null) {
    detachSocket(state, attachment);
    sendStatus(socket, DURABLE_EVENT_SOCKET_STATUS.retentionGap);
    return false;
  }
  const grantRowValue = grantRow(sql, attachment.grantId);
  const grantTerminal = terminalGrantStatus(grantRowValue, Date.now());
  if (grantTerminal !== null) {
    detachSocket(state, attachment);
    sendStatus(socket, grantTerminal);
    return false;
  }
  if (Number(attachment.sentSequence ?? 0) >
      Number(attachment.acknowledgedSequence ?? 0)) return false;
  const row = one(
    sql,
    `SELECT sequence, event_id, cursor, payload_json, accepted_at_ms, expires_at_ms
     FROM durable_event_stream_events WHERE sequence > ? ORDER BY sequence LIMIT 1`,
    Number(meta.acknowledged_sequence)
  );
  if (!row) {
    if (grantMoved(sql, grantRowValue)) {
      detachSocket(state, attachment);
      sendStatus(socket, DURABLE_EVENT_SOCKET_STATUS.streamMoved);
    }
    return false;
  }
  const message = publicEvent(row, publicGrant(grantRowValue));
  if (encoder.encode(JSON.stringify(message)).byteLength >
      DURABLE_EVENT_SOCKET_LIMITS.maxServerEventFrameBytes) {
    detachSocket(state, attachment);
    sendStatus(socket, DURABLE_EVENT_SOCKET_STATUS.internalError,
      DURABLE_EVENT_SOCKET_CLOSE_CODES.internalError);
    return false;
  }
  if (!safeSend(socket, message)) {
    detachSocket(state, attachment);
    return false;
  }
  socket.serializeAttachment({
    ...attachment,
    sentSequence: Number(row.sequence),
    sentCursor: row.cursor
  });
  return true;
}

function terminateInvalidSockets(state, env, nowMs = Date.now()) {
  const disabled = env?.DURABLE_EVENT_STREAMS_ENABLED !== "true";
  for (const socket of streamSockets(state)) {
    const attachment = socketAttachment(socket);
    if (!attachment?.registered) continue;
    const row = grantRow(state.storage.sql, attachment.grantId);
    const terminal = disabled
      ? DURABLE_EVENT_SOCKET_STATUS.serviceDisabled
      : terminalGrantStatus(row, nowMs);
    if (terminal !== null) {
      detachSocket(state, attachment);
      sendStatus(socket, terminal);
    }
  }
}

function normalizedGrantLookup(input, { secret = true } = {}) {
  if (
    typeof input !== "object" || input === null ||
    !UUID_PATTERN.test(input.grantId ?? "") ||
    (secret && !DIGEST_PATTERN.test(input.secretDigest ?? "")) ||
    !ENVIRONMENT_PATTERN.test(input.environment ?? "") ||
    !ROUTE_ID_PATTERN.test(input.routeId ?? "") ||
    !["discord", "twitch"].includes(input.target?.platform) ||
    !/^\d{1,30}$/.test(input.target?.groupId ?? "") ||
    !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
  ) {
    throw new DurableEventGrantError("The durable-event credential is invalid.", {
      code: "durable_event_access_denied",
      status: 403
    });
  }
  return input;
}

async function issueGrant(state, registry, input) {
  const grant = input?.grant;
  const route = grant?.route;
  const definition = declaration(
    registry,
    grant?.stream?.feature,
    grant?.stream?.stream,
    grant?.stream?.version
  );
  if (
    !definition ||
    !UUID_PATTERN.test(input?.grantId ?? "") ||
    !DIGEST_PATTERN.test(input?.secretDigest ?? "") ||
    !ENVIRONMENT_PATTERN.test(grant?.environment ?? "") ||
    !["discord", "twitch"].includes(grant?.target?.platform) ||
    !/^\d{1,30}$/.test(grant?.target?.groupId ?? "") ||
    !definition.platforms.includes(grant.target.platform) ||
    !Number.isSafeInteger(grant?.issuedAtMs) ||
    !Number.isSafeInteger(grant?.expiresAtMs) ||
    grant.expiresAtMs < grant.issuedAtMs +
      DURABLE_EVENT_GRANT_LIMITS.minLifetimeSeconds * 1000 ||
    grant.expiresAtMs > grant.issuedAtMs +
      DURABLE_EVENT_GRANT_LIMITS.maxLifetimeSeconds * 1000 ||
    !ROUTE_ID_PATTERN.test(route?.routeId ?? "") ||
    route?.descriptor?.featureId !== grant.stream.feature ||
    route?.descriptor?.streamId !== grant.stream.stream ||
    route?.descriptor?.version !== grant.stream.version ||
    route?.descriptor?.scopeKind !== definition.scope.kind ||
    route?.descriptor?.deploymentEnvironment !== grant.environment ||
    await durableEventRouteId(route.descriptor) !== route.routeId ||
    typeof input?.actor?.id !== "string" || input.actor.id.length === 0 ||
    input.actor.id.length > 200 || input.actor.platform !== grant.target.platform ||
    typeof input?.resetBacklog !== "boolean"
  ) {
    throw new DurableEventGrantError("The event-grant request is invalid.");
  }
  if (definition.scope.kind === "effective_shareable" && (
    !Number.isSafeInteger(route.bindingRevision) ||
    route.bindingRevision < 0 ||
    route.binding?.revision !== route.bindingRevision ||
    route.binding?.sourceKey !== route.descriptor.realmIdentity ||
    route.binding?.sourceGroup?.platform !== grant.target.platform ||
    route.binding?.sourceGroup?.id !== grant.target.groupId
  )) {
    throw new DurableEventGrantError("The event-grant binding is invalid.", {
      code: "durable_event_stream_transition",
      status: 409
    });
  }
  const nowMs = grant.issuedAtMs;
  const resetId = crypto.randomUUID();
  const result = state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    let meta = metadata(sql);
    const previousGrantId = one(
      sql,
      "SELECT grant_id FROM durable_event_stream_grants WHERE status = 'active'"
    )?.grant_id ?? null;
    if (meta.route_id !== null && meta.route_id !== route.routeId) {
      throw new DurableEventGrantError("The event stream moved.", {
        code: "durable_event_stream_transition",
        status: 409
      });
    }
    if (meta.descriptor_json !== null &&
        meta.descriptor_json !== JSON.stringify(route.descriptor)) {
      throw new DurableEventGrantError("The event stream moved.", {
        code: "durable_event_stream_transition",
        status: 409
      });
    }
    if (definition.scope.kind === "effective_shareable") {
      requireEffectiveBinding(sql, {
        definition,
        binding: {
          sourceGroupKey: route.binding.sourceGroup.key,
          targetPlatform: route.binding.targetPlatform,
          revision: route.binding.revision,
          sourceKey: route.binding.sourceKey
        }
      });
    }
    meta = metadata(sql);
    if (meta.gap_first_sequence !== null && !input.resetBacklog) {
      throw durableEventError(DURABLE_EVENT_CODES.gapRequiresReset, { status: 409 });
    }
    let reset = null;
    if (input.resetBacklog) {
      reset = meta.gap_first_sequence === null ? null : {
        firstSequence: Number(meta.gap_first_sequence),
        lastSequence: Number(meta.gap_last_sequence)
      };
      sql.exec("DELETE FROM durable_event_stream_events");
      sql.exec(
        `UPDATE durable_event_stream_metadata
         SET retained_count = 0, retained_bytes = 0,
             acknowledged_sequence = next_sequence - 1,
             acknowledged_cursor = NULL,
             gap_first_sequence = NULL, gap_last_sequence = NULL,
             consumer_ready = 0, consumer_grant_id = NULL
         WHERE singleton = 1`
      );
      if (reset !== null) {
        sql.exec(
          `INSERT INTO durable_event_stream_resets
           (reset_id, feature_id, stream_id, stream_version, route_id,
            first_sequence, last_sequence, actor_json, reset_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          resetId,
          grant.stream.feature,
          grant.stream.stream,
          grant.stream.version,
          route.routeId,
          reset.firstSequence,
          reset.lastSequence,
          JSON.stringify(input.actor),
          nowMs
        );
        sql.exec(
          `DELETE FROM durable_event_stream_resets WHERE reset_id IN (
             SELECT reset_id FROM durable_event_stream_resets
             ORDER BY reset_at_ms DESC, reset_id DESC LIMIT -1 OFFSET ?
           )`,
          MAX_RESET_AUDIT_ROWS
        );
      }
    }
    sql.exec(
      `UPDATE durable_event_stream_grants
       SET status = 'replaced', revoked_at_ms = ? WHERE status = 'active'`,
      nowMs
    );
    sql.exec(
      `DELETE FROM durable_event_stream_grants
       WHERE expires_at_ms < ? OR (revoked_at_ms IS NOT NULL AND revoked_at_ms < ?)`,
      nowMs - 7 * 24 * 60 * 60 * 1000,
      nowMs - 7 * 24 * 60 * 60 * 1000
    );
    sql.exec(
      `DELETE FROM durable_event_stream_grants WHERE grant_id IN (
         SELECT grant_id FROM durable_event_stream_grants
         WHERE status <> 'active'
         ORDER BY COALESCE(revoked_at_ms, expires_at_ms) DESC, grant_id DESC
         LIMIT -1 OFFSET ?
       )`,
      MAX_GRANT_ROWS - 1
    );
    sql.exec(
      `INSERT INTO durable_event_stream_grants
       (grant_id, secret_digest, environment, target_platform, target_group_id,
        feature_id, stream_id, stream_version, route_id, binding_revision,
        issued_by_json, issued_at_ms, expires_at_ms, status, revoked_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)`,
      input.grantId,
      input.secretDigest,
      grant.environment,
      grant.target.platform,
      grant.target.groupId,
      grant.stream.feature,
      grant.stream.stream,
      grant.stream.version,
      route.routeId,
      route.bindingRevision,
      JSON.stringify(input.actor),
      grant.issuedAtMs,
      grant.expiresAtMs
    );
    sql.exec(
      `UPDATE durable_event_stream_metadata
       SET route_id = COALESCE(route_id, ?),
           descriptor_json = COALESCE(descriptor_json, ?), consumer_ready = 0,
           consumer_grant_id = NULL
       WHERE singleton = 1`,
      route.routeId,
      JSON.stringify(route.descriptor)
    );
    return { created: true, reset, previousGrantId };
  });
  if (result.previousGrantId) {
    terminateSockets(state, DURABLE_EVENT_SOCKET_STATUS.grantReplaced, {
      grantId: result.previousGrantId
    });
  }
  state.waitUntil(scheduleNextAlarm(state));
  return { created: result.created, reset: result.reset };
}

function validateGrant(state, rawInput, options) {
  const input = normalizedGrantLookup(rawInput, options);
  const row = grantRow(state.storage.sql, input.grantId);
  const status = grantStatus(row, input, input.nowMs, options);
  return status === "active" ? { status, grant: publicGrant(row) } : { status };
}

function revokeGrant(state, rawInput) {
  const input = normalizedGrantLookup(rawInput);
  const row = grantRow(state.storage.sql, input.grantId);
  const status = grantStatus(row, input, input.nowMs);
  if (status !== "active") return { status };
  state.storage.sql.exec(
    `UPDATE durable_event_stream_grants
     SET status = 'revoked', revoked_at_ms = ?
     WHERE grant_id = ? AND status = 'active'`,
    input.nowMs,
    input.grantId
  );
  const meta = metadata(state.storage.sql);
  if (meta.consumer_grant_id === input.grantId) {
    state.storage.sql.exec(
      `UPDATE durable_event_stream_metadata
       SET consumer_ready = 0, consumer_grant_id = NULL WHERE singleton = 1`
    );
  }
  terminateSockets(state, DURABLE_EVENT_SOCKET_STATUS.grantRevoked, {
    grantId: input.grantId
  });
  return { status: "revoked" };
}

async function append(state, registry, rawInput) {
  const input = await validateAppendInput(rawInput, registry);
  const nowMs = Date.now();
  if (pruneExpired(state, nowMs) > 0) {
    terminateSockets(state, DURABLE_EVENT_SOCKET_STATUS.retentionGap);
  }
  const existing = one(
    state.storage.sql,
    `SELECT event_id, fingerprint, sequence, accepted_at_ms
     FROM durable_event_stream_receipts WHERE event_id = ?`,
    input.eventId
  );
  if (existing) {
    if (existing.fingerprint !== input.fingerprint) {
      throw durableEventError(DURABLE_EVENT_CODES.sourceConflict, { status: 409 });
    }
    return {
      replayed: true,
      sequence: Number(existing.sequence),
      acceptedAtMs: Number(existing.accepted_at_ms)
    };
  }
  if (input.recoveryOnly === true) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
  }
  const cursor = `dec1.${randomBase64Url()}`;
  // Binding movement is stream lifecycle state, not part of an individual
  // append. Commit it first so a rejected append can still require a newly
  // connected consumer for a later incarnation of the same physical stream.
  state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const meta = metadata(sql);
    if (meta.route_id !== null && meta.route_id !== input.route.routeId) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    if (
      meta.descriptor_json !== null &&
      meta.descriptor_json !== JSON.stringify(input.route.descriptor)
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    if (
      input.definition.scope.kind === "group_local" &&
      meta.binding_revision !== null &&
      Number(meta.binding_revision) !== input.route.bindingRevision
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    requireEffectiveBinding(sql, input);
    if (input.definition.scope.kind === "effective_shareable") {
      sql.exec(
        `UPDATE durable_event_stream_metadata
         SET route_id = COALESCE(route_id, ?),
             descriptor_json = COALESCE(descriptor_json, ?)
         WHERE singleton = 1`,
        input.route.routeId,
        JSON.stringify(input.route.descriptor)
      );
    }
  });
  const result = state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const meta = metadata(sql);
    if (meta.route_id !== null && meta.route_id !== input.route.routeId) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    if (
      meta.descriptor_json !== null &&
      meta.descriptor_json !== JSON.stringify(input.route.descriptor)
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    if (
      input.definition.scope.kind === "group_local" &&
      meta.binding_revision !== null &&
      Number(meta.binding_revision) !== input.route.bindingRevision
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    if (meta.gap_first_sequence !== null) {
      throw durableEventError(DURABLE_EVENT_CODES.gapRequiresReset, { status: 409 });
    }
    const epoch = Number(meta.consumer_epoch ?? 0);
    const selectedGrant = meta.consumer_grant_id === null
      ? null
      : grantRow(sql, meta.consumer_grant_id);
    const grantIsViable = selectedGrant !== null &&
      selectedGrant.status === "active" && Number(selectedGrant.expires_at_ms) > nowMs &&
      selectedGrant.route_id === input.route.routeId &&
      Number(selectedGrant.binding_revision) === Number(input.route.bindingRevision) &&
      !grantMoved(sql, selectedGrant);
    const socketIsViable = epoch === 0 || currentSocket(state, meta) !== null;
    if (Number(meta.consumer_ready) !== 1 ||
        (epoch > 0 && (!grantIsViable || !socketIsViable))) {
      throw durableEventError(DURABLE_EVENT_CODES.consumerUnavailable, { status: 409 });
    }
    const ingress = Number(one(
      sql,
      "SELECT COUNT(*) AS total FROM durable_event_stream_ingress WHERE accepted_at_ms > ?",
      nowMs - 1_000
    )?.total ?? 0);
    if (
      Number(meta.retained_count) >= DURABLE_EVENT_LIMITS.maxRetainedEvents ||
      Number(meta.retained_bytes) + input.payloadBytes >
        DURABLE_EVENT_LIMITS.maxRetainedBytes ||
      ingress >= DURABLE_EVENT_LIMITS.maxIngressPerSecond
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.streamFull, { status: 429 });
    }
    const sequence = Number(meta.next_sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1 ||
        sequence === Number.MAX_SAFE_INTEGER) {
      throw durableEventError(DURABLE_EVENT_CODES.streamFull, { status: 409 });
    }
    const receiptMetadataBytes = Number(one(
      sql,
      `SELECT COALESCE(SUM(metadata_bytes), 0) AS total
       FROM durable_event_stream_receipts`
    )?.total ?? 0);
    const receiptRows = Number(one(
      sql,
      "SELECT COUNT(*) AS total FROM durable_event_stream_receipts"
    )?.total ?? 0);
    const metadataBytes =
      input.eventId.length + input.fingerprint.length + cursor.length + 32;
    if (
      receiptRows >= DURABLE_EVENT_LIMITS.maxReceiptRows ||
      receiptMetadataBytes + metadataBytes >
        DURABLE_EVENT_LIMITS.maxReceiptMetadataBytes
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.streamFull, { status: 429 });
    }
    const expiresAtMs = nowMs + DURABLE_EVENT_LIMITS.retentionMs;
    const receiptExpiresAtMs = nowMs + DURABLE_EVENT_LIMITS.receiptRetentionMs;
    sql.exec(
      `INSERT INTO durable_event_stream_events
       (sequence, event_id, cursor, payload_json, payload_bytes, accepted_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sequence,
      input.eventId,
      cursor,
      input.payload,
      input.payloadBytes,
      nowMs,
      expiresAtMs
    );
    sql.exec(
      `INSERT INTO durable_event_stream_receipts
       (event_id, fingerprint, cursor, sequence, accepted_at_ms, expires_at_ms, metadata_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.eventId,
      input.fingerprint,
      cursor,
      sequence,
      nowMs,
      receiptExpiresAtMs,
      metadataBytes
    );
    sql.exec(
      "INSERT INTO durable_event_stream_ingress (event_id, accepted_at_ms) VALUES (?, ?)",
      input.eventId,
      nowMs
    );
    sql.exec(
      `UPDATE durable_event_stream_metadata
       SET route_id = COALESCE(route_id, ?), descriptor_json = COALESCE(descriptor_json, ?),
           binding_revision = COALESCE(binding_revision, ?), next_sequence = ?,
           retained_count = retained_count + 1,
           retained_bytes = retained_bytes + ?
       WHERE singleton = 1`,
      input.route.routeId,
      JSON.stringify(input.route.descriptor),
      input.definition.scope.kind === "group_local"
        ? input.route.bindingRevision
        : null,
      sequence + 1,
      input.payloadBytes
    );
    return { replayed: false, sequence, acceptedAtMs: nowMs };
  });
  const socket = currentSocket(state);
  if (socket) sendNextEvent(state, socket);
  state.waitUntil(scheduleNextAlarm(state));
  return result;
}

function socketFailure(message, {
  status = 403,
  code = "durable_event_socket_invalid"
} = {}) {
  throw new DurableEventGrantError(message, { status, code });
}

function socketHandshake(request) {
  const grantId = request.headers.get(DURABLE_EVENT_SOCKET_GRANT_HEADER);
  const platform = request.headers.get(DURABLE_EVENT_SOCKET_PLATFORM_HEADER);
  const groupId = request.headers.get(DURABLE_EVENT_SOCKET_GROUP_HEADER);
  const routeId = request.headers.get(DURABLE_EVENT_SOCKET_ROUTE_HEADER);
  if (!UUID_PATTERN.test(grantId ?? "") ||
      !["discord", "twitch"].includes(platform) ||
      !/^\d{1,30}$/.test(groupId ?? "") ||
      !ROUTE_ID_PATTERN.test(routeId ?? "")) {
    socketFailure("Durable-event socket authentication is invalid.");
  }
  return { grantId, target: { platform, groupId }, routeId };
}

export function acceptDurableEventSocket(state, env, request) {
  if (env?.DURABLE_EVENT_STREAMS_ENABLED !== "true") {
    socketFailure("Durable event streams are unavailable.", {
      status: 503,
      code: "durable_event_service_unavailable"
    });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const authenticated = socketHandshake(request);
  const nowMs = Date.now();
  const row = grantRow(state.storage.sql, authenticated.grantId);
  const status = grantStatus(row, {
    ...authenticated,
    environment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT,
    nowMs
  }, nowMs, { secret: false });
  if (status !== "active") {
    socketFailure("Durable-event socket authentication is invalid.");
  }
  const pair = new globalThis.WebSocketPair();
  const [client, server] = Object.values(pair);
  server.serializeAttachment({
    version: 1,
    transport: SOCKET_TRANSPORT,
    registered: false,
    ...authenticated
  });
  state.acceptWebSocket(server, [SOCKET_TAG]);
  return new Response(null, { status: 101, webSocket: client });
}

function readyFrame(row) {
  return {
    protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
    type: DURABLE_EVENT_SOCKET_TYPES.ready,
    stream: publicGrant(row).stream,
    delivery: {
      kind: "bounded_at_least_once",
      retentionSeconds: DURABLE_EVENT_LIMITS.retentionMs / 1_000,
      maxRetainedEvents: DURABLE_EVENT_LIMITS.maxRetainedEvents,
      maxRetainedBytes: DURABLE_EVENT_LIMITS.maxRetainedBytes
    }
  };
}

function registerSocket(state, env, socket, attachment) {
  if (env?.DURABLE_EVENT_STREAMS_ENABLED !== "true") {
    socketFailure("Durable event streams are unavailable.", {
      status: 503,
      code: "durable_event_service_unavailable"
    });
  }
  const nowMs = Date.now();
  const row = grantRow(state.storage.sql, attachment.grantId);
  if (grantStatus(row, {
    ...attachment,
    environment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT,
    nowMs
  }, nowMs, { secret: false }) !== "active") {
    socketFailure("Durable-event grant is not active.");
  }
  const priorSockets = streamSockets(state).filter((candidate) => candidate !== socket);
  const registered = state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const meta = metadata(sql);
    if (meta.route_id !== attachment.routeId || meta.gap_first_sequence !== null) {
      socketFailure("Durable-event stream is unavailable.");
    }
    const currentGrant = grantRow(sql, attachment.grantId);
    if (terminalGrantStatus(currentGrant, nowMs) !== null) {
      socketFailure("Durable-event grant is not active.");
    }
    const epoch = Number(meta.consumer_epoch ?? 0) + 1;
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      socketFailure("Durable-event stream is unavailable.", { status: 503 });
    }
    const moved = grantMoved(sql, currentGrant);
    sql.exec(
      `UPDATE durable_event_stream_metadata
       SET consumer_epoch = ?, consumer_grant_id = ?, consumer_ready = ?
       WHERE singleton = 1`,
      epoch,
      attachment.grantId,
      moved ? 0 : 1
    );
    return {
      epoch,
      moved,
      acknowledgedSequence: Number(meta.acknowledged_sequence),
      acknowledgedCursor: meta.acknowledged_cursor,
      grant: currentGrant
    };
  });
  const nextAttachment = {
    ...attachment,
    registered: true,
    epoch: registered.epoch,
    acknowledgedSequence: registered.acknowledgedSequence,
    acknowledgedCursor: registered.acknowledgedCursor,
    sentSequence: registered.acknowledgedSequence,
    sentCursor: registered.acknowledgedCursor
  };
  socket.serializeAttachment(nextAttachment);
  for (const prior of priorSockets) {
    if (socketAttachment(prior)?.registered) {
      sendStatus(prior, DURABLE_EVENT_SOCKET_STATUS.consumerReplaced,
        DURABLE_EVENT_SOCKET_CLOSE_CODES.replaced);
    }
  }
  if (!safeSend(socket, readyFrame(registered.grant))) {
    detachSocket(state, nextAttachment);
    return;
  }
  sendNextEvent(state, socket);
}

function acknowledgeSocketEvent(state, socket, attachment, cursor) {
  const sql = state.storage.sql;
  const meta = metadata(sql);
  if (Number(meta.consumer_epoch) !== attachment.epoch ||
      meta.consumer_grant_id !== attachment.grantId) {
    socketFailure("Durable-event consumer was replaced.");
  }
  const sentSequence = Number(attachment.sentSequence ?? 0);
  const acknowledgedSequence = Number(meta.acknowledged_sequence);
  if (cursor === attachment.sentCursor && sentSequence > acknowledgedSequence) {
    const event = one(
      sql,
      `SELECT sequence, payload_bytes FROM durable_event_stream_events
       WHERE sequence = ? AND cursor = ?`,
      sentSequence,
      cursor
    );
    if (!event) socketFailure("Durable-event acknowledgement is invalid.");
    state.storage.transactionSync(() => {
      const removed = one(
        sql,
        `SELECT COUNT(*) AS total, COALESCE(SUM(payload_bytes), 0) AS bytes
         FROM durable_event_stream_events WHERE sequence <= ?`,
        sentSequence
      );
      sql.exec("DELETE FROM durable_event_stream_events WHERE sequence <= ?", sentSequence);
      sql.exec(
        `UPDATE durable_event_stream_metadata
         SET acknowledged_sequence = ?, acknowledged_cursor = ?,
             retained_count = MAX(0, retained_count - ?),
             retained_bytes = MAX(0, retained_bytes - ?)
         WHERE singleton = 1 AND consumer_epoch = ? AND consumer_grant_id = ?`,
        sentSequence,
        cursor,
        Number(removed.total),
        Number(removed.bytes),
        attachment.epoch,
        attachment.grantId
      );
    });
    socket.serializeAttachment({
      ...attachment,
      acknowledgedSequence: sentSequence,
      acknowledgedCursor: cursor
    });
    sendNextEvent(state, socket);
    state.waitUntil(scheduleNextAlarm(state));
    return;
  }
  if (cursor === meta.acknowledged_cursor) return;
  const duplicate = one(
    sql,
    `SELECT sequence FROM durable_event_stream_receipts
     WHERE cursor = ? AND sequence <= ?`,
    cursor,
    acknowledgedSequence
  );
  if (duplicate) return;
  socketFailure("Durable-event acknowledgement is invalid.");
}

export async function handleDurableEventSocketMessage(state, env, socket, message) {
  const attachment = socketAttachment(socket);
  try {
    if (attachment?.transport !== SOCKET_TRANSPORT) {
      socketFailure("Durable-event socket connection is invalid.");
    }
    if (typeof message !== "string") {
      socketFailure("Durable-event socket messages must be UTF-8 text.", {
        status: 413
      });
    }
    if (message === DURABLE_EVENT_SOCKET_PING) {
      safeSend(socket, DURABLE_EVENT_SOCKET_PONG);
      return;
    }
    const maximumBytes = attachment.registered
      ? DURABLE_EVENT_SOCKET_LIMITS.maxControlFrameBytes
      : DURABLE_EVENT_SOCKET_LIMITS.maxRegistrationFrameBytes;
    if (encoder.encode(message).byteLength > maximumBytes) {
      socketFailure("Durable-event socket message exceeds its size limit.", {
        status: 413
      });
    }
    let input;
    try {
      input = JSON.parse(message);
    } catch {
      socketFailure("Durable-event socket message is invalid.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        input.protocol !== DURABLE_EVENT_SOCKET_PROTOCOL) {
      socketFailure("Durable-event socket protocol is invalid.");
    }
    if (!attachment.registered) {
      if (input.type !== DURABLE_EVENT_SOCKET_TYPES.register ||
          !hasOnlyKeys(input, new Set(["protocol", "type"]))) {
        socketFailure("The first durable-event socket message must register.");
      }
      registerSocket(state, env, socket, attachment);
      return;
    }
    if (input.type !== DURABLE_EVENT_SOCKET_TYPES.acknowledge ||
        !hasOnlyKeys(input, new Set(["protocol", "type", "cursor"])) ||
        typeof input.cursor !== "string" || !CURSOR_PATTERN.test(input.cursor)) {
      socketFailure("Durable-event socket control message is invalid.");
    }
    acknowledgeSocketEvent(state, socket, attachment, input.cursor);
  } catch (error) {
    detachSocket(state, attachment);
    safeSend(socket, {
      protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
      type: DURABLE_EVENT_SOCKET_TYPES.error,
      code: error?.code ?? "durable_event_socket_invalid",
      message: "Durable event socket message is invalid."
    });
    const closeCode = error?.status === 413
      ? DURABLE_EVENT_SOCKET_CLOSE_CODES.messageTooLarge
      : error?.status === 429 || error?.status === 503
        ? DURABLE_EVENT_SOCKET_CLOSE_CODES.tryAgainLater
        : error instanceof DurableEventGrantError
          ? DURABLE_EVENT_SOCKET_CLOSE_CODES.policyViolation
          : DURABLE_EVENT_SOCKET_CLOSE_CODES.internalError;
    closeSocket(socket, closeCode, closeCode === DURABLE_EVENT_SOCKET_CLOSE_CODES.messageTooLarge
      ? "Message too large"
      : closeCode === DURABLE_EVENT_SOCKET_CLOSE_CODES.tryAgainLater
        ? "Try again later"
        : closeCode === DURABLE_EVENT_SOCKET_CLOSE_CODES.policyViolation
          ? "Policy violation"
          : "Internal error");
  }
}

export function closeDurableEventSocket(state, socket) {
  detachSocket(state, socketAttachment(socket));
}

export function initializeDurableEventStreamTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS durable_event_stream_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      route_id TEXT,
      descriptor_json TEXT,
      binding_revision INTEGER,
      next_sequence INTEGER NOT NULL,
      retained_count INTEGER NOT NULL,
      retained_bytes INTEGER NOT NULL,
      acknowledged_sequence INTEGER NOT NULL,
      acknowledged_cursor TEXT,
      gap_first_sequence INTEGER,
      gap_last_sequence INTEGER,
      consumer_ready INTEGER NOT NULL,
      consumer_epoch INTEGER NOT NULL DEFAULT 0,
      consumer_grant_id TEXT
    );
    INSERT OR IGNORE INTO durable_event_stream_metadata
      (singleton, route_id, descriptor_json, binding_revision, next_sequence,
       retained_count, retained_bytes, acknowledged_sequence,
       gap_first_sequence, gap_last_sequence, consumer_ready)
      VALUES (1, NULL, NULL, NULL, 1, 0, 0, 0, NULL, NULL, 0);
    CREATE TABLE IF NOT EXISTS durable_event_stream_events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      cursor TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS durable_event_stream_events_expiry
      ON durable_event_stream_events(expires_at_ms, sequence);
    CREATE TABLE IF NOT EXISTS durable_event_stream_receipts (
      event_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      cursor TEXT NOT NULL UNIQUE,
      sequence INTEGER NOT NULL,
      accepted_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      metadata_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS durable_event_stream_receipts_expiry
      ON durable_event_stream_receipts(expires_at_ms, event_id);
    CREATE TABLE IF NOT EXISTS durable_event_stream_ingress (
      event_id TEXT PRIMARY KEY,
      accepted_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS durable_event_stream_ingress_time
      ON durable_event_stream_ingress(accepted_at_ms, event_id);
    CREATE TABLE IF NOT EXISTS durable_event_stream_bindings (
      source_group_key TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      binding_revision INTEGER NOT NULL CHECK (binding_revision >= 0),
      source_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'moved')),
      reason TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_group_key, target_platform)
    );
    CREATE TABLE IF NOT EXISTS durable_event_stream_grants (
      grant_id TEXT PRIMARY KEY,
      secret_digest TEXT NOT NULL,
      environment TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      target_group_id TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      route_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL,
      issued_by_json TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'replaced')),
      revoked_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS durable_event_stream_grants_expiry
      ON durable_event_stream_grants(expires_at_ms, status);
    CREATE TABLE IF NOT EXISTS durable_event_stream_resets (
      reset_id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      route_id TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      actor_json TEXT NOT NULL,
      reset_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS durable_event_stream_resets_time
      ON durable_event_stream_resets(reset_at_ms, reset_id);
  `);
  const tableColumns = (table) => new Set(state.storage.sql.exec(
    `PRAGMA table_info(${table})`
  ).toArray().map((column) => column.name));
  const metadataColumns = tableColumns("durable_event_stream_metadata");
  for (const [name, definition] of [
    ["acknowledged_cursor", "TEXT"],
    ["consumer_epoch", "INTEGER NOT NULL DEFAULT 0"],
    ["consumer_grant_id", "TEXT"]
  ]) {
    if (!metadataColumns.has(name)) {
      state.storage.sql.exec(
        `ALTER TABLE durable_event_stream_metadata ADD COLUMN ${name} ${definition}`
      );
    }
  }
  if (!tableColumns("durable_event_stream_events").has("cursor")) {
    state.storage.sql.exec("ALTER TABLE durable_event_stream_events ADD COLUMN cursor TEXT");
  }
  if (!tableColumns("durable_event_stream_receipts").has("cursor")) {
    state.storage.sql.exec("ALTER TABLE durable_event_stream_receipts ADD COLUMN cursor TEXT");
  }
  for (const row of state.storage.sql.exec(
    "SELECT event_id FROM durable_event_stream_events WHERE cursor IS NULL"
  ).toArray()) {
    const cursor = `dec1.${randomBase64Url()}`;
    state.storage.sql.exec(
      "UPDATE durable_event_stream_events SET cursor = ? WHERE event_id = ?",
      cursor,
      row.event_id
    );
    state.storage.sql.exec(
      `UPDATE durable_event_stream_receipts
       SET cursor = ?, metadata_bytes = metadata_bytes + ?
       WHERE event_id = ? AND cursor IS NULL`,
      cursor,
      cursor.length,
      row.event_id
    );
  }
  for (const row of state.storage.sql.exec(
    "SELECT event_id FROM durable_event_stream_receipts WHERE cursor IS NULL"
  ).toArray()) {
    const cursor = `dec1.${randomBase64Url()}`;
    state.storage.sql.exec(
      `UPDATE durable_event_stream_receipts
       SET cursor = ?, metadata_bytes = metadata_bytes + ? WHERE event_id = ?`,
      cursor,
      cursor.length,
      row.event_id
    );
  }
  state.storage.sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS durable_event_stream_events_cursor
      ON durable_event_stream_events(cursor);
    CREATE UNIQUE INDEX IF NOT EXISTS durable_event_stream_receipts_cursor
      ON durable_event_stream_receipts(cursor);
  `);
}

export class DurableEventStreamBackend {
  constructor(state, env, registry) {
    this.state = state;
    this.env = env;
    this.registry = registry;
    initializeDurableEventStreamTables(state);
    state.setWebSocketAutoResponse(new globalThis.WebSocketRequestResponsePair(
      DURABLE_EVENT_SOCKET_PING,
      DURABLE_EVENT_SOCKET_PONG
    ));
  }

  async fetch(request) {
    try {
      requireInternal(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === DURABLE_EVENT_SOCKET_INTERNAL_PATH) {
        return acceptDurableEventSocket(this.state, this.env, request);
      }
      if (request.method === "POST" && url.pathname === DURABLE_EVENT_APPEND_PATH) {
        return json(await append(this.state, this.registry, await request.json()));
      }
      if (request.method === "POST" && url.pathname === DURABLE_EVENT_BINDING_PATH) {
        const result = applyBindingNotification(this.state, await request.json());
        if (!result.stale && Number(metadata(this.state.storage.sql).retained_count) === 0) {
          terminateSockets(this.state, DURABLE_EVENT_SOCKET_STATUS.streamMoved);
        }
        return json(result);
      }
      if (request.method === "POST" && url.pathname.startsWith(`${DURABLE_EVENT_GRANT_PATH}/`)) {
        const operation = url.pathname.slice(`${DURABLE_EVENT_GRANT_PATH}/`.length);
        const input = await request.json();
        if (operation === "issue") {
          return json(await issueGrant(this.state, this.registry, input), 201);
        }
        if (operation === "validate") {
          return json(validateGrant(this.state, input));
        }
        if (operation === "reference") {
          return json(validateGrant(this.state, input, { secret: false }));
        }
        if (operation === "revoke") {
          const result = revokeGrant(this.state, input);
          this.state.waitUntil(scheduleNextAlarm(this.state));
          return json(result);
        }
      }
      return new Response("Not Found", { status: 404 });
    } catch (cause) {
      if (cause instanceof DurableEventError || cause instanceof DurableEventGrantError) {
        return json({ error: cause.message, code: cause.code }, cause.status);
      }
      logError("durable_event.stream_failed", {
        platform: "shared",
        correlationId: crypto.randomUUID()
      }, cause);
      return json({
        error: "The durable event service is temporarily unavailable.",
        code: DURABLE_EVENT_CODES.serviceUnavailable
      }, 500);
    }
  }

  async alarm() {
    const nowMs = Date.now();
    if (pruneExpired(this.state, nowMs) > 0) {
      terminateSockets(this.state, DURABLE_EVENT_SOCKET_STATUS.retentionGap);
    }
    terminateInvalidSockets(this.state, this.env, nowMs);
    const meta = metadata(this.state.storage.sql);
    const activeGrant = meta.consumer_grant_id
      ? grantRow(this.state.storage.sql, meta.consumer_grant_id)
      : null;
    if (Number(meta.retained_count) === 0 && grantMoved(this.state.storage.sql, activeGrant)) {
      terminateSockets(this.state, DURABLE_EVENT_SOCKET_STATUS.streamMoved);
    }
    await scheduleNextAlarm(this.state);
  }

  async webSocketMessage(socket, message) {
    await handleDurableEventSocketMessage(this.state, this.env, socket, message);
  }

  async webSocketClose(socket, code, reason, wasClean) {
    void code;
    void reason;
    void wasClean;
    closeDurableEventSocket(this.state, socket);
  }

  async webSocketError(socket, error) {
    void error;
    closeDurableEventSocket(this.state, socket);
    closeSocket(socket, DURABLE_EVENT_SOCKET_CLOSE_CODES.internalError,
      "Durable event stream unavailable");
  }
}

export const durableEventInternalHeaders = Object.freeze({
  [INTERNAL_HEADER]: INTERNAL_VALUE
});
