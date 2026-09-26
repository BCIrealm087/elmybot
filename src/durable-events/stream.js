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

export const DURABLE_EVENT_APPEND_PATH = "/internal/events/append";
export const DURABLE_EVENT_CONSUMER_PATH = "/internal/events/consumer";
export const DURABLE_EVENT_BINDING_PATH = "/internal/events/binding";
export const DURABLE_EVENT_GRANT_PATH = "/internal/events/grants";
const INTERNAL_HEADER = "x-elmybot-durable-event-internal";
const INTERNAL_VALUE = "v1";
const EVENT_ID_PATTERN = /^dev1\.[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_ID_PATTERN = /^des1\.[A-Za-z0-9_-]{43}$/;
const NOTIFICATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const ENVIRONMENT_PATTERN = /^[a-z0-9_-]{1,40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_GRANT_ROWS = 1_000;
const MAX_RESET_AUDIT_ROWS = 100;

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
    if (stillCurrent) {
      sql.exec(
        "UPDATE durable_event_stream_metadata SET consumer_ready = 0 WHERE singleton = 1"
      );
    }
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
             gap_last_sequence = MAX(COALESCE(gap_last_sequence, 0), ?)
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
             gap_first_sequence = NULL, gap_last_sequence = NULL
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
           descriptor_json = COALESCE(descriptor_json, ?), consumer_ready = 0
       WHERE singleton = 1`,
      route.routeId,
      JSON.stringify(route.descriptor)
    );
    return { created: true, reset };
  });
  state.waitUntil(scheduleNextAlarm(state));
  return result;
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
  return { status: "revoked" };
}

async function append(state, registry, rawInput) {
  const input = await validateAppendInput(rawInput, registry);
  const nowMs = Date.now();
  pruneExpired(state, nowMs);
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
    if (Number(meta.consumer_ready) !== 1) {
      throw durableEventError(DURABLE_EVENT_CODES.consumerUnavailable, { status: 409 });
    }
    if (meta.gap_first_sequence !== null) {
      throw durableEventError(DURABLE_EVENT_CODES.gapRequiresReset, { status: 409 });
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
    const metadataBytes = input.eventId.length + input.fingerprint.length + 32;
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
       (sequence, event_id, payload_json, payload_bytes, accepted_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sequence,
      input.eventId,
      input.payload,
      input.payloadBytes,
      nowMs,
      expiresAtMs
    );
    sql.exec(
      `INSERT INTO durable_event_stream_receipts
       (event_id, fingerprint, sequence, accepted_at_ms, expires_at_ms, metadata_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.eventId,
      input.fingerprint,
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
  state.waitUntil(scheduleNextAlarm(state));
  return result;
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
      gap_first_sequence INTEGER,
      gap_last_sequence INTEGER,
      consumer_ready INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO durable_event_stream_metadata
      (singleton, route_id, descriptor_json, binding_revision, next_sequence,
       retained_count, retained_bytes, acknowledged_sequence,
       gap_first_sequence, gap_last_sequence, consumer_ready)
      VALUES (1, NULL, NULL, NULL, 1, 0, 0, 0, NULL, NULL, 0);
    CREATE TABLE IF NOT EXISTS durable_event_stream_events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
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
}

export class DurableEventStreamBackend {
  constructor(state, env, registry) {
    this.state = state;
    this.env = env;
    this.registry = registry;
    initializeDurableEventStreamTables(state);
  }

  async fetch(request) {
    try {
      requireInternal(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === DURABLE_EVENT_APPEND_PATH) {
        return json(await append(this.state, this.registry, await request.json()));
      }
      if (request.method === "POST" && url.pathname === DURABLE_EVENT_CONSUMER_PATH) {
        const input = await request.json();
        if (typeof input?.ready !== "boolean") {
          throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
        }
        this.state.storage.sql.exec(
          "UPDATE durable_event_stream_metadata SET consumer_ready = ? WHERE singleton = 1",
          input.ready ? 1 : 0
        );
        return json({ ready: input.ready });
      }
      if (request.method === "POST" && url.pathname === DURABLE_EVENT_BINDING_PATH) {
        return json(applyBindingNotification(this.state, await request.json()));
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
    pruneExpired(this.state, Date.now());
    await scheduleNextAlarm(this.state);
  }
}

export const durableEventInternalHeaders = Object.freeze({
  [INTERNAL_HEADER]: INTERNAL_VALUE
});
