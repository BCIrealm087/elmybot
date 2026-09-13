import { createPlatformGroupRef } from "../integrations/contracts.js";
import {
  getStateQueryBinding as getRegistryStateQueryBinding,
  registerStateQueryBindingWatcher as registerRegistryStateQueryBindingWatcher,
  unregisterStateQueryBindingWatcher as unregisterRegistryStateQueryBindingWatcher
} from "../integrations/registry-client.js";
import {
  requestShareableStateRealm,
  shareableStateRealmObjectName
} from "../shareable-state/index.js";
import { stateQueryEnvironment } from "./grant-client.js";
import { STATE_QUERY_OBSERVER_PATHS } from "./observer.js";
import {
  STATE_QUERY_NOTIFICATION_LIMITS,
  STATE_QUERY_SOURCE_WATCH_PATH,
  StateQueryNotificationError,
  stateQueryObserverObjectName
} from "./source-notifications.js";

function group(value) {
  return createPlatformGroupRef({
    platform: value?.platform,
    kind: value?.platform === "discord" ? "guild" : "channel",
    id: value?.groupId ?? value?.id
  });
}

function checkedWatcherInput(env, input) {
  const watcherId = input?.watcherId;
  const expectedRevision = input?.expectedRevision;
  const leaseSeconds = input?.leaseSeconds ??
    STATE_QUERY_NOTIFICATION_LIMITS.defaultLeaseSeconds;
  if (typeof watcherId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(watcherId)) {
    throw new StateQueryNotificationError("Watcher ID is invalid.");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new StateQueryNotificationError("Watcher expected revision is invalid.");
  }
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < STATE_QUERY_NOTIFICATION_LIMITS.minLeaseSeconds ||
    leaseSeconds > STATE_QUERY_NOTIFICATION_LIMITS.maxLeaseSeconds
  ) {
    throw new StateQueryNotificationError("Watcher lease is invalid.");
  }
  const target = group(input.target);
  return {
    watcherId,
    expectedRevision,
    leaseSeconds,
    environment: stateQueryEnvironment(env),
    target: { platform: target.platform, groupId: target.id }
  };
}

async function checkedResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw new StateQueryNotificationError("State watcher returned an invalid response.", {
      status: 502,
      code: "state_query_notification_invalid_response",
      cause
    });
  }
  if (!response.ok) {
    throw new StateQueryNotificationError(
      result?.error ?? result?.userFacingError ?? "State watcher request failed.",
      {
        status: response.status,
        code: result?.code ?? "state_query_notification_request_failed"
      }
    );
  }
  return result;
}

function localSourceStub(env, sourceGroup) {
  if (!env?.CONFIG) {
    throw new StateQueryNotificationError("Local state storage is unavailable.", {
      status: 503,
      code: "state_query_notification_source_unavailable"
    });
  }
  return env.CONFIG.get(env.CONFIG.idFromName(sourceGroup.key));
}

async function localWatcherRequest(env, operation, input) {
  const sourceGroup = group(input.sourceGroup);
  const normalized = checkedWatcherInput(env, input);
  return await checkedResponse(await localSourceStub(env, sourceGroup).fetch(
    `https://group-config${STATE_QUERY_SOURCE_WATCH_PATH}${operation}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...normalized,
        featureId: input.featureId,
        source: {
          kind: "group_local",
          key: sourceGroup.key,
          target: { platform: sourceGroup.platform, groupId: sourceGroup.id }
        }
      })
    }
  ));
}

export async function registerLocalStateQueryWatcher(env, input) {
  return await localWatcherRequest(env, "register", input);
}

export async function unregisterLocalStateQueryWatcher(env, input) {
  return await localWatcherRequest(env, "unregister", {
    expectedRevision: 0,
    ...input
  });
}

async function shareableWatcherRequest(env, operation, input) {
  const normalized = checkedWatcherInput(env, input);
  return await requestShareableStateRealm(env, {
    realm: input.realm,
    featureId: input.featureId,
    namespaceId: input.namespaceId,
    operation: `watch-${operation}`,
    storage: {
      ...normalized,
      source: {
        kind: "shareable",
        key: shareableStateRealmObjectName(input.realm)
      }
    },
    correlationId: input.correlationId
  });
}

export async function registerShareableStateQueryWatcher(env, input) {
  return await shareableWatcherRequest(env, "register", input);
}

export async function unregisterShareableStateQueryWatcher(env, input) {
  return await shareableWatcherRequest(env, "unregister", {
    expectedRevision: 0,
    ...input
  });
}

function bindingWatcherInput(env, input) {
  const sourceGroup = group(input.sourceGroup);
  const normalized = checkedWatcherInput(env, { ...input, target: sourceGroup });
  return {
    sourceGroup,
    targetPlatform: input.targetPlatform,
    ...normalized
  };
}

export async function getStateQueryBinding(env, input) {
  return await getRegistryStateQueryBinding(env, {
    sourceGroup: group(input.sourceGroup),
    targetPlatform: input.targetPlatform
  });
}

export async function registerStateQueryBindingWatcher(env, input) {
  return await registerRegistryStateQueryBindingWatcher(
    env,
    bindingWatcherInput(env, input)
  );
}

export async function unregisterStateQueryBindingWatcher(env, input) {
  return await unregisterRegistryStateQueryBindingWatcher(env, {
    ...bindingWatcherInput(env, { expectedRevision: 0, ...input }),
    expectedRevision: 0
  });
}

function observerStub(env, target) {
  if (!env?.STATE_QUERY_OBSERVER) {
    throw new StateQueryNotificationError("State-query observer is unavailable.", {
      status: 503,
      code: "state_query_observer_unavailable"
    });
  }
  const normalizedTarget = group(target);
  const environment = stateQueryEnvironment(env);
  const observerKey = stateQueryObserverObjectName(environment, normalizedTarget);
  return env.STATE_QUERY_OBSERVER.get(env.STATE_QUERY_OBSERVER.idFromName(observerKey));
}

async function observerRequest(env, target, path, body) {
  return await checkedResponse(await observerStub(env, target).fetch(
    `https://state-query-observer${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  ));
}

export async function listStateQueryNotifications(env, target, { limit = 100 } = {}) {
  return await observerRequest(env, target, STATE_QUERY_OBSERVER_PATHS.list, { limit });
}

export async function acknowledgeStateQueryNotifications(env, target, ids) {
  return await observerRequest(env, target, STATE_QUERY_OBSERVER_PATHS.acknowledge, { ids });
}
