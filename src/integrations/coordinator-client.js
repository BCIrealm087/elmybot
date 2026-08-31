import { IntegrationCoordinatorError } from "./coordinator-errors.js";

export function integrationCoordinatorObjectName(integrationId) {
  return `integration-coordinator:${integrationId}`;
}

export function integrationCoordinatorStub(env, integrationId) {
  if (!env.INTEGRATION_COORDINATOR) {
    throw new IntegrationCoordinatorError(
      "The integration coordinator is not configured.",
      { status: 503, code: "integration_coordinator_not_configured" }
    );
  }
  if (typeof integrationId !== "string" || integrationId.length === 0) {
    throw new IntegrationCoordinatorError("The integration ID is invalid.", {
      status: 422,
      code: "integration_identity_invalid"
    });
  }
  return env.INTEGRATION_COORDINATOR.get(
    env.INTEGRATION_COORDINATOR.idFromName(
      integrationCoordinatorObjectName(integrationId)
    )
  );
}

async function checkedCoordinatorResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw new IntegrationCoordinatorError(
      result?.error || "The integration coordinator request failed.",
      {
        status: response.status,
        code: result?.code || "integration_coordinator_request_failed"
      }
    );
  }
  return result;
}

export async function submitIntegrationExecution(env, input) {
  const integrationId = input?.integration?.id;
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch("https://integration-coordinator/executions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  }));
}

export async function getIntegrationExecution(env, integrationId, sourceEventId) {
  const url = new URL("https://integration-coordinator/executions");
  url.searchParams.set("sourceEventId", sourceEventId);
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch(url));
}

export async function getIntegrationCoordinatorStatus(env, integrationId) {
  const url = new URL("https://integration-coordinator/status");
  url.searchParams.set("integrationId", integrationId);
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch(url));
}

export async function getIntegrationDeadLetters(env, integrationId, { limit } = {}) {
  const url = new URL("https://integration-coordinator/dead-letters");
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch(url));
}

export async function retryIntegrationEffect(env, integrationId, idempotencyKey) {
  return checkedCoordinatorResponse(await integrationCoordinatorStub(
    env,
    integrationId
  ).fetch("https://integration-coordinator/effects/retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ integrationId, idempotencyKey })
  }));
}
