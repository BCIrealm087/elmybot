import { createPlatformGroupRef } from "../integrations/contracts.js";
import {
  DURABLE_EVENT_CODES,
  durableEventError
} from "./contract.js";
import { registerDurableEventBindingWatcher } from "./binding-notifications.js";
import {
  DURABLE_EVENT_APPEND_PATH,
  durableEventInternalHeaders
} from "./stream.js";

function normalizedInput(input) {
  let sourceGroup;
  try {
    sourceGroup = createPlatformGroupRef(input?.sourceGroup);
  } catch (cause) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 422, cause });
  }
  if (
    !["discord", "twitch"].includes(input?.targetPlatform) ||
    input.targetPlatform === sourceGroup.platform ||
    input?.append?.route?.descriptor?.scopeKind !== "effective_shareable" ||
    input.append.route.descriptor.deploymentEnvironment !== input.environment ||
    input.append.route.bindingRevision !== input.expectedRevision ||
    input.append.route.descriptor.realmIdentity !== input.expectedSourceKey
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 422 });
  }
  return {
    sourceGroup,
    targetPlatform: input.targetPlatform,
    expectedRevision: input.expectedRevision,
    expectedSourceKey: input.expectedSourceKey,
    expiresAtMs: input.expiresAtMs,
    environment: input.environment,
    append: input.append
  };
}

async function checkedStreamResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, {
      status: 502,
      cause
    });
  }
  if (!response.ok) {
    throw durableEventError(
      Object.values(DURABLE_EVENT_CODES).includes(result?.code)
        ? result.code
        : DURABLE_EVENT_CODES.serviceUnavailable,
      { status: response.status }
    );
  }
  return result;
}

export async function appendWithDurableEventBindingAuthority(registry, rawInput) {
  const input = normalizedInput(rawInput);
  const current = registry.stateQueryBinding(input.sourceGroup, input.targetPlatform);
  const registration = registerDurableEventBindingWatcher(
    registry.state,
    registry.env,
    {
      sourceGroup: input.sourceGroup,
      targetPlatform: input.targetPlatform,
      routeId: input.append.route.routeId,
      expectedRevision: input.expectedRevision,
      expectedSourceKey: input.expectedSourceKey,
      expiresAtMs: input.expiresAtMs,
      environment: input.environment
    },
    current
  );
  if (!registry.env?.DURABLE_EVENT_STREAM) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 503 });
  }
  const append = registration.revisionMatched
    ? {
        ...input.append,
        binding: {
          sourceGroupKey: input.sourceGroup.key,
          targetPlatform: input.targetPlatform,
          revision: input.expectedRevision,
          sourceKey: input.expectedSourceKey
        }
      }
    : { ...input.append, recoveryOnly: true };
  return await checkedStreamResponse(await registry.env.DURABLE_EVENT_STREAM.get(
    registry.env.DURABLE_EVENT_STREAM.idFromName(input.append.route.routeId)
  ).fetch(`https://durable-event-stream${DURABLE_EVENT_APPEND_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...durableEventInternalHeaders
    },
    body: JSON.stringify(append)
  }));
}
