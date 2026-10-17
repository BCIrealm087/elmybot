import { shareableStateRealmObjectName } from "../shareable-state/realm-client.js";
import { recoveryError, StateEventRecoveryError, validateAttempt } from "./identity.js";

export const STATE_EVENT_OWNER_PATH = "/internal/state-events/owner/";

export function createStateEventOwnerClient(env) {
  async function send(operation, attempt) {
    validateAttempt(attempt);
    const { route } = attempt;
    let namespace, path, body;
    if (route.kind === "group_local") {
      namespace = env?.CONFIG;
      path = `${STATE_EVENT_OWNER_PATH}${operation}`;
      body = { attempt };
    } else {
      namespace = env?.SHAREABLE_STATE_REALM;
      if (shareableStateRealmObjectName(route.realm) !== route.key) throw recoveryError("invalid_route", 422);
      path = `/internal/shareable-state/realm/state-event-${operation}`;
      body = { realm: route.realm, namespace: route.namespace, storage: { attempt } };
    }
    if (!namespace) throw recoveryError("owner_unavailable", 503);
    const response = await namespace.get(namespace.idFromName(route.key)).fetch(`https://state-owner${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new StateEventRecoveryError(result?.code ?? "state_event_owner_unavailable", response.status);
    return result;
  }
  return Object.freeze({ lookup: (attempt) => send("lookup", attempt), fence: (attempt) => send("fence", attempt), confirm: (attempt) => send("confirm", attempt) });
}
