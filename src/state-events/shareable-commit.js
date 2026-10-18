import { calculatePreparedStateEvent, StateEventOperationDefinitionError, validatePreparedStateEventOperation } from "../framework/state-event-operation.js";
import { durableEventId, durableEventRouteId } from "../durable-events/contract.js";
import { scheduleStorageAlarmInTransaction } from "../storage-alarm.js";
import { canonicalJson, fingerprint, recoveryError, validateAttempt } from "./identity.js";
import { commitStateEventAtOwner, lookupStateEventOwner } from "./storage.js";
import { allocateStateEventSequence, enqueueStateEventIntent, STATE_EVENT_OUTBOX_LIMITS } from "./outbox.js";

// A private binding protocol marker, not a public credential. Registry forwarding
// holds the lifecycle queue and a durable uncertain-call barrier until resolved.
export const STATE_EVENT_AUTHORITY_HEADER = "x-elmybot-state-event-authority";
export const STATE_EVENT_AUTHORITY_VALUE = "registry-v1";
export const STATE_EVENT_ORIGIN_HEADER = "x-elmybot-state-event-origin";

export async function commitShareableStateEvent(state, env, registry, input, adapter) {
  const normalized = JSON.parse(canonicalJson(input, 24 * 1024));
  if (!normalized?.request || typeof normalized.request !== "object" || Array.isArray(normalized.request)) throw recoveryError("invalid_request", 422);
  const { attempt, request } = normalized;
  validateAttempt(attempt);
  const { identity, route } = attempt;
  if (route.kind !== "effective_shareable" || route.key !== adapter.ownerKey ||
      env.SHAREABLE_STATE_REALM.idFromName(route.key).toString() !== state.id.toString() ||
      identity.environment !== env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT) throw recoveryError("wrong_owner", 422);
  if (await fingerprint(request) !== attempt.preparedFingerprint) throw recoveryError("source_conflict");
  const prior = lookupStateEventOwner(state, attempt, adapter.ownerKey);
  if (prior.state === "committed") return prior;
  if (prior.state === "fenced") throw recoveryError("attempt_fenced");
  if (env.STATE_EVENT_OPERATIONS_ENABLED !== "true" || env.DURABLE_EVENT_STREAMS_ENABLED !== "true") throw recoveryError("service_unavailable", 503);
  const entry = registry?.stateEvents?.[`${identity.featureId}:${request.operation}`];
  const action = registry?.actions?.[identity.actionKind];
  if (!entry || entry.definition.scope.kind !== "effective_shareable" ||
      entry.definition.scope.namespace !== adapter.namespace.namespaceId ||
      action?.featureId !== identity.featureId || !action.uses.stateEvents?.includes(request.operation) ||
      !action.supportedOrigins.includes(identity.originGroupKey.split(":")[0])) throw recoveryError("operation_undeclared", 422);
  if (route.namespace.schemaVersion !== adapter.namespace.declaration.schemaVersion) throw recoveryError("schema_changed", 409);
  let prepared;
  try { prepared = validatePreparedStateEventOperation(entry.definition, request); }
  catch { throw recoveryError("invalid_request", 422); }
  const stream = entry.streamDefinition;
  if (route.streamRouteId !== await durableEventRouteId({ deploymentEnvironment: identity.environment,
    scopeKind: "effective_shareable", realmIdentity: adapter.ownerKey, featureId: identity.featureId,
    streamId: stream.id, version: stream.version })) throw recoveryError("invalid_route", 422);
  const plan = await adapter.prepare(prepared.mutation);
  const eventId = await durableEventId({ featureId: identity.featureId, streamId: stream.id, version: stream.version,
    originGroupKey: identity.originGroupKey, sourceEventId: identity.sourceEventId });
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const candidateToken = "ses1." + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return state.storage.transaction(async () => {
    const outcome = await commitStateEventAtOwner(state, { attempt, request: prepared, physicalOwnerKey: adapter.ownerKey }, () => {
      // No remote authority read inside this transaction: registry serialization
      // and its durable barrier protect the route, while these owner-local checks
      // serialize against seals/freezes/materialization at the actual write.
      adapter.ensureWritable();
      const nowMs = Date.now();
      let calculation;
      try { calculation = calculatePreparedStateEvent(prepared, stream, adapter.read(plan)); }
      catch (error) {
        if (error instanceof StateEventOperationDefinitionError) throw recoveryError("invalid_result", 422);
        throw error;
      }
      const partitionKey = JSON.stringify([identity.featureId, adapter.namespace.namespaceId]);
      const correlation = allocateStateEventSequence(state, partitionKey, candidateToken, nowMs);
      const stateRevision = adapter.apply(plan);
      const stateEvent = { ...correlation, operationId: identity.operationId, stateRevision };
      const expiresAtMs = nowMs + STATE_EVENT_OUTBOX_LIMITS.retentionMs;
      enqueueStateEventIntent(state, { operationId: identity.operationId, eventId, featureId: identity.featureId,
        namespaceId: adapter.namespace.namespaceId, partitionKey, stream: prepared.stream,
        route, environment: identity.environment, originGroupKey: identity.originGroupKey,
        sourceEventId: identity.sourceEventId, stateEvent, committedAtMs: nowMs, expiresAtMs, payload: calculation.payload });
      return { eventId, result: calculation.result, stateEvent, expiresAtMs, committedAtMs: nowMs };
    });
    await scheduleStorageAlarmInTransaction(state);
    return outcome;
  });
}
