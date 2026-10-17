import { claimFeatureCooldownInTransaction } from "../framework/feature-storage.js";
import {
  STATE_EVENT_LIMITS as LIMITS, assertFresh, canonicalJson, fingerprint, jsonBytes,
  newAttempt, recoveryError, sameAttempt, sameIdentity, validateAttempt, validateIdentity
} from "./identity.js";

function one(state, query, ...args) {
  return state.storage.sql.exec(query, ...args).toArray()[0] ?? null;
}
function exists(state) {
  return Boolean(one(state, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_event_records'"));
}
function initialize(state) {
  state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS state_event_records (
    record_key TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, metadata_bytes INTEGER NOT NULL,
    request_json TEXT, request_bytes INTEGER NOT NULL, pending INTEGER NOT NULL,
    prune_at_ms INTEGER)`);
  state.storage.sql.exec("CREATE INDEX IF NOT EXISTS state_event_prune ON state_event_records(prune_at_ms)");
  state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS state_event_budget (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL,
    metadata_bytes INTEGER NOT NULL, pending_rows INTEGER NOT NULL, pending_bytes INTEGER NOT NULL)`);
  state.storage.sql.exec("INSERT OR IGNORE INTO state_event_budget VALUES (1, 0, 0, 0, 0)");
}
function read(state, key) {
  const row = one(state, "SELECT * FROM state_event_records WHERE record_key = ?", key);
  return row ? { ...row, metadata: JSON.parse(row.metadata_json), request: row.request_json === null ? null : JSON.parse(row.request_json) } : null;
}
function remove(state, row) {
  state.storage.sql.exec(`UPDATE state_event_budget SET rows = rows - 1,
    metadata_bytes = metadata_bytes - ?, pending_rows = pending_rows - ?, pending_bytes = pending_bytes - ? WHERE singleton = 1`,
  row.metadata_bytes, row.pending, row.request_bytes);
  state.storage.sql.exec("DELETE FROM state_event_records WHERE record_key = ?", row.record_key);
}
function prune(state, nowMs) {
  // Only explicitly terminal records have a deadline. Never expire an unknown
  // origin outcome or an owner receipt whose event is still pending/leased.
  const rows = state.storage.sql.exec(`SELECT * FROM state_event_records
    WHERE prune_at_ms <= ? ORDER BY prune_at_ms LIMIT ?`, nowMs, LIMITS.pruneBatch).toArray();
  for (const row of rows) remove(state, row);
}
function write(state, key, metadata, request, pruneAtMs = null) {
  const json = canonicalJson(metadata, LIMITS.maxRecordBytes);
  const requestJson = request === null ? null : canonicalJson(request);
  const bytes = jsonBytes(json), requestBytes = requestJson === null ? 0 : jsonBytes(requestJson);
  const pending = requestJson === null ? 0 : 1;
  const old = read(state, key);
  const budget = one(state, "SELECT * FROM state_event_budget WHERE singleton = 1");
  const next = { rows: budget.rows + (old ? 0 : 1),
    bytes: budget.metadata_bytes + bytes - (old?.metadata_bytes ?? 0),
    pending: budget.pending_rows + pending - (old?.pending ?? 0),
    requestBytes: budget.pending_bytes + requestBytes - (old?.request_bytes ?? 0) };
  if (next.rows > LIMITS.maxRows || next.bytes > LIMITS.maxMetadataBytes ||
      next.pending > LIMITS.maxPendingRows || next.requestBytes > LIMITS.maxPendingBytes) {
    throw recoveryError("capacity", 503);
  }
  state.storage.sql.exec(`INSERT INTO state_event_records VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_key) DO UPDATE SET metadata_json = excluded.metadata_json,
    metadata_bytes = excluded.metadata_bytes, request_json = excluded.request_json,
    request_bytes = excluded.request_bytes, pending = excluded.pending, prune_at_ms = excluded.prune_at_ms`,
  key, json, bytes, requestJson, requestBytes, pending, pruneAtMs);
  state.storage.sql.exec(`UPDATE state_event_budget SET rows = ?, metadata_bytes = ?, pending_rows = ?, pending_bytes = ? WHERE singleton = 1`,
    next.rows, next.bytes, next.pending, next.requestBytes);
}
function conflictUnless(condition) {
  if (!condition) throw recoveryError("source_conflict");
}
function originKey(identity) { return `origin:${identity.sourceKey}`; }
function ownerKey(attempt) { return `owner:${attempt.identity.operationId}`; }
function originValue(row) {
  return row ? { ...row.metadata, request: row.request } : null;
}

export function lookupStateEventOrigin(state, identity) {
  validateIdentity(identity);
  if (!exists(state)) return null;
  const row = read(state, originKey(identity));
  if (row) conflictUnless(sameIdentity(row.metadata.attempt.identity, identity));
  return originValue(row);
}

export async function prepareStateEventOrigin(state, { identity, request, route, cooldownSeconds }, nowMs) {
  validateIdentity(identity);
  identity = JSON.parse(canonicalJson(identity, 2048));
  request = JSON.parse(canonicalJson(request));
  route = JSON.parse(canonicalJson(route, 2048));
  // Retry lookup precedes config preparation in the coordinator, and is checked
  // again here after hashing because another request may win during that await.
  const preparedFingerprint = await fingerprint(request);
  return state.storage.transactionSync(() => {
    nowMs ??= Date.now();
    initialize(state);
    const existing = lookupStateEventOrigin(state, identity);
    if (existing) return existing; // First prepared configuration wins.
    assertFresh(identity, nowMs);
    prune(state, nowMs);
    const cooldown = claimFeatureCooldownInTransaction(state, { featureId: identity.featureId,
      actionKind: identity.actionKind, scopeKey: identity.originGroupKey, seconds: cooldownSeconds }, nowMs);
    if (!cooldown.allowed) {
      const error = recoveryError("cooldown", 429);
      error.retryAfterSeconds = cooldown.retryAfterSeconds;
      throw error;
    }
    const metadata = { state: "prepared", attempt: newAttempt(identity, preparedFingerprint, route), preparedAtMs: nowMs };
    write(state, originKey(identity), metadata, request);
    return originValue(read(state, originKey(identity)));
  });
}
function validateOwner(attempt, physicalOwnerKey) {
  validateAttempt(attempt);
  if (attempt.route.key !== physicalOwnerKey) throw recoveryError("wrong_owner", 422);
}
function ownerRow(state, attempt) {
  if (!exists(state)) return null;
  const row = read(state, ownerKey(attempt));
  if (row) conflictUnless(sameIdentity(row.metadata.identity, attempt.identity) &&
    row.metadata.preparedFingerprint === attempt.preparedFingerprint);
  return row;
}
function ownerValue(row, attempt) {
  if (row?.metadata.receipt) return { state: "committed", receipt: row.metadata.receipt,
    ...(row.metadata.pendingDelivery === false ? { terminal: true } : {}) };
  if ((row?.metadata.fencedThrough ?? 0) >= attempt.epoch) return { state: "fenced" };
  return { state: "absent" };
}
export function lookupStateEventOwner(state, attempt, physicalOwnerKey) {
  validateOwner(attempt, physicalOwnerKey);
  return ownerValue(ownerRow(state, attempt), attempt);
}
export function fenceStateEventOwner(state, attempt, physicalOwnerKey, nowMs = Date.now()) {
  validateOwner(attempt, physicalOwnerKey);
  return state.storage.transactionSync(() => {
    initialize(state);
    const row = ownerRow(state, attempt);
    if (row?.metadata.receipt) return ownerValue(row, attempt);
    prune(state, nowMs);
    const metadata = { identity: attempt.identity, preparedFingerprint: attempt.preparedFingerprint,
      fencedThrough: Math.max(row?.metadata.fencedThrough ?? 0, attempt.epoch) };
    write(state, ownerKey(attempt), metadata, null,
      Math.max(nowMs + LIMITS.receiptRetentionMs, attempt.identity.sourceCreatedAtMs + LIMITS.sourceLifetimeMs));
    return { state: "fenced" };
  });
}

// Framework-only transaction primitive, not a feature callback API or an HTTP
// mutation endpoint. Steps 4/5 supply the real state + revision + outbox adapter.
// All of that adapter's writes MUST use this same synchronous transaction.
export async function commitStateEventAtOwner(state, { attempt, request, physicalOwnerKey }, apply, nowMs) {
  validateOwner(attempt, physicalOwnerKey);
  attempt = JSON.parse(canonicalJson(attempt));
  request = JSON.parse(canonicalJson(request));
  conflictUnless(await fingerprint(request) === attempt.preparedFingerprint);
  return state.storage.transactionSync(() => {
    nowMs ??= Date.now();
    initialize(state);
    const prior = ownerValue(ownerRow(state, attempt), attempt);
    if (prior.state === "committed") return prior;
    if (prior.state === "fenced") throw recoveryError("attempt_fenced");
    assertFresh(attempt.identity, nowMs);
    prune(state, nowMs);
    if (typeof apply !== "function" || Object.prototype.toString.call(apply) === "[object AsyncFunction]") {
      throw recoveryError("async_mutation", 422);
    }
    const applied = apply();
    // Any asynchronous callback, invalid result or capacity failure rolls back
    // its SQL writes. There is deliberately no receipt-only acceptance endpoint.
    if (applied && typeof applied.then === "function") throw recoveryError("async_mutation", 422);
    if (!/^dev1\.[\w-]{43}$/.test(applied?.eventId ?? "")) throw recoveryError("invalid_result", 422);
    canonicalJson(applied.result, LIMITS.maxResultBytes);
    const receipt = { operationId: attempt.identity.operationId, eventId: applied.eventId,
      committedAtMs: nowMs, result: applied.result };
    write(state, ownerKey(attempt), { identity: attempt.identity, preparedFingerprint: attempt.preparedFingerprint,
      fencedThrough: 0, receipt, pendingDelivery: true, originConfirmed: false }, null);
    return { state: "committed", receipt };
  });
}

export function finalizeStateEventOrigin(state, attempt, receipt, nowMs = Date.now(), terminal = false) {
  // Called only after an authoritative owner response by recovery.js.
  return state.storage.transactionSync(() => {
    const current = lookupStateEventOrigin(state, attempt.identity);
    if (!current || !sameAttempt(current.attempt, attempt)) return current;
    if (current.state === "committed" && !terminal) return current;
    const metadata = { ...current };
    delete metadata.request;
    write(state, originKey(attempt.identity), { ...metadata, state: "committed", receipt, confirmedAtMs: nowMs }, null,
      terminal ? Math.max(current.preparedAtMs, receipt.committedAtMs) + LIMITS.receiptRetentionMs : null);
    return lookupStateEventOrigin(state, attempt.identity);
  });
}
export function repinStateEventOrigin(state, attempt, route, nowMs = Date.now()) {
  // Private CAS used only AFTER the coordinator has obtained a durable fence.
  return state.storage.transactionSync(() => {
    const current = lookupStateEventOrigin(state, attempt.identity);
    if (!current || current.state === "committed" || !sameAttempt(current.attempt, attempt)) return current;
    assertFresh(attempt.identity, nowMs);
    if (attempt.epoch >= LIMITS.maxAttempts) throw recoveryError("attempt_limit", 503);
    const { request, ...metadata } = current;
    write(state, originKey(attempt.identity), { ...metadata,
      attempt: newAttempt(attempt.identity, attempt.preparedFingerprint, route, attempt.epoch + 1) }, request);
    return lookupStateEventOrigin(state, attempt.identity);
  });
}

// Delivery will call these only once work is terminal (never pending/leased).
export function retireStateEventOwner(state, attempt, physicalOwnerKey, nowMs = Date.now()) {
  validateOwner(attempt, physicalOwnerKey);
  return state.storage.transactionSync(() => {
    const row = ownerRow(state, attempt);
    if (!row?.metadata.receipt) throw recoveryError("missing_receipt", 503);
    write(state, ownerKey(attempt), { ...row.metadata, pendingDelivery: false }, null,
      row.metadata.originConfirmed ? Math.max(row.metadata.receipt.committedAtMs + LIMITS.receiptRetentionMs, nowMs) : null);
  });
}

export function expireStateEventOrigin(state, attempt, nowMs = Date.now()) {
  // Only called after recovery has durably fenced the original owner.
  return state.storage.transactionSync(() => {
    const current = lookupStateEventOrigin(state, attempt.identity);
    if (!current || current.state !== "prepared" || !sameAttempt(current.attempt, attempt)) return current;
    if (nowMs < attempt.identity.sourceCreatedAtMs + LIMITS.sourceLifetimeMs) throw recoveryError("still_pending", 409);
    const metadata = { ...current, state: "expired" };
    delete metadata.request;
    write(state, originKey(attempt.identity), metadata, null, current.preparedAtMs + LIMITS.receiptRetentionMs);
    return lookupStateEventOrigin(state, attempt.identity);
  });
}

export function confirmStateEventOwner(state, attempt, physicalOwnerKey, nowMs = Date.now()) {
  // Private origin acknowledgement, sent only AFTER its receipt cache is durable.
  // Delivery may finish first; neither side alone permits owner receipt pruning.
  validateOwner(attempt, physicalOwnerKey);
  return state.storage.transactionSync(() => {
    const row = ownerRow(state, attempt);
    if (!row?.metadata.receipt) throw recoveryError("missing_receipt", 503);
    write(state, ownerKey(attempt), { ...row.metadata, originConfirmed: true }, null,
      row.metadata.pendingDelivery === false
        ? Math.max(row.metadata.receipt.committedAtMs + LIMITS.receiptRetentionMs, nowMs) : null);
    return ownerValue(read(state, ownerKey(attempt)), attempt);
  });
}

export function markStateEventOriginConfirmed(state, attempt) {
  return state.storage.transactionSync(() => {
    const current = lookupStateEventOrigin(state, attempt.identity);
    if (!current || current.state !== "committed" || !sameAttempt(current.attempt, attempt)) return;
    const metadata = { ...current, ownerConfirmed: true };
    delete metadata.request;
    const row = read(state, originKey(attempt.identity));
    write(state, originKey(attempt.identity), metadata, null, row.prune_at_ms);
  });
}
