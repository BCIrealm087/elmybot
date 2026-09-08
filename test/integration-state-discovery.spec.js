import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  IntegrationRegistry,
  integrationRegistryStub
} from "../src/integrations/index.js";

let sequence = 0;
const uniqueId = (prefix) => `${prefix}-discovery-${++sequence}`;
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

function invitationToken(invitation) {
  return new URL(invitation.invitationUrl).hash.slice("#invite=".length);
}

const fingerprint = (character) => `sha256:${character.repeat(64)}`;

function inventory(side) {
  const values = {
    both_empty: {
      meaningful: false,
      fingerprint: fingerprint("0")
    },
    discord_only: {
      meaningful: side === "discord",
      fingerprint: fingerprint(side === "discord" ? "1" : "0")
    },
    twitch_only: {
      meaningful: side === "twitch",
      fingerprint: fingerprint(side === "twitch" ? "2" : "0")
    },
    identical: {
      meaningful: true,
      fingerprint: fingerprint("3")
    },
    collision: {
      meaningful: true,
      fingerprint: fingerprint(side === "discord" ? "4" : "5")
    }
  };
  return {
    namespaces: Object.entries(values).map(([namespaceId, value]) => ({
      featureId: "test.discovery",
      featureLabel: "Discovery test feature",
      namespaceId,
      namespaceLabel: namespaceId.replaceAll("_", " "),
      schemaVersion: 1,
      mutationVersion: value.meaningful ? 1 : 0,
      fingerprint: value.fingerprint,
      meaningful: value.meaningful,
      summary: {
        kind: "entry_count",
        used: value.meaningful,
        entryCount: value.meaningful ? 1 : 0
      }
    }))
  };
}

function finalizingRealmBinding({ failOnceAt = null } = {}) {
  const targets = new Map();
  const materializations = new Map();
  const overrides = new Map();
  let failed = false;
  const currentInventory = (side) => ({
    namespaces: inventory(side).namespaces.map((namespace) =>
      overrides.get(`${side}\u0000${namespace.namespaceId}`) ?? namespace
    )
  });
  return {
    targets,
    materializations,
    mutate(side, namespaceId) {
      const namespace = currentInventory(side).namespaces.find(
        (candidate) => candidate.namespaceId === namespaceId
      );
      overrides.set(`${side}\u0000${namespaceId}`, {
        ...namespace,
        mutationVersion: namespace.mutationVersion + 1,
        fingerprint: fingerprint(side === "discord" ? "a" : "b")
      });
    },
    binding: {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async (input, init) => {
          const operation = new URL(input).pathname.split("/").at(-1);
          const body = JSON.parse(init.body);
          const namespaceKey =
            `${body.namespace?.featureId}\u0000${body.namespace?.namespaceId}`;
          if (operation === "inventory") {
            return Response.json(currentInventory(
              name.includes("discord:guild") ? "discord" : "twitch"
            ));
          }
          if (operation === "seal-snapshot") {
            const side = name.includes("discord:guild") ? "discord" : "twitch";
            const entry = currentInventory(side).namespaces.find((namespace) =>
              namespace.featureId === body.namespace.featureId &&
              namespace.namespaceId === body.namespace.namespaceId
            );
            return Response.json({
              sealId: body.storage.sealId,
              expiresAtMs: body.storage.expiresAtMs,
              snapshot: {
                formatVersion: 1,
                namespace: {
                  featureId: entry.featureId,
                  namespaceId: entry.namespaceId,
                  schemaVersion: entry.schemaVersion
                },
                mutationVersion: entry.mutationVersion,
                fingerprint: entry.fingerprint,
                meaningful: entry.meaningful,
                summary: entry.summary,
                entries: entry.meaningful
                  ? [{ key: "value", value: `${side}:${entry.namespaceId}` }]
                  : []
              }
            });
          }
          if (operation === "release-seal") {
            return Response.json({ released: true });
          }
          if (operation === "clone-snapshot") {
            const idempotencyKey = body.storage.idempotencyKey;
            if (materializations.has(idempotencyKey)) {
              return Response.json(materializations.get(idempotencyKey));
            }
            if (failOnceAt === body.namespace.namespaceId && !failed) {
              failed = true;
              return Response.json({
                error: "Temporary target failure.",
                code: "shareable_state_realm_unavailable"
              }, { status: 503 });
            }
            const snapshot = {
              ...body.storage.snapshot,
              mutationVersion: 1
            };
            targets.set(namespaceKey, snapshot);
            const result = {
              cloned: true,
              replayed: false,
              mutationVersion: 1,
              fingerprint: snapshot.fingerprint
            };
            materializations.set(idempotencyKey, {
              ...result,
              cloned: false,
              replayed: true
            });
            return Response.json(result);
          }
          if (operation === "initialize-empty") {
            const idempotencyKey = body.storage.idempotencyKey;
            if (materializations.has(idempotencyKey)) {
              return Response.json(materializations.get(idempotencyKey));
            }
            if (failOnceAt === body.namespace.namespaceId && !failed) {
              failed = true;
              return Response.json({
                error: "Temporary target failure.",
                code: "shareable_state_realm_unavailable"
              }, { status: 503 });
            }
            const targetFingerprint = fingerprint("e");
            targets.set(namespaceKey, {
              formatVersion: 1,
              namespace: {
                featureId: body.namespace.featureId,
                namespaceId: body.namespace.namespaceId,
                schemaVersion: 1
              },
              mutationVersion: 1,
              fingerprint: targetFingerprint,
              meaningful: false,
              summary: { kind: "entry_count", used: false, entryCount: 0 },
              entries: []
            });
            const result = {
              cloned: true,
              replayed: false,
              mutationVersion: 1,
              fingerprint: targetFingerprint
            };
            materializations.set(idempotencyKey, {
              ...result,
              cloned: false,
              replayed: true
            });
            return Response.json(result);
          }
          if (operation === "snapshot") {
            return Response.json(targets.get(namespaceKey));
          }
          return Response.json({ error: "Unexpected realm operation." }, {
            status: 500
          });
        }
      })
    }
  };
}

describe("Pending integration shareable-state discovery", () => {
  it("classifies automatic outcomes and persists only safe collision metadata", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_registryInstance, registryState) => {
        const realms = finalizingRealmBinding();
        const discoveryEnv = {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        };
        const registry = new IntegrationRegistry(registryState, discoveryEnv);
        const invitation = await registry.createInvitation({
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager"), claims: [] },
          connectUrl: "https://example.com/twitch/integrations/connect"
        });
        const reservationId = crypto.randomUUID();
        const reservation = await registry.reserveInvitation({
          token: invitationToken(invitation),
          reservationId,
          reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
        });
        const verification = await registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: twitch,
          actor: {
            platform: "twitch",
            id: twitch.id,
            claims: ["twitch.broadcaster"]
          },
          groupLabel: "test_channel"
        });

        const discovery = verification.pendingIntegration.stateDiscovery;
        expect(discovery).toMatchObject({
          version: 1,
          requiresResolution: true
        });
        expect(discovery.namespaces.map((namespace) => ({
          id: namespace.namespaceId,
          outcome: namespace.outcome,
          selection: namespace.automaticSelection
        }))).toEqual([
          { id: "both_empty", outcome: "both_empty", selection: "reset" },
          { id: "collision", outcome: "collision", selection: null },
          { id: "discord_only", outcome: "discord_only", selection: "discord" },
          { id: "identical", outcome: "identical", selection: "discord" },
          { id: "twitch_only", outcome: "twitch_only", selection: "twitch" }
        ]);
        expect(discovery.namespaces.find(
          (namespace) => namespace.namespaceId === "collision"
        )).toMatchObject({
          featureLabel: "Discovery test feature",
          namespaceLabel: "collision",
          discordSummary: { kind: "entry_count", used: true, entryCount: 1 },
          twitchSummary: { kind: "entry_count", used: true, entryCount: 1 }
        });

        const resumed = await registry.resumeInvitation({ reservationId });
        expect(resumed.pendingIntegration.stateDiscovery.version).toBe(1);
        const replayed = await registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: twitch,
          actor: {
            platform: "twitch",
            id: twitch.id,
            claims: ["twitch.broadcaster"]
          }
        });
        expect(replayed.replayed).toBe(true);
        expect(replayed.pendingIntegration.stateDiscovery.version).toBe(1);

        const persisted = registryState.storage.sql.exec(
          `SELECT * FROM integration_pending_namespace_discoveries
           WHERE invitation_id = ?`,
          invitation.invitationId
        ).toArray();
        expect(persisted).toHaveLength(5);
        expect(Object.keys(persisted[0])).not.toContain("entries");
        expect(Object.keys(persisted[0])).not.toContain("values");
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_pending_discoveries
           WHERE invitation_id = ?`,
          invitation.invitationId
        ).one().total).toBe(1);
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE invitation_id = ?
             AND event = 'integration.state_discovery.collisions_found.v1'`,
          invitation.invitationId
        ).one().total).toBe(1);

        await expect(registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 2,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "discord"
          }]
        })).rejects.toMatchObject({
          status: 409,
          code: "integration_state_resolution_stale"
        });
        await expect(registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: []
        })).rejects.toMatchObject({
          status: 422,
          code: "integration_state_resolution_incomplete"
        });

        const resolved = await registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "twitch"
          }]
        });
        expect(resolved).toMatchObject({
          replayed: false,
          stateResolution: {
            discoveryVersion: 1,
            selections: [
              {
                featureId: "test.discovery",
                namespaceId: "both_empty",
                selection: "reset",
                source: "automatic"
              },
              {
                featureId: "test.discovery",
                namespaceId: "collision",
                selection: "twitch",
                source: "user"
              },
              {
                featureId: "test.discovery",
                namespaceId: "discord_only",
                selection: "discord",
                source: "automatic"
              },
              {
                featureId: "test.discovery",
                namespaceId: "identical",
                selection: "discord",
                source: "automatic"
              },
              {
                featureId: "test.discovery",
                namespaceId: "twitch_only",
                selection: "twitch",
                source: "automatic"
              }
            ]
          },
          pendingIntegration: {
            stateResolution: {
              discoveryVersion: 1
            }
          }
        });
        const replayedResolution = await registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "twitch"
          }]
        });
        expect(replayedResolution.replayed).toBe(true);
        await expect(registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "reset"
          }]
        })).rejects.toMatchObject({
          status: 409,
          code: "integration_state_resolution_already_recorded"
        });
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_pending_resolutions
           WHERE invitation_id = ?`,
          invitation.invitationId
        ).one().total).toBe(1);
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total
           FROM integration_pending_namespace_resolutions
           WHERE invitation_id = ?`,
          invitation.invitationId
        ).one().total).toBe(5);
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE invitation_id = ?
             AND event = 'integration.state_resolution.recorded.v1'`,
          invitation.invitationId
        ).one().total).toBe(1);

        const activations = await Promise.all([
          registry.activateInvitation({
            invitationId: invitation.invitationId,
            reservationId
          }),
          registry.activateInvitation({
            invitationId: invitation.invitationId,
            reservationId
          })
        ]);
        expect(activations.map((result) => result.replayed).sort())
          .toEqual([false, true]);
        const activated = activations.find((result) => !result.replayed);
        expect(activated).toMatchObject({
          replayed: false,
          integration: {
            status: "active",
            shareableStateGeneration: 1
          }
        });
        expect(realms.targets.size).toBe(5);
        expect(realms.targets.get("test.discovery\u0000collision").entries)
          .toEqual([{ key: "value", value: "twitch:collision" }]);
        expect(realms.targets.get("test.discovery\u0000both_empty").meaningful)
          .toBe(false);
        expect(realms.targets.get("test.discovery\u0000discord_only").entries)
          .toEqual([{ key: "value", value: "discord:discord_only" }]);
        expect(realms.targets.get("test.discovery\u0000twitch_only").entries)
          .toEqual([{ key: "value", value: "twitch:twitch_only" }]);
        expect(realms.targets.get("test.discovery\u0000identical").entries)
          .toEqual([{ key: "value", value: "discord:identical" }]);
        expect((await registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        })).replayed).toBe(true);
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE invitation_id = ?
             AND event = 'integration.state_resolution.applied.v1'`,
          invitation.invitationId
        ).one().total).toBe(1);
      }
    );
  });

  it("resets a nonempty collision without changing either candidate", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_registryInstance, registryState) => {
        const realms = finalizingRealmBinding();
        const registry = new IntegrationRegistry(registryState, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        const invitation = await registry.createInvitation({
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager"), claims: [] },
          connectUrl: "https://example.com/twitch/integrations/connect"
        });
        const reservationId = crypto.randomUUID();
        const reservation = await registry.reserveInvitation({
          token: invitationToken(invitation),
          reservationId,
          reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
        });
        await registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: twitch,
          actor: {
            platform: "twitch",
            id: twitch.id,
            claims: ["twitch.broadcaster"]
          }
        });
        await registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "reset"
          }]
        });

        await expect(registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        })).resolves.toMatchObject({
          integration: { status: "active" }
        });
        expect(realms.targets.get("test.discovery\u0000collision"))
          .toMatchObject({ meaningful: false, entries: [] });
        expect(inventory("discord").namespaces.find(
          (namespace) => namespace.namespaceId === "collision"
        )).toMatchObject({ meaningful: true, fingerprint: fingerprint("4") });
        expect(inventory("twitch").namespaces.find(
          (namespace) => namespace.namespaceId === "collision"
        )).toMatchObject({ meaningful: true, fingerprint: fingerprint("5") });
      }
    );
  });

  it("cancels after collision resolution without materializing shared state", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_registryInstance, registryState) => {
        const realms = finalizingRealmBinding();
        const registry = new IntegrationRegistry(registryState, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        const invitation = await registry.createInvitation({
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager"), claims: [] },
          connectUrl: "https://example.com/twitch/integrations/connect"
        });
        const reservationId = crypto.randomUUID();
        const reservation = await registry.reserveInvitation({
          token: invitationToken(invitation),
          reservationId,
          reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
        });
        await registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: twitch,
          actor: {
            platform: "twitch",
            id: twitch.id,
            claims: ["twitch.broadcaster"]
          }
        });
        await registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "discord"
          }]
        });

        const cancelled = await registry.cancelInvitation({ reservationId });
        expect(cancelled.pendingIntegration.status).toBe("cancelled");
        expect(realms.targets.size).toBe(0);
        expect(registry.listIntegrations(new URL(
          `https://registry/integrations?groupKey=${encodeURIComponent(
            `discord:guild:${discord.id}`
          )}`
        )).total).toBe(0);
        await expect(registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        })).rejects.toMatchObject({
          status: 409,
          code: "integration_pending_not_ready"
        });
      }
    );
  });

  it("resumes discovery after a temporary realm failure without re-verifying Twitch", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_registryInstance, registryState) => {
        let requests = 0;
        const discoveryEnv = {
          ...env,
          SHAREABLE_STATE_REALM: {
            idFromName: (name) => name,
            get: () => ({
              fetch: async () => {
                requests += 1;
                return requests === 1
                  ? Response.json(
                      { error: "Temporary realm outage." },
                      { status: 503 }
                    )
                  : Response.json({ namespaces: [] });
              }
            })
          }
        };
        const registry = new IntegrationRegistry(registryState, discoveryEnv);
        const invitation = await registry.createInvitation({
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager"), claims: [] },
          connectUrl: "https://example.com/twitch/integrations/connect"
        });
        const reservationId = crypto.randomUUID();
        const reservation = await registry.reserveInvitation({
          token: invitationToken(invitation),
          reservationId,
          reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
        });

        await expect(registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: twitch,
          actor: {
            platform: "twitch",
            id: twitch.id,
            claims: ["twitch.broadcaster"]
          }
        })).rejects.toMatchObject({
          status: 503,
          code: "integration_state_discovery_unavailable"
        });
        expect(registryState.storage.sql.exec(
          `SELECT status FROM integration_pending_links
           WHERE invitation_id = ?`,
          invitation.invitationId
        ).one().status).toBe("awaiting_state_resolution");
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_pending_discoveries
           WHERE invitation_id = ?`,
          invitation.invitationId
        ).one().total).toBe(0);

        const resumed = await registry.resumeInvitation({ reservationId });
        expect(resumed.pendingIntegration).toMatchObject({
          status: "awaiting_state_resolution",
          stateDiscovery: {
            version: 1,
            requiresResolution: false,
            namespaces: []
          }
        });
        await expect(registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: []
        })).rejects.toMatchObject({
          status: 409,
          code: "integration_state_resolution_not_required"
        });
      }
    );
  });

  it("rediscovers changed candidates and requires a fresh collision decision", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_registryInstance, registryState) => {
        const realms = finalizingRealmBinding();
        const registry = new IntegrationRegistry(registryState, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        const invitation = await registry.createInvitation({
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager"), claims: [] },
          connectUrl: "https://example.com/twitch/integrations/connect"
        });
        const reservationId = crypto.randomUUID();
        const reservation = await registry.reserveInvitation({
          token: invitationToken(invitation),
          reservationId,
          reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
        });
        await registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: twitch,
          actor: {
            platform: "twitch",
            id: twitch.id,
            claims: ["twitch.broadcaster"]
          }
        });
        await registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "twitch"
          }]
        });

        realms.mutate("discord", "collision");
        await expect(registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        })).rejects.toMatchObject({
          status: 409,
          code: "integration_state_rediscovery_required"
        });
        const rediscovered = await registry.resumeInvitation({ reservationId });
        expect(rediscovered.pendingIntegration).toMatchObject({
          status: "awaiting_state_resolution",
          stateDiscovery: { version: 2, requiresResolution: true },
          stateResolution: null
        });
        expect(realms.targets.size).toBe(0);
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE invitation_id = ?
             AND event = 'integration.state_discovery.refreshed.v1'`,
          invitation.invitationId
        ).one().total).toBe(1);

        await registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 2,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "twitch"
          }]
        });
        const activated = await registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        });
        expect(activated.integration).toMatchObject({
          status: "active",
          shareableStateGeneration: 2
        });
        expect(registry.getDefaultLink(discord, "twitch")).toMatchObject({
          integration: { shareableStateGeneration: 2 }
        });
      }
    );
  });

  it("resumes a partially materialized realm without duplicating namespace copies", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_registryInstance, registryState) => {
        const realms = finalizingRealmBinding({ failOnceAt: "collision" });
        const registry = new IntegrationRegistry(registryState, {
          ...env,
          SHAREABLE_STATE_REALM: realms.binding
        });
        const invitation = await registry.createInvitation({
          group: discord,
          actor: { platform: "discord", id: uniqueId("manager"), claims: [] },
          connectUrl: "https://example.com/twitch/integrations/connect"
        });
        const reservationId = crypto.randomUUID();
        const reservation = await registry.reserveInvitation({
          token: invitationToken(invitation),
          reservationId,
          reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
        });
        await registry.verifyInvitation({
          invitationId: reservation.invitationId,
          reservationId,
          group: twitch,
          actor: {
            platform: "twitch",
            id: twitch.id,
            claims: ["twitch.broadcaster"]
          }
        });
        await registry.resolveInvitationState({
          reservationId,
          discoveryVersion: 1,
          selections: [{
            featureId: "test.discovery",
            namespaceId: "collision",
            selection: "discord"
          }]
        });

        await expect(registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        })).rejects.toMatchObject({
          status: 503,
          code: "integration_state_finalization_unavailable"
        });
        expect(realms.targets.size).toBe(1);
        expect((await registry.resumeInvitation({ reservationId }))
          .pendingIntegration.status).toBe("awaiting_state_resolution");

        const activated = await registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        });
        expect(activated).toMatchObject({
          replayed: false,
          integration: { status: "active" }
        });
        expect(realms.targets.size).toBe(5);
        expect(realms.materializations.size).toBe(5);
        expect(registryState.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE invitation_id = ?
             AND event = 'integration.state_resolution.applied.v1'`,
          invitation.invitationId
        ).one().total).toBe(1);
      }
    );
  });
});
