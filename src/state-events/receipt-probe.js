import { integrationRegistryStub } from "../integrations/registry-client.js";
import { canonicalJson, recoveryError } from "./identity.js";
import { deliveryReceiptFingerprint } from "./delivery-snapshot.js";
import { boundedStateEventRequest, relayStreamRequest } from "./relay-client.js";

export async function probeStateEventReceipt(env, intent, deadline, work) {
  const fingerprint = await deliveryReceiptFingerprint(intent);
  const input = { owner: { kind: intent.route.kind, key: intent.route.key }, operationId: intent.operationId,
    routeId: intent.route.streamRouteId, eventId: intent.eventId, fingerprint };
  let response;
  if (intent.route.kind === "effective_shareable") {
    work.take("authority.probe");
    response = await boundedStateEventRequest(() => integrationRegistryStub(env).fetch("https://registry/state-events/probe", {
      method: "POST", headers: { "x-elmybot-state-event-delivery": "v1" }, body: JSON.stringify(input)
    }), deadline, { env, operationId: intent.operationId, routeId: input.routeId, rpc: "authority.probe" });
  } else response = await relayStreamRequest(env, input.routeId, "probe", input, deadline, work);
  if (response?.state === "absent" && response.operationId === intent.operationId) return null;
  canonicalJson(response, 2048);
  const outcome = response?.outcome;
  if (response?.version !== 1 || response.eventId !== intent.eventId || response.fingerprint !== fingerprint ||
      outcome?.operationId !== intent.operationId || !["appended", "gap"].includes(outcome?.state)) throw recoveryError("invalid_receipt", 503);
  if (outcome.state === "appended") {
    if (!Number.isSafeInteger(outcome.sequence) || outcome.sequence < 1 ||
        !Number.isSafeInteger(outcome.acceptedAtMs) || outcome.acceptedAtMs < 0 || outcome.expiresAtMs !== intent.expiresAtMs ||
        ![null, "acknowledged", "reset", "retention"].includes(outcome.terminal)) throw recoveryError("invalid_receipt", 503);
  } else if (!["lifecycle", "retention"].includes(outcome.reason) || outcome.terminal !== outcome.reason ||
      outcome.scopeToken !== intent.stateEvent.scopeToken || outcome.firstOperationSequence !== intent.stateEvent.operationSequence ||
      outcome.lastOperationSequence !== intent.stateEvent.operationSequence) throw recoveryError("invalid_receipt", 503);
  return outcome;
}
