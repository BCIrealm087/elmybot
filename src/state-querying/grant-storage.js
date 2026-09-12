import { canonicalStateQueryJson } from "./query.js";

const MAX_ACTIVE_GRANTS = 100;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  `);
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

function revokeGrant(state, input) {
  const result = validateGrant(state, input);
  if (result.status !== "active") return result;
  const nowMs = safeInteger(input?.nowMs ?? Date.now(), "Current time");
  state.storage.sql.exec(
    `UPDATE state_query_read_grants SET revoked_at_ms = ?
     WHERE grant_id = ? AND revoked_at_ms IS NULL`,
    nowMs,
    input.grantId
  );
  return { status: "revoked" };
}

export function handleStateQueryGrantStorageRequest(state, request, pathname) {
  const prefix = "/internal/state-query/grants/";
  if (!pathname.startsWith(prefix)) return null;
  if (request.method !== "POST") {
    return Promise.resolve(new Response("Method Not Allowed", { status: 405 }));
  }
  return request.json().then((input) => {
    const operation = pathname.slice(prefix.length);
    let result;
    if (operation === "issue") result = issueGrant(state, input);
    else if (operation === "validate") result = validateGrant(state, input);
    else if (operation === "revoke") result = revokeGrant(state, input);
    else return new Response("Not Found", { status: 404 });
    return Response.json(result, {
      headers: { "cache-control": "no-store" }
    });
  });
}
