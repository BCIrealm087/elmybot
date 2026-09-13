import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  createPlatformGroupRef,
  IntegrationRegistry,
  integrationRegistryStub
} from "../src/integrations/index.js";
import {
  drainStateQueryBindingNotifications,
  stateQueryBindingSourceKey
} from "../src/state-querying/binding-notifications.js";
import { stateQueryEnvironment } from "../src/state-querying/grant-client.js";
import { STATE_QUERY_OBSERVER_PATHS } from "../src/state-querying/observer.js";
import { stateQueryObserverObjectName } from "../src/state-querying/source-notifications.js";
import {
  acknowledgeStateQueryNotifications,
  getStateQueryBinding,
  listStateQueryNotifications,
  registerStateQueryBindingWatcher,
  unregisterStateQueryBindingWatcher
} from "../src/state-querying/watcher-client.js";

let sequence = 0;
const uniqueId = (prefix) => `${prefix}-binding-${++sequence}`;
const lifecycleEnv = env;

function discordGroup() {
  return createPlatformGroupRef({
    platform: "discord",
    kind: "guild",
    id: uniqueId("guild")
  });
}

function twitchGroup() {
  return createPlatformGroupRef({
    platform: "twitch",
    kind: "channel",
    id: uniqueId("channel")
  });
}

function lifecycleSnapshot(value = 7) {
  return {
    formatVersion: 1,
    namespace: {
      featureId: "test.lifecycle",
      namespaceId: "counts",
      schemaVersion: 1
    },
    mutationVersion: 4,
    fingerprint: `sha256:${"a".repeat(64)}`,
    meaningful: true,
    summary: { kind: "entry_count", used: true, entryCount: 1 },
    entries: [{ key: "value", value }]
  };
}

function realmBinding({ failCloneOnce = false } = {}) {
  const sourceSnapshot = lifecycleSnapshot();
  const snapshots = new Map();
  let cloneFailed = false;
  return {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async (input, init) => {
        const operation = new URL(input).pathname.split("/").at(-1);
        const body = JSON.parse(init.body);
        if (operation === "inventory") {
          return Response.json({
            namespaces: [{
              featureId: "test.lifecycle",
              featureLabel: "Lifecycle test",
              namespaceId: "counts",
              namespaceLabel: "Counts",
              schemaVersion: 1,
              mutationVersion: sourceSnapshot.mutationVersion,
              fingerprint: sourceSnapshot.fingerprint,
              meaningful: true,
              summary: sourceSnapshot.summary
            }]
          });
        }
        if (operation === "freeze-snapshot") {
          return Response.json({
            freezeId: body.storage.freezeId,
            snapshot: sourceSnapshot
          });
        }
        if (operation === "clone-snapshot") {
          if (failCloneOnce && !cloneFailed) {
            cloneFailed = true;
            return Response.json({
              error: "Temporary clone failure.",
              code: "shareable_state_realm_unavailable"
            }, { status: 503 });
          }
          snapshots.set(name, { ...body.storage.snapshot, mutationVersion: 1 });
          return Response.json({
            cloned: true,
            replayed: false,
            mutationVersion: 1,
            fingerprint: body.storage.snapshot.fingerprint
          });
        }
        if (operation === "snapshot") {
          return Response.json(snapshots.get(name) ?? sourceSnapshot);
        }
        return Response.json({ error: "Unexpected realm operation." }, { status: 500 });
      }
    })
  };
}

function installIntegration(state, registry, {
  integrationId,
  discord,
  twitch,
  createdAtMs,
  assignDiscordDefault = true,
  assignTwitchDefault = true
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
  for (const group of [discord, twitch]) {
    state.storage.sql.exec(
      `INSERT INTO integration_members
        (integration_id, group_key, platform, group_kind, group_id, joined_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      integrationId,
      group.key,
      group.platform,
      group.kind,
      group.id,
      createdAtMs
    );
  }
  if (assignDiscordDefault) {
    registry.assignDefaultLinkIfAbsent({
      sourceGroup: discord,
      targetGroup: twitch,
      integrationId,
      nowMs: createdAtMs
    });
  }
  if (assignTwitchDefault) {
    registry.assignDefaultLinkIfAbsent({
      sourceGroup: twitch,
      targetGroup: discord,
      integrationId,
      nowMs: createdAtMs
    });
  }
}

function registerBinding(registry, sourceGroup, watcherId, expectedRevision) {
  return registry.registerStateQueryBindingWatcher({
    sourceGroup,
    targetPlatform: sourceGroup.platform === "discord" ? "twitch" : "discord",
    watcherId,
    expectedRevision,
    leaseSeconds: 120,
    environment: stateQueryEnvironment(lifecycleEnv)
  });
}

async function delayedBindingDelivery(group, watcherId, revision, binding) {
  const observerKey = stateQueryObserverObjectName(
    stateQueryEnvironment(lifecycleEnv),
    group
  );
  const observer = lifecycleEnv.STATE_QUERY_OBSERVER.get(
    lifecycleEnv.STATE_QUERY_OBSERVER.idFromName(observerKey)
  );
  return await observer.fetch(
    `https://state-query-observer${STATE_QUERY_OBSERVER_PATHS.deliver}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        id: revision.toString(16).padStart(32, "0"),
        watcherId,
        observer: {
          environment: stateQueryEnvironment(lifecycleEnv),
          target: { platform: group.platform, groupId: group.id }
        },
        source: {
          kind: "binding",
          key: stateQueryBindingSourceKey(group, "twitch")
        },
        revision,
        committedAtMs: Date.now(),
        binding
      })
    }
  );
}

describe("state-query effective binding lifecycle", () => {
  it("closes the binding snapshot/register race through the registry API", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(lifecycleEnv),
      async (registry, state) => {
        installIntegration(state, registry, {
          integrationId: uniqueId("api"),
          discord,
          twitch,
          createdAtMs: 1
        });
      }
    );
    const current = await getStateQueryBinding(lifecycleEnv, {
      sourceGroup: discord,
      targetPlatform: "twitch"
    });
    expect(current.binding).toMatchObject({ revision: 1, status: "ready" });
    const attached = await registerStateQueryBindingWatcher(lifecycleEnv, {
      sourceGroup: discord,
      targetPlatform: "twitch",
      watcherId: "registry-api",
      expectedRevision: 0,
      leaseSeconds: 120
    });
    expect(attached).toMatchObject({
      currentRevision: 1,
      revisionMatched: false,
      status: "ready"
    });
    expect(await unregisterStateQueryBindingWatcher(lifecycleEnv, {
      sourceGroup: discord,
      targetPlatform: "twitch",
      watcherId: "registry-api"
    })).toEqual({ removed: true });
  });

  it("orders A-to-B-to-A handoffs and permanently rejects delayed binding events", async () => {
    const discord = discordGroup();
    const firstTwitch = twitchGroup();
    const secondTwitch = twitchGroup();
    const firstId = uniqueId("first");
    const secondId = uniqueId("second");
    await runInDurableObject(
      integrationRegistryStub(lifecycleEnv),
      async (_instance, state) => {
        const registry = new IntegrationRegistry(state, {
          ...lifecycleEnv,
          SHAREABLE_STATE_REALM: realmBinding()
        });
        installIntegration(state, registry, {
          integrationId: firstId,
          discord,
          twitch: firstTwitch,
          createdAtMs: 1
        });
        expect(registry.stateQueryBinding(discord, "twitch")).toMatchObject({
          revision: 1,
          status: "ready",
          reason: "integration_activated"
        });
        expect(registerBinding(registry, discord, "a-b-a", 1).revisionMatched)
          .toBe(true);

        installIntegration(state, registry, {
          integrationId: secondId,
          discord,
          twitch: secondTwitch,
          createdAtMs: 2,
          assignDiscordDefault: false
        });
        expect(registry.stateQueryBinding(discord, "twitch").revision).toBe(1);
        expect(registry.stateQueryBinding(firstTwitch, "discord").revision).toBe(1);
        expect(registry.stateQueryBinding(secondTwitch, "discord").revision).toBe(1);

        registry.setDefaultLink({
          sourceGroup: discord,
          targetGroup: secondTwitch,
          integrationId: secondId,
          actor: { platform: "discord", id: "manager", claims: [] }
        });
        expect(registry.stateQueryBinding(discord, "twitch").revision).toBe(2);
        expect(registry.stateQueryBinding(firstTwitch, "discord").revision).toBe(1);
        expect(registry.stateQueryBinding(secondTwitch, "discord").revision).toBe(1);
        registry.setDefaultLink({
          sourceGroup: discord,
          targetGroup: firstTwitch,
          integrationId: firstId,
          actor: { platform: "discord", id: "manager", claims: [] }
        });
        const current = registry.stateQueryBinding(discord, "twitch");
        expect(current).toMatchObject({
          revision: 3,
          status: "ready",
          reason: "default_changed"
        });
        expect(current.sourceKey).toContain(firstId);
        expect(registry.stateQueryBinding(firstTwitch, "discord").revision).toBe(1);
        expect(registry.stateQueryBinding(secondTwitch, "discord").revision).toBe(1);
        expect(registerBinding(registry, discord, "attachment-race", 1))
          .toMatchObject({ currentRevision: 3, revisionMatched: false });

        await drainStateQueryBindingNotifications(state, lifecycleEnv);
      }
    );

    const delivered = await listStateQueryNotifications(lifecycleEnv, discord);
    expect(delivered.notifications).toHaveLength(1);
    expect(delivered.notifications[0]).toMatchObject({
      watcherId: "a-b-a",
      revision: 3,
      binding: { status: "ready", reason: "default_changed" }
    });
    await acknowledgeStateQueryNotifications(
      lifecycleEnv,
      discord,
      [delivered.notifications[0].id]
    );
    const stale = await delayedBindingDelivery(discord, "a-b-a", 2, {
      status: "ready",
      sourceKey: `integration:${secondId}:g1`,
      reason: "default_changed"
    });
    expect(await stale.json()).toEqual({
      accepted: true,
      duplicate: false,
      stale: true
    });
    expect((await listStateQueryNotifications(lifecycleEnv, discord)).notifications)
      .toEqual([]);
  });

  it("publishes an interrupted revocation transition before a ready fallback", async () => {
    const discord = discordGroup();
    const primaryTwitch = twitchGroup();
    const fallbackTwitch = twitchGroup();
    const primaryId = uniqueId("primary");
    const fallbackId = uniqueId("fallback");
    await runInDurableObject(
      integrationRegistryStub(lifecycleEnv),
      async (_instance, state) => {
        const registry = new IntegrationRegistry(state, {
          ...lifecycleEnv,
          SHAREABLE_STATE_REALM: realmBinding()
        });
        installIntegration(state, registry, {
          integrationId: primaryId,
          discord,
          twitch: primaryTwitch,
          createdAtMs: 1
        });
        installIntegration(state, registry, {
          integrationId: fallbackId,
          discord,
          twitch: fallbackTwitch,
          createdAtMs: 2,
          assignDiscordDefault: false
        });
        registerBinding(registry, discord, "fallback", 1);
        registry.beginIntegrationRevocation({
          integrationId: primaryId,
          group: discord,
          actor: { platform: "discord", id: "manager", claims: [] },
          reason: "test"
        });
        expect(registry.stateQueryBinding(discord, "twitch")).toMatchObject({
          revision: 2,
          status: "transitioning",
          sourceKey: null,
          reason: "revocation_started"
        });
        await drainStateQueryBindingNotifications(state, lifecycleEnv);
      }
    );
    const transition = await listStateQueryNotifications(lifecycleEnv, discord);
    expect(transition.notifications[0]).toMatchObject({
      revision: 2,
      binding: { status: "transitioning", reason: "revocation_started" }
    });
    await acknowledgeStateQueryNotifications(
      lifecycleEnv,
      discord,
      [transition.notifications[0].id]
    );

    await runInDurableObject(
      integrationRegistryStub(lifecycleEnv),
      async (_instance, state) => {
        const registry = new IntegrationRegistry(state, {
          ...lifecycleEnv,
          SHAREABLE_STATE_REALM: realmBinding()
        });
        await registry.completeIntegrationRevocation(primaryId);
        expect(registry.stateQueryBinding(discord, "twitch")).toMatchObject({
          revision: 3,
          status: "ready",
          reason: "fallback_selected"
        });
        expect(registry.stateQueryBinding(discord, "twitch").sourceKey)
          .toContain(fallbackId);
        await drainStateQueryBindingNotifications(state, lifecycleEnv);
      }
    );
    expect((await listStateQueryNotifications(lifecycleEnv, discord)).notifications[0])
      .toMatchObject({
        revision: 3,
        binding: { status: "ready", reason: "fallback_selected" }
      });
  });

  it("keeps a failed lazy successor unavailable until readiness advances authority", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    const integrationId = uniqueId("successor");
    const realms = realmBinding({ failCloneOnce: true });
    await runInDurableObject(
      integrationRegistryStub(lifecycleEnv),
      async (_instance, state) => {
        const registry = new IntegrationRegistry(state, {
          ...lifecycleEnv,
          SHAREABLE_STATE_REALM: realms
        });
        installIntegration(state, registry, {
          integrationId,
          discord,
          twitch,
          createdAtMs: 1
        });
        registerBinding(registry, discord, "successor", 1);
        await registry.revokeIntegration({
          integrationId,
          group: discord,
          actor: { platform: "discord", id: "manager", claims: [] }
        });
        expect(registry.stateQueryBinding(discord, "twitch")).toMatchObject({
          revision: 3,
          status: "transitioning",
          reason: "successor_pending"
        });
        await expect(registry.resolveEffectiveShareableState({
          sourceGroup: discord,
          targetPlatform: "twitch"
        })).rejects.toMatchObject({
          code: "integration_state_successor_unavailable"
        });
        expect(registry.stateQueryBinding(discord, "twitch").revision).toBe(3);

        const resolved = await registry.resolveEffectiveShareableState({
          sourceGroup: discord,
          targetPlatform: "twitch"
        });
        expect(resolved).toMatchObject({ bindingRevision: 4 });
        expect(registry.stateQueryBinding(discord, "twitch")).toMatchObject({
          revision: 4,
          status: "ready",
          reason: "successor_ready"
        });
        expect(registry.stateQueryBinding(discord, "twitch").sourceKey)
          .toContain("standalone");
        await drainStateQueryBindingNotifications(state, lifecycleEnv);
      }
    );
    expect((await listStateQueryNotifications(lifecycleEnv, discord)).notifications[0])
      .toMatchObject({
        revision: 4,
        binding: { status: "ready", reason: "successor_ready" }
      });
  });

  it("recovers a durable handoff notification after registry restart", async () => {
    const discord = discordGroup();
    const firstTwitch = twitchGroup();
    const secondTwitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(lifecycleEnv),
      async (_instance, state) => {
        const failingEnv = {
          ...lifecycleEnv,
          STATE_QUERY_OBSERVER: {
            idFromName: (name) => name,
            get: () => ({
              fetch: async () => new Response("Unavailable", { status: 503 })
            })
          }
        };
        const registry = new IntegrationRegistry(state, {
          ...failingEnv,
          SHAREABLE_STATE_REALM: realmBinding()
        });
        const firstId = uniqueId("restart-first");
        const secondId = uniqueId("restart-second");
        installIntegration(state, registry, {
          integrationId: firstId,
          discord,
          twitch: firstTwitch,
          createdAtMs: 1
        });
        installIntegration(state, registry, {
          integrationId: secondId,
          discord,
          twitch: secondTwitch,
          createdAtMs: 2,
          assignDiscordDefault: false
        });
        registerBinding(registry, discord, "restart", 1);
        registry.setDefaultLink({
          sourceGroup: discord,
          targetGroup: secondTwitch,
          integrationId: secondId,
          actor: { platform: "discord", id: "manager", claims: [] }
        });
        await drainStateQueryBindingNotifications(state, failingEnv);
        expect(state.storage.sql.exec(
          `SELECT binding_revision, attempt_count
           FROM state_query_binding_outbox
           WHERE source_group_key = ? AND watcher_id = 'restart'`,
          discord.key
        ).one()).toMatchObject({ binding_revision: 2, attempt_count: 1 });

        state.storage.sql.exec(
          "UPDATE state_query_binding_outbox SET next_attempt_at_ms = 0"
        );
        const restarted = new IntegrationRegistry(state, {
          ...lifecycleEnv,
          SHAREABLE_STATE_REALM: realmBinding()
        });
        await drainStateQueryBindingNotifications(state, restarted.env);
        expect(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM state_query_binding_outbox"
        ).one().total).toBe(0);
      }
    );
    expect((await listStateQueryNotifications(lifecycleEnv, discord)).notifications[0])
      .toMatchObject({
        watcherId: "restart",
        revision: 2,
        binding: { status: "ready", reason: "default_changed" }
      });
  });

  it("does not retarget a direction when an unselected integration revokes", async () => {
    const discord = discordGroup();
    const selectedTwitch = twitchGroup();
    const unselectedTwitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(lifecycleEnv),
      async (_instance, state) => {
        const registry = new IntegrationRegistry(state, {
          ...lifecycleEnv,
          SHAREABLE_STATE_REALM: realmBinding()
        });
        installIntegration(state, registry, {
          integrationId: uniqueId("selected"),
          discord,
          twitch: selectedTwitch,
          createdAtMs: 1
        });
        const unselectedId = uniqueId("unselected");
        installIntegration(state, registry, {
          integrationId: unselectedId,
          discord,
          twitch: unselectedTwitch,
          createdAtMs: 2,
          assignDiscordDefault: false
        });
        const before = registry.stateQueryBinding(discord, "twitch");
        await registry.revokeIntegration({
          integrationId: unselectedId,
          group: discord,
          actor: { platform: "discord", id: "manager", claims: [] }
        });
        expect(registry.stateQueryBinding(discord, "twitch")).toEqual(before);
      }
    );
  });
});
