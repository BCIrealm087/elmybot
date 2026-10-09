import {
  DURABLE_EVENT_CODES,
  DURABLE_EVENT_LIMITS,
  durableEventError,
  DurableEventError
} from "./contract.js";

export const DURABLE_EVENT_LEDGER_PATH = "/internal/durable-events/publications";

const EVENT_ID_PATTERN = /^dev1\.[A-Za-z0-9_-]{43}$/;
const ROUTE_ID_PATTERN = /^des1\.[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const TERMINAL_STATES = new Set(["committed", "rejected"]);

function one(sql, query, ...bindings) {
  return sql.exec(query, ...bindings).toArray()[0] ?? null;
}

function count(sql, query, ...bindings) {
  return Number(one(sql, query, ...bindings)?.total ?? 0);
}

function requireInput(input) {
  if (
    typeof input !== "object" ||
    input === null ||
    !EVENT_ID_PATTERN.test(input.eventId ?? "") ||
    !FINGERPRINT_PATTERN.test(input.fingerprint ?? "") ||
    !SAFE_ID_PATTERN.test(input.featureId ?? "") ||
    !SAFE_ID_PATTERN.test(input.streamId ?? "") ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !ROUTE_ID_PATTERN.test(input.route?.routeId ?? "") ||
    !Number.isSafeInteger(input.route?.bindingRevision) ||
    input.route.bindingRevision < 0 ||
    typeof input.route?.descriptor !== "object" ||
    input.route.descriptor === null ||
    typeof input.payload !== "string"
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  const pendingBytes = new TextEncoder().encode(input.payload).byteLength;
  const routeJson = JSON.stringify(input.route);
  if (pendingBytes > DURABLE_EVENT_LIMITS.maxPayloadBytes) {
    throw durableEventError(DURABLE_EVENT_CODES.payloadInvalid, { status: 422 });
  }
  if (new TextEncoder().encode(routeJson).byteLength > 2_048) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  return {
    ...input,
    pendingBytes,
    routeJson
  };
}

function publicRow(row) {
  if (row.state === "committed") {
    return {
      state: "committed",
      receipt: {
        sequence: Number(row.sequence),
        acceptedAtMs: Number(row.accepted_at_ms)
      }
    };
  }
  if (row.state === "rejected") {
    return { state: "rejected", code: row.rejection_code };
  }
  return {
    state: "pending",
    route: JSON.parse(row.route_json)
  };
}

function prune(sql, nowMs) {
  sql.exec(
    `UPDATE durable_event_publications
     SET state = 'rejected', rejection_code = ?, pending_payload = NULL,
         pending_payload_bytes = 0, updated_at_ms = ?, expires_at_ms = ?
     WHERE state = 'pending' AND expires_at_ms <= ?`,
    DURABLE_EVENT_CODES.serviceUnavailable,
    nowMs,
    nowMs + DURABLE_EVENT_LIMITS.receiptRetentionMs,
    nowMs
  );
  sql.exec(
    `DELETE FROM durable_event_publications
     WHERE state IN ('committed', 'rejected') AND expires_at_ms <= ?`,
    nowMs
  );
}

function prepare(state, rawInput) {
  const input = requireInput(rawInput);
  const nowMs = Date.now();
  return state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    prune(sql, nowMs);
    const existing = one(
      sql,
      `SELECT state, fingerprint, route_json, sequence, accepted_at_ms,
              rejection_code
       FROM durable_event_publications WHERE event_id = ?`,
      input.eventId
    );
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        throw durableEventError(DURABLE_EVENT_CODES.sourceConflict, { status: 409 });
      }
      return publicRow(existing);
    }
    const rows = count(sql, "SELECT COUNT(*) AS total FROM durable_event_publications");
    const pendingRows = count(
      sql,
      "SELECT COUNT(*) AS total FROM durable_event_publications WHERE state = 'pending'"
    );
    const pendingBytes = count(
      sql,
      `SELECT COALESCE(SUM(pending_payload_bytes), 0) AS total
       FROM durable_event_publications WHERE state = 'pending'`
    );
    if (
      rows >= DURABLE_EVENT_LIMITS.maxReceiptRows ||
      pendingRows >= DURABLE_EVENT_LIMITS.maxPendingRows ||
      pendingBytes + input.pendingBytes > DURABLE_EVENT_LIMITS.maxPendingBytes
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 503 });
    }
    sql.exec(
      `INSERT INTO durable_event_publications
       (event_id, fingerprint, feature_id, stream_id, stream_version,
        route_id, binding_revision, route_json, state, pending_payload,
        pending_payload_bytes, sequence, accepted_at_ms, rejection_code,
        created_at_ms, updated_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      input.eventId,
      input.fingerprint,
      input.featureId,
      input.streamId,
      input.version,
      input.route.routeId,
      input.route.bindingRevision,
      input.routeJson,
      input.payload,
      input.pendingBytes,
      nowMs,
      nowMs,
      nowMs + DURABLE_EVENT_LIMITS.receiptRetentionMs
    );
    return { state: "pending", route: input.route };
  });
}

function finalize(state, rawInput) {
  const nowMs = Date.now();
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    !EVENT_ID_PATTERN.test(rawInput.eventId ?? "") ||
    !FINGERPRINT_PATTERN.test(rawInput.fingerprint ?? "") ||
    !["committed", "rejected"].includes(rawInput.state)
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  return state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const existing = one(
      sql,
      `SELECT state, fingerprint, route_json, sequence, accepted_at_ms,
              rejection_code
       FROM durable_event_publications WHERE event_id = ?`,
      rawInput.eventId
    );
    if (!existing) {
      throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 409 });
    }
    if (existing.fingerprint !== rawInput.fingerprint) {
      throw durableEventError(DURABLE_EVENT_CODES.sourceConflict, { status: 409 });
    }
    if (TERMINAL_STATES.has(existing.state)) return publicRow(existing);
    if (rawInput.state === "committed") {
      if (
        !Number.isSafeInteger(rawInput.receipt?.sequence) ||
        rawInput.receipt.sequence < 1 ||
        !Number.isSafeInteger(rawInput.receipt?.acceptedAtMs) ||
        rawInput.receipt.acceptedAtMs < 0
      ) {
        throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
      }
      sql.exec(
        `UPDATE durable_event_publications
         SET state = 'committed', pending_payload = NULL,
             pending_payload_bytes = 0, sequence = ?, accepted_at_ms = ?,
             updated_at_ms = ? WHERE event_id = ? AND state = 'pending'`,
        rawInput.receipt.sequence,
        rawInput.receipt.acceptedAtMs,
        nowMs,
        rawInput.eventId
      );
    } else {
      if (!Object.values(DURABLE_EVENT_CODES).includes(rawInput.code)) {
        throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
      }
      sql.exec(
        `UPDATE durable_event_publications
         SET state = 'rejected', pending_payload = NULL,
             pending_payload_bytes = 0, rejection_code = ?, updated_at_ms = ?
         WHERE event_id = ? AND state = 'pending'`,
        rawInput.code,
        nowMs,
        rawInput.eventId
      );
    }
    return publicRow(one(
      sql,
      `SELECT state, route_json, sequence, accepted_at_ms, rejection_code
       FROM durable_event_publications WHERE event_id = ?`,
      rawInput.eventId
    ));
  });
}

function repin(state, rawInput) {
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    !EVENT_ID_PATTERN.test(rawInput.eventId ?? "") ||
    !FINGERPRINT_PATTERN.test(rawInput.fingerprint ?? "") ||
    !ROUTE_ID_PATTERN.test(rawInput.previousRouteId ?? "") ||
    !ROUTE_ID_PATTERN.test(rawInput.route?.routeId ?? "") ||
    !Number.isSafeInteger(rawInput.route?.bindingRevision) ||
    rawInput.route.bindingRevision < 0
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  const routeJson = JSON.stringify(rawInput.route);
  if (new TextEncoder().encode(routeJson).byteLength > 2_048) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  return state.storage.transactionSync(() => {
    const sql = state.storage.sql;
    const existing = one(
      sql,
      `SELECT state, fingerprint, route_id, route_json, sequence,
              accepted_at_ms, rejection_code
       FROM durable_event_publications WHERE event_id = ?`,
      rawInput.eventId
    );
    if (!existing) {
      throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 409 });
    }
    if (existing.fingerprint !== rawInput.fingerprint) {
      throw durableEventError(DURABLE_EVENT_CODES.sourceConflict, { status: 409 });
    }
    if (existing.state !== "pending") return publicRow(existing);
    if (existing.route_id !== rawInput.previousRouteId) return publicRow(existing);
    sql.exec(
      `UPDATE durable_event_publications
       SET route_id = ?, binding_revision = ?, route_json = ?, updated_at_ms = ?
       WHERE event_id = ? AND state = 'pending' AND route_id = ?`,
      rawInput.route.routeId,
      rawInput.route.bindingRevision,
      routeJson,
      Date.now(),
      rawInput.eventId,
      rawInput.previousRouteId
    );
    return { state: "pending", route: rawInput.route };
  });
}

export function initializeDurableEventPublicationTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS durable_event_publications (
      event_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      feature_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      route_id TEXT NOT NULL,
      binding_revision INTEGER NOT NULL,
      route_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'rejected')),
      pending_payload TEXT,
      pending_payload_bytes INTEGER NOT NULL,
      sequence INTEGER,
      accepted_at_ms INTEGER,
      rejection_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS durable_event_publications_expiry
      ON durable_event_publications(expires_at_ms, event_id);
  `);
}

export function handleDurableEventPublicationRequest(state, request, pathname) {
  if (pathname !== `${DURABLE_EVENT_LEDGER_PATH}/prepare` &&
      pathname !== `${DURABLE_EVENT_LEDGER_PATH}/finalize` &&
      pathname !== `${DURABLE_EVENT_LEDGER_PATH}/repin`) return null;
  if (request.method !== "POST") {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 405 });
  }
  return request.json().then((input) => {
    if (pathname.endsWith("/prepare")) return prepare(state, input);
    if (pathname.endsWith("/repin")) return repin(state, input);
    return finalize(state, input);
  });
}

export function isDurableEventPublicationError(error) {
  return error instanceof DurableEventError;
}
