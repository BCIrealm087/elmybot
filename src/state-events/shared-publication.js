import { createIntegrationRealmIdentity, createStandaloneRealmIdentity, shareableStateRealmObjectName } from "../shareable-state/realm-client.js";
import { integrationRegistryStub, resolveEffectiveShareableStateRealm } from "../integrations/registry-client.js";
import { durableEventRouteId } from "../durable-events/contract.js";
import { canonicalJson, fingerprint, recoveryError, sameAttempt, StateEventRecoveryError, validateAttempt } from "./identity.js";
import { finalizeStateEventOrigin, lookupStateEventOrigin, markStateEventOriginConfirmed } from "./storage.js";
import { createStateEventRecovery } from "./recovery.js";
import { createStateEventOwnerClient } from "./owner-client.js";
import { STATE_EVENT_ORIGIN_HEADER } from "./shareable-commit.js";

export async function resolveStateEventSharedRoute(env, { sourceGroup, targetPlatform, featureId, namespaceId, schemaVersion, stream }) {
  const selected = await resolveEffectiveShareableStateRealm(env, { sourceGroup, targetPlatform });
  const realm = selected.defaultLink
    ? createIntegrationRealmIdentity(selected.defaultLink.integration, { generation: selected.defaultLink.integration.shareableStateGeneration ?? 1 })
    : createStandaloneRealmIdentity(selected.standaloneRealm.ownerGroup, { generation: selected.standaloneRealm.generation });
  const key = shareableStateRealmObjectName(realm);
  return { kind: "effective_shareable", key, realm, targetPlatform, bindingRevision: selected.bindingRevision,
    namespace: { featureId, namespaceId, schemaVersion }, streamRouteId: await durableEventRouteId({
      deploymentEnvironment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT, scopeKind: "effective_shareable",
      realmIdentity: key, featureId, streamId: stream.id, version: stream.version }) };
}

// Called at the origin object, never with a caller-supplied receipt. The only
// accepted outcome is the registry's response to the verified saved preparation.
export async function commitPreparedSharedStateEvent(state, env, raw) {
  const input = JSON.parse(canonicalJson(raw, 24 * 1024));
  validateAttempt(input?.attempt);
  const { attempt, request } = input;
  if (attempt.route.kind !== "effective_shareable" ||
      env.CONFIG.idFromName(attempt.identity.originGroupKey).toString() !== state.id.toString()) throw recoveryError("wrong_owner", 422);
  const origin = lookupStateEventOrigin(state, attempt.identity);
  if (!origin || !sameAttempt(origin.attempt, attempt)) throw recoveryError("missing_origin", 503);
  if (await fingerprint(request) !== attempt.preparedFingerprint) throw recoveryError("source_conflict");
  if (origin.state === "committed") return createStateEventRecovery(state, createStateEventOwnerClient(env)).recover(attempt.identity);
  if (origin.state !== "prepared") throw recoveryError("source_expired", 410);
  const response = await integrationRegistryStub(env).fetch("https://registry/state-events/commit", {
    method: "POST", headers: { "content-type": "application/json", [STATE_EVENT_ORIGIN_HEADER]: "prepared-v1" },
    body: JSON.stringify({ attempt, request })
  });
  const outcome = await response.json();
  if (!response.ok) throw new StateEventRecoveryError(outcome?.code ?? "state_event_outcome_unknown", response.status);
  if (outcome?.state !== "committed" || outcome.receipt?.operationId !== attempt.identity.operationId) throw recoveryError("outcome_unknown", 503);
  try {
    const cached = finalizeStateEventOrigin(state, attempt, outcome.receipt);
    if (cached?.state === "committed") {
      const acknowledged = await createStateEventOwnerClient(env).confirm(attempt);
      if (acknowledged?.state === "committed" && acknowledged.receipt?.operationId === outcome.receipt.operationId) {
        markStateEventOriginConfirmed(state, attempt);
      }
    }
  } catch {
    // Owner acceptance remains authoritative. Durable locator/receipt recovery
    // survives an origin cache or acknowledgement failure.
  }
  return { state: "committed", receipt: outcome.receipt };
}
