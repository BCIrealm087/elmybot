import {
  FEATURE_STORAGE_PATH_PREFIX,
  INTEGRATION_FEATURE_STATE_PATH_PREFIX
} from "./feature-storage.js";
import { integrationCoordinatorStub } from "../integrations/coordinator-client.js";
import { getIntegrationDefaultLink } from "../integrations/registry-client.js";

export const FEATURE_RUNTIME_SERVICES = Object.freeze([
  "authorization",
  "config",
  "integrationState",
  "links",
  "state",
  "random"
]);

export class FeatureServiceRuntimeError extends Error {
  constructor(message, {
    code = "feature_service_failed",
    status = 500,
    cause
  } = {}) {
    super(message, { cause });
    this.name = "FeatureServiceRuntimeError";
    this.code = code;
    this.status = status;
  }
}

function featureStorageStub(env, groupKey) {
  if (!env?.CONFIG) {
    throw new FeatureServiceRuntimeError("Feature storage is not configured.", {
      code: "feature_storage_unavailable",
      status: 503
    });
  }
  return env.CONFIG.get(env.CONFIG.idFromName(groupKey));
}

async function storageRequest(env, invocation, operation, input) {
  const response = await featureStorageStub(env, invocation.origin.group.key).fetch(
    `https://config${FEATURE_STORAGE_PATH_PREFIX}${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": invocation.correlationId
      },
      body: JSON.stringify(input)
    }
  );
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw new FeatureServiceRuntimeError(
      "Feature storage returned an invalid response.",
      { code: "feature_storage_invalid_response", status: 502, cause }
    );
  }
  if (!response.ok) {
    throw new FeatureServiceRuntimeError(
      result?.userFacingError ?? "Feature storage request failed.",
      { code: "feature_storage_request_failed", status: response.status }
    );
  }
  return result;
}

async function integrationStateRequest(env, invocation, link, operation, input) {
  const response = await integrationCoordinatorStub(
    env,
    link.integration.id
  ).fetch(
    `https://integration-coordinator${INTEGRATION_FEATURE_STATE_PATH_PREFIX}${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": invocation.correlationId
      },
      body: JSON.stringify({
        integration: link.integration,
        sourceGroup: link.sourceGroup,
        targetGroup: link.targetGroup,
        storage: input
      })
    }
  );
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw new FeatureServiceRuntimeError(
      "Integration feature storage returned an invalid response.",
      { code: "integration_feature_storage_invalid_response", status: 502, cause }
    );
  }
  if (!response.ok) {
    throw new FeatureServiceRuntimeError(
      result?.userFacingError ?? result?.error ??
        "Integration feature storage request failed.",
      {
        code: result?.code ?? "integration_feature_storage_request_failed",
        status: response.status
      }
    );
  }
  return result;
}

export function createFeatureServiceRuntime(env, invocation) {
  const input = (featureId, values = {}) => ({ featureId, ...values });
  return Object.freeze({
    featureServices: Object.freeze({
      config: Object.freeze({
        async get(featureId, key) {
          const result = await storageRequest(
            env,
            invocation,
            "config/get",
            input(featureId, { key })
          );
          return result.value;
        }
      }),
      integrationState: Object.freeze({
        async get(featureId, link, key) {
          const result = await integrationStateRequest(
            env,
            invocation,
            link,
            "state/get",
            input(featureId, { key })
          );
          return result.value;
        },
        async set(featureId, link, key, value) {
          await integrationStateRequest(
            env,
            invocation,
            link,
            "state/set",
            input(featureId, { key, value })
          );
        },
        async delete(featureId, link, key) {
          const result = await integrationStateRequest(
            env,
            invocation,
            link,
            "state/delete",
            input(featureId, { key })
          );
          return result.deleted;
        },
        async increment(featureId, link, key, amount = 1) {
          const result = await integrationStateRequest(
            env,
            invocation,
            link,
            "state/increment",
            input(featureId, { key, amount })
          );
          return result.value;
        },
        async boundedCounter(featureId, link, descriptor, operation, operand) {
          const result = await integrationStateRequest(
            env,
            invocation,
            link,
            "state/bounded-counter",
            input(featureId, {
              ...descriptor,
              operation,
              ...(operation === "set" ? { value: operand } : { amount: operand })
            })
          );
          return result.value;
        }
      }),
      links: Object.freeze({
        async default(_featureId, targetPlatform) {
          const result = await getIntegrationDefaultLink(env, {
            sourceGroup: invocation.origin.group,
            targetPlatform
          });
          return result.defaultLink;
        }
      }),
      state: Object.freeze({
        async get(featureId, key) {
          const result = await storageRequest(
            env,
            invocation,
            "state/get",
            input(featureId, { key })
          );
          return result.value;
        },
        async set(featureId, key, value) {
          await storageRequest(
            env,
            invocation,
            "state/set",
            input(featureId, { key, value })
          );
        },
        async delete(featureId, key) {
          const result = await storageRequest(
            env,
            invocation,
            "state/delete",
            input(featureId, { key })
          );
          return result.deleted;
        },
        async increment(featureId, key, amount = 1) {
          const result = await storageRequest(
            env,
            invocation,
            "state/increment",
            input(featureId, { key, amount })
          );
          return result.value;
        },
        async boundedCounter(featureId, descriptor, operation, operand) {
          const result = await storageRequest(
            env,
            invocation,
            "state/bounded-counter",
            input(featureId, {
              ...descriptor,
              operation,
              ...(operation === "set" ? { value: operand } : { amount: operand })
            })
          );
          return result.value;
        }
      })
    }),
    async claimFeatureCooldown({ featureId, actionKind, scopeKey, seconds }) {
      return await storageRequest(env, invocation, "cooldown/claim", {
        featureId,
        actionKind,
        scopeKey,
        seconds
      });
    }
  });
}

export async function setFeatureConfig(env, invocation, featureId, key, value) {
  await storageRequest(env, invocation, "config/set", { featureId, key, value });
}

export async function deleteFeatureConfig(env, invocation, featureId, key) {
  const result = await storageRequest(
    env,
    invocation,
    "config/delete",
    { featureId, key }
  );
  return result.deleted;
}

export async function getFeatureConfig(env, invocation, featureId, key) {
  const result = await storageRequest(
    env,
    invocation,
    "config/get",
    { featureId, key }
  );
  return result.value;
}
