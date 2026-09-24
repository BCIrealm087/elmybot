import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  defineDurableEventStream,
  defineFeature,
  frameworkApiVersion
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import {
  createCommandInvocation,
  createPlatformGroupRef
} from "../src/integrations/contracts.js";
import {
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  shareableStateRealmObjectName
} from "../src/shareable-state/index.js";
import {
  integrationRegistryStub
} from "../src/integrations/index.js";
import {
  drainDurableEventBindingNotifications
} from "../src/durable-events/binding-notifications.js";
import {
  DURABLE_EVENT_BINDING_PATH,
  DURABLE_EVENT_CONSUMER_PATH,
  durableEventInternalHeaders
} from "../src/durable-events/stream.js";
import {
  durableEventRouteId,
  DURABLE_EVENT_CODES
} from "../src/durable-events/contract.js";

let sequence = 0;
const unique = (prefix) => `${prefix}-event-lifecycle-${++sequence}`;

function group(platform) {
  return createPlatformGroupRef({
    platform,
    kind: platform === "discord" ? "guild" : "channel",
    id: unique(platform)
  });
}

function invocation(originGroup, source = unique("source")) {
  return createCommandInvocation({
    kind: "test.events.publish.v1",
    origin: {
      group: originGroup,
      actor: { platform: originGroup.platform, id: "actor", claims: [] }
    },
    args: {},
    sourceEventId: `${originGroup.platform}:test:${source}`
  });
}

function featureRegistry() {
  return createFeatureRegistry([defineFeature({
    apiVersion: frameworkApiVersion,
    id: "test.events",
    description: "Tests durable event ownership changes.",
    eventStreams: [defineDurableEventStream({
      id: "updates",
      version: 1,
      label: "Updates",
      description: "Lifecycle test updates.",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable" },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: {
            data: { type: "string", minLength: 1, maxLength: 100 }
          },
          required: ["data"]
        }
      }
    })]
  })], { availableServices: ["eventStreams"] });
}

function installIntegration(state, registry, {
  integrationId,
  discord,
  twitch,
  createdAtMs,
  discordDefault = true,
  twitchDefault = true
}) {
  state.storage.sql.exec(
    `INSERT INTO integrations
     (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
      created_by_platform, created_by_actor_id, completed_by_platform,
      completed_by_actor_id, shareable_state_generation)
     VALUES (?, 'active', ?, ?, ?, 'discord', 'manager', 'twitch',
             'broadcaster', 1)`,
    integrationId,
    createdAtMs,
    createdAtMs,
    createdAtMs
  );
  for (const member of [discord, twitch]) {
    state.storage.sql.exec(
      `INSERT INTO integration_members
       (integration_id, group_key, platform, group_kind, group_id, joined_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      integrationId,
      `${member.platform}:${member.kind}:${member.id}`,
      member.platform,
      member.kind,
      member.id,
      createdAtMs
    );
  }
  if (discordDefault) {
    registry.assignDefaultLinkIfAbsent({
      sourceGroup: discord,
      targetGroup: twitch,
      integrationId,
      nowMs: createdAtMs
    });
  }
  if (twitchDefault) {
    registry.assignDefaultLinkIfAbsent({
      sourceGroup: twitch,
      targetGroup: discord,
      integrationId,
      nowMs: createdAtMs
    });
  }
}

async function routeFor(realmIdentity) {
  const descriptor = {
    deploymentEnvironment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT,
    scopeKind: "effective_shareable",
    realmIdentity,
    featureId: "test.events",
    streamId: "updates",
    version: 1
  };
  return { routeId: await durableEventRouteId(descriptor), descriptor };
}

async function configureStream(registry, realmIdentity, { ready = true } = {}) {
  const route = await routeFor(realmIdentity);
  const stub = env.DURABLE_EVENT_STREAM.get(
    env.DURABLE_EVENT_STREAM.idFromName(route.routeId)
  );
  await runInDurableObject(stub, async (instance) => {
    instance.registry = registry;
    if (ready) {
      const response = await instance.fetch(new Request(
        `https://durable-event-stream${DURABLE_EVENT_CONSUMER_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...durableEventInternalHeaders
          },
          body: JSON.stringify({ ready: true })
        }
      ));
      expect(response.ok).toBe(true);
    }
  });
  return { ...route, stub };
}

async function publish(registry, action, data) {
  const runtime = createFeatureServiceRuntime(env, action, registry);
  const target = action.origin.group.platform === "discord" ? "twitch" : "discord";
  const stream = await runtime.featureServices.eventStreams.current(
    "test.events",
    target,
    "updates"
  );
  return await stream.publish({ data });
}

async function integrationRealm(integrationId) {
  return await runInDurableObject(
    integrationRegistryStub(env),
    async (registry) => shareableStateRealmObjectName(createIntegrationRealmIdentity(
      registry.getIntegration(integrationId),
      { generation: 1 }
    ))
  );
}

describe("durable event stream lifecycle ownership", () => {
  it("moves a standalone stream on first selected integration without copying backlog", async () => {
    const registry = featureRegistry();
    const discord = group("discord");
    const twitch = group("twitch");
    const standaloneRealm = shareableStateRealmObjectName(
      createStandaloneRealmIdentity(discord, { generation: 1 })
    );
    const standalone = await configureStream(registry, standaloneRealm);
    await expect(publish(registry, invocation(discord), "standalone"))
      .resolves.toEqual({ accepted: true });

    const integrationId = unique("integration");
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      installIntegration(state, instance, {
        integrationId,
        discord,
        twitch,
        createdAtMs: Date.now()
      });
      await drainDurableEventBindingNotifications(state, env);
    });
    await runInDurableObject(standalone.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT status, reason FROM durable_event_stream_bindings`
      ).one()).toMatchObject({ status: "moved", reason: "integration_activated" });
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(1);
    });

    const selectedRealm = await integrationRealm(integrationId);
    const selected = await configureStream(registry, selectedRealm, { ready: false });
    await expect(publish(registry, invocation(discord), "new-owner"))
      .rejects.toMatchObject({ code: DURABLE_EVENT_CODES.consumerUnavailable });
    await runInDurableObject(selected.stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(0);
    });
  });

  it("shares one ordered physical stream only for symmetric selected defaults", async () => {
    const registry = featureRegistry();
    const discord = group("discord");
    const twitch = group("twitch");
    const integrationId = unique("integration");
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      installIntegration(state, instance, {
        integrationId,
        discord,
        twitch,
        createdAtMs: Date.now()
      });
    });
    const selected = await configureStream(registry, await integrationRealm(integrationId));
    await publish(registry, invocation(discord), "from-discord");
    await publish(registry, invocation(twitch), "from-twitch");
    await runInDurableObject(selected.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT sequence FROM durable_event_stream_events ORDER BY sequence"
      ).toArray().map((row) => Number(row.sequence))).toEqual([1, 2]);
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_bindings"
      ).one().total)).toBe(2);
    });

    const otherTwitch = group("twitch");
    const otherIntegrationId = unique("unselected");
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      installIntegration(state, instance, {
        integrationId: otherIntegrationId,
        discord,
        twitch: otherTwitch,
        createdAtMs: Date.now() + 1,
        discordDefault: false
      });
    });
    await publish(registry, invocation(discord), "still-selected");
    await runInDurableObject(selected.stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(3);
    });
    const asymmetric = await configureStream(
      registry,
      await integrationRealm(otherIntegrationId)
    );
    await publish(registry, invocation(otherTwitch), "asymmetric-direction");
    await runInDurableObject(asymmetric.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT sequence FROM durable_event_stream_events ORDER BY sequence"
      ).toArray().map((row) => Number(row.sequence))).toEqual([1]);
    });
  });

  it("orders A-to-B-to-A movement and ignores a delayed old invalidation", async () => {
    const registry = featureRegistry();
    const discord = group("discord");
    const twitchA = group("twitch");
    const twitchB = group("twitch");
    const integrationA = unique("integration-a");
    const integrationB = unique("integration-b");
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      installIntegration(state, instance, {
        integrationId: integrationA,
        discord,
        twitch: twitchA,
        createdAtMs: 1
      });
      installIntegration(state, instance, {
        integrationId: integrationB,
        discord,
        twitch: twitchB,
        createdAtMs: 2,
        discordDefault: false
      });
    });
    const streamA = await configureStream(registry, await integrationRealm(integrationA));
    const streamB = await configureStream(registry, await integrationRealm(integrationB));
    await publish(registry, invocation(discord), "a-1");

    await runInDurableObject(integrationRegistryStub(env), async (instance) => {
      instance.setDefaultLink({
        sourceGroup: discord,
        targetGroup: twitchB,
        integrationId: integrationB,
        actor: { platform: "discord", id: "manager", claims: [] }
      });
    });
    await publish(registry, invocation(discord), "b-1");

    await runInDurableObject(integrationRegistryStub(env), async (instance) => {
      instance.setDefaultLink({
        sourceGroup: discord,
        targetGroup: twitchA,
        integrationId: integrationA,
        actor: { platform: "discord", id: "manager", claims: [] }
      });
    });
    await expect(publish(registry, invocation(discord), "a-needs-new-consumer"))
      .rejects.toMatchObject({ code: DURABLE_EVENT_CODES.consumerUnavailable });
    await runInDurableObject(integrationRegistryStub(env), async (_instance, state) => {
      await drainDurableEventBindingNotifications(state, env);
    });
    await configureStream(registry, await integrationRealm(integrationA));
    await runInDurableObject(streamA.stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT consumer_ready FROM durable_event_stream_metadata WHERE singleton = 1"
      ).one().consumer_ready)).toBe(1);
    });
    await publish(registry, invocation(discord), "a-2");

    const delayed = await streamA.stub.fetch(
      `https://durable-event-stream${DURABLE_EVENT_BINDING_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...durableEventInternalHeaders
        },
        body: JSON.stringify({
          notificationId: "a".repeat(32),
          routeId: streamA.routeId,
          environment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT,
          sourceGroupKey: discord.key,
          targetPlatform: "twitch",
          previousRevision: 1,
          previousSourceKey: streamA.descriptor.realmIdentity,
          revision: 2,
          status: "ready",
          sourceKey: streamB.descriptor.realmIdentity,
          reason: "default_changed",
          committedAtMs: Date.now()
        })
      }
    );
    expect(await delayed.json()).toMatchObject({ accepted: true, stale: true });
    await runInDurableObject(streamA.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT binding_revision, status FROM durable_event_stream_bindings"
      ).one()).toMatchObject({ binding_revision: 3, status: "active" });
      expect(state.storage.sql.exec(
        "SELECT sequence FROM durable_event_stream_events ORDER BY sequence"
      ).toArray().map((row) => Number(row.sequence))).toEqual([1, 2]);
    });
    await runInDurableObject(streamB.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT sequence FROM durable_event_stream_events ORDER BY sequence"
      ).toArray().map((row) => Number(row.sequence))).toEqual([1]);
    });
  });

  it("reactivates an empty A stream after a collapsed A-to-B-to-A movement", async () => {
    const registry = featureRegistry();
    const discord = group("discord");
    const twitchA = group("twitch");
    const twitchB = group("twitch");
    const integrationA = unique("empty-integration-a");
    const integrationB = unique("empty-integration-b");
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      installIntegration(state, instance, {
        integrationId: integrationA,
        discord,
        twitch: twitchA,
        createdAtMs: 1
      });
      installIntegration(state, instance, {
        integrationId: integrationB,
        discord,
        twitch: twitchB,
        createdAtMs: 2,
        discordDefault: false
      });
    });
    const streamA = await configureStream(
      registry,
      await integrationRealm(integrationA),
      { ready: false }
    );
    await expect(publish(registry, invocation(discord), "never-accepted"))
      .rejects.toMatchObject({ code: DURABLE_EVENT_CODES.consumerUnavailable });

    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      instance.setDefaultLink({
        sourceGroup: discord,
        targetGroup: twitchB,
        integrationId: integrationB,
        actor: { platform: "discord", id: "manager", claims: [] }
      });
      instance.setDefaultLink({
        sourceGroup: discord,
        targetGroup: twitchA,
        integrationId: integrationA,
        actor: { platform: "discord", id: "manager", claims: [] }
      });
      await drainDurableEventBindingNotifications(state, env);
    });
    await runInDurableObject(streamA.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT binding_revision, status FROM durable_event_stream_bindings"
      ).one()).toMatchObject({ binding_revision: 3, status: "active" });
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(0);
    });

    await configureStream(registry, await integrationRealm(integrationA));
    await expect(publish(registry, invocation(discord), "accepted-after-return"))
      .resolves.toEqual({ accepted: true });
  });

  it("marks the old stream drain-only during revocation before fallback selection", async () => {
    const registry = featureRegistry();
    const discord = group("discord");
    const primaryTwitch = group("twitch");
    const fallbackTwitch = group("twitch");
    const primaryId = unique("primary");
    const fallbackId = unique("fallback");
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      installIntegration(state, instance, {
        integrationId: primaryId,
        discord,
        twitch: primaryTwitch,
        createdAtMs: 1
      });
      installIntegration(state, instance, {
        integrationId: fallbackId,
        discord,
        twitch: fallbackTwitch,
        createdAtMs: 2,
        discordDefault: false
      });
    });
    const primary = await configureStream(registry, await integrationRealm(primaryId));
    await publish(registry, invocation(discord), "retained-before-revoke");

    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      instance.beginIntegrationRevocation({
        integrationId: primaryId,
        group: discord,
        actor: { platform: "discord", id: "manager", claims: [] },
        reason: "test"
      });
      await drainDurableEventBindingNotifications(state, env);
      expect(instance.stateQueryBinding(discord, "twitch")).toMatchObject({
        revision: 2,
        status: "transitioning"
      });
      await instance.completeIntegrationRevocation(primaryId);
      expect(instance.stateQueryBinding(discord, "twitch")).toMatchObject({
        revision: 3,
        status: "ready",
        reason: "fallback_selected"
      });
    });
    await runInDurableObject(primary.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT status, reason FROM durable_event_stream_bindings"
      ).one()).toMatchObject({ status: "moved", reason: "revocation_started" });
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(1);
    });
    await configureStream(registry, await integrationRealm(fallbackId), { ready: false });
    await expect(publish(registry, invocation(discord), "fallback-unavailable"))
      .rejects.toMatchObject({ code: DURABLE_EVENT_CODES.consumerUnavailable });
  });

  it("moves to an independent standalone stream when revocation has no fallback", async () => {
    const registry = featureRegistry();
    const discord = group("discord");
    const twitch = group("twitch");
    const integrationId = unique("no-fallback");
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      installIntegration(state, instance, {
        integrationId,
        discord,
        twitch,
        createdAtMs: 1
      });
    });
    const previous = await configureStream(registry, await integrationRealm(integrationId));
    await publish(registry, invocation(discord), "retained-before-standalone");

    let successor;
    await runInDurableObject(integrationRegistryStub(env), async (instance, state) => {
      await instance.revokeIntegration({
        integrationId,
        group: discord,
        actor: { platform: "discord", id: "manager", claims: [] },
        reason: "test"
      });
      expect(instance.stateQueryBinding(discord, "twitch")).toMatchObject({
        revision: 3,
        status: "transitioning",
        reason: "successor_pending"
      });
      successor = await instance.resolveEffectiveShareableState({
        sourceGroup: discord,
        targetPlatform: "twitch"
      });
      expect(instance.stateQueryBinding(discord, "twitch")).toMatchObject({
        revision: 4,
        status: "ready",
        reason: "successor_ready"
      });
      await drainDurableEventBindingNotifications(state, env);
    });
    await runInDurableObject(previous.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT binding_revision, status, reason FROM durable_event_stream_bindings"
      ).one()).toMatchObject({
        binding_revision: 3,
        status: "moved",
        reason: "successor_pending"
      });
      expect(state.storage.sql.exec(
        "SELECT sequence FROM durable_event_stream_events ORDER BY sequence"
      ).toArray().map((row) => Number(row.sequence))).toEqual([1]);
    });

    const next = await configureStream(
      registry,
      shareableStateRealmObjectName(createStandaloneRealmIdentity(
        successor.standaloneRealm.ownerGroup,
        { generation: successor.standaloneRealm.generation }
      )),
      { ready: false }
    );
    expect(next.routeId).not.toBe(previous.routeId);
    await expect(publish(registry, invocation(discord), "standalone-unavailable"))
      .rejects.toMatchObject({ code: DURABLE_EVENT_CODES.consumerUnavailable });
  });
});
