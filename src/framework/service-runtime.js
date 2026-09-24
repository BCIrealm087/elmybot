import {
  FEATURE_STORAGE_PATH_PREFIX,
  INTEGRATION_FEATURE_STATE_PATH_PREFIX
} from "./feature-storage.js";
import { integrationCoordinatorStub } from "../integrations/coordinator-client.js";
import {
  getIntegrationById,
  getIntegrationDefaultLink,
  resolveEffectiveShareableStateRealm
} from "../integrations/registry-client.js";
import {
  createIntegrationRef,
  createPlatformGroupRef
} from "../integrations/contracts.js";
import {
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  requestShareableStateRealm,
  shareableStateRealmObjectName,
  ShareableStateRealmError
} from "../shareable-state/index.js";

export const FEATURE_RUNTIME_SERVICES = Object.freeze([
  "authorization",
  "config",
  "integrationState",
  "links",
  "shareableState",
  "state",
  "eventStreams",
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

function normalizedDefaultLink(value, invocation, targetPlatform) {
  let integration;
  let sourceGroup;
  let targetGroup;
  try {
    const reference = createIntegrationRef(value?.integration);
    const shareableStateGeneration =
      value?.integration?.shareableStateGeneration ?? 1;
    if (
      !Number.isSafeInteger(shareableStateGeneration) ||
      shareableStateGeneration < 1
    ) {
      throw new TypeError("Invalid shareable-state generation.");
    }
    integration = Object.freeze({ ...reference, shareableStateGeneration });
    sourceGroup = createPlatformGroupRef(value?.sourceGroup);
    targetGroup = createPlatformGroupRef(value?.targetGroup);
  } catch (cause) {
    throw new FeatureServiceRuntimeError(
      "Default-link resolution returned an invalid shareable-state owner.",
      { code: "shareable_state_resolution_invalid", status: 502, cause }
    );
  }
  if (
    sourceGroup.key !== invocation.origin.group.key ||
    targetGroup.platform !== targetPlatform
  ) {
    throw new FeatureServiceRuntimeError(
      "Default-link resolution returned an invalid shareable-state owner.",
      { code: "shareable_state_resolution_invalid", status: 502 }
    );
  }
  return Object.freeze({ integration, sourceGroup, targetGroup });
}

async function resolveShareableState(
  env,
  invocation,
  featureId,
  targetPlatform,
  namespaceId
) {
  const result = await resolveEffectiveShareableStateRealm(env, {
    sourceGroup: invocation.origin.group,
    targetPlatform,
    correlationId: invocation.correlationId
  });
  if (
    !Number.isSafeInteger(result?.bindingRevision) ||
    result.bindingRevision < 0
  ) {
    throw new FeatureServiceRuntimeError(
      "Shareable-state resolution returned an invalid binding revision.",
      { code: "shareable_state_resolution_invalid", status: 502 }
    );
  }
  if (result.defaultLink === null) {
    let realm;
    try {
      realm = createStandaloneRealmIdentity(
        result.standaloneRealm?.ownerGroup,
        { generation: result.standaloneRealm?.generation }
      );
    } catch (cause) {
      throw new FeatureServiceRuntimeError(
        "Shareable-state resolution returned an invalid standalone owner.",
        { code: "shareable_state_resolution_invalid", status: 502, cause }
      );
    }
    if (realm.ownerGroup.key !== invocation.origin.group.key) {
      throw new FeatureServiceRuntimeError(
        "Shareable-state resolution returned an invalid standalone owner.",
        { code: "shareable_state_resolution_invalid", status: 502 }
      );
    }
    return Object.freeze({
      featureId,
      namespaceId,
      targetPlatform,
      bindingRevision: result.bindingRevision,
      realm
    });
  }
  const link = normalizedDefaultLink(
    result.defaultLink,
    invocation,
    targetPlatform
  );
  return Object.freeze({
    featureId,
    namespaceId,
    targetPlatform,
    bindingRevision: result.bindingRevision,
    realm: createIntegrationRealmIdentity(link.integration, {
      generation: link.integration.shareableStateGeneration ?? 1
    }),
    link
  });
}

async function requireWritableShareableStateScope(env, invocation, scope) {
  if (scope.realm.kind === "standalone") {
    let current;
    try {
      current = await resolveEffectiveShareableStateRealm(env, {
        sourceGroup: invocation.origin.group,
        targetPlatform: scope.targetPlatform,
        correlationId: invocation.correlationId
      });
    } catch (cause) {
      throw new FeatureServiceRuntimeError(
        "The selected standalone shareable state is transitioning.",
        { code: "shareable_state_transition", status: 409, cause }
      );
    }
    if (
      current.defaultLink !== null ||
      shareableStateRealmObjectName(current.standaloneRealm) !==
        shareableStateRealmObjectName(scope.realm)
    ) {
      throw new FeatureServiceRuntimeError(
        "The selected standalone shareable state is no longer current.",
        { code: "shareable_state_transition", status: 409 }
      );
    }
    return;
  }
  let result;
  try {
    result = await getIntegrationById(env, scope.link.integration.id);
  } catch (cause) {
    throw new FeatureServiceRuntimeError(
      "The selected shareable-state integration is unavailable.",
      { code: "shareable_state_transition", status: 409, cause }
    );
  }
  const memberKeys = new Set(
    result?.integration?.members?.map((member) => member.group.key) ?? []
  );
  if (
    result?.integration?.status !== "active" ||
    result.integration.shareableStateGeneration !== scope.realm.generation ||
    !memberKeys.has(invocation.origin.group.key) ||
    !memberKeys.has(scope.link.targetGroup.key)
  ) {
    throw new FeatureServiceRuntimeError(
      "The selected shareable-state integration is no longer writable.",
      { code: "shareable_state_transition", status: 409 }
    );
  }
}

async function shareableStateRequest(
  env,
  invocation,
  resolvedScopes,
  featureId,
  scope,
  operation,
  storage
) {
  if (!resolvedScopes.has(scope) || scope.featureId !== featureId) {
    throw new FeatureServiceRuntimeError(
      "Shareable state requires a realm resolved by this invocation.",
      { code: "shareable_state_scope_invalid", status: 403 }
    );
  }
  await requireWritableShareableStateScope(env, invocation, scope);
  try {
    return await requestShareableStateRealm(env, {
      realm: scope.realm,
      featureId,
      namespaceId: scope.namespaceId,
      operation,
      storage,
      correlationId: invocation.correlationId
    });
  } catch (cause) {
    if (cause instanceof ShareableStateRealmError) {
      throw new FeatureServiceRuntimeError(cause.message, {
        code: cause.code,
        status: cause.status,
        cause
      });
    }
    throw cause;
  }
}

export function createFeatureServiceRuntime(env, invocation) {
  const input = (featureId, values = {}) => ({ featureId, ...values });
  const resolvedShareableStateScopes = new WeakSet();
  const shareableRequest = async (
    featureId,
    scope,
    operation,
    storage
  ) => await shareableStateRequest(
    env,
    invocation,
    resolvedShareableStateScopes,
    featureId,
    scope,
    operation,
    storage
  );
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
      shareableState: Object.freeze({
        async current(featureId, targetPlatform, namespaceId) {
          const scope = await resolveShareableState(
            env,
            invocation,
            featureId,
            targetPlatform,
            namespaceId
          );
          resolvedShareableStateScopes.add(scope);
          return scope;
        },
        async get(featureId, scope, key) {
          const result = await shareableRequest(featureId, scope, "get", { key });
          return result.value;
        },
        async queryRead(featureId, scope, key) {
          return await shareableRequest(featureId, scope, "query-read", { key });
        },
        async revision(featureId, scope) {
          const result = await shareableRequest(featureId, scope, "revision", {});
          return result.mutationVersion;
        },
        async set(featureId, scope, key, value) {
          await shareableRequest(featureId, scope, "set", { key, value });
        },
        async delete(featureId, scope, key) {
          const result = await shareableRequest(featureId, scope, "delete", { key });
          return result.deleted;
        },
        async increment(featureId, scope, key, amount = 1) {
          const result = await shareableRequest(
            featureId,
            scope,
            "increment",
            { key, amount }
          );
          return result.value;
        },
        async boundedCounter(featureId, scope, descriptor, operation, operand) {
          const result = await shareableRequest(
            featureId,
            scope,
            "bounded-counter",
            {
              ...descriptor,
              operation,
              ...(operation === "set" ? { value: operand } : { amount: operand })
            }
          );
          return result.value;
        },
        async boundedCounterSubjects(featureId, scope, name) {
          return await shareableRequest(
            featureId,
            scope,
            "bounded-counter-subjects",
            { name }
          );
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
        async queryRead(featureId, key) {
          return await storageRequest(
            env,
            invocation,
            "state/query-read",
            input(featureId, { key })
          );
        },
        async revision(featureId) {
          const result = await storageRequest(
            env,
            invocation,
            "state/revision",
            input(featureId)
          );
          return result.mutationVersion;
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
        },
        async boundedCounterSubjects(featureId, name) {
          return await storageRequest(
            env,
            invocation,
            "state/bounded-counter-subjects",
            input(featureId, { name })
          );
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
