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

describe("Pending integration shareable-state discovery", () => {
  it("classifies automatic outcomes and persists only safe collision metadata", async () => {
    const discord = discordGroup();
    const twitch = twitchGroup();
    await runInDurableObject(
      integrationRegistryStub(env),
      async (_registryInstance, registryState) => {
        const discoveryEnv = {
          ...env,
          SHAREABLE_STATE_REALM: {
            idFromName: (name) => name,
            get: (name) => ({
              fetch: async () => Response.json(
                inventory(name.includes("discord:guild") ? "discord" : "twitch")
              )
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

        await expect(registry.activateInvitation({
          invitationId: invitation.invitationId,
          reservationId
        })).rejects.toMatchObject({
          status: 409,
          code: "integration_state_finalization_required"
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
      }
    );
  });
});
