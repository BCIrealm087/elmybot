import { env, runInDurableObject } from "cloudflare:test";
import { featureRegistry } from "../../src/features/index.js";
import { executeAction, createActionRegistry } from "../../src/actions/registry.js";
import { createFeatureServiceRuntime } from "../../src/framework/service-runtime.js";
import { createCommandInvocation, createPlatformGroupRef } from "../../src/integrations/contracts.js";
import { integrationRegistryStub } from "../../src/integrations/registry-client.js";
import { resolveStateEventSharedRoute } from "../../src/state-events/shared-publication.js";
import { issueDurableEventGrant } from "../../src/durable-events/grant-client.js";
import { durableEventInternalHeaders } from "../../src/durable-events/stream.js";
import { evaluateStateQuery } from "../../src/state-querying/evaluator.js";

let serial = 0;
const fixtures = new Set();
export async function cleanupNativeHealthFixtures() {
  for (const f of fixtures) await f.close();
  fixtures.clear();
}

// Installed declarations and native bindings, including the real registry
// singleton. Apart from an optional activation-flag override, no forwarding
// binding, per-hop runInDurableObject, env injection,
// declaration replacement, forced due date or manual drain in the measured path.
// Permission authorization is supplied at the action boundary, not simulated as
// a Discord/Twitch HTTP signature. Control operations are counted separately.
export async function nativeHealthFixture({ linked = false, immediate = false, platform = "discord" } = {}) {
  const suffix = `${Date.now()}${++serial}`;
  const discord = createPlatformGroupRef({ platform: "discord", kind: "guild", id: `${suffix}1` });
  const twitch = createPlatformGroupRef({ platform: "twitch", kind: "channel", id: `${suffix}2` });
  const registryStub = integrationRegistryStub(env), sockets = new Set(), owners = new Set();
  const originStubs = [discord, twitch].map((g) => env.CONFIG.get(env.CONFIG.idFromName(g.key)));
  let controlCalls = 0;
  async function control(stub, operation) { controlCalls++; return runInDurableObject(stub, operation); }
  if (linked) {
    const integrationId = crypto.randomUUID();
    // Seed only the integration record before measurement; real default-link
    // requests perform the production binding transitions. No instance mutation.
    await control(registryStub, (_i, state) => {
      const now = Date.now();
      state.storage.sql.exec(`INSERT INTO integrations (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
        created_by_platform, created_by_actor_id, completed_by_platform, completed_by_actor_id, shareable_state_generation)
        VALUES (?, 'active', ?, ?, ?, 'discord', 'operator', 'twitch', 'operator', 1)`, integrationId, now, now, now);
      for (const g of [discord, twitch]) state.storage.sql.exec(`INSERT INTO integration_members
        (integration_id, group_key, platform, group_kind, group_id, joined_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      integrationId, g.key, g.platform, g.kind, g.id, now);
    });
    for (const [sourceGroup, targetGroup] of [[discord, twitch], [twitch, discord]]) {
      const response = await registryStub.fetch("https://registry/default-links/set", { method: "POST", body: JSON.stringify({
        sourceGroup, targetGroup, integrationId, actor: { platform: sourceGroup.platform, id: "operator", claims: [] }
      }) });
      if (!response.ok) throw Error(`Native default-link setup failed (${response.status})`);
    }
  }
  const routeFor = (group) => resolveStateEventSharedRoute(env, { sourceGroup: group,
    targetPlatform: group.platform === "discord" ? "twitch" : "discord", featureId: "fun.health", namespaceId: "health", schemaVersion: 1,
    stream: featureRegistry.eventStreams["fun.health:impacts:v2"].definition });
  const group = platform === "twitch" ? twitch : discord;
  const route = await routeFor(group), otherRoute = await routeFor(platform === "twitch" ? discord : twitch);
  const ownerStub = env.SHAREABLE_STATE_REALM.get(env.SHAREABLE_STATE_REALM.idFromName(route.key));
  owners.add(ownerStub);
  const otherOwner = env.SHAREABLE_STATE_REALM.get(env.SHAREABLE_STATE_REALM.idFromName(otherRoute.key));
  owners.add(otherOwner);
  const streamStub = env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(route.streamRouteId));
  // Activation coverage changes only this optional operational flag. Every
  // service binding remains the native binding; no forwarding or per-hop setup.
  if (immediate) for (const stub of [...owners, streamStub]) {
    await control(stub, (instance) => {
      instance.env = { ...instance.env, STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED: "true" };
    });
  }
  const actionRegistry = createActionRegistry(featureRegistry.actions);
  function invocation(group = platform === "twitch" ? twitch : discord, args = { operation: "damage", amount: 1 }) {
    return createCommandInvocation({ kind: "fun.health.impact.v2", args, sourceCreatedAtMs: Date.now(),
      sourceEventId: `${group.platform}:native-health:${suffix}:${++serial}`,
      origin: { group, actor: { platform: group.platform, id: "operator", claims: [] } } });
  }
  const command = (input = invocation()) => executeAction(actionRegistry, input, {
    ...createFeatureServiceRuntime(env, input, featureRegistry), authorize: async () => true
  });
  async function read(group = platform === "twitch" ? twitch : discord) {
    const result = await evaluateStateQuery(featureRegistry, { version: 1, target: { platform: group.platform, groupId: group.id },
      bindings: { current: { read: { feature: "fun.health", export: "current", version: 1 } } }, select: { health: { ref: "current" } }
    }, { env });
    if (result.envelope.status !== "ready") throw Error("Native health snapshot unavailable");
    return result.envelope.data.health;
  }
  async function openSocket() {
    const { grant } = await issueDurableEventGrant(env, featureRegistry, {
      target: { platform: group.platform, groupId: group.id }, stream: "fun.health:impacts:v2", expiresInSeconds: 600
    }, { actor: { platform: group.platform, id: "operator" } });
    const response = await streamStub.fetch("https://stream/internal/events/socket", { method: "GET", headers: {
      ...durableEventInternalHeaders, upgrade: "websocket", "x-elmybot-durable-event-grant": grant.id,
      "x-elmybot-durable-event-platform": group.platform, "x-elmybot-durable-event-group": group.id,
      "x-elmybot-durable-event-route": route.streamRouteId
    } });
    if (response.status !== 101) throw Error(`Native socket setup failed (${response.status})`);
    response.webSocket.accept(); sockets.add(response.webSocket); return response.webSocket;
  }
  const nativeObjects = [[registryStub, "INTEGRATION_REGISTRY"], ...originStubs.map((stub) => [stub, "CONFIG"]),
    ...[...owners].map((stub) => [stub, "SHAREABLE_STATE_REALM"]), [streamStub, "DURABLE_EVENT_STREAM"]];
  const f = { discord, twitch, group, nativeObjects, route, otherRoute, ownerStub, streamStub, registryStub, invocation, command, read, openSocket,
    get controlCalls() { return controlCalls; },
    rows(stub, table) { return control(stub, (_i, state) => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()); },
    async close() {
      for (const socket of sockets) socket.close(); sockets.clear();
      for (const stub of [...originStubs, ...owners, streamStub, registryStub]) {
        await control(stub, (_i, state) => state.storage.deleteAlarm());
      }
    } };
  fixtures.add(f);
  return f;
}
