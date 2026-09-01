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
  createCommandInvocation,
  createIntegrationInvitation,
  getIntegrationDefaultLink,
  INTEGRATION_INVITATION_RETENTION_MS,
  INTEGRATION_INVITATION_TTL_MS,
  integrationRegistryStub,
  listIntegrationsForGroup,
  reserveIntegrationInvitation,
  revokeIntegration,
  revokeIntegrationsForGroup,
  setIntegrationDefaultLink
} from "../src/integrations/index.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { initializeRegistryTables } from "../src/integrations/registry-schema.js";
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

async function prepareIntegration({
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
  return { group, actor, channel, invitation, reservation, login };
}

async function completePreparedIntegration(prepared) {
  const completion = await completeIntegrationInvitation(integrationEnv, {
    invitationId: prepared.reservation.invitationId,
    reservationId: prepared.reservation.reservationId,
    group: prepared.channel,
    actor: twitchActor(prepared.channel.id),
    groupLabel: prepared.login
  });
  return { ...prepared, completion };
}

async function activateIntegration(options = {}) {
  return await completePreparedIntegration(await prepareIntegration(options));
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
    expect(commands.integration_default_set.guild.capability)
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

  it("automatically assigns the first active link in both directions", async () => {
    const linked = await activateIntegration();
    const integrationId = linked.completion.integration.id;
    const discordDefault = await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: linked.group,
      targetPlatform: "twitch"
    });
    const twitchDefault = await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: linked.channel,
      targetPlatform: "discord"
    });

    expect(discordDefault.defaultLink).toMatchObject({
      sourceGroup: linked.group,
      targetPlatform: "twitch",
      integration: { id: integrationId },
      targetGroup: linked.channel
    });
    expect(twitchDefault.defaultLink).toMatchObject({
      sourceGroup: linked.channel,
      targetPlatform: "discord",
      integration: { id: integrationId },
      targetGroup: linked.group
    });

    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (_instance, state) => {
        expect(state.storage.sql.exec(
          `SELECT source_group_key, target_platform, integration_id,
                  target_group_key
           FROM integration_default_links
           WHERE integration_id = ?
           ORDER BY source_group_key`,
          integrationId
        ).toArray()).toEqual([
          {
            source_group_key: linked.group.key ?? `discord:guild:${linked.group.id}`,
            target_platform: "twitch",
            integration_id: integrationId,
            target_group_key: linked.channel.key ?? `twitch:channel:${linked.channel.id}`
          },
          {
            source_group_key: linked.channel.key ?? `twitch:channel:${linked.channel.id}`,
            target_platform: "discord",
            integration_id: integrationId,
            target_group_key: linked.group.key ?? `discord:guild:${linked.group.id}`
          }
        ]);
      }
    );
  });

  it("exposes the invocation group's default through the feature service runtime", async () => {
    const linked = await activateIntegration();
    const invocation = createCommandInvocation({
      kind: "test.default-link.read.v1",
      origin: { group: linked.group, actor: linked.actor },
      sourceEventId: "discord:interaction:feature-default-link"
    });
    const runtime = createFeatureServiceRuntime(integrationEnv, invocation);

    await expect(runtime.featureServices.links.default(
      "test.default-link",
      "twitch"
    )).resolves.toMatchObject({
      sourceGroup: linked.group,
      targetPlatform: "twitch",
      integration: { id: linked.completion.integration.id },
      targetGroup: linked.channel
    });
  });

  it("shares feature state through an active integration and blocks it after revocation", async () => {
    const linked = await activateIntegration();
    const discordInvocation = createCommandInvocation({
      kind: "test.integration-state.read.v1",
      origin: { group: linked.group, actor: linked.actor },
      sourceEventId: "discord:interaction:integration-state"
    });
    const discordRuntime = createFeatureServiceRuntime(
      integrationEnv,
      discordInvocation
    );
    const discordLink = await discordRuntime.featureServices.links.default(
      "test.integration-state",
      "twitch"
    );
    const descriptor = {
      name: "score",
      subject: "shared-game",
      min: 0,
      max: 100,
      initial: 0
    };

    await expect(discordRuntime.featureServices.integrationState.boundedCounter(
      "test.integration-state",
      discordLink,
      descriptor,
      "increment",
      1
    )).resolves.toBe(1);

    const twitchInvocation = createCommandInvocation({
      kind: "test.integration-state.read.v1",
      origin: {
        group: linked.channel,
        actor: twitchActor(linked.channel.id)
      },
      sourceEventId: "twitch:chat:integration-state"
    });
    const twitchRuntime = createFeatureServiceRuntime(
      integrationEnv,
      twitchInvocation
    );
    const twitchLink = await twitchRuntime.featureServices.links.default(
      "test.integration-state",
      "discord"
    );
    await expect(twitchRuntime.featureServices.integrationState.boundedCounter(
      "test.integration-state",
      twitchLink,
      descriptor,
      "get"
    )).resolves.toBe(1);

    await expect(discordRuntime.featureServices.integrationState.get(
      "test.integration-state",
      {
        ...discordLink,
        sourceGroup: discordGroup("outside-guild")
      },
      "value"
    )).rejects.toMatchObject({
      status: 403,
      code: "integration_feature_state_member_invalid"
    });

    await revokeIntegration(integrationEnv, {
      integrationId: linked.completion.integration.id,
      group: linked.group,
      actor: linked.actor,
      reason: "test_revocation"
    });
    await expect(discordRuntime.featureServices.integrationState.boundedCounter(
      "test.integration-state",
      discordLink,
      descriptor,
      "get"
    )).rejects.toMatchObject({
      status: 409,
      code: "integration_inactive"
    });
  });

  it("backfills defaults for active links created before the default table", async () => {
    const linked = await activateIntegration();
    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM integration_default_links WHERE integration_id = ?",
          linked.completion.integration.id
        );
        initializeRegistryTables(state);
        expect(state.storage.sql.exec(
          `SELECT source_group_key, target_platform, integration_id
           FROM integration_default_links
           WHERE integration_id = ?
           ORDER BY source_group_key`,
          linked.completion.integration.id
        ).toArray()).toEqual([
          {
            source_group_key: `discord:guild:${linked.group.id}`,
            target_platform: "twitch",
            integration_id: linked.completion.integration.id
          },
          {
            source_group_key: `twitch:channel:${linked.channel.id}`,
            target_platform: "discord",
            integration_id: linked.completion.integration.id
          }
        ]);
      }
    );
  });

  it("does not replace a directional default when a later link is assigned", async () => {
    const group = discordGroup();
    const first = await activateIntegration({ group, channel: twitchGroup() });
    const second = await activateIntegration({ group, channel: twitchGroup() });
    const unchanged = await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: group,
      targetPlatform: "twitch"
    });

    expect(unchanged.defaultLink.integration.id)
      .toBe(first.completion.integration.id);
    expect(unchanged.defaultLink.targetGroup).toMatchObject(first.channel);
    expect(unchanged.defaultLink.integration.id)
      .not.toBe(second.completion.integration.id);

    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (_instance, state) => {
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_default_links
           WHERE source_group_key = ?`,
          `discord:guild:${group.id}`
        ).one().total).toBe(1);
      }
    );
  });

  it("keeps four many-to-many defaults independent in both directions", async () => {
    const firstGuild = discordGroup();
    const secondGuild = discordGroup();
    const firstChannel = twitchGroup();
    const secondChannel = twitchGroup();
    const firstActor = discordActor();
    const secondActor = discordActor();
    const firstToFirst = await activateIntegration({
      group: firstGuild,
      actor: firstActor,
      channel: firstChannel
    });
    const firstToSecond = await activateIntegration({
      group: firstGuild,
      actor: firstActor,
      channel: secondChannel
    });
    const secondToFirst = await activateIntegration({
      group: secondGuild,
      actor: secondActor,
      channel: firstChannel
    });
    await activateIntegration({
      group: secondGuild,
      actor: secondActor,
      channel: secondChannel
    });

    await setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: firstGuild,
      targetGroup: secondChannel,
      integrationId: firstToSecond.completion.integration.id,
      actor: firstActor
    });
    await setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: firstChannel,
      targetGroup: secondGuild,
      integrationId: secondToFirst.completion.integration.id,
      actor: twitchActor(firstChannel.id)
    });

    const defaults = await Promise.all([
      getIntegrationDefaultLink(integrationEnv, {
        sourceGroup: firstGuild,
        targetPlatform: "twitch"
      }),
      getIntegrationDefaultLink(integrationEnv, {
        sourceGroup: secondGuild,
        targetPlatform: "twitch"
      }),
      getIntegrationDefaultLink(integrationEnv, {
        sourceGroup: firstChannel,
        targetPlatform: "discord"
      }),
      getIntegrationDefaultLink(integrationEnv, {
        sourceGroup: secondChannel,
        targetPlatform: "discord"
      })
    ]);
    expect(defaults.map(({ defaultLink }) => defaultLink.targetGroup.id)).toEqual([
      secondChannel.id,
      firstChannel.id,
      secondGuild.id,
      firstGuild.id
    ]);
    expect(defaults[1].defaultLink.integration.id)
      .toBe(secondToFirst.completion.integration.id);
    expect(defaults[3].defaultLink.integration.id)
      .toBe(firstToSecond.completion.integration.id);
    expect(defaults[0].defaultLink.integration.id)
      .not.toBe(firstToFirst.completion.integration.id);
  });

  it("serializes concurrent first-link completion to one directional winner", async () => {
    const group = discordGroup();
    const actor = discordActor();
    const [first, second] = await Promise.all([
      activateIntegration({ group, actor, channel: twitchGroup() }),
      activateIntegration({ group, actor, channel: twitchGroup() })
    ]);
    const candidates = new Set([
      first.completion.integration.id,
      second.completion.integration.id
    ]);
    const selected = (await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: group,
      targetPlatform: "twitch"
    })).defaultLink;

    expect(candidates.has(selected.integration.id)).toBe(true);
    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (_instance, state) => {
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_default_links
           WHERE source_group_key = ? AND target_platform = 'twitch'`,
          `discord:guild:${group.id}`
        ).one().total).toBe(1);
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_audit
           WHERE group_key = ? AND event = 'integration.default.assigned.v1'`,
          `discord:guild:${group.id}`
        ).one().total).toBe(1);
      }
    );
  });

  it("allows an owning platform actor to switch but not unset its default", async () => {
    const group = discordGroup();
    const actor = discordActor();
    const first = await activateIntegration({ group, actor, channel: twitchGroup() });
    const second = await activateIntegration({ group, actor, channel: twitchGroup() });
    const switchedAtMs = Date.now() + 1_000;
    vi.spyOn(Date, "now").mockReturnValue(switchedAtMs);

    const switched = await setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: group,
      targetGroup: second.channel,
      integrationId: second.completion.integration.id,
      actor
    });
    expect(switched).toMatchObject({
      changed: true,
      defaultLink: {
        sourceGroup: group,
        targetPlatform: "twitch",
        integration: { id: second.completion.integration.id },
        targetGroup: second.channel,
        updatedAtMs: switchedAtMs
      }
    });
    expect(switched.defaultLink.createdAtMs).toBeLessThan(switchedAtMs);

    await expect(setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: group,
      targetGroup: second.channel,
      integrationId: second.completion.integration.id,
      actor: twitchActor(second.channel.id)
    })).rejects.toMatchObject({
      status: 403,
      code: "integration_actor_platform_mismatch"
    });
    await expect(setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: group,
      targetGroup: null,
      integrationId: first.completion.integration.id,
      actor
    })).rejects.toMatchObject({ code: "integration_identity_invalid" });

    const unchanged = await setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: group,
      targetGroup: second.channel,
      integrationId: second.completion.integration.id,
      actor
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.defaultLink.updatedAtMs).toBe(switchedAtMs);

    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (_instance, state) => {
        expect(state.storage.sql.exec(
          `SELECT event, actor_platform, actor_id, group_key
           FROM integration_audit
           WHERE integration_id = ? AND event = 'integration.default.updated.v1'`,
          second.completion.integration.id
        ).toArray()).toEqual([{
          event: "integration.default.updated.v1",
          actor_platform: "discord",
          actor_id: actor.id,
          group_key: `discord:guild:${group.id}`
        }]);
      }
    );
  });

  it("rejects invalid directional default-link ownership", async () => {
    const linked = await activateIntegration();

    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (instance) => {
        expect(() => instance.assignDefaultLinkIfAbsent({
          sourceGroup: linked.group,
          targetGroup: discordGroup(),
          integrationId: linked.completion.integration.id
        })).toThrow(expect.objectContaining({
          code: "integration_default_platform_invalid"
        }));
        expect(() => instance.assignDefaultLinkIfAbsent({
          sourceGroup: linked.group,
          targetGroup: twitchGroup(),
          integrationId: linked.completion.integration.id
        })).toThrow(expect.objectContaining({
          code: "integration_default_target_not_member"
        }));
      }
    );
  });

  it("prevents a source manager from selecting another group's integration", async () => {
    const owned = await activateIntegration();
    const foreign = await activateIntegration();

    await expect(setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: owned.group,
      targetGroup: foreign.channel,
      integrationId: foreign.completion.integration.id,
      actor: owned.actor
    })).rejects.toMatchObject({
      status: 403,
      code: "integration_group_not_member"
    });
    await expect(setIntegrationDefaultLink(integrationEnv, {
      sourceGroup: owned.group,
      targetGroup: foreign.channel,
      integrationId: owned.completion.integration.id,
      actor: owned.actor
    })).rejects.toMatchObject({
      status: 422,
      code: "integration_default_target_not_member"
    });
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: owned.group,
      targetPlatform: "twitch"
    })).defaultLink).toMatchObject({
      integration: { id: owned.completion.integration.id },
      targetGroup: owned.channel
    });
  });

  it("falls back independently in each direction and clears only the last link", async () => {
    const firstGuild = discordGroup();
    const secondGuild = discordGroup();
    const firstChannel = twitchGroup();
    const secondChannel = twitchGroup();
    const first = await activateIntegration({
      group: firstGuild,
      channel: firstChannel
    });
    const discordFallback = await activateIntegration({
      group: firstGuild,
      channel: secondChannel
    });
    const twitchFallback = await activateIntegration({
      group: secondGuild,
      channel: firstChannel
    });

    await revokeIntegration(integrationEnv, {
      integrationId: first.completion.integration.id,
      group: firstGuild,
      actor: first.actor,
      reason: "test_default_fallback"
    });

    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: firstGuild,
      targetPlatform: "twitch"
    })).defaultLink).toMatchObject({
      integration: { id: discordFallback.completion.integration.id },
      targetGroup: secondChannel
    });
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: firstChannel,
      targetPlatform: "discord"
    })).defaultLink).toMatchObject({
      integration: { id: twitchFallback.completion.integration.id },
      targetGroup: secondGuild
    });

    await revokeIntegration(integrationEnv, {
      integrationId: discordFallback.completion.integration.id,
      group: firstGuild,
      actor: discordFallback.actor,
      reason: "test_last_link"
    });
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: firstGuild,
      targetPlatform: "twitch"
    })).defaultLink).toBeNull();

    const replacement = await activateIntegration({
      group: firstGuild,
      channel: twitchGroup()
    });
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: firstGuild,
      targetPlatform: "twitch"
    })).defaultLink).toMatchObject({
      integration: { id: replacement.completion.integration.id },
      targetGroup: replacement.channel
    });
  });

  it("repairs counterpart defaults during a group-wide revocation", async () => {
    const firstGuild = discordGroup();
    const secondGuild = discordGroup();
    const sharedChannel = twitchGroup();
    const otherChannel = twitchGroup();
    const first = await activateIntegration({
      group: firstGuild,
      channel: sharedChannel
    });
    const fallback = await activateIntegration({
      group: secondGuild,
      channel: sharedChannel
    });
    await activateIntegration({
      group: firstGuild,
      actor: first.actor,
      channel: otherChannel
    });

    await expect(revokeIntegrationsForGroup(integrationEnv, {
      group: firstGuild,
      actor: first.actor,
      reason: "test_group_default_repair"
    })).resolves.toEqual({ revoked: 2, pending: false });

    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: firstGuild,
      targetPlatform: "twitch"
    })).defaultLink).toBeNull();
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: sharedChannel,
      targetPlatform: "discord"
    })).defaultLink).toMatchObject({
      integration: { id: fallback.completion.integration.id },
      targetGroup: secondGuild
    });
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: otherChannel,
      targetPlatform: "discord"
    })).defaultLink).toBeNull();
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: secondGuild,
      targetPlatform: "twitch"
    })).defaultLink).toMatchObject({
      integration: { id: fallback.completion.integration.id },
      targetGroup: sharedChannel
    });
  });

  it("converges when revocation races replacement-link completion", async () => {
    const group = discordGroup();
    const actor = discordActor();
    const original = await activateIntegration({
      group,
      actor,
      channel: twitchGroup()
    });
    const replacement = await prepareIntegration({
      group,
      actor,
      channel: twitchGroup()
    });

    const [revoked, completed] = await Promise.all([
      revokeIntegration(integrationEnv, {
        integrationId: original.completion.integration.id,
        group,
        actor,
        reason: "test_concurrent_replacement"
      }),
      completePreparedIntegration(replacement)
    ]);

    expect(revoked.revoked).toBe(true);
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: group,
      targetPlatform: "twitch"
    })).defaultLink).toMatchObject({
      integration: { id: completed.completion.integration.id },
      targetGroup: replacement.channel
    });
    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (_instance, state) => {
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_default_links
           WHERE integration_id = ?`,
          original.completion.integration.id
        ).one().total).toBe(0);
      }
    );
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
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: active.group,
      targetPlatform: "twitch"
    })).defaultLink).toBeNull();
    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: active.channel,
      targetPlatform: "discord"
    })).defaultLink).toBeNull();
  });

  it("expires and continues large maintenance batches through alarms", async () => {
    const prefix = uniqueId("expiry-batch");
    const nowMs = Date.now();
    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (instance, state) => {
        for (let index = 0; index < 51; index += 1) {
          state.storage.sql.exec(
            `INSERT INTO integration_invitations
              (invitation_id, discord_group_key, discord_group_id,
               discord_actor_id, status, created_at_ms, expires_at_ms)
             VALUES (?, 'discord:guild:batch', 'batch', 'actor', 'pending', ?, ?)`,
            `${prefix}-${index}`,
            nowMs - 2_000,
            nowMs - 1_000
          );
        }

        expect(await instance.expireInvitations()).toBe(50);
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_invitations
           WHERE invitation_id LIKE ? AND status = 'pending'`,
          `${prefix}-%`
        ).one().total).toBe(1);

        await instance.alarm();
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integration_invitations
           WHERE invitation_id LIKE ? AND status = 'expired'`,
          `${prefix}-%`
        ).one().total).toBe(51);
        expect(await state.storage.getAlarm()).toBeGreaterThan(nowMs);
      }
    );
  });

  it("prunes terminal invitation payloads after retention but preserves audit", async () => {
    const oldInvitationId = uniqueId("old-invitation");
    const recentInvitationId = uniqueId("recent-invitation");
    const nowMs = Date.now();
    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (instance, state) => {
        for (const [invitationId, completedAtMs] of [
          [oldInvitationId, nowMs - INTEGRATION_INVITATION_RETENTION_MS - 1],
          [recentInvitationId, nowMs]
        ]) {
          state.storage.sql.exec(
            `INSERT INTO integration_invitations
              (invitation_id, discord_group_key, discord_group_id,
               discord_actor_id, status, created_at_ms, expires_at_ms,
               completed_at_ms)
             VALUES (?, 'discord:guild:retention', 'retention', 'actor',
                     'completed', ?, ?, ?)`,
            invitationId,
            completedAtMs,
            completedAtMs,
            completedAtMs
          );
          state.storage.sql.exec(
            `INSERT INTO integration_invitation_routes
              (invitation_id, route_kind, source_platform, target_platform,
               destination_json)
             VALUES (?, 'twitch.retention-test.v1', 'twitch', 'discord', '{}')`,
            invitationId
          );
        }
        state.storage.sql.exec(
          `INSERT INTO integration_audit
            (invitation_id, event, occurred_at_ms)
           VALUES (?, 'integration.invitation.completed.v1', ?)`,
          oldInvitationId,
          nowMs - INTEGRATION_INVITATION_RETENTION_MS - 1
        );

        expect(instance.pruneTerminalInvitations()).toBe(1);
        expect(state.storage.sql.exec(
          `SELECT invitation_id FROM integration_invitations
           WHERE invitation_id IN (?, ?) ORDER BY invitation_id`,
          oldInvitationId,
          recentInvitationId
        ).toArray()).toEqual([{ invitation_id: recentInvitationId }]);
        expect(state.storage.sql.exec(
          `SELECT invitation_id FROM integration_invitation_routes
           WHERE invitation_id IN (?, ?)`,
          oldInvitationId,
          recentInvitationId
        ).toArray()).toEqual([{ invitation_id: recentInvitationId }]);
        expect(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM integration_audit WHERE invitation_id = ?",
          oldInvitationId
        ).one().total).toBe(1);
      }
    );
  });

  it("continues oversized group revocations durably in bounded batches", async () => {
    const group = discordGroup();
    const groupKey = `discord:guild:${group.id}`;
    const prefix = uniqueId("revocation-batch");
    const nowMs = Date.now();
    await runInDurableObject(
      integrationRegistryStub(integrationEnv),
      async (instance, state) => {
        for (let index = 0; index < 51; index += 1) {
          const integrationId = `${prefix}-${index}`;
          state.storage.sql.exec(
            `INSERT INTO integrations
              (integration_id, status, created_at_ms, updated_at_ms,
               activated_at_ms, created_by_platform, created_by_actor_id,
               completed_by_platform, completed_by_actor_id)
             VALUES (?, 'active', ?, ?, ?, 'discord', 'actor', 'twitch', 'actor')`,
            integrationId,
            nowMs + index,
            nowMs + index,
            nowMs + index
          );
          state.storage.sql.exec(
            `INSERT INTO integration_members
              (integration_id, group_key, platform, group_kind, group_id,
               joined_at_ms)
             VALUES (?, ?, 'discord', 'guild', ?, ?)`,
            integrationId,
            groupKey,
            group.id,
            nowMs
          );
        }

        expect(await instance.revokeForGroup({ group, reason: "test" }))
          .toEqual({ revoked: 50, pending: true });
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integrations
           WHERE integration_id LIKE ? AND status = 'active'`,
          `${prefix}-%`
        ).one().total).toBe(1);

        await instance.alarm();
        expect(state.storage.sql.exec(
          `SELECT COUNT(*) AS total FROM integrations
           WHERE integration_id LIKE ? AND status = 'revoked'`,
          `${prefix}-%`
        ).one().total).toBe(51);
        expect(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM integration_group_revocations WHERE group_key = ?",
          groupKey
        ).one().total).toBe(0);
      }
    );
  });
});
