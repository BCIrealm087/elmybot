import { canonicalStateQueryJson } from "./query.js";
import { logError } from "../common.js";
import { stateQueryErrorForLog } from "./operations.js";
import { stateQueryObserverObjectName } from "./source-notifications.js";

const MAX_ACTIVE_GRANTS = 100;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const INVALIDATION_BATCH_SIZE = 10;
const INVALIDATION_ATTEMPT_LEASE_MS = 30 * 1000;
const INVALIDATION_RETRY_BASE_MS = 1_000;
const INVALIDATION_RETRY_MAX_MS = 30 * 1000;
const GRANT_INVALIDATION_PATH = "/internal/state-query/grant-invalidation";

export class StateQueryGrantStorageError extends Error {
  constructor(message, { status = 422, code = "state_query_grant_invalid" } = {}) {
    super(message);
    this.name = "StateQueryGrantStorageError";
    this.status = status;
    this.code = code;
  }
}

function requireString(value, name, maxLength = 500) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new StateQueryGrantStorageError(`${name} is invalid.`);
  }
  return value;
}

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StateQueryGrantStorageError(`${name} is invalid.`);
  }
  return value;
}

function json(value, name) {
  try {
    return canonicalStateQueryJson(value);
  } catch (cause) {
    throw new StateQueryGrantStorageError(`${name} is invalid.`, { cause });
  }
}

export function initializeStateQueryGrantTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS state_query_read_grants (
      grant_id TEXT PRIMARY KEY,
      secret_digest TEXT NOT NULL,
      environment TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      target_group_id TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      issued_by_json TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS state_query_read_grants_expiry
      ON state_query_read_grants(expires_at_ms);
    CREATE TABLE IF NOT EXISTS state_query_grant_invalidation_outbox (
      grant_id TEXT PRIMARY KEY,
      environment TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      target_group_id TEXT NOT NULL,
      invalidated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_query_grant_invalidation_due
      ON state_query_grant_invalidation_outbox(next_attempt_at_ms);
  `);
}

export function hasPendingStateQueryGrantInvalidations(state) {
  return Boolean(state.storage.sql.exec(
    `SELECT 1 AS found FROM state_query_grant_invalidation_outbox LIMIT 1`
  ).toArray()[0]);
}

function storedGrant(row) {
  return Object.freeze({
    id: row.grant_id,
    target: Object.freeze({
      platform: row.target_platform,
      groupId: row.target_group_id
    }),
    environment: row.environment,
    permissions: Object.freeze(JSON.parse(row.permissions_json)),
    limits: Object.freeze(JSON.parse(row.limits_json)),
    issuedAtMs: Number(row.issued_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms)
  });
}

function findGrant(sql, grantId) {
  return sql.exec(
    `SELECT grant_id, secret_digest, environment, target_platform,
            target_group_id, permissions_json, limits_json, issued_by_json, issued_at_ms,
            expires_at_ms, revoked_at_ms
     FROM state_query_read_grants WHERE grant_id = ?`,
    grantId
  ).toArray()[0] ?? null;
}

function sameSecret(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function credentialStatus(row, input, nowMs) {
  if (!row || !sameSecret(row.secret_digest, input.secretDigest)) return "denied";
  if (
    row.environment !== input.environment ||
    row.target_platform !== input.target.platform ||
    row.target_group_id !== input.target.groupId
  ) return "denied";
  if (row.revoked_at_ms !== null) return "revoked";
  if (Number(row.expires_at_ms) <= nowMs) return "expired";
  return "active";
}

function referenceStatus(row, input, nowMs) {
  if (!row) return "denied";
  if (
    row.environment !== input.environment ||
    row.target_platform !== input.target.platform ||
    row.target_group_id !== input.target.groupId
  ) return "denied";
  if (row.revoked_at_ms !== null) return "revoked";
  if (Number(row.expires_at_ms) <= nowMs) return "expired";
  return "active";
}

function issueGrant(state, input) {
  const grantId = requireString(input?.grantId, "Grant ID", 80);
  const secretDigest = requireString(input?.secretDigest, "Secret digest", 100);
  const environment = requireString(input?.grant?.environment, "Environment", 40);
  const platform = requireString(input?.grant?.target?.platform, "Target platform", 20);
  const groupId = requireString(input?.grant?.target?.groupId, "Target group", 200);
  const issuedAtMs = safeInteger(input?.grant?.issuedAtMs, "Issued time");
  const expiresAtMs = safeInteger(input?.grant?.expiresAtMs, "Expiry time");
  if (expiresAtMs <= issuedAtMs) {
    throw new StateQueryGrantStorageError("Grant expiry is invalid.");
  }
  const permissionsJson = json(input?.grant?.permissions, "Grant permissions");
  const limitsJson = json(input?.grant?.limits, "Grant limits");
  const issuedByJson = json(input?.actor, "Grant issuer");

  state.storage.transactionSync(() => {
    state.storage.sql.exec(
      `DELETE FROM state_query_read_grants
       WHERE expires_at_ms < ?`,
      issuedAtMs - RETENTION_MS
    );
    const active = state.storage.sql.exec(
      `SELECT COUNT(*) AS total FROM state_query_read_grants
       WHERE revoked_at_ms IS NULL AND expires_at_ms > ?`,
      issuedAtMs
    ).toArray()[0];
    if (Number(active.total) >= MAX_ACTIVE_GRANTS) {
      throw new StateQueryGrantStorageError("The group has too many active read grants.", {
        status: 409,
        code: "state_query_grant_capacity"
      });
    }
    state.storage.sql.exec(
      `INSERT INTO state_query_read_grants
        (grant_id, secret_digest, environment, target_platform, target_group_id,
         permissions_json, limits_json, issued_by_json, issued_at_ms, expires_at_ms,
         revoked_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      grantId,
      secretDigest,
      environment,
      platform,
      groupId,
      permissionsJson,
      limitsJson,
      issuedByJson,
      issuedAtMs,
      expiresAtMs
    );
  });
  return { created: true };
}

function validateGrant(state, input) {
  const normalized = {
    grantId: requireString(input?.grantId, "Grant ID", 80),
    secretDigest: requireString(input?.secretDigest, "Secret digest", 100),
    environment: requireString(input?.environment, "Environment", 40),
    target: {
      platform: requireString(input?.target?.platform, "Target platform", 20),
      groupId: requireString(input?.target?.groupId, "Target group", 200)
    }
  };
  const nowMs = safeInteger(input?.nowMs ?? Date.now(), "Current time");
  const row = findGrant(state.storage.sql, normalized.grantId);
  const status = credentialStatus(row, normalized, nowMs);
  return status === "active"
    ? { status, grant: storedGrant(row) }
    : { status };
}

function validateGrantReference(state, input) {
  const normalized = {
    grantId: requireString(input?.grantId, "Grant ID", 80),
    environment: requireString(input?.environment, "Environment", 40),
    target: {
      platform: requireString(input?.target?.platform, "Target platform", 20),
      groupId: requireString(input?.target?.groupId, "Target group", 200)
    }
  };
  const nowMs = safeInteger(input?.nowMs ?? Date.now(), "Current time");
  const row = findGrant(state.storage.sql, normalized.grantId);
  const status = referenceStatus(row, normalized, nowMs);
  return status === "active"
    ? { status, grant: storedGrant(row) }
    : { status };
}

function revokeGrant(state, input) {
  const result = validateGrant(state, input);
  if (result.status !== "active") return result;
  const nowMs = safeInteger(input?.nowMs ?? Date.now(), "Current time");
  const row = findGrant(state.storage.sql, input.grantId);
  state.storage.transactionSync(() => {
    state.storage.sql.exec(
      `UPDATE state_query_read_grants SET revoked_at_ms = ?
       WHERE grant_id = ? AND revoked_at_ms IS NULL`,
      nowMs,
      input.grantId
    );
    state.storage.sql.exec(
      `INSERT INTO state_query_grant_invalidation_outbox
        (grant_id, environment, target_platform, target_group_id,
         invalidated_at_ms, expires_at_ms, attempt_count, next_attempt_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0)
       ON CONFLICT(grant_id) DO UPDATE SET
         invalidated_at_ms = excluded.invalidated_at_ms,
         expires_at_ms = excluded.expires_at_ms,
         attempt_count = 0,
         next_attempt_at_ms = 0`,
      row.grant_id,
      row.environment,
      row.target_platform,
      row.target_group_id,
      nowMs,
      Number(row.expires_at_ms)
    );
  });
  return { status: "revoked" };
}

function tableExists(sql, name) {
  return Boolean(sql.exec(
    `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
    name
  ).toArray()[0]);
}

async function scheduleGrantInvalidationAlarm(
  state,
  { immediate = false, nowMs = Date.now() } = {}
) {
  state.storage.sql.exec(
    "DELETE FROM state_query_grant_invalidation_outbox WHERE expires_at_ms <= ?",
    nowMs
  );
  const candidates = [];
  if (immediate) candidates.push(nowMs);
  const grantDue = state.storage.sql.exec(
    `SELECT MIN(next_attempt_at_ms) AS next_at
     FROM state_query_grant_invalidation_outbox`
  ).toArray()[0]?.next_at;
  if (grantDue !== null && grantDue !== undefined) candidates.push(Number(grantDue));
  if (tableExists(state.storage.sql, "state_query_notification_outbox")) {
    const notificationDue = state.storage.sql.exec(
      `SELECT MIN(next_at) AS next_at FROM (
         SELECT MIN(next_attempt_at_ms) AS next_at
         FROM state_query_notification_outbox
         UNION ALL
         SELECT MIN(lease_expires_at_ms) AS next_at
         FROM state_query_source_watchers
       ) WHERE next_at IS NOT NULL`
    ).toArray()[0]?.next_at;
    if (notificationDue !== null && notificationDue !== undefined) {
      candidates.push(Number(notificationDue));
    }
  }
  const nextAlarm = candidates.length > 0
    ? Math.max(nowMs, Math.min(...candidates))
    : null;
  const current = await state.storage.getAlarm();
  if (nextAlarm === null) {
    if (current !== null) await state.storage.deleteAlarm();
  } else if (current === null || current > nextAlarm) {
    await state.storage.setAlarm(nextAlarm);
  }
}

export async function recoverStateQueryGrantInvalidations(state) {
  await scheduleGrantInvalidationAlarm(state);
}

function claimGrantInvalidations(state, nowMs) {
  return state.storage.transactionSync(() => {
    state.storage.sql.exec(
      "DELETE FROM state_query_grant_invalidation_outbox WHERE expires_at_ms <= ?",
      nowMs
    );
    const rows = state.storage.sql.exec(
      `SELECT grant_id, environment, target_platform, target_group_id,
              invalidated_at_ms, expires_at_ms, attempt_count
       FROM state_query_grant_invalidation_outbox
       WHERE next_attempt_at_ms <= ?
       ORDER BY next_attempt_at_ms, grant_id LIMIT ?`,
      nowMs,
      INVALIDATION_BATCH_SIZE
    ).toArray();
    for (const row of rows) {
      state.storage.sql.exec(
        `UPDATE state_query_grant_invalidation_outbox
         SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?
         WHERE grant_id = ?`,
        nowMs + INVALIDATION_ATTEMPT_LEASE_MS,
        row.grant_id
      );
    }
    return rows;
  });
}

async function deliverGrantInvalidation(state, env, row) {
  let delivered = false;
  try {
    const observerName = stateQueryObserverObjectName(row.environment, {
      platform: row.target_platform,
      groupId: row.target_group_id
    });
    const stub = env.STATE_QUERY_OBSERVER.get(
      env.STATE_QUERY_OBSERVER.idFromName(observerName)
    );
    const response = await stub.fetch(`https://state-query-observer${GRANT_INVALIDATION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        grantId: row.grant_id,
        code: "query_grant_revoked",
        environment: row.environment,
        target: {
          platform: row.target_platform,
          groupId: row.target_group_id
        },
        invalidatedAtMs: Number(row.invalidated_at_ms),
        expiresAtMs: Number(row.expires_at_ms)
      })
    });
    if (!response.ok) {
      await response.text();
      throw new Error(`Observer rejected grant invalidation with status ${response.status}.`);
    }
    await response.text();
    delivered = true;
  } catch (error) {
    logError("state_query.grant_invalidation_failed", {
      platform: "shared",
      correlationId: `state-query-grant:${row.grant_id}`,
      attempt: Number(row.attempt_count) + 1
    }, stateQueryErrorForLog(error));
  }
  state.storage.transactionSync(() => {
    if (delivered) {
      state.storage.sql.exec(
        "DELETE FROM state_query_grant_invalidation_outbox WHERE grant_id = ?",
        row.grant_id
      );
      return;
    }
    const attempt = Number(row.attempt_count) + 1;
    const delay = Math.min(
      INVALIDATION_RETRY_MAX_MS,
      INVALIDATION_RETRY_BASE_MS * (2 ** Math.min(5, attempt - 1))
    );
    state.storage.sql.exec(
      `UPDATE state_query_grant_invalidation_outbox
       SET next_attempt_at_ms = ? WHERE grant_id = ?`,
      Date.now() + delay,
      row.grant_id
    );
  });
}

export async function drainStateQueryGrantInvalidations(state, env) {
  const rows = claimGrantInvalidations(state, Date.now());
  for (const row of rows) await deliverGrantInvalidation(state, env, row);
  await scheduleGrantInvalidationAlarm(state, {
    immediate: rows.length === INVALIDATION_BATCH_SIZE,
    nowMs: Date.now()
  });
  return { attempted: rows.length };
}

export async function handleStateQueryGrantStorageRequest(state, request, pathname) {
  const prefix = "/internal/state-query/grants/";
  if (!pathname.startsWith(prefix)) return null;
  if (request.method !== "POST") {
    return Promise.resolve(new Response("Method Not Allowed", { status: 405 }));
  }
  const input = await request.json();
  const operation = pathname.slice(prefix.length);
  let result;
  if (operation === "issue") result = issueGrant(state, input);
  else if (operation === "validate") result = validateGrant(state, input);
  else if (operation === "revoke") {
    result = revokeGrant(state, input);
    if (result.status === "revoked") {
      await scheduleGrantInvalidationAlarm(state, { immediate: true });
    }
  } else if (operation === "reference") result = validateGrantReference(state, input);
  else return new Response("Not Found", { status: 404 });
  return Response.json(result, {
    headers: { "cache-control": "no-store" }
  });
}
