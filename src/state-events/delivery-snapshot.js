import { canonicalJson, recoveryError } from "./identity.js";
import { initializeStateEventOutbox, stateEventOutboxExists } from "./outbox.js";
const one = (state, sql, ...args) => state.storage.sql.exec(sql, ...args).toArray()[0];

// Framework-owned binding protocol, never a public credential or feature input.
// The producer constructs this from its local receipt/outbox. Headers mark the
// private call path; they do not authenticate arbitrary external callers.
export const STATE_EVENT_SOURCE_SNAPSHOT_HEADER = "x-elmybot-state-event-source";
export const STATE_EVENT_DELIVERY_REQUEST_BYTES = 24 * 1024;
export function sourceSnapshotHeaders(snapshot) {
  return snapshot ? { [STATE_EVENT_SOURCE_SNAPSHOT_HEADER]: "snapshot-v1" } : {};
}
export function readSourceSnapshot(input, trusted) {
  if (!Object.hasOwn(input, "sourceSnapshot")) return null;
  if (!trusted) throw recoveryError("authority_required", 403);
  const snapshot = JSON.parse(canonicalJson(input.sourceSnapshot));
  const proof = snapshot?.proof, intent = proof?.intent;
  if (snapshot?.version !== 1 || canonicalJson(snapshot.owner) !== canonicalJson(input.owner) ||
      snapshot.routeId !== input.routeId || intent?.operationId !== input.operationId ||
      intent?.route?.key !== input.owner?.key || intent?.route?.kind !== input.owner?.kind ||
      intent.route.streamRouteId !== input.routeId ||
      !["pending", "parked", "gap_pending", "appended", "gap_recorded", "retiring", "reset_discarded"].includes(proof.state) ||
      !(proof.head === null || /^seo1\.[\w-]{43}$/.test(proof.head)) ||
      !Number.isSafeInteger(proof.interestEpoch) || proof.interestEpoch < 1) throw recoveryError("invalid_receipt", 422);
  return proof;
}

export function sourceIntentProof(state, operationId, routeId) {
  if (!stateEventOutboxExists(state)) throw recoveryError("missing_intent", 409);
  initializeStateEventOutbox(state);
  const row = one(state, "SELECT * FROM state_event_outbox WHERE operation_id = ? AND stream_route_id = ?", operationId, routeId);
  const receipt = one(state, "SELECT metadata_json FROM state_event_records WHERE record_key = ?", `owner:${operationId}`);
  if (!row || !receipt) throw recoveryError("missing_intent", 409);
  const intent = JSON.parse(row.intent_json), saved = JSON.parse(receipt.metadata_json).receipt;
  if (!saved || saved.operationId !== operationId || intent.operationId !== operationId ||
      saved.eventId !== intent.eventId || canonicalJson(saved.stateEvent) !== canonicalJson(intent.stateEvent) ||
      saved.expiresAtMs !== intent.expiresAtMs || saved.committedAtMs !== intent.committedAtMs) throw recoveryError("invalid_receipt", 503);
  const head = one(state, `SELECT operation_id FROM state_event_outbox WHERE stream_route_id = ?
    AND state NOT IN ('appended', 'gap_recorded', 'reset_discarded', 'retiring') ORDER BY operation_sequence LIMIT 1`, routeId);
  const stream = one(state, "SELECT interest_epoch FROM state_event_source_streams WHERE route_id = ?", routeId);
  return { intent, state: row.state, head: head?.operation_id ?? null, interestEpoch: Number(stream?.interest_epoch ?? 1) };
}
export function sourceDeliverySnapshot(state, env, owner, operationId, routeId) {
  const binding = owner.kind === "group_local" ? env.CONFIG : env.SHAREABLE_STATE_REALM;
  if (binding.idFromName(owner.key).toString() !== state.id.toString()) throw recoveryError("wrong_owner", 422);
  const proof = sourceIntentProof(state, operationId, routeId);
  if (proof.intent.route.kind !== owner.kind || proof.intent.route.key !== owner.key) throw recoveryError("wrong_owner", 422);
  return { version: 1, owner, routeId, proof };
}
