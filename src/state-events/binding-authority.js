import { resolveCombinedAppendBarrier } from "./delivery-authority.js";
import { createPlatformGroupRef } from "../integrations/contracts.js";
import { shareableStateRealmObjectName } from "../shareable-state/realm-client.js";
import { storageTableExists } from "../storage-alarm.js";
import { canonicalJson, fingerprint, jsonBytes, recoveryError, sameIdentity, StateEventRecoveryError, validateAttempt } from "./identity.js";
import { createStateEventOwnerClient } from "./owner-client.js";
import { STATE_EVENT_AUTHORITY_HEADER, STATE_EVENT_AUTHORITY_VALUE } from "./shareable-commit.js";

export const STATE_EVENT_BARRIER_LIMITS = Object.freeze({ rows: 100, bytes: 512 * 1024, batch: 20, timeoutMs: 5000 });
export function sourceGroupForAttempt(attempt) {
  const [platform, kind, id] = attempt.identity.originGroupKey.split(":");
  return createPlatformGroupRef({ platform, kind, id });
}
export async function boundedStateEventCall(call, deadline = Date.now() + STATE_EVENT_BARRIER_LIMITS.timeoutMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw recoveryError("recovery_pending", 503);
  let timer;
  try { return await Promise.race([call(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(recoveryError("outcome_unknown", 503)), remaining);
  })]); } finally { clearTimeout(timer); }
}
export function initializeStateEventBarriers(state) {
  state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS state_event_commit_barriers (
    operation_id TEXT PRIMARY KEY, source_group_key TEXT NOT NULL, owner_key TEXT NOT NULL,
    attempt_json TEXT NOT NULL, bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS state_event_barriers_source ON state_event_commit_barriers(source_group_key);
    CREATE TABLE IF NOT EXISTS state_event_barrier_budget (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
    INSERT OR IGNORE INTO state_event_barrier_budget VALUES (1, 0, 0);`);
}
export function removeStateEventBarrier(state, row) {
  state.storage.transactionSync(() => {
    const deleted = state.storage.sql.exec("DELETE FROM state_event_commit_barriers WHERE operation_id = ? RETURNING bytes", row.operation_id).toArray()[0];
    if (deleted) state.storage.sql.exec("UPDATE state_event_barrier_budget SET rows = rows - 1, bytes = bytes - ?", deleted.bytes);
  });
}
export async function resolveStateEventBarrier(registry, row, deadline = Date.now() + STATE_EVENT_BARRIER_LIMITS.timeoutMs) {
  const attempt = JSON.parse(row.attempt_json);
  if (attempt.kind === "append") {
    const outcome = await resolveCombinedAppendBarrier(registry, attempt, deadline);
    removeStateEventBarrier(registry.state, row);
    return outcome;
  }
  const owner = createStateEventOwnerClient(registry.env);
  let outcome;
  try {
    outcome = await boundedStateEventCall(() => owner.lookup(attempt), deadline);
    if (outcome.state !== "committed") outcome = await boundedStateEventCall(() => owner.fence(attempt), deadline);
    if (outcome?.state === "committed" && outcome.receipt?.operationId !== attempt.identity.operationId) throw recoveryError("outcome_unknown", 503);
    if (!["committed", "fenced"].includes(outcome?.state)) throw recoveryError("outcome_unknown", 503);
  } catch { throw recoveryError("outcome_unknown", 503); }
  removeStateEventBarrier(registry.state, row);
  return outcome;
}
export async function recoverStateEventBarriers(registry, groupKeys = null) {
  if (!storageTableExists(registry.state, "state_event_commit_barriers")) return;
  const params = groupKeys === null ? [] : groupKeys;
  if (groupKeys !== null && !groupKeys.length) return;
  const clause = groupKeys === null ? "" : `WHERE source_group_key IN (${params.map(() => "?").join(",")})`;
  const rows = registry.state.storage.sql.exec(`SELECT * FROM state_event_commit_barriers ${clause} ORDER BY operation_id LIMIT ?`,
    ...params, STATE_EVENT_BARRIER_LIMITS.batch + 1).toArray();
  const started = Date.now();
  for (const [index, row] of rows.slice(0, STATE_EVENT_BARRIER_LIMITS.batch).entries()) {
    if (index && Date.now() - started >= STATE_EVENT_BARRIER_LIMITS.timeoutMs) throw recoveryError("recovery_pending", 503);
    await resolveStateEventBarrier(registry, row, started + STATE_EVENT_BARRIER_LIMITS.timeoutMs);
  }
  if (rows.length > STATE_EVENT_BARRIER_LIMITS.batch) throw recoveryError("recovery_pending", 503);
}
export async function commitWithStateEventBindingAuthority(registry, raw) {
  const input = JSON.parse(canonicalJson(raw, 24 * 1024));
  if (!input?.request) throw recoveryError("invalid_request", 422);
  const { attempt, request } = input;
  validateAttempt(attempt);
  const { route, identity } = attempt;
  if (route.kind !== "effective_shareable" || shareableStateRealmObjectName(route.realm) !== route.key ||
      identity.environment !== registry.env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT ||
      !["discord", "twitch"].includes(route.targetPlatform)) throw recoveryError("invalid_route", 422);
  if (await fingerprint(request) !== attempt.preparedFingerprint) throw recoveryError("source_conflict");
  initializeStateEventBarriers(registry.state);
  const existing = registry.state.storage.sql.exec("SELECT * FROM state_event_commit_barriers WHERE operation_id = ?", identity.operationId).toArray()[0];
  if (existing && JSON.parse(existing.attempt_json).kind === "append") {
    const owner = createStateEventOwnerClient(registry.env);
    const committed = await boundedStateEventCall(() => owner.lookup(attempt));
    if (committed.state === "committed") return committed;
    throw recoveryError("outcome_unknown", 503);
  }
  if (existing) {
    const old = JSON.parse(existing.attempt_json);
    if (!sameIdentity(old.identity, identity) || old.preparedFingerprint !== attempt.preparedFingerprint || old.epoch > attempt.epoch) throw recoveryError("source_conflict");
    const prior = await resolveStateEventBarrier(registry, existing);
    if (prior.state === "committed") return prior;
    if (old.epoch === attempt.epoch) throw recoveryError("attempt_fenced");
  }
  const binding = registry.stateQueryBinding(sourceGroupForAttempt(attempt), route.targetPlatform);
  if (binding.status !== "ready" || binding.revision !== route.bindingRevision || binding.sourceKey !== route.key) {
    const owner = createStateEventOwnerClient(registry.env);
    let prior;
    try { prior = await boundedStateEventCall(() => owner.fence(attempt)); } catch { throw recoveryError("outcome_unknown", 503); }
    if (prior.state === "committed" && prior.receipt?.operationId === identity.operationId) return prior;
    if (prior.state !== "fenced") throw recoveryError("outcome_unknown", 503);
    throw recoveryError("binding_changed", 409);
  }
  const json = canonicalJson(attempt, 8192), bytes = jsonBytes(json);
  registry.state.storage.transactionSync(() => {
    const budget = registry.state.storage.sql.exec("SELECT * FROM state_event_barrier_budget").one();
    if (budget.rows >= STATE_EVENT_BARRIER_LIMITS.rows || budget.bytes + bytes > STATE_EVENT_BARRIER_LIMITS.bytes) throw recoveryError("authority_capacity", 503);
    registry.state.storage.sql.exec("INSERT INTO state_event_commit_barriers VALUES (?, ?, ?, ?, ?)", identity.operationId, identity.originGroupKey, route.key, json, bytes);
    registry.state.storage.sql.exec("UPDATE state_event_barrier_budget SET rows = rows + 1, bytes = bytes + ?", bytes);
  });
  // Once this record is durable, a timeout/restart must retain it. Lifecycle
  // requests cannot pass its affected source until owner lookup/fencing resolves it.
  await registry.state.storage.sync();
  const ns = registry.env.SHAREABLE_STATE_REALM;
  let response;
  try { response = await boundedStateEventCall(() => ns.get(ns.idFromName(route.key)).fetch("https://realm/internal/shareable-state/realm/state-event-commit", {
    method: "POST", headers: { "content-type": "application/json", [STATE_EVENT_AUTHORITY_HEADER]: STATE_EVENT_AUTHORITY_VALUE },
    body: JSON.stringify({ realm: route.realm, namespace: route.namespace, storage: input })
  })); } catch { throw recoveryError("outcome_unknown", 503); }
  const outcome = await response.json();
  if (!response.ok) {
    // A definite validation/admission rejection should not consume the global
    // uncertainty budget. Fence it before clearing the locator so a delayed
    // duplicate of the rejected attempt cannot later become admissible.
    if (response.status >= 400 && response.status < 500) {
      const prior = await resolveStateEventBarrier(registry, { operation_id: identity.operationId, attempt_json: json });
      if (prior.state === "committed") return prior;
    }
    throw new StateEventRecoveryError(outcome?.code ?? "state_event_outcome_unknown", response.status);
  }
  if (outcome?.state !== "committed" || outcome.receipt?.operationId !== identity.operationId) throw recoveryError("outcome_unknown", 503);
  removeStateEventBarrier(registry.state, { operation_id: identity.operationId });
  return outcome;
}

// Recover only sources whose authority can change in this lifecycle operation.
// Matching through the bounded barrier table avoids scanning registry history.
export async function recoverLifecycleStateEvents(registry, path, input) {
  if (!storageTableExists(registry.state, "state_event_commit_barriers")) return;
  const keys = new Set();
  const sql = registry.state.storage.sql;
  const addGroup = (value) => { if (value) keys.add(createPlatformGroupRef(value).key); };
  addGroup(input?.sourceGroup); addGroup(input?.group);
  if (input?.integrationId) {
    for (const row of sql.exec(`SELECT DISTINCT barrier.source_group_key FROM state_event_commit_barriers barrier
      JOIN integration_members member ON member.group_key = barrier.source_group_key WHERE member.integration_id = ?`, input.integrationId).toArray()) keys.add(row.source_group_key);
  }
  if (path === "/groups/revoke" && input?.group) {
    const key = createPlatformGroupRef(input.group).key;
    for (const row of sql.exec(`SELECT DISTINCT barrier.source_group_key FROM state_event_commit_barriers barrier
      JOIN integration_members peer ON peer.group_key = barrier.source_group_key
      JOIN integration_members member ON member.integration_id = peer.integration_id WHERE member.group_key = ?`, key).toArray()) keys.add(row.source_group_key);
  }
  if (input?.invitationId) {
    const row = sql.exec(`SELECT invitation.discord_group_key, pending.twitch_group_key FROM integration_invitations invitation
      LEFT JOIN integration_pending_links pending ON pending.invitation_id = invitation.invitation_id WHERE invitation.invitation_id = ?`, input.invitationId).toArray()[0];
    if (row?.discord_group_key) keys.add(row.discord_group_key);
    if (row?.twitch_group_key) keys.add(row.twitch_group_key);
  }
  await recoverStateEventBarriers(registry, [...keys]);
}
