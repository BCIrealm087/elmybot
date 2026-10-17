import {
  applyLocalStateEventMutation, prepareLocalStateEventMutation, readLocalStateEventMutation
} from "../framework/feature-storage.js";
import {
  calculatePreparedStateEvent, StateEventOperationDefinitionError, validatePreparedStateEventOperation
} from "../framework/state-event-operation.js";
import { durableEventId, durableEventRouteId } from "../durable-events/contract.js";
import { scheduleStorageAlarmInTransaction } from "../storage-alarm.js";
import { canonicalJson, fingerprint, recoveryError, sameAttempt, validateAttempt } from "./identity.js";
import { commitStateEventAtOwner, confirmStateEventOwner, finalizeStateEventOrigin, lookupStateEventOrigin, lookupStateEventOwner, markStateEventOriginConfirmed } from "./storage.js";
import { allocateStateEventSequence, enqueueStateEventIntent, STATE_EVENT_OUTBOX_LIMITS } from "./outbox.js";

// Private storage boundary. Command/service execution remains blocked until the
// shared-owner, delivery and operational-mode stages are complete.
export async function commitLocalStateEvent(state, env, registry, input) {
  const normalized = JSON.parse(canonicalJson(input, 24 * 1024));
  if (!normalized || !normalized.request || typeof normalized.request !== "object" || Array.isArray(normalized.request)) {
    throw recoveryError("invalid_request", 422);
  }
  const { attempt, request } = normalized;
  validateAttempt(attempt);
  const identity = attempt.identity;
  if (attempt.route.kind !== "group_local" || !env?.CONFIG ||
      env.CONFIG.idFromName(attempt.route.key).toString() !== state.id.toString() ||
      identity.environment !== env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT) throw recoveryError("wrong_owner", 422);
  if (await fingerprint(request) !== attempt.preparedFingerprint) throw recoveryError("source_conflict");
  const prior = lookupStateEventOwner(state, attempt, attempt.route.key);
  if (prior.state === "committed") return prior;
  if (prior.state === "fenced") throw recoveryError("attempt_fenced");
  const entry = registry?.stateEvents?.[`${identity.featureId}:${request.operation}`];
  const action = registry?.actions?.[identity.actionKind];
  if (!entry || entry.definition.scope.kind !== "group_local" || action?.featureId !== identity.featureId ||
      !action.uses.stateEvents?.includes(request.operation) ||
      !action.supportedOrigins.includes(identity.originGroupKey.split(":")[0])) throw recoveryError("operation_undeclared", 422);
  let prepared;
  try { prepared = validatePreparedStateEventOperation(entry.definition, request); }
  catch { throw recoveryError("invalid_request", 422); }
  const stream = entry.streamDefinition;
  const routeId = await durableEventRouteId({ deploymentEnvironment: identity.environment,
    scopeKind: "group_local", realmIdentity: identity.originGroupKey, featureId: identity.featureId,
    streamId: stream.id, version: stream.version });
  if (routeId !== attempt.route.streamRouteId || attempt.route.bindingRevision !== 0) throw recoveryError("invalid_route", 422);
  const plan = await prepareLocalStateEventMutation(identity.featureId, prepared.mutation);
  const eventId = await durableEventId({ featureId: identity.featureId, streamId: stream.id,
    version: stream.version, originGroupKey: identity.originGroupKey, sourceEventId: identity.sourceEventId });
  const tokenBytes = crypto.getRandomValues(new Uint8Array(16));
  const candidateToken = "ses1." + btoa(String.fromCharCode(...tokenBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  // SQLite storage.transaction includes SQL and alarm operations. The nested
  // synchronous transaction contains all state/result/notification/intent writes;
  // outer rollback also covers a failed alarm write, leaving no unscheduled commit.
  return state.storage.transaction(async () => {
    const outcome = await commitStateEventAtOwner(state, { attempt, request: prepared, physicalOwnerKey: attempt.route.key }, () => {
      const origin = lookupStateEventOrigin(state, identity);
      if (!origin || origin.state !== "prepared") throw recoveryError("missing_origin", 503);
      if (!sameAttempt(origin.attempt, attempt)) throw recoveryError("source_conflict");
      const nowMs = Date.now();
      let calculation;
      try { calculation = calculatePreparedStateEvent(prepared, stream, readLocalStateEventMutation(state, plan)); }
      catch (error) {
        if (error instanceof StateEventOperationDefinitionError) throw recoveryError("invalid_result", 422);
        throw error;
      }
      const correlation = allocateStateEventSequence(state, identity.featureId, candidateToken, nowMs);
      const stateRevision = applyLocalStateEventMutation(state, plan);
      const stateEvent = { ...correlation, operationId: identity.operationId, stateRevision };
      const expiresAtMs = nowMs + STATE_EVENT_OUTBOX_LIMITS.retentionMs;
      enqueueStateEventIntent(state, { operationId: identity.operationId, eventId, featureId: identity.featureId,
        stream: prepared.stream, route: attempt.route, environment: identity.environment,
        originGroupKey: identity.originGroupKey, sourceEventId: identity.sourceEventId,
        stateEvent, committedAtMs: nowMs, expiresAtMs, payload: calculation.payload });
      return { eventId, result: calculation.result, stateEvent, expiresAtMs, committedAtMs: nowMs };
    });
    try {
      // Local origin and owner share this transaction: cache and acknowledge
      // without another object request. A full optional cache cannot undo the
      // authoritative receipt; retain its locator for step-3 recovery instead.
      const cached = finalizeStateEventOrigin(state, attempt, outcome.receipt);
      if (cached?.state === "committed") {
        confirmStateEventOwner(state, attempt, attempt.route.key);
        markStateEventOriginConfirmed(state, attempt);
      }
    } catch (error) {
      if (!["state_event_capacity", "state_event_too_large"].includes(error?.code)) throw error;
    }
    await scheduleStorageAlarmInTransaction(state);
    return outcome;
  });
}
