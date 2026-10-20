import { env, runInDurableObject } from "cloudflare:test";
import { defineAction, defineReadableStateExport, defineDurableEventStream, defineFeature, defineStateEventOperation, discordActionCommand, frameworkApiVersion, schema } from "../../src/framework/index.js";
import { createFeatureRegistry } from "../../src/framework/feature-registry.js";
import { prepareStateEventOperation } from "../../src/framework/state-event-operation.js";
import { createCommandInvocation, createPlatformGroupRef } from "../../src/integrations/contracts.js";
import { createStateEventIdentity } from "../../src/state-events/identity.js";
import { prepareStateEventOrigin } from "../../src/state-events/storage.js";
import { commitLocalStateEvent } from "../../src/state-events/local-commit.js";
import { resolveStateEventSharedRoute, commitPreparedSharedStateEvent } from "../../src/state-events/shared-publication.js";
import { durableEventRouteId } from "../../src/durable-events/contract.js";
import { durableEventInternalHeaders } from "../../src/durable-events/stream.js";
import { STATE_EVENT_DELIVERY_HEADERS } from "../../src/state-events/delivery-source.js";

let sequence = 0;
export const objects = new Map();
const sockets = new Set();
export async function cleanupDeliveryFixtures() {
  for (const socket of sockets) socket.close();
  sockets.clear();
  for (const { kind, id } of objects.values()) await runInDurableObject(env[kind].get(id), (_i, state) => state.storage.deleteAlarm());
  objects.clear();
}
export async function deliveryFixture({ shared = false, streams = 1, suppressLocalCommitAlarm = false, bounded = false, payloadPadding = "" } = {}) {
  const featureId = "test.delivery", scope = shared ? { kind: "effective_shareable", namespace: "health" } : { kind: "group_local" };
  const entries = Array.from({ length: streams }, (_, index) => {
    const suffix = index ? `-${index}` : "";
    const operation = defineStateEventOperation({ id: `change${suffix}`, scope, stream: { id: `impacts${suffix}`, version: 2 }, input: schema.object({}),
      mutation: bounded ? { kind: "bounded_counter", name: "health", subject: { literal: "current" }, min: 0, max: 1, initial: 1, operation: "increment", amount: { literal: 1 } }
        : { kind: "increment", key: { literal: `health${suffix}` }, amount: { literal: 1 } }, event: {
      value: { result: "after" }, ...(payloadPadding ? { padding: { literal: payloadPadding } } : {}) } });
    const stream = defineDurableEventStream({ id: `impacts${suffix}`, version: 2, label: "Impacts", description: "Test delivery", platforms: ["discord", "twitch"],
      scope: { kind: scope.kind }, publication: { kind: "state_event", source: scope }, access: { kind: "operator_grant" },
      payload: { schema: { type: "object", properties: { value: { type: "integer" }, ...(payloadPadding ? { padding: { type: "string", maxLength: 4096 } } : {}) }, required: ["value", ...(payloadPadding ? ["padding"] : [])] } } });
    const action = defineAction({ kind: `test.delivery.change${suffix}.v1`, supportedOrigins: ["discord"], input: operation.input,
      uses: { services: ["stateEvents"], stateEvents: [operation.id] }, cooldown: { scope: "group", seconds: 1 }, async execute() { throw Error("blocked"); } });
    return { operation, stream, action, name: `change${suffix}` };
  });
  const { stream } = entries[0];
  const registry = createFeatureRegistry([defineFeature({ id: featureId, apiVersion: frameworkApiVersion, description: "Delivery fixture",
    ...(shared ? { shareableState: [{ id: "health", label: "Health", schemaVersion: 1, compatibleVersions: [1], limits: { maxEntries: 100, maxValueBytes: 1024 } }] } : {}),
    readableState: [defineReadableStateExport({ id: "current", version: 1, label: "Current", description: "Current value", kind: "value",
      platforms: ["discord", "twitch"], scope, access: { kind: "operator_grant" }, parameters: {},
      result: { schema: { type: "integer" }, absence: { kind: "default" } },
      async resolve(ctx) { return { state: "present", value: bounded ? await ctx.state.boundedCounter("health", "current", { min: 0, max: 1, initial: 1 }) : (await ctx.state.get("health")).value ?? 0 }; }
    })],
    actions: entries.map((entry) => entry.action), stateEvents: entries.map((entry) => entry.operation), eventStreams: entries.map((entry) => entry.stream),
    commands: { discord: entries.map((entry) => discordActionCommand({ name: entry.name, description: "Change", availability: "guild", actionKind: entry.action.kind })) } })], { availableServices: ["stateEvents"] });
  const group = createPlatformGroupRef({ platform: "discord", kind: "guild", id: `${Date.now()}${++sequence}` });
  const registryId = env.INTEGRATION_REGISTRY.idFromName(`delivery-${group.id}`);
  const ownerBindings = ["CONFIG", "SHAREABLE_STATE_REALM", "DURABLE_EVENT_STREAM"];
  let interceptor = null;
  const tracked = (kind, id) => { objects.set(`${kind}:${id}`, { kind, id }); return env[kind].get(id); };
  const bindings = Object.fromEntries(ownerBindings.map((kind) => [kind, {
    idFromName: (name) => env[kind].idFromName(name), get: (id) => ({ fetch: async (input, init) => {
      await runInDurableObject(tracked(kind, id), (instance) => { instance.env = testEnv; instance.featureRegistry = registry; instance.registry = registry; });
      const send = () => env[kind].get(id).fetch(input, init);
      return interceptor ? interceptor(kind, input, init, send) : send();
    } })
  }]));
  const testEnv = { ...env, ...bindings, INTEGRATION_REGISTRY: { idFromName: () => registryId, get: () => ({ fetch: async (input, init) => {
    const stub = tracked("INTEGRATION_REGISTRY", registryId);
    // The native runtime may evict an idle registry between paced commands.
    // Reinstall fixture bindings on every request, as for the owner/stream.
    await runInDurableObject(stub, (instance) => { instance.env = testEnv; });
    return stub.fetch(input, init);
  } }) } };
  const registryStub = tracked("INTEGRATION_REGISTRY", registryId);
  await runInDurableObject(registryStub, (instance) => { instance.env = testEnv; });
  const route = shared ? await resolveStateEventSharedRoute(testEnv, { sourceGroup: group, targetPlatform: "twitch", featureId, namespaceId: "health", schemaVersion: 1, stream }) : {
    kind: "group_local", key: group.key, bindingRevision: 0, streamRouteId: await durableEventRouteId({ deploymentEnvironment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT,
      scopeKind: "group_local", realmIdentity: group.key, featureId, streamId: stream.id, version: stream.version }) };
  const routes = await Promise.all(entries.map(async (entry) => ({ ...route, streamRouteId: await durableEventRouteId({
    deploymentEnvironment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT, scopeKind: route.kind, realmIdentity: route.key,
    featureId, streamId: entry.stream.id, version: entry.stream.version }) })));
  const owner = { kind: route.kind, key: route.key }, ownerKind = shared ? "SHAREABLE_STATE_REALM" : "CONFIG";
  const ownerStub = tracked(ownerKind, env[ownerKind].idFromName(route.key));
  const streamStubs = routes.map((value) => tracked("DURABLE_EVENT_STREAM", env.DURABLE_EVENT_STREAM.idFromName(value.streamRouteId)));
  const streamStub = streamStubs[0];
  const source = async (path, body = {}) => {
    const response = await bindings[ownerKind].get(env[ownerKind].idFromName(route.key)).fetch(`https://owner/internal/state-events/delivery/${path}`, {
      method: "POST", headers: STATE_EVENT_DELIVERY_HEADERS, body: JSON.stringify({ ...body, owner, routeId: body.routeId ?? route.streamRouteId }) });
    return { status: response.status, data: await response.json() };
  };
  const streamCall = async (path, body = {}, headers = {}) => {
    const response = await bindings.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(body.routeId ?? route.streamRouteId)).fetch(`https://stream/internal/events/${path}`, {
      method: "POST", headers: { ...durableEventInternalHeaders, ...STATE_EVENT_DELIVERY_HEADERS, ...headers },
      body: JSON.stringify({ owner, routeId: route.streamRouteId, ...body }) });
    return { status: response.status, data: await response.json() };
  };
  const commit = async (index = 0) => {
    const { action, operation } = entries[index], selectedRoute = routes[index];
    const invocation = createCommandInvocation({ kind: action.kind, args: {}, sourceCreatedAtMs: Date.now(), sourceEventId: `discord:interaction:${group.id}-${++sequence}`,
      origin: { group, actor: { platform: "discord", id: "actor", claims: [] } } });
    const identity = await createStateEventIdentity({ environment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT, featureId, invocation, declaration: { mutation: operation.mutation, stream: operation.stream } });
    const origin = tracked("CONFIG", env.CONFIG.idFromName(group.key));
    const record = await runInDurableObject(origin, (instance, state) => {
      // A paced local owner may have been evicted since socket setup. Its
      // constructor restores production bindings/declarations; restore this
      // injected fixture before direct commit so alarm delivery uses them too.
      instance.env = testEnv; instance.featureRegistry = registry; instance.registry = registry;
      state.storage.sql.exec("DELETE FROM framework_feature_cooldowns");
      return prepareStateEventOrigin(state, { identity, request: prepareStateEventOperation(operation, {}), route: selectedRoute, cooldownSeconds: 1 });
    });
    const accepted = await runInDurableObject(origin, (_i, state) => {
      const controlled = suppressLocalCommitAlarm ? { id: state.id, storage: new Proxy(state.storage, { get(target, key) {
        if (key === "setAlarm") return async () => {};
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } }) } : state;
      return shared ? commitPreparedSharedStateEvent(state, testEnv, record) : commitLocalStateEvent(controlled, testEnv, registry, record);
    });
    return { ...accepted, operationId: identity.operationId };
  };
  const descriptor = { deploymentEnvironment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT, scopeKind: route.kind,
    realmIdentity: route.key, featureId, streamId: stream.id, version: stream.version };
  const grant = (resetBacklog = false, grantId = crypto.randomUUID()) => ({ grantId, secretDigest: "a".repeat(43),
    actor: { platform: "discord", id: "operator" }, resetBacklog,
    grant: { target: { platform: "discord", groupId: group.id }, stream: { feature: featureId, stream: stream.id, version: stream.version },
      environment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 600_000,
      route: { routeId: route.streamRouteId, bindingRevision: route.bindingRevision, descriptor,
        ...(shared ? { binding: { sourceGroup: group, targetPlatform: "twitch", revision: route.bindingRevision, sourceKey: route.key } } : {}) } } });
  const move = async () => {
    const integrationId = crypto.randomUUID(), twitchId = `${Date.now()}${++sequence}`;
    const target = createPlatformGroupRef({ platform: "twitch", kind: "channel", id: twitchId });
    await runInDurableObject(registryStub, (_i, state) => {
      const now = Date.now();
      state.storage.sql.exec(`INSERT INTO integrations (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
        created_by_platform, created_by_actor_id, completed_by_platform, completed_by_actor_id, shareable_state_generation)
        VALUES (?, 'active', ?, ?, ?, 'discord', 'manager', 'twitch', 'broadcaster', 1)`, integrationId, now, now, now);
      for (const member of [group, target]) state.storage.sql.exec("INSERT INTO integration_members (integration_id, group_key, platform, group_kind, group_id, joined_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        integrationId, member.key, member.platform, member.kind, member.id, now);
    });
    const response = await registryStub.fetch("https://registry/default-links/set", { method: "POST", body: JSON.stringify({ sourceGroup: group,
      targetGroup: target, integrationId, actor: { platform: "discord", id: "manager", claims: [] } }) });
    return { status: response.status, data: await response.json() };
  };
  const openSocket = async (grantId) => {
    const response = await bindings.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(route.streamRouteId)).fetch("https://stream/internal/events/socket", {
      method: "GET", headers: { ...durableEventInternalHeaders, upgrade: "websocket", "x-elmybot-durable-event-grant": grantId,
        "x-elmybot-durable-event-platform": group.platform, "x-elmybot-durable-event-group": group.id, "x-elmybot-durable-event-route": route.streamRouteId } });
    if (response.status !== 101) throw Error(`Socket status ${response.status}`);
    response.webSocket.accept(); sockets.add(response.webSocket); return response.webSocket;
  };
  return { routes, streamStubs, openSocket, move, group, owner, route, testEnv, registry, ownerStub, streamStub, registryStub, source, streamCall, commit, grant,
    intercept(fn) { interceptor = fn; },
    rows(stub, table) { return runInDurableObject(stub, (_i, state) => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()); } };
}
