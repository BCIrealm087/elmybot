import { createPlatformGroupRef } from "../integrations/contracts.js";
import { registerDurableEventBindingWatcher } from "./binding-notifications.js";
import { DurableEventGrantError } from "./grants.js";
import {
  DURABLE_EVENT_GRANT_PATH,
  durableEventInternalHeaders
} from "./stream.js";

export async function issueWithDurableEventBindingAuthority(registry, input) {
  let sourceGroup;
  try {
    sourceGroup = createPlatformGroupRef(input?.sourceGroup);
  } catch {
    throw new DurableEventGrantError("The event-grant binding is invalid.");
  }
  if (
    !["discord", "twitch"].includes(input?.targetPlatform) ||
    input.targetPlatform === sourceGroup.platform ||
    !Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0 ||
    typeof input?.expectedSourceKey !== "string" ||
    input?.issue?.grant?.route?.routeId !== input.routeId
  ) {
    throw new DurableEventGrantError("The event-grant binding is invalid.");
  }
  const current = registry.stateQueryBinding(sourceGroup, input.targetPlatform);
  const registration = registerDurableEventBindingWatcher(
    registry.state,
    registry.env,
    {
      sourceGroup,
      targetPlatform: input.targetPlatform,
      routeId: input.routeId,
      expectedRevision: input.expectedRevision,
      expectedSourceKey: input.expectedSourceKey,
      expiresAtMs: input.expiresAtMs,
      environment: input.environment
    },
    current,
    input.issue?.grant?.issuedAtMs
  );
  if (!registration.revisionMatched) {
    throw new DurableEventGrantError("The selected event stream is transitioning.", {
      code: "durable_event_stream_transition",
      status: 409
    });
  }
  const response = await registry.env.DURABLE_EVENT_STREAM.get(
    registry.env.DURABLE_EVENT_STREAM.idFromName(input.routeId)
  ).fetch(`https://durable-event-stream${DURABLE_EVENT_GRANT_PATH}/issue`, {
    method: "POST",
    headers: { "content-type": "application/json", ...durableEventInternalHeaders },
    body: JSON.stringify(input.issue)
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new DurableEventGrantError("The event-grant service is unavailable.", {
      code: "durable_event_service_unavailable",
      status: 503
    });
  }
  if (!response.ok) {
    throw new DurableEventGrantError(body?.error ?? "Event-grant issuance failed.", {
      code: body?.code ?? "durable_event_service_unavailable",
      status: response.status
    });
  }
  return body;
}
