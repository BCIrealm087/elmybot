import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  IntegrationRegistry,
  integrationRegistryStub
} from "../src/integrations/index.js";
import {
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  shareableStateRealmObjectName
} from "../src/shareable-state/index.js";

let sequence = 0;
const uniqueId = (prefix) => `${prefix}-revocation-${++sequence}`;
const fingerprint = (character) => `sha256:${character.repeat(64)}`;
const discordGroup = () => ({
  platform: "discord",
  kind: "guild",
  id: uniqueId("guild")
});
const twitchGroup = () => ({
  platform: "twitch",
  kind: "channel",
  id: uniqueId("channel")
});
const namespaceDefinitions = [
  { id: "counts", label: "Shared counts" },
  { id: "settings", label: "Shared settings" }
];

function snapshot(namespaceId, value, character) {
  const meaningful = value !== null;
  return {
    formatVersion: 1,
    namespace: {
      featureId: "test.lifecycle",
      namespaceId,
      schemaVersion: 1
    },
    mutationVersion: meaningful ? 4 : 0,
    fingerprint: fingerprint(character),
    meaningful,
    summary: {
      kind: "entry_count",
      used: meaningful,
      entryCount: meaningful ? 1 : 0
    },
    entries: meaningful ? [{ key: "value", value }] : []
  };
}

function revocationRealmBinding({
  failCloneOnceAt = null,
  failFreezeOnceAt = null
} = {}) {
  const realms = new Map();
  const frozen = new Set();
  const materializations = new Map();
  let failed = false;
  let freezeFailed = false;
  const realmMap = (name) => {
    const value = realms.get(name) ?? new Map();
    realms.set(name, value);
    return value;
  };
  const namespaceSnapshot = (name, namespaceId) =>
    realmMap(name).get(namespaceId) ?? snapshot(namespaceId, null, "0");
  return {
    realms,
    frozen,
    materializations,
    seed(realm, snapshots) {
      const values = realmMap(shareableStateRealmObjectName(realm));
      for (const value of snapshots) values.set(value.namespace.namespaceId, value);
    },
    mutate(realm, namespaceId, value) {
      const name = shareableStateRealmObjectName(realm);
      const current = namespaceSnapshot(name, namespaceId);
      realmMap(name).set(namespaceId, {
        ...current,
        mutationVersion: current.mutationVersion + 1,
        fingerprint: fingerprint("f"),
        meaningful: true,
        summary: { kind: "entry_count", used: true, entryCount: 1 },
        entries: [{ key: "value", value }]
      });
    },
    binding: {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async (input, init) => {
          const operation = new URL(input).pathname.split("/").at(-1);
          const body = JSON.parse(init.body);
          if (operation === "inventory") {
            return Response.json({
              namespaces: namespaceDefinitions.map((definition) => {
                const value = namespaceSnapshot(name, definition.id);
                return {
                  featureId: "test.lifecycle",
                  featureLabel: "Lifecycle test feature",
                  namespaceId: definition.id,
                  namespaceLabel: definition.label,
                  schemaVersion: value.namespace.schemaVersion,
                  mutationVersion: value.mutationVersion,
                  fingerprint: value.fingerprint,
                  meaningful: value.meaningful,
                  summary: value.summary
                };
              })
            });
          }
          const namespaceId = body.namespace.namespaceId;
          if (operation === "freeze-snapshot") {
            if (failFreezeOnceAt === namespaceId && !freezeFailed) {
              freezeFailed = true;
              return Response.json({
                error: "Temporary archive failure.",
                code: "shareable_state_realm_unavailable"
              }, { status: 503 });
            }
            const key = `${name}\u0000${namespaceId}`;
            const existing = [...frozen].find((entry) => entry.startsWith(`${key}\u0000`));
            const freezeId = body.storage.freezeId;
            if (existing && existing !== `${key}\u0000${freezeId}`) {
              return Response.json({
                error: "Already frozen.",
                code: "shareable_state_realm_frozen"
              }, { status: 409 });
            }
            frozen.add(`${key}\u0000${freezeId}`);
            return Response.json({
              freezeId,
              snapshot: namespaceSnapshot(name, namespaceId)
            });
          }
          if (operation === "clone-snapshot") {
            const idempotencyKey = body.storage.idempotencyKey;
            const materializationKey = `${name}\u0000${idempotencyKey}`;
            if (materializations.has(materializationKey)) {
              return Response.json(materializations.get(materializationKey));
            }
            if (failCloneOnceAt === namespaceId && !failed) {
              failed = true;
              return Response.json({
                error: "Temporary successor failure.",
                code: "shareable_state_realm_unavailable"
              }, { status: 503 });
            }
            const cloned = {
              ...body.storage.snapshot,
              mutationVersion: 1
            };
            realmMap(name).set(namespaceId, cloned);
            const first = {
              cloned: true,
              replayed: false,
              mutationVersion: 1,
              fingerprint: cloned.fingerprint
            };
            materializations.set(materializationKey, {
              ...first,
              cloned: false,
              replayed: true
            });
            return Response.json(first);
          }
          if (operation === "snapshot") {
            return Response.json(namespaceSnapshot(name, namespaceId));
          }
          return Response.json({ error: "Unexpected realm operation." }, {
            status: 500
          });
        }
      })
    }
  };
}

function installIntegration(state, {
  integrationId,
  discord,
  twitch,
  generation = 1,
  createdAtMs = Date.now(),
  assignDiscordDefault = true,
  assignTwitchDefault = true
}) {
  state.storage.sql.exec(
    `INSERT INTO integrations
      (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
       created_by_platform, created_by_actor_id, completed_by_platform,
       completed_by_actor_id, shareable_state_generation)
     VALUES (?, 'active', ?, ?, ?, 'discord', 'manager', 'twitch',
             'broadcaster', ?)`,
    integrationId,
    createdAtMs,
    createdAtMs,
    createdAtMs,
    generation
  );
  for (const group of [discord, twitch]) {
    state.storage.sql.exec(
      `INSERT INTO integration_members
        (integration_id, group_key, platform, group_kind, group_id, joined_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      integrationId,
      `${group.platform}:${group.kind}:${group.id}`,
      group.platform,
      group.kind,
      group.id,
      createdAtMs
    );
  }
  for (const [enabled, source, target] of [
    [assignDiscordDefault, discord, twitch],
    [assignTwitchDefault, twitch, discord]
  ]) {
    if (!enabled) continue;
    state.storage.sql.exec(
      `INSERT INTO integration_default_links
        (source_group_key, target_platform, integration_id, target_group_key,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      `${source.platform}:${source.kind}:${source.id}`,
      target.platform,
      integrationId,
      `${target.platform}:${target.kind}:${target.id}`,
      createdAtMs,
      createdAtMs
    );
  }
}

function invitationToken(invitation) {
  return new URL(invitation.invitationUrl).hash.slice("#invite=".length);
}

describe("Integration shareable-state revocation", () => {
  it("records lazy successors, forks both groups independently, and relinks from them", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    const integrationId = uniqueId("integration");
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_instance, state) => {
        const realms = revocationRealmBinding();
        const registry = new IntegrationRegistry(state, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        installIntegration(state, {
          integrationId,
          discord,
          twitch,
          generation: 3
        });
        realms.seed(createIntegrationRealmIdentity(
          { id: integrationId },
          { generation: 3 }
        ), [
          snapshot("counts", 12, "c"),
          snapshot("settings", { mode: "hard" }, "d")
        ]);

        const revoked = await registry.revokeIntegration({
          integrationId,
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager") },
          reason: "test_successor"
        });
        expect(revoked).toMatchObject({
          revoked: true,
          alreadyRevoked: false,
          integration: { status: "revoked", shareableStateGeneration: 3 }
        });
        expect(realms.frozen.size).toBe(2);
        expect(realms.materializations.size).toBe(0);
        expect(state.storage.sql.exec(
          `SELECT group_key, generation, status, source_integration_id,
                  source_generation
           FROM shareable_state_standalone_successors
           ORDER BY group_key`
        ).toArray()).toEqual([
          {
            group_key: `discord:guild:${discord.id}`,
            generation: 2,
            status: "pending",
            source_integration_id: integrationId,
            source_generation: 3
          },
          {
            group_key: `twitch:channel:${twitch.id}`,
            generation: 2,
            status: "pending",
            source_integration_id: integrationId,
            source_generation: 3
          }
        ]);
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_revocation_namespaces
           WHERE integration_id = ?`,
          integrationId
        ).one().total).toBe(2);

        const replay = await registry.revokeIntegration({
          integrationId,
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager") }
        });
        expect(replay).toMatchObject({ revoked: false, alreadyRevoked: true });
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE integration_id = ? AND event = 'integration.revoked.v1'`,
          integrationId
        ).one().total).toBe(1);

        const discordResolved = await registry.resolveEffectiveShareableState({
          sourceGroup: discord,
          targetPlatform: "twitch"
        });
        const discordRealm = createStandaloneRealmIdentity(discord, {
          generation: 2
        });
        expect(discordResolved).toMatchObject({
          defaultLink: null,
          standaloneRealm: { generation: 2 }
        });
        expect(realms.materializations.size).toBe(2);
        expect(state.storage.sql.exec(
          `SELECT status FROM shareable_state_standalone_successors
           WHERE group_key = ?`,
          `discord:guild:${discord.id}`
        ).one().status).toBe("ready");

        const twitchResolved = await registry.resolveEffectiveShareableState({
          sourceGroup: twitch,
          targetPlatform: "discord"
        });
        const twitchRealm = createStandaloneRealmIdentity(twitch, {
          generation: 2
        });
        expect(twitchResolved.standaloneRealm.generation).toBe(2);
        expect(realms.materializations.size).toBe(4);
        realms.mutate(discordRealm, "counts", 13);
        const discordCount = realms.realms.get(
          shareableStateRealmObjectName(discordRealm)
        ).get("counts").entries[0].value;
        const twitchCount = realms.realms.get(
          shareableStateRealmObjectName(twitchRealm)
        ).get("counts").entries[0].value;
        expect({ discordCount, twitchCount }).toEqual({
          discordCount: 13,
          twitchCount: 12
        });

        const invitation = await registry.createInvitation({
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager"), claims: [] },
          connectUrl: "https://example.com/twitch/integrations/connect"
        });
        const replacementTwitch = twitchGroup();
        const reservationId = crypto.randomUUID();
        const reservation = await registry.reserveInvitation({
          token: invitationToken(invitation),
          reservationId,
          reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
        });
        const verified = await registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: replacementTwitch,
          actor: {
            platform: "twitch",
            id: replacementTwitch.id,
            claims: ["twitch.broadcaster"]
          }
        });
        expect(verified.pendingIntegration.stateDiscovery).toMatchObject({
          namespaces: [
            { namespaceId: "counts", outcome: "discord_only" },
            { namespaceId: "settings", outcome: "discord_only" }
          ]
        });
        const discoveryRealms = state.storage.sql.exec(
          `SELECT discord_realm_json, twitch_realm_json
           FROM integration_pending_discoveries
           WHERE invitation_id = ?`,
          invitation.invitationId
        ).one();
        expect(JSON.parse(discoveryRealms.discord_realm_json)).toMatchObject({
          kind: "standalone",
          generation: 2
        });
        expect(JSON.parse(discoveryRealms.twitch_realm_json)).toMatchObject({
          kind: "standalone",
          generation: 1
        });
      }
    );
  });

  it("uses an active fallback without creating a successor for that direction", async () => {
    const discord = discordGroup();
    const firstTwitch = twitchGroup();
    const fallbackTwitch = twitchGroup();
    const primaryId = uniqueId("primary");
    const fallbackId = uniqueId("fallback");
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_instance, state) => {
        const realms = revocationRealmBinding();
        const registry = new IntegrationRegistry(state, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        installIntegration(state, {
          integrationId: primaryId,
          discord,
          twitch: firstTwitch,
          createdAtMs: 1
        });
        installIntegration(state, {
          integrationId: fallbackId,
          discord,
          twitch: fallbackTwitch,
          createdAtMs: 2,
          assignDiscordDefault: false
        });
        realms.seed(createIntegrationRealmIdentity({ id: primaryId }), [
          snapshot("counts", 3, "a"),
          snapshot("settings", "primary", "b")
        ]);

        await registry.revokeIntegration({
          integrationId: primaryId,
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager") }
        });
        expect(registry.getDefaultLink(discord, "twitch")).toMatchObject({
          integration: { id: fallbackId },
          targetGroup: { id: fallbackTwitch.id }
        });
        await expect(registry.resolveEffectiveShareableState({
          sourceGroup: discord,
          targetPlatform: "twitch"
        })).resolves.toMatchObject({
          defaultLink: {
            integration: { id: fallbackId },
            targetGroup: { id: fallbackTwitch.id }
          },
          standaloneRealm: null
        });
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM shareable_state_standalone_successors
           WHERE group_key = ?`,
          `discord:guild:${discord.id}`
        ).one().total).toBe(0);
        expect(state.storage.sql.exec(
          `SELECT generation, status FROM shareable_state_standalone_successors
           WHERE group_key = ?`,
          `twitch:channel:${firstTwitch.id}`
        ).one()).toEqual({ generation: 2, status: "pending" });
      }
    );
  });

  it("resumes a partially copied lazy successor idempotently", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    const integrationId = uniqueId("partial");
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_instance, state) => {
        const realms = revocationRealmBinding({ failCloneOnceAt: "settings" });
        const registry = new IntegrationRegistry(state, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        installIntegration(state, { integrationId, discord, twitch });
        realms.seed(createIntegrationRealmIdentity({ id: integrationId }), [
          snapshot("counts", 4, "4"),
          snapshot("settings", "kept", "5")
        ]);
        await registry.revokeIntegration({
          integrationId,
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager") }
        });

        await expect(registry.resolveEffectiveShareableState({
          sourceGroup: discord,
          targetPlatform: "twitch"
        })).rejects.toMatchObject({
          status: 503,
          code: "integration_state_successor_unavailable"
        });
        expect(realms.materializations.size).toBe(1);
        expect(state.storage.sql.exec(
          `SELECT status FROM shareable_state_standalone_successors
           WHERE group_key = ?`,
          `discord:guild:${discord.id}`
        ).one().status).toBe("pending");

        await expect(registry.resolveEffectiveShareableState({
          sourceGroup: discord,
          targetPlatform: "twitch"
        })).resolves.toMatchObject({
          standaloneRealm: { generation: 2 }
        });
        expect(realms.materializations.size).toBe(2);
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE integration_id = ?
             AND group_key = ?
             AND event = 'integration.state_successor.ready.v1'`,
          integrationId,
          `discord:guild:${discord.id}`
        ).one().total).toBe(1);
      }
    );
  });

  it("keeps a durable revocation job and resumes a partial archive", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    const integrationId = uniqueId("archive-retry");
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_instance, state) => {
        const realms = revocationRealmBinding({ failFreezeOnceAt: "settings" });
        const registry = new IntegrationRegistry(state, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        installIntegration(state, { integrationId, discord, twitch });
        realms.seed(createIntegrationRealmIdentity({ id: integrationId }), [
          snapshot("counts", 7, "7"),
          snapshot("settings", "kept", "8")
        ]);

        await expect(registry.revokeIntegration({
          integrationId,
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager") }
        })).rejects.toMatchObject({
          status: 503,
          code: "integration_revocation_state_unavailable"
        });
        expect(registry.getIntegration(integrationId).status).toBe("revoking");
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_revocation_jobs
           WHERE integration_id = ?`,
          integrationId
        ).one().total).toBe(1);
        await expect(registry.resolveEffectiveShareableState({
          sourceGroup: discord,
          targetPlatform: "twitch"
        })).rejects.toMatchObject({
          status: 409,
          code: "shareable_state_transition"
        });

        await expect(registry.revokeIntegration({
          integrationId,
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager") }
        })).resolves.toMatchObject({
          revoked: true,
          integration: { status: "revoked" }
        });
        expect(realms.frozen.size).toBe(2);
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_revocation_jobs
           WHERE integration_id = ?`,
          integrationId
        ).one().total).toBe(0);
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE integration_id = ?
             AND event = 'integration.revocation.started.v1'`,
          integrationId
        ).one().total).toBe(1);
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE integration_id = ? AND event = 'integration.revoked.v1'`,
          integrationId
        ).one().total).toBe(1);
      }
    );
  });
});
