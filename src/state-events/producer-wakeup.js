import { traceStateEvent, traceStateEventForOwner } from "./diagnostics.js";
import { storageTableExists } from "../storage-alarm.js";
import { canonicalJson, recoveryError } from "./identity.js";
import { boundedStateEventRequest, stateEventRetryDelay } from "./relay-client.js";

const one = (state, sql, ...args) => state.storage.sql.exec(sql, ...args).toArray()[0];
export function producerInterestExists(state) { return storageTableExists(state, "state_event_producer_interest"); }
function initialize(state) {
  state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS state_event_producer_interest (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_json TEXT NOT NULL, route_id TEXT NOT NULL,
    epoch INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0,
    due_ms INTEGER, last_sent_ms INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_until_ms INTEGER);`);
}
export function registerProducerInterest(state, owner, routeId, epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw recoveryError("invalid_request", 422);
  initialize(state);
  const previous = one(state, "SELECT * FROM state_event_producer_interest");
  if (previous && (previous.owner_json !== canonicalJson(owner) || previous.route_id !== routeId)) throw recoveryError("wrong_owner", 409);
  if (!previous) state.storage.sql.exec("INSERT INTO state_event_producer_interest (singleton, owner_json, route_id, epoch) VALUES (1, ?, ?, ?)", canonicalJson(owner), routeId, epoch);
  else if (epoch > previous.epoch || epoch === previous.epoch && previous.active) state.storage.sql.exec("UPDATE state_event_producer_interest SET epoch = ?, active = 1 WHERE singleton = 1", epoch);
  return { registered: true };
}
export function releaseProducerInterest(state, owner, routeId, epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw recoveryError("invalid_request", 422);
  if (!producerInterestExists(state)) return { released: true };
  state.storage.sql.exec(`UPDATE state_event_producer_interest SET active = 0, due_ms = NULL, lease_token = NULL, lease_until_ms = NULL
    WHERE singleton = 1 AND owner_json = ? AND route_id = ? AND epoch = ?`, canonicalJson(owner), routeId, epoch);
  return { released: true };
}
export function nextProducerWakeup(state) {
  return producerInterestExists(state) ? one(state, "SELECT due_ms FROM state_event_producer_interest WHERE active = 1")?.due_ms ?? null : null;
}
export async function queueProducerWakeup(state, schedule, nowMs = Date.now()) {
  if (!producerInterestExists(state)) return;
  return state.storage.transaction(async () => {
    const interest = one(state, "SELECT * FROM state_event_producer_interest");
    if (!interest?.active) {
      traceStateEventForOwner(state, "wake.skipped", { reason: "inactive_interest" });
      return;
    }
    if (!Number.isSafeInteger(interest.version + 1)) throw recoveryError("sequence_exhausted", 409);
    const due = Math.max(nowMs, Number(interest.last_sent_ms) + 1000);
    state.storage.sql.exec(`UPDATE state_event_producer_interest SET version = version + 1, attempts = 0,
      due_ms = CASE WHEN lease_until_ms > ? THEN lease_until_ms ELSE MIN(COALESCE(due_ms, ?), ?) END WHERE singleton = 1`, nowMs, due, due);
    traceStateEventForOwner(state, "wake.queued", { routeId: interest.route_id, version: interest.version + 1,
      nextWakeupAtMs: interest.lease_until_ms > nowMs ? interest.lease_until_ms : Math.min(interest.due_ms ?? due, due),
      leaseUntilMs: interest.lease_until_ms });
    await schedule();
    return due <= nowMs && !(interest.lease_until_ms > nowMs);
  });
}
export async function drainProducerWakeup(state, env, schedule, nowMs = Date.now()) {
  if (!producerInterestExists(state)) return { attempted: 0 };
  const claimed = await state.storage.transaction(async () => {
    const row = one(state, "SELECT * FROM state_event_producer_interest WHERE active = 1 AND due_ms <= ?", nowMs);
    if (!row) return null;
    if (row.lease_until_ms > nowMs) {
      traceStateEvent(env, "wake.blocked", { routeId: row.route_id, version: row.version, leaseUntilMs: row.lease_until_ms });
      return null;
    }
    const token = crypto.randomUUID();
    state.storage.sql.exec(`UPDATE state_event_producer_interest SET lease_token = ?, lease_until_ms = ?, due_ms = ?,
      last_sent_ms = ?, attempts = attempts + 1 WHERE singleton = 1`, token, nowMs + 30_000, nowMs + 30_000, nowMs);
    await schedule();
    return { ...row, lease_token: token, attempts: row.attempts + 1 };
  });
  if (!claimed) return { attempted: 0 };
  traceStateEvent(env, "wake.claim", { ownerId: state.id.toString(), routeId: claimed.route_id,
    version: claimed.version, dueAtMs: claimed.due_ms, leaseUntilMs: nowMs + 30_000, attempts: claimed.attempts });
  let result, error;
  try {
    const owner = JSON.parse(claimed.owner_json), binding = owner.kind === "group_local" ? env.CONFIG : env.SHAREABLE_STATE_REALM;
    result = await boundedStateEventRequest(() => binding.get(binding.idFromName(owner.key)).fetch("https://owner/internal/state-events/delivery/wake", {
      method: "POST", headers: { "x-elmybot-state-event-delivery": "v1" }, body: JSON.stringify({ owner, routeId: claimed.route_id, version: claimed.version })
    }), undefined, { env, routeId: claimed.route_id, rpc: "producer.wake" });
    if (result.accepted !== true) throw recoveryError("outcome_unknown", 503);
  } catch (cause) { error = cause; }
  await state.storage.transaction(async () => {
    const current = one(state, "SELECT * FROM state_event_producer_interest");
    if (current?.lease_token !== claimed.lease_token) return;
    const changed = current.version !== claimed.version || current.epoch !== claimed.epoch;
    let due = changed ? Math.max(Date.now(), Number(current.last_sent_ms) + 1000) : null;
    if (error && !changed && claimed.attempts < 12) due = Date.now() + stateEventRetryDelay(claimed.attempts);
    state.storage.sql.exec(`UPDATE state_event_producer_interest SET due_ms = ?, active = ?, lease_token = NULL, lease_until_ms = NULL WHERE singleton = 1`,
      due, !changed && result?.pending === false ? 0 : current.active);
    traceStateEvent(env, "wake.finish", { ownerId: state.id.toString(), routeId: claimed.route_id,
      version: claimed.version, nextWakeupAtMs: due, code: error?.code ?? (error ? "state_event_outcome_unknown" : "ok") });
    await schedule();
  });
  return { attempted: 1 };
}
