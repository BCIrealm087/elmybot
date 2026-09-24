import {
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  shareableStateRealmObjectName
} from "../shareable-state/index.js";
import {
  integrationRegistryStub,
  resolveEffectiveShareableStateRealm
} from "../integrations/registry-client.js";
import {
  DURABLE_EVENT_CODES,
  DURABLE_EVENT_LIMITS,
  durableEventError,
  durableEventId,
  durableEventRouteId,
  DurableEventError,
  serializeDurableEventPayload,
  sha256Hex
} from "./contract.js";
import { DURABLE_EVENT_LEDGER_PATH } from "./source-ledger.js";
import {
  DURABLE_EVENT_APPEND_PATH,
  durableEventInternalHeaders
} from "./stream.js";

const TERMINAL_REJECTIONS = new Set([
  DURABLE_EVENT_CODES.consumerUnavailable,
  DURABLE_EVENT_CODES.streamFull,
  DURABLE_EVENT_CODES.gapRequiresReset,
  DURABLE_EVENT_CODES.payloadInvalid
]);

function enabled(env) {
  return env?.DURABLE_EVENT_STREAMS_ENABLED === "true";
}

function deploymentEnvironment(env) {
  const value = env?.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 503 });
  }
  return value;
}

function declaration(registry, featureId, streamId) {
  const matches = Object.values(registry?.eventStreams ?? {}).filter((entry) =>
    entry.featureId === featureId && entry.definition.id === streamId
  );
  if (matches.length !== 1) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 500 });
  }
  return matches[0].definition;
}

async function checkedJson(response) {
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, {
      status: 502,
      cause
    });
  }
  if (!response.ok) {
    throw durableEventError(
      Object.values(DURABLE_EVENT_CODES).includes(body?.code)
        ? body.code
        : DURABLE_EVENT_CODES.serviceUnavailable,
      { status: response.status }
    );
  }
  return body;
}

function groupConfigStub(env, invocation) {
  if (!env?.CONFIG) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 503 });
  }
  return env.CONFIG.get(env.CONFIG.idFromName(invocation.origin.group.key));
}

async function ledgerRequest(env, invocation, operation, input) {
  return checkedJson(await groupConfigStub(env, invocation).fetch(
    `https://config${DURABLE_EVENT_LEDGER_PATH}/${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": invocation.correlationId
      },
      body: JSON.stringify(input)
    }
  ));
}

function streamStub(env, routeId) {
  if (!env?.DURABLE_EVENT_STREAM) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 503 });
  }
  return env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(routeId));
}

async function appendToStream(env, input) {
  if (input.route.binding) {
    return checkedJson(await integrationRegistryStub(env).fetch(
      "https://integration-registry/durable-events/append",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceGroup: input.route.binding.sourceGroup,
          targetPlatform: input.route.binding.targetPlatform,
          expectedRevision: input.route.binding.revision,
          expectedSourceKey: input.route.binding.sourceKey,
          expiresAtMs: Date.now() + DURABLE_EVENT_LIMITS.receiptRetentionMs,
          environment: deploymentEnvironment(env),
          append: input
        })
      }
    ));
  }
  return checkedJson(await streamStub(env, input.route.routeId).fetch(
    `https://durable-event-stream${DURABLE_EVENT_APPEND_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...durableEventInternalHeaders
      },
      body: JSON.stringify(input)
    }
  ));
}

async function effectiveRoute(env, invocation, featureId, stream) {
  let result;
  try {
    result = await resolveEffectiveShareableStateRealm(env, {
      sourceGroup: invocation.origin.group,
      targetPlatform: stream.targetPlatform,
      correlationId: invocation.correlationId
    });
  } catch (cause) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409, cause });
  }
  if (!Number.isSafeInteger(result?.bindingRevision) || result.bindingRevision < 0) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
  }
  let realm;
  try {
    realm = result.defaultLink === null
      ? createStandaloneRealmIdentity(
          result.standaloneRealm?.ownerGroup,
          { generation: result.standaloneRealm?.generation }
        )
      : createIntegrationRealmIdentity(
          result.defaultLink?.integration,
          { generation: result.defaultLink?.integration?.shareableStateGeneration ?? 1 }
        );
  } catch (cause) {
    throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409, cause });
  }
  const realmIdentity = shareableStateRealmObjectName(realm);
  const descriptor = Object.freeze({
    deploymentEnvironment: deploymentEnvironment(env),
    scopeKind: "effective_shareable",
    realmIdentity,
    featureId,
    streamId: stream.definition.id,
    version: stream.definition.version
  });
  return Object.freeze({
    routeId: await durableEventRouteId(descriptor),
    bindingRevision: result.bindingRevision,
    binding: Object.freeze({
      sourceGroup: invocation.origin.group,
      targetPlatform: stream.targetPlatform,
      revision: result.bindingRevision,
      sourceKey: realmIdentity
    }),
    descriptor
  });
}

async function localRoute(env, invocation, featureId, definition) {
  const descriptor = Object.freeze({
    deploymentEnvironment: deploymentEnvironment(env),
    scopeKind: "group_local",
    realmIdentity: invocation.origin.group.key,
    featureId,
    streamId: definition.id,
    version: definition.version
  });
  return Object.freeze({
    routeId: await durableEventRouteId(descriptor),
    bindingRevision: 0,
    descriptor
  });
}

function safeReceipt() {
  return Object.freeze({ accepted: true });
}

async function publishAccepted(
  env,
  invocation,
  definition,
  eventId,
  fingerprint,
  serialized,
  route
) {
  try {
    const receipt = await appendToStream(env, {
      eventId,
      fingerprint,
      featureId: route.descriptor.featureId,
      streamId: definition.id,
      version: definition.version,
      route,
      payload: serialized
    });
    await ledgerRequest(env, invocation, "finalize", {
      eventId,
      fingerprint,
      state: "committed",
      receipt: {
        sequence: receipt.sequence,
        acceptedAtMs: receipt.acceptedAtMs
      }
    });
    return safeReceipt();
  } catch (cause) {
    if (cause instanceof DurableEventError && TERMINAL_REJECTIONS.has(cause.code)) {
      await ledgerRequest(env, invocation, "finalize", {
        eventId,
        fingerprint,
        state: "rejected",
        code: cause.code
      });
    }
    throw cause;
  }
}

async function publish(
  env,
  invocation,
  featureId,
  definition,
  initialRoute,
  payload,
  resolveAfterTransition = null
) {
  const normalized = serializeDurableEventPayload(payload, definition.payload.schema);
  const eventId = await durableEventId({
    featureId,
    streamId: definition.id,
    version: definition.version,
    originGroupKey: invocation.origin.group.key,
    sourceEventId: invocation.sourceEventId
  });
  const fingerprint = await sha256Hex(normalized.serialized);
  const prepared = await ledgerRequest(env, invocation, "prepare", {
    eventId,
    fingerprint,
    featureId,
    streamId: definition.id,
    version: definition.version,
    route: initialRoute,
    payload: normalized.serialized
  });
  if (prepared.state === "committed") return safeReceipt();
  if (prepared.state === "rejected") {
    throw durableEventError(prepared.code, {
      status: prepared.code === DURABLE_EVENT_CODES.streamFull ? 429 : 409
    });
  }
  try {
    return await publishAccepted(
      env,
      invocation,
      definition,
      eventId,
      fingerprint,
      normalized.serialized,
      prepared.route
    );
  } catch (cause) {
    if (
      !(cause instanceof DurableEventError) ||
      cause.code !== DURABLE_EVENT_CODES.transition ||
      typeof resolveAfterTransition !== "function"
    ) {
      throw cause;
    }
    const nextRoute = await resolveAfterTransition();
    if (
      nextRoute.routeId === prepared.route.routeId &&
      nextRoute.bindingRevision === prepared.route.bindingRevision
    ) throw cause;
    const repinned = await ledgerRequest(env, invocation, "repin", {
      eventId,
      fingerprint,
      previousRouteId: prepared.route.routeId,
      route: nextRoute
    });
    if (repinned.state === "committed") return safeReceipt();
    if (repinned.state === "rejected") {
      throw durableEventError(repinned.code, { status: 409 });
    }
    return await publishAccepted(
      env,
      invocation,
      definition,
      eventId,
      fingerprint,
      normalized.serialized,
      repinned.route
    );
  }
}

function requireDefinition(registry, invocation, featureId, streamId, scopeKind) {
  const definition = declaration(registry, featureId, streamId);
  if (
    definition.scope.kind !== scopeKind ||
    !definition.platforms.includes(invocation.origin.group.platform)
  ) {
    throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 422 });
  }
  return definition;
}

export function createDurableEventStreamRuntime(env, invocation, registry) {
  return Object.freeze({
    async local(featureId, streamId) {
      if (!enabled(env)) {
        throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 503 });
      }
      const definition = requireDefinition(
        registry,
        invocation,
        featureId,
        streamId,
        "group_local"
      );
      const route = await localRoute(env, invocation, featureId, definition);
      return Object.freeze({
        publish: async (payload) => publish(
          env,
          invocation,
          featureId,
          definition,
          route,
          payload
        )
      });
    },
    async current(featureId, targetPlatform, streamId) {
      if (!enabled(env)) {
        throw durableEventError(DURABLE_EVENT_CODES.serviceUnavailable, { status: 503 });
      }
      const definition = requireDefinition(
        registry,
        invocation,
        featureId,
        streamId,
        "effective_shareable"
      );
      const route = await effectiveRoute(env, invocation, featureId, {
        definition,
        targetPlatform
      });
      return Object.freeze({
        publish: async (payload) => publish(
          env,
          invocation,
          featureId,
          definition,
          route,
          payload,
          async () => await effectiveRoute(env, invocation, featureId, {
            definition,
            targetPlatform
          })
        )
      });
    }
  });
}
