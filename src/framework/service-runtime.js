import { FEATURE_STORAGE_PATH_PREFIX } from "./feature-storage.js";

export const FEATURE_RUNTIME_SERVICES = Object.freeze([
  "config",
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
