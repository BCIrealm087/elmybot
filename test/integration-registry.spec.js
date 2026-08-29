import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  env,
  runInDurableObject
} from "cloudflare:test";
import worker from "../src/index.js";
import { commands } from "../src/platforms/discord/commands.js";
import {
  CAPABILITIES,
  checkPermissions
} from "../src/platforms/discord/discord-permissions.js";
import {
  completeIntegrationInvitation,
  createIntegrationInvitation,
  INTEGRATION_INVITATION_TTL_MS,
  integrationRegistryStub,
  listIntegrationsForGroup,
  reserveIntegrationInvitation
} from "../src/integrations/index.js";
import { twitchChannelAuthObjectName } from "../src/platforms/twitch/channel-auth.js";

const integrationEnv = {
  ...env,
  TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
  TWITCH_PUBLIC_ORIGIN: "https://example.com",
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_BOT_USER_ID: "bot-user-id",
  TWITCH_EVENTSUB_SECRET: "eventsub-secret"
};

let idCounter = 0;

function uniqueId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function discordGroup(id = uniqueId("guild")) {
  return { platform: "discord", kind: "guild", id };
}

function discordActor(id = uniqueId("discord-user")) {
  return { platform: "discord", id, claims: [] };
}

function twitchGroup(id = uniqueId("broadcaster")) {
  return { platform: "twitch", kind: "channel", id };
}

function twitchActor(id) {
  return { platform: "twitch", id, claims: ["twitch.broadcaster"] };
}

function invitationToken(invitation) {
  return new URL(invitation.invitationUrl).hash.slice("#invite=".length);
}

async function activateIntegration({
  group = discordGroup(),
  actor = discordActor(),
  channel = twitchGroup(),
  login = uniqueId("channel")
} = {}) {
  const invitation = await createIntegrationInvitation(integrationEnv, {
    group,
    actor,
    connectUrl: "https://example.com/twitch/integrations/connect"
  });
  const reservationId = crypto.randomUUID();
  const reservation = await reserveIntegrationInvitation(integrationEnv, {
    token: invitationToken(invitation),
    reservationId,
    reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
  });
  const completion = await completeIntegrationInvitation(integrationEnv, {
    invitationId: reservation.invitationId,
    reservationId,
    group: channel,
    actor: twitchActor(channel.id),
    groupLabel: login
  });
  return { group, actor, channel, invitation, reservation, completion };
}

async function beginIntegrationOAuth(token) {
  const response = await worker.fetch(
    new Request("https://example.com/twitch/integrations/connect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ invite: token })
    }),
    integrationEnv,
    createExecutionContext()
  );
  const location = response.headers.get("location");
  return {
    response,
    authorizationUrl: location ? new URL(location) : null
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cross-platform integration linking", () => {
  it("keeps link management strict while allowing moderators to publish", async () => {
    expect(commands.integration_link_twitch.guild.capability)
      .toBe(CAPABILITIES.INTEGRATION_MANAGE);
    expect(commands.integration_list.guild.capability)
      .toBe(CAPABILITIES.INTEGRATION_MANAGE);
    expect(commands.integration_unlink.guild.capability)
      .toBe(CAPABILITIES.INTEGRATION_MANAGE);
    expect(commands.integration_announce_twitch.guild.capability)
      .toBe(CAPABILITIES.INTEGRATION_ANNOUNCEMENT_PUBLISH);

    const guildId = uniqueId("guild");
    const manager = await checkPermissions({
      guild_id: guildId,
      member: {
        permissions: "32",
        roles: [],
        user: { id: uniqueId("manager") }
      }
    }, integrationEnv, { capability: CAPABILITIES.INTEGRATION_MANAGE });
    expect(manager.ok).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ owner_id: "owner" })));
    const ordinaryModerator = await checkPermissions({
      guild_id: guildId,
      member: {
        permissions: "8192",
        roles: [],
        user: { id: uniqueId("moderator") }
      }
    }, integrationEnv, { capability: CAPABILITIES.INTEGRATION_MANAGE });
    expect(ordinaryModerator.ok).toBe(false);
    const announcementPublisher = await checkPermissions({
      guild_id: guildId,
      member: {
        permissions: "8192",
        roles: [],
        user: { id: uniqueId("moderator") }
      }
    }, integrationEnv, {
      capability: CAPABILITIES.INTEGRATION_ANNOUNCEMENT_PUBLISH
    });
    expect(announcementPublisher.ok).toBe(true);

    const ordinaryMember = await checkPermissions({
      guild_id: guildId,
      member: {
        permissions: "0",
        roles: [],
        user: { id: uniqueId("ordinary-member") }
      }
    }, integrationEnv, {
      capability: CAPABILITIES.INTEGRATION_ANNOUNCEMENT_PUBLISH
    });
    expect(ordinaryMember.ok).toBe(false);
  });

  it("creates a hashed, short-lived invitation and reserves it once", async () => {
    const group = discordGroup();
    const actor = discordActor();
    const channelId = uniqueId("discord-channel");
    const result = await commands.integration_link_twitch.exec({
      id: uniqueId("interaction"),
      guild_id: group.id,
      channel_id: channelId,
      member: { user: { id: actor.id } }
    }, integrationEnv);
    const invitationUrl = result.content.match(/<(https:[^>]+)>/u)?.[1];
    const token = new URL(invitationUrl).hash.slice("#invite=".length);

    expect(result.flags).toBe(64);
    expect(invitationUrl).toMatch(
      /^https:\/\/example\.com\/twitch\/integrations\/connect#invite=[0-9a-f]{64}$/
    );
    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (_instance, state) => {
        const rows = state.storage.sql.exec(
          "SELECT token_hash, status, expires_at_ms FROM integration_invitations"
        ).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("pending");
        expect(rows[0].token_hash).not.toBe(token);
        expect(JSON.stringify(rows)).not.toContain(token);
        expect(rows[0].expires_at_ms).toBeGreaterThan(
          Date.now() + INTEGRATION_INVITATION_TTL_MS - 10_000
        );
        const routes = state.storage.sql.exec(
          `SELECT route_kind, source_platform, target_platform, destination_json
           FROM integration_invitation_routes ORDER BY route_kind`
        ).toArray();
        expect(routes).toEqual([
          {
            route_kind: "discord.announce-to-twitch.v1",
            source_platform: "discord",
            target_platform: "twitch",
            destination_json: "{}"
          },
          {
            route_kind: "twitch.announce-to-discord.v1",
            source_platform: "twitch",
            target_platform: "discord",
            destination_json: JSON.stringify({ channelId })
          },
          {
            route_kind: "twitch.stream-online-to-discord.v1",
            source_platform: "twitch",
            target_platform: "discord",
            destination_json: JSON.stringify({ channelId })
          }
        ]);
      }
    );

    const page = await worker.fetch(
      new Request("https://example.com/twitch/integrations/connect"),
      integrationEnv,
      createExecutionContext()
    );
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("Link Twitch to Discord");

    const { response, authorizationUrl } = await beginIntegrationOAuth(token);
    expect(response.status).toBe(303);
    expect(authorizationUrl.origin).toBe("https://id.twitch.tv");
    expect(authorizationUrl.searchParams.get("scope")).toBe("channel:bot");

    const replay = await beginIntegrationOAuth(token);
    expect(replay.response.status).toBe(400);
    expect(await replay.response.text()).toContain("already been used");
  });

  it("derives the broadcaster through OAuth and activates a discoverable link", async () => {
    const group = discordGroup();
    const actor = discordActor();
    const invitation = await createIntegrationInvitation(integrationEnv, {
      group,
      actor,
      connectUrl: "https://example.com/twitch/integrations/connect"
    });
    const { authorizationUrl } = await beginIntegrationOAuth(invitationToken(invitation));
    const state = authorizationUrl.searchParams.get("state");
    const broadcasterId = uniqueId("broadcaster");
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (input === "https://id.twitch.tv/oauth2/token") {
        expect(init.body.get("code")).toBe("authorization-code");
        return Response.json({
          access_token: "broadcaster-access-token",
          refresh_token: "broadcaster-refresh-token",
          expires_in: 14400,
          scope: ["channel:bot"],
          token_type: "bearer"
        });
      }
      expect(input).toBe("https://id.twitch.tv/oauth2/validate");
      return Response.json({
        client_id: "client-id",
        user_id: broadcasterId,
        login: "linked_channel",
        scopes: ["channel:bot"],
        expires_in: 14390
      });
    }));

    const callback = new URL("https://example.com/twitch/channels/oauth/callback");
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", state);
    const response = await worker.fetch(
      new Request(callback),
      integrationEnv,
      createExecutionContext()
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Twitch and Discord are linked");
    expect(html).toContain("linked_channel");

    const listed = await listIntegrationsForGroup(integrationEnv, group);
    expect(listed.total).toBe(1);
    expect(listed.integrations[0]).toMatchObject({
      status: "active",
      members: expect.arrayContaining([
        expect.objectContaining({
          group: expect.objectContaining({
            key: `discord:guild:${group.id}`
          })
        }),
        expect.objectContaining({
          group: expect.objectContaining({
            key: `twitch:channel:${broadcasterId}`
          }),
          label: "linked_channel"
        })
      ])
    });

    const listResult = await commands.integration_list.exec({
      guild_id: group.id,
      member: { user: { id: actor.id } }
    }, integrationEnv);
    expect(listResult.content).toContain("linked_channel");
    expect(listResult.content).toContain(listed.integrations[0].id);

    const unlinkResult = await commands.integration_unlink.exec({
      guild_id: group.id,
      member: { user: { id: actor.id } },
      data: {
        options: [{ name: "integration_id", value: listed.integrations[0].id }]
      }
    }, integrationEnv);
    expect(unlinkResult.content).toContain("Unlinked integration");
    expect((await listIntegrationsForGroup(integrationEnv, group)).total).toBe(0);
  });

  it("requires the OAuth-derived actor to be the Twitch broadcaster", async () => {
    const group = discordGroup();
    const invitation = await createIntegrationInvitation(integrationEnv, {
      group,
      actor: discordActor(),
      connectUrl: "https://example.com/twitch/integrations/connect"
    });
    const reservationId = crypto.randomUUID();
    const reservation = await reserveIntegrationInvitation(integrationEnv, {
      token: invitationToken(invitation),
      reservationId,
      reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
    });
    const channel = twitchGroup();

    await expect(completeIntegrationInvitation(integrationEnv, {
      invitationId: reservation.invitationId,
      reservationId,
      group: channel,
      actor: twitchActor(uniqueId("different-user"))
    })).rejects.toMatchObject({
      status: 403,
      code: "integration_twitch_broadcaster_required"
    });

    const completion = await completeIntegrationInvitation(integrationEnv, {
      invitationId: reservation.invitationId,
      reservationId,
      group: channel,
      actor: twitchActor(channel.id)
    });
    expect(completion.integration.status).toBe("active");

    const replayed = await completeIntegrationInvitation(integrationEnv, {
      invitationId: reservation.invitationId,
      reservationId,
      group: channel,
      actor: twitchActor(channel.id)
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.integration.id).toBe(completion.integration.id);
  });

  it("rejects invitations after their short-lived expiry", async () => {
    const invitation = await createIntegrationInvitation(integrationEnv, {
      group: discordGroup(),
      actor: discordActor(),
      connectUrl: "https://example.com/twitch/integrations/connect"
    });
    vi.spyOn(Date, "now").mockReturnValue(invitation.expiresAtMs + 1);

    await expect(reserveIntegrationInvitation(integrationEnv, {
      token: invitationToken(invitation),
      reservationId: crypto.randomUUID(),
      reservationExpiresAtMs: invitation.expiresAtMs + 5 * 60 * 1000
    })).rejects.toMatchObject({
      code: "integration_invitation_invalid"
    });
  });

  it("reuses an existing active integration for the same group pair", async () => {
    const group = discordGroup();
    const channel = twitchGroup();
    const first = await activateIntegration({ group, channel });
    const second = await activateIntegration({ group, channel });

    expect(second.completion.alreadyLinked).toBe(true);
    expect(second.completion.integration.id).toBe(first.completion.integration.id);
    expect((await listIntegrationsForGroup(integrationEnv, group)).total).toBe(1);
  });

  it("revokes active links when the Twitch channel authorization disconnects", async () => {
    const active = await activateIntegration();
    const broadcasterId = active.channel.id;
    const authStub = env.TWITCH_CHANNEL_AUTH.get(
      env.TWITCH_CHANNEL_AUTH.idFromName(twitchChannelAuthObjectName(broadcasterId))
    );
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      expect(input).toBe("https://id.twitch.tv/oauth2/revoke");
      return new Response(null, { status: 200 });
    }));

    await runInDurableObject(authStub, async (instance, state) => {
      instance.env = integrationEnv;
      await state.storage.put("channelAuthorization", {
        status: "authorized",
        accessToken: "channel-access-token",
        refreshToken: "channel-refresh-token",
        expiresAtMs: Date.now() + 4 * 60 * 60 * 1000,
        lastValidatedAtMs: Date.now(),
        authorizedAtMs: Date.now(),
        clientId: "client-id",
        userId: broadcasterId,
        login: "linked_channel",
        scopes: ["channel:bot"],
        callbackUrl: "https://example.com/twitch",
        provisioningPending: false,
        deconfigurationPending: false,
        integrationCompletionPending: null,
        integrationDeactivationPending: false
      });
      await instance.disconnect();
    });

    expect((await listIntegrationsForGroup(integrationEnv, active.group)).total).toBe(0);
  });
});
