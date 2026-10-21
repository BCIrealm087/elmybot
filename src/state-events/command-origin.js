import { canonicalJson, recoveryError, validateIdentity, validateRoute } from "./identity.js";
import { createStateEventRecovery } from "./recovery.js";
import { createStateEventOwnerClient } from "./owner-client.js";
import { commitLocalStateEvent } from "./local-commit.js";
import { commitPreparedSharedStateEvent } from "./shared-publication.js";
import { stateEventAcceptanceEnabled } from "./command-runtime.js";

export async function handleStateEventCommand(state, env, registry, request, path) {
  const prefix = "/internal/state-events/command/";
  if (!path.startsWith(prefix)) return null;
  if (request.method !== "POST" || request.headers.get("x-elmybot-state-event-command") !== "v1") throw recoveryError("authority_required", 403);
  const input = JSON.parse(canonicalJson(await request.json(), 24 * 1024)), operation = path.slice(prefix.length);
  if (!["lookup", "invoke"].includes(operation)) throw recoveryError("invalid_request", 404);
  const { identity } = input; validateIdentity(identity);
  if (identity.environment !== env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT || env.CONFIG.idFromName(identity.originGroupKey).toString() !== state.id.toString()) throw recoveryError("wrong_owner", 422);
  const recovery = createStateEventRecovery(state, createStateEventOwnerClient(env));
  let saved = await recovery.recover(identity);
  if (saved?.state === "prepared" && identity.sourceCreatedAtMs + 7_200_000 <= Date.now()) saved = await recovery.retire(identity);
  if (saved?.state === "expired") throw recoveryError("source_expired", 410);
  if (saved?.state === "committed") return saved;
  if (operation === "lookup") return saved ?? { state: "absent" };
  if (!stateEventAcceptanceEnabled(env)) throw recoveryError("service_unavailable", 503);
  const action = registry.actions[identity.actionKind];
  if (action?.featureId !== identity.featureId || !action.uses.services.includes("stateEvents")) throw recoveryError("operation_undeclared", 422);
  if (!saved || input.repin) {
    validateRoute(input.route);
    const next = saved ? await recovery.repin(identity, async () => input.route)
      : await recovery.prepare(identity, async () => ({ request: input.request, route: input.route, cooldownSeconds: action.cooldown.seconds }));
    saved = next;
  }
  if (saved.state === "committed") return saved;
  return saved.attempt.route.kind === "group_local" ? commitLocalStateEvent(state, env, registry, saved) : commitPreparedSharedStateEvent(state, env, saved);
}
