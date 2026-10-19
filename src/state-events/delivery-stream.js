import { registerProducerInterest, releaseProducerInterest } from "./producer-wakeup.js";
import { durableEventId, durableEventRouteId, serializeDurableEventPayload, sha256Hex, DURABLE_EVENT_CODES, durableEventError, DURABLE_EVENT_LIMITS } from "../durable-events/contract.js";
import { canonicalJson, recoveryError } from "./identity.js";
import { deliverySourceRequest } from "./delivery-source.js";
import { storageTableExists } from "../storage-alarm.js";
import { readSourceSnapshot, STATE_EVENT_DELIVERY_REQUEST_BYTES } from "./delivery-snapshot.js";

export const COMBINED_STREAM_PATH = "/internal/events/combined/";
const one = (state, sql, ...args) => state.storage.sql.exec(sql, ...args).toArray()[0];
function initialize(state) {
  state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS state_event_destination (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_json TEXT NOT NULL,
    gap_first INTEGER, gap_last INTEGER, gap_reasons INTEGER NOT NULL DEFAULT 0,
    reset_id TEXT, reset_checkpoint INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS state_event_destination_records (
      operation_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      outcome_json TEXT NOT NULL, fenced_json TEXT NOT NULL, expires_at_ms INTEGER, metadata_bytes INTEGER NOT NULL, operation_sequence INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS state_event_destination_expiry ON state_event_destination_records(expires_at_ms);
    CREATE TABLE IF NOT EXISTS state_event_destination_resets (reset_id TEXT PRIMARY KEY, operation_checkpoint INTEGER NOT NULL,
      actor_json TEXT NOT NULL, reset_at_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state_event_destination_budget (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL);`);
  if (!one(state, "SELECT * FROM state_event_destination_budget")) {
    const existing = one(state, "SELECT COUNT(*) AS rows, COALESCE(SUM(metadata_bytes), 0) AS bytes FROM durable_event_stream_receipts");
    state.storage.sql.exec("INSERT INTO state_event_destination_budget VALUES (1, ?, ?)", existing.rows, existing.bytes);
  }
  state.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS state_event_receipt_insert AFTER INSERT ON durable_event_stream_receipts BEGIN
    UPDATE state_event_destination_budget SET rows = rows + 1, bytes = bytes + NEW.metadata_bytes; END;
    CREATE TRIGGER IF NOT EXISTS state_event_receipt_delete AFTER DELETE ON durable_event_stream_receipts BEGIN
    UPDATE state_event_destination_budget SET rows = rows - 1, bytes = bytes - OLD.metadata_bytes; END;`);
}
export function combinedGap(state) {
  return storageTableExists(state, "state_event_destination") && one(state, "SELECT gap_first FROM state_event_destination")?.gap_first != null;
}
export function combinedOwner(descriptor) {
  return { kind: descriptor.scopeKind, key: descriptor.realmIdentity };
}
export async function combinedSourceStatus(state, env, descriptor, routeId) {
  if (!descriptor) throw recoveryError("invalid_route", 422);
  return deliverySourceRequest(env, combinedOwner(descriptor), "status", { routeId });
}
function save(state, input, fingerprint, outcome, fences = []) {
  const old = one(state, "SELECT * FROM state_event_destination_records WHERE operation_id = ?", input.operationId);
  fences = [...new Set([...(old ? JSON.parse(old.fenced_json) : []), ...fences])];
  if (fences.length > 20) throw recoveryError("attempt_limit", 503);
  const json = canonicalJson(outcome), fenced = JSON.stringify(fences);
  const size = new TextEncoder().encode(json + fenced + input.operationId + input.eventId + fingerprint).byteLength;
  const budget = one(state, "SELECT * FROM state_event_destination_budget");
  if (budget.rows + (old ? 0 : 1) > DURABLE_EVENT_LIMITS.maxReceiptRows ||
      budget.bytes + size - (old?.metadata_bytes ?? 0) > DURABLE_EVENT_LIMITS.maxReceiptMetadataBytes) throw durableEventError(DURABLE_EVENT_CODES.streamFull, { status: 429 });
  state.storage.sql.exec(`INSERT INTO state_event_destination_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(operation_id) DO UPDATE SET outcome_json = excluded.outcome_json, fenced_json = excluded.fenced_json,
      metadata_bytes = excluded.metadata_bytes, expires_at_ms = excluded.expires_at_ms`, input.operationId, input.eventId, fingerprint, json, fenced,
  ["appended", "gap"].includes(outcome.state) ? null : input.committedAtMs + DURABLE_EVENT_LIMITS.receiptRetentionMs, size, input.stateEvent.operationSequence);
  state.storage.sql.exec("UPDATE state_event_destination_budget SET rows = rows + ?, bytes = bytes + ?", old ? 0 : 1, size - (old?.metadata_bytes ?? 0));
}
export function recordExpiredCombinedEvents(state, nowMs) {
  if (!storageTableExists(state, "state_event_destination")) return;
  const rows = state.storage.sql.exec("SELECT state_event_json FROM durable_event_stream_events WHERE expires_at_ms <= ? AND state_event_json IS NOT NULL", nowMs).toArray();
  if (!rows.length) return;
  const sequences = rows.map((row) => JSON.parse(row.state_event_json).operationSequence);
  const first = Math.min(...sequences), last = Math.max(...sequences);
  state.storage.sql.exec(`UPDATE state_event_destination SET gap_first = MIN(COALESCE(gap_first, ?), ?),
    gap_last = MAX(COALESCE(gap_last, 0), ?), gap_reasons = gap_reasons | 1 WHERE singleton = 1`, first, first, last);
}
export function pruneCombinedRecords(state, nowMs) {
  if (!storageTableExists(state, "state_event_destination_records")) return false;
  state.storage.transactionSync(() => {
    const rows = state.storage.sql.exec(`DELETE FROM state_event_destination_records WHERE operation_id IN (
      SELECT operation_id FROM state_event_destination_records WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT 20) RETURNING metadata_bytes`, nowMs).toArray();
    if (rows.length) state.storage.sql.exec("UPDATE state_event_destination_budget SET rows = rows - ?, bytes = bytes - ?", rows.length, rows.reduce((sum, row) => sum + row.metadata_bytes, 0));
  });
  return true;
}
export async function combinedAppend(state, env, registry, raw, operation, append, { trustedSnapshot = false } = {}) {
  const input = JSON.parse(canonicalJson(raw, STATE_EVENT_DELIVERY_REQUEST_BYTES));
  if ((operation !== "interest-release" && !/^seo1\.[\w-]{43}$/.test(input.operationId ?? "")) || !/^des1\.[\w-]{43}$/.test(input.routeId ?? "") ||
      env.DURABLE_EVENT_STREAM.idFromName(input.routeId).toString() !== state.id.toString() ||
      !["group_local", "effective_shareable"].includes(input.owner?.kind)) throw recoveryError("invalid_route", 422);
  const forwarded = readSourceSnapshot(input, trustedSnapshot);
  initialize(state);
  if (operation === "interest-release") return releaseProducerInterest(state, input.owner, input.routeId, input.epoch);
  const stored = one(state, "SELECT * FROM state_event_destination_records WHERE operation_id = ?", input.operationId);
  // A receipt read/fence needs no producer round trip once the outcome is known.
  const producer = one(state, "SELECT owner_json FROM state_event_destination");
  if (producer && producer.owner_json !== canonicalJson(input.owner)) throw recoveryError("wrong_owner", 422);
  if (stored && operation !== "confirm") {
    const outcome = JSON.parse(stored.outcome_json);
    if (["appended", "gap"].includes(outcome.state) && operation !== "interest") return operation === "outcome"
      ? terminalDestinationOutcome(state, outcome, stored.operation_sequence) : outcome;
  }
  const proof = forwarded ?? await deliverySourceRequest(env, input.owner, "proof", { operationId: input.operationId, routeId: input.routeId });
  const intent = proof.intent;
  const descriptor = { deploymentEnvironment: intent.environment, scopeKind: intent.route.kind,
    realmIdentity: input.owner.key, featureId: intent.featureId, streamId: intent.stream.id, version: intent.stream.version };
  const definition = registry?.eventStreams?.[`${intent.featureId}:${intent.stream.id}:v${intent.stream.version}`]?.definition;
  if (intent.operationId !== input.operationId || intent.route.streamRouteId !== input.routeId ||
      intent.route.key !== input.owner.key || intent.route.kind !== input.owner.kind ||
      intent.environment !== env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT ||
      await durableEventRouteId(descriptor) !== input.routeId || !definition?.publication ||
      definition.scope.kind !== input.owner.kind || definition.publication.source.namespace !== intent.namespaceId ||
      await durableEventId({ featureId: intent.featureId, streamId: intent.stream.id, version: intent.stream.version,
        originGroupKey: intent.originGroupKey, sourceEventId: intent.sourceEventId }) !== intent.eventId ||
      !Number.isSafeInteger(intent.committedAtMs) || intent.committedAtMs > Date.now() ||
      intent.expiresAtMs !== intent.committedAtMs + DURABLE_EVENT_LIMITS.retentionMs ||
      intent.stateEvent?.version !== 1 || !/^ses1\.[\w-]{22}$/.test(intent.stateEvent.scopeToken) ||
      !Number.isSafeInteger(intent.stateEvent.operationSequence) || intent.stateEvent.operationSequence < 1 ||
      !Number.isSafeInteger(intent.stateEvent.stateRevision)) throw recoveryError("invalid_receipt", 422);
  if (operation === "interest") {
    if (input.epoch !== proof.interestEpoch) throw recoveryError("source_conflict", 409);
    return state.storage.transactionSync(() => {
      bindProducer(state, input.owner, descriptor, input.routeId);
      return registerProducerInterest(state, input.owner, input.routeId, input.epoch);
    });
  }
  if (operation === "outcome") {
    if (proof.intent.delivery?.state === "appended") return terminalDestinationOutcome(state, proof.intent.delivery, intent.stateEvent.operationSequence);
    return { state: "absent", operationId: input.operationId };
  }
  const fingerprint = await sha256Hex(canonicalJson({ operationId: intent.operationId, eventId: intent.eventId,
    committedAtMs: intent.committedAtMs, expiresAtMs: intent.expiresAtMs, stateEvent: intent.stateEvent, routeId: input.routeId }));
  if (stored?.fingerprint && stored.fingerprint !== fingerprint) throw recoveryError("source_conflict", 409);
  const prior = stored ? JSON.parse(stored.outcome_json) : null;
  if (operation === "confirm") {
    // A confirmed receipt may expire while its reply is lost. The durable
    // source cache still proves the gap outcome; do not recreate that receipt
    // or strand cleanup after the destination's bounded retention window.
    if (!stored && proof.state === "gap_recorded" && proof.intent.delivery?.state === "gap" &&
        proof.intent.delivery.operationId === intent.operationId) return { confirmed: true };
    if (!stored && proof.intent.delivery?.state === "appended" && terminalDestinationOutcome(state, proof.intent.delivery, intent.stateEvent.operationSequence).terminal) return { confirmed: true };
    if (!stored || !["appended", "gap_recorded"].includes(proof.state) || proof.intent.delivery?.operationId !== intent.operationId) throw recoveryError("missing_receipt", 409);
    state.storage.sql.exec("UPDATE state_event_destination_records SET expires_at_ms = COALESCE(expires_at_ms, ?) WHERE operation_id = ?",
      Math.max(Date.now(), Number(prior.acceptedAtMs ?? intent.committedAtMs) + DURABLE_EVENT_LIMITS.receiptRetentionMs), intent.operationId);
    return { confirmed: true };
  }
  if (prior && ["appended", "gap"].includes(prior.state)) return prior;
  if (operation === "lookup") return { state: "absent", operationId: input.operationId };
  if (input.owner.kind === "effective_shareable" && input.authority !== "registry-v1") throw recoveryError("authority_required", 403);
  const fences = stored ? JSON.parse(stored.fenced_json) : [];
  if (operation === "fence") {
    if (typeof input.callId !== "string") throw recoveryError("invalid_request", 422);
    // At the total attempt ceiling, all further append calls are fenced.
    if (!fences.includes(input.callId) && fences.length < 20) fences.push(input.callId);
    state.storage.transactionSync(() => save(state, intent, fingerprint, { state: "fenced", operationId: input.operationId }, fences));
    return { state: "fenced", operationId: input.operationId };
  }
  if (proof.state === "reset_discarded") {
    if (operation === "fence") return { state: "fenced", operationId: input.operationId };
    throw recoveryError("reset_discarded", 409);
  }
  const producerCheckpoint = one(state, "SELECT reset_checkpoint FROM state_event_destination");
  if (Number(producerCheckpoint?.reset_checkpoint ?? 0) >= intent.stateEvent.operationSequence) {
    if (operation === "fence") return { state: "fenced", operationId: input.operationId };
    throw recoveryError("reset_discarded", 409);
  }
  const expired = intent.expiresAtMs <= Date.now();
  const lifecycle = operation === "gap";
  if (expired || lifecycle) {
    const outcome = { state: "gap", operationId: intent.operationId, reason: lifecycle ? "lifecycle" : "retention",
      scopeToken: intent.stateEvent.scopeToken, firstOperationSequence: intent.stateEvent.operationSequence, lastOperationSequence: intent.stateEvent.operationSequence };
    state.storage.transactionSync(() => {
      bindProducer(state, input.owner, descriptor, input.routeId);
      save(state, intent, fingerprint, outcome, fences);
      state.storage.sql.exec(`UPDATE state_event_destination SET gap_first = MIN(COALESCE(gap_first, ?), ?),
        gap_last = MAX(COALESCE(gap_last, 0), ?), gap_reasons = gap_reasons | ? WHERE singleton = 1`,
      outcome.firstOperationSequence, outcome.firstOperationSequence, outcome.lastOperationSequence, lifecycle ? 2 : 1);
      state.storage.sql.exec("UPDATE durable_event_stream_metadata SET consumer_ready = 0 WHERE singleton = 1");
    });
    return outcome;
  }
  if (env.DURABLE_EVENT_STREAMS_ENABLED !== "true") throw recoveryError("service_unavailable", 503);
  if (proof.head !== intent.operationId || ["gap_recorded", "reset_discarded"].includes(proof.state)) throw recoveryError("delivery_order", 409);
  const normalized = serializeDurableEventPayload(intent.payload, definition.payload.schema);
  const receipt = await append({ eventId: intent.eventId, fingerprint, featureId: intent.featureId, streamId: intent.stream.id,
    version: intent.stream.version, payload: normalized.serialized,
    route: { routeId: input.routeId, bindingRevision: intent.route.bindingRevision, descriptor },
    ...(input.binding ? { binding: input.binding } : {}) }, {
    combined: true, expiresAtMs: intent.expiresAtMs, stateEvent: intent.stateEvent,
    guard() {
      const record = one(state, "SELECT fenced_json FROM state_event_destination_records WHERE operation_id = ?", intent.operationId);
      if (record) {
        const fenced = JSON.parse(record.fenced_json);
        if (fenced.length >= 20) throw recoveryError("attempt_limit", 409);
        if (fenced.includes(input.callId)) throw recoveryError("attempt_fenced", 409);
      }
      const producer = one(state, "SELECT reset_id, reset_checkpoint FROM state_event_destination");
      if (Number(producer?.reset_checkpoint ?? 0) >= intent.stateEvent.operationSequence) throw recoveryError("reset_discarded", 409);
      if (producer?.reset_id || combinedGap(state)) throw durableEventError(DURABLE_EVENT_CODES.gapRequiresReset, { status: 409 });
      bindProducer(state, input.owner, descriptor, input.routeId);
    },
    commit(receipt) { save(state, intent, fingerprint, { ...receipt, state: "appended", operationId: intent.operationId, expiresAtMs: intent.expiresAtMs }, fences); }
  });
  return { ...receipt, state: "appended", operationId: intent.operationId, expiresAtMs: intent.expiresAtMs };
}
function bindProducer(state, owner, descriptor, routeId) {
  const old = one(state, "SELECT * FROM state_event_destination");
  if (old && old.owner_json !== canonicalJson(owner)) throw recoveryError("wrong_owner", 409);
  state.storage.sql.exec("INSERT OR IGNORE INTO state_event_destination (singleton, owner_json) VALUES (1, ?)", canonicalJson(owner));
  const meta = one(state, "SELECT route_id FROM durable_event_stream_metadata");
  if (meta.route_id !== null && meta.route_id !== routeId) throw recoveryError("invalid_route", 409);
  state.storage.sql.exec("UPDATE durable_event_stream_metadata SET route_id = COALESCE(route_id, ?), descriptor_json = COALESCE(descriptor_json, ?) WHERE singleton = 1", routeId, JSON.stringify(descriptor));
}
export async function prepareCombinedGrant(state, env, input) {
  const { route } = input.grant;
  const owner = combinedOwner(route.descriptor);
  const status = await combinedSourceStatus(state, env, route.descriptor, route.routeId);
  if (!input.resetBacklog) {
    if (status.gap || status.unresolvedGap || status.reset || combinedGap(state)) throw durableEventError(DURABLE_EVENT_CODES.gapRequiresReset, { status: 409 });
    initialize(state);
    state.storage.transactionSync(() => bindProducer(state, owner, route.descriptor, route.routeId));
    return null;
  }
  initialize(state);
  const checkpoint = await deliverySourceRequest(env, owner, "reset-prepare", { routeId: route.routeId, resetId: input.grantId });
  if (checkpoint.completed) throw recoveryError("reset_already_completed", 409);
  state.storage.transactionSync(() => {
    bindProducer(state, owner, route.descriptor, route.routeId);
    const previous = one(state, "SELECT reset_id FROM state_event_destination")?.reset_id;
    if (previous && previous !== input.grantId) throw recoveryError("reset_pending", 409);
    state.storage.sql.exec("UPDATE state_event_destination SET reset_id = ?, reset_checkpoint = ? WHERE singleton = 1", input.grantId, checkpoint.checkpoint);
  });
  await deliverySourceRequest(env, owner, "reset-commit", { routeId: route.routeId, resetId: input.grantId });
  return { owner, checkpoint: checkpoint.checkpoint, routeId: route.routeId, resetId: input.grantId };
}
export function commitCombinedReset(state, reset, actor) {
  if (!reset) return;
  state.storage.sql.exec("INSERT OR IGNORE INTO state_event_destination_resets VALUES (?, ?, ?, ?)", reset.resetId, reset.checkpoint, JSON.stringify(actor), Date.now());
  state.storage.sql.exec("DELETE FROM state_event_destination_resets WHERE reset_id IN (SELECT reset_id FROM state_event_destination_resets ORDER BY reset_at_ms DESC, reset_id DESC LIMIT -1 OFFSET 100)");
  state.storage.sql.exec("UPDATE state_event_destination_records SET expires_at_ms = COALESCE(expires_at_ms, ?) WHERE operation_sequence <= ?", Date.now() + DURABLE_EVENT_LIMITS.receiptRetentionMs, reset.checkpoint);
  state.storage.sql.exec("UPDATE state_event_destination SET gap_first = NULL, gap_last = NULL, gap_reasons = 0 WHERE singleton = 1 AND reset_id = ?", reset.resetId);
}
export async function finishCombinedReset(state, env, reset) {
  if (!reset) return;
  await deliverySourceRequest(env, reset.owner, "reset-release", { routeId: reset.routeId, resetId: reset.resetId });
  state.storage.sql.exec("UPDATE state_event_destination SET reset_id = NULL WHERE singleton = 1 AND reset_id = ?", reset.resetId);
}

function terminalDestinationOutcome(state, outcome, operationSequence) {
  if (outcome.state === "gap") return { ...outcome, terminal: outcome.reason };
  const reset = one(state, "SELECT reset_checkpoint FROM state_event_destination");
  if (Number(reset?.reset_checkpoint ?? 0) >= operationSequence) return { ...outcome, terminal: "reset" };
  const meta = one(state, "SELECT acknowledged_sequence FROM durable_event_stream_metadata");
  if (Number(meta.acknowledged_sequence) >= outcome.sequence) return { ...outcome, terminal: "acknowledged" };
  const event = one(state, "SELECT 1 FROM durable_event_stream_events WHERE event_id = ?", outcome.eventId ?? "");
  // Existing receipts predate eventId in the safe delivery result; sequence is
  // equally authoritative within this already pinned physical stream.
  const retained = event || one(state, "SELECT 1 FROM durable_event_stream_events WHERE sequence = ?", outcome.sequence);
  if (!retained && outcome.expiresAtMs <= Date.now()) return { ...outcome, terminal: "retention" };
  return { ...outcome, terminal: null };
}
