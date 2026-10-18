import { registerStateEventRuntime } from "./runtime-capability.js";
import { canonicalJson, createStateEventIdentity, recoveryError, STATE_EVENT_LIMITS } from "./identity.js";
import { boundedStateEventRequest } from "./relay-client.js";
import { resolveStateEventSharedRoute } from "./shared-publication.js";
import { durableEventId, durableEventRouteId, DURABLE_EVENT_LIMITS } from "../durable-events/contract.js";

function acceptedReceipt(outcome, identity, eventId) {
  const receipt = outcome?.receipt, marker = receipt?.stateEvent;
  if (outcome?.state !== "committed" || receipt?.operationId !== identity.operationId || receipt?.eventId !== eventId ||
      !Number.isSafeInteger(receipt?.committedAtMs) || receipt.committedAtMs < 0 ||
      receipt.expiresAtMs !== receipt.committedAtMs + DURABLE_EVENT_LIMITS.retentionMs ||
      !Number.isSafeInteger(receipt.expiresAtMs) || marker?.version !== 1 || marker.operationId !== identity.operationId ||
      !/^ses1\.[\w-]{22}$/.test(marker.scopeToken ?? "") ||
      !Number.isSafeInteger(marker.operationSequence) || marker.operationSequence < 1 ||
      !Number.isSafeInteger(marker.stateRevision) || marker.stateRevision < 0) throw recoveryError("outcome_unknown", 503);
  try { canonicalJson(receipt.result, STATE_EVENT_LIMITS.maxResultBytes); }
  catch { throw recoveryError("outcome_unknown", 503); }
  // Return only the public receipt, never extra transport metadata or routes.
  return Object.freeze({ accepted: true, operationId: receipt.operationId, eventId: receipt.eventId,
    committedAtMs: receipt.committedAtMs, expiresAtMs: receipt.expiresAtMs, result: receipt.result,
    stateEvent: { version: 1, operationId: marker.operationId, scopeToken: marker.scopeToken,
      operationSequence: marker.operationSequence, stateRevision: marker.stateRevision } });
}

export function stateEventAcceptanceEnabled(env) {
  return env?.STATE_EVENT_OPERATIONS_ENABLED === "true" && env?.DURABLE_EVENT_STREAMS_ENABLED === "true";
}
export function createStateEventCommandRuntime(env, invocation, registry) {
  async function open(featureId, targetPlatform, operationId, kind) {
    if (!env?.CONFIG) throw recoveryError("service_unavailable", 503);
    const entry = registry?.stateEvents?.[`${featureId}:${operationId}`], action = registry?.actions?.[invocation.kind];
    if (!entry || action?.featureId !== featureId || !action.uses.stateEvents?.includes(operationId) || entry.definition.scope.kind !== kind) throw recoveryError("operation_undeclared", 422);
    if (kind === "effective_shareable" && (targetPlatform === invocation.origin.group.platform || !["discord", "twitch"].includes(targetPlatform))) throw recoveryError("invalid_route", 422);
    const command = { ...invocation, args: action.input.parse(invocation.args) };
    const identity = await createStateEventIdentity({ environment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT, featureId, invocation: command,
      declaration: { operation: operationId, scope: entry.definition.scope, stream: entry.definition.stream } });
    const eventId = await durableEventId({ featureId, streamId: entry.streamDefinition.id, version: entry.streamDefinition.version,
      originGroupKey: identity.originGroupKey, sourceEventId: identity.sourceEventId });
    const send = (operation, input) => boundedStateEventRequest(() => env.CONFIG.get(env.CONFIG.idFromName(identity.originGroupKey)).fetch(
      `https://origin/internal/state-events/command/${operation}`, { method: "POST", headers: { "x-elmybot-state-event-command": "v1" }, body: JSON.stringify(input) }));
    async function route() {
      if (kind === "group_local") return { kind, key: identity.originGroupKey, bindingRevision: 0, streamRouteId: await durableEventRouteId({
        deploymentEnvironment: identity.environment, scopeKind: kind, realmIdentity: identity.originGroupKey, featureId,
        streamId: entry.streamDefinition.id, version: entry.streamDefinition.version }) };
      const namespace = registry.featuresById[featureId].shareableState.find(({ id }) => id === entry.definition.scope.namespace);
      return resolveStateEventSharedRoute(env, { sourceGroup: command.origin.group, targetPlatform, featureId,
        namespaceId: namespace.id, schemaVersion: namespace.schemaVersion, stream: entry.streamDefinition });
    }
    async function commitPrepared(prepare) {
      const saved = await send("lookup", { identity });
      if (saved?.state === "committed") return acceptedReceipt(saved, identity, eventId);
      if (!["absent", "prepared"].includes(saved?.state)) throw recoveryError("outcome_unknown", 503);
      if (!stateEventAcceptanceEnabled(env)) throw recoveryError("service_unavailable", 503);
      const input = saved.state === "absent" ? { identity, request: await prepare(), route: await route() } : { identity };
      let outcome;
      try { outcome = await send("invoke", input); }
      catch (error) {
        if (kind !== "effective_shareable" || !["state_event_binding_changed", "state_event_attempt_fenced"].includes(error.code)) throw error;
        outcome = await send("invoke", { identity, route: await route(), repin: true });
      }
      return acceptedReceipt(outcome, identity, eventId);
    }
    return Object.freeze({ commitPrepared, commit: (request) => commitPrepared(async () => request) });
  }
  return registerStateEventRuntime({ local: (featureId, operationId) => open(featureId, null, operationId, "group_local"),
    current: (featureId, targetPlatform, operationId) => open(featureId, targetPlatform, operationId, "effective_shareable") });
}
