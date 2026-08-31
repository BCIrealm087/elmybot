import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { commands } from "../src/platforms/discord/commands.js";
import { CAPABILITIES } from "../src/platforms/discord/discord-permissions.js";
import {
  completeIntegrationInvitation,
  createIntegrationInvitation,
  defaultDiscordTwitchRoutes,
  getIntegrationDefaultLink,
  getIntegrationManagementStatus,
  INTEGRATION_ROUTE_KINDS,
  listIntegrationAudit,
  resolveIntegrationRoutes,
  reserveIntegrationInvitation,
  updateIntegrationRoute
} from "../src/integrations/index.js";

const integrationEnv = {
  ...env,
  TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
  TWITCH_PUBLIC_ORIGIN: "https://example.com",
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_BOT_USER_ID: "bot-user-id",
  TWITCH_EVENTSUB_SECRET: "eventsub-secret",
  DISCORD_TOKEN: "discord-token"
};

let idCounter = 0;
const uniqueId = (prefix) => `${prefix}-${++idCounter}`;
const discordGroup = (id = uniqueId("guild")) => ({
  platform: "discord", kind: "guild", id
});
const discordActor = (id = uniqueId("discord-user")) => ({
  platform: "discord", id, claims: []
});
const twitchGroup = (id = uniqueId("broadcaster")) => ({
  platform: "twitch", kind: "channel", id
});

async function activateIntegration({
  group = discordGroup(),
  actor = discordActor(),
  channel = twitchGroup()
} = {}) {
  const destinationChannelId = uniqueId("discord-channel");
  const invitation = await createIntegrationInvitation(integrationEnv, {
    group,
    actor,
    connectUrl: "https://example.com/twitch/integrations/connect",
    routes: defaultDiscordTwitchRoutes(destinationChannelId)
  });
  const token = new URL(invitation.invitationUrl).hash.slice("#invite=".length);
  const reservationId = crypto.randomUUID();
  const reservation = await reserveIntegrationInvitation(integrationEnv, {
    token,
    reservationId,
    reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
  });
  const completion = await completeIntegrationInvitation(integrationEnv, {
    invitationId: reservation.invitationId,
    reservationId,
    group: channel,
    actor: { platform: "twitch", id: channel.id, claims: ["twitch.broadcaster"] },
    groupLabel: uniqueId("channel")
  });
  return {
    group,
    actor,
    channel,
    destinationChannelId,
    integration: completion.integration
  };
}

function commandInteraction(linked, name, options = []) {
  return {
    id: uniqueId("interaction"),
    guild_id: linked.group.id,
    channel_id: linked.destinationChannelId,
    member: { user: { id: linked.actor.id } },
    data: { name, options }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cross-platform integration management", () => {
  it("requires integration management capability for every operational command", () => {
    for (const name of [
      "integration_status",
      "integration_default_set",
      "integration_route_set",
      "integration_audit",
      "integration_dead_letters",
      "integration_retry_effect"
    ]) {
      expect(commands[name].guild.capability).toBe(CAPABILITIES.INTEGRATION_MANAGE);
    }
  });

  it("shows all routes, updates one through a member group, and records audit history", async () => {
    const linked = await activateIntegration();
    const original = await getIntegrationManagementStatus(integrationEnv, {
      integrationId: linked.integration.id,
      group: linked.group
    });
    expect(original.routes).toHaveLength(3);
    expect(original.routes.every((route) => route.enabled)).toBe(true);

    const newChannelId = uniqueId("retargeted-channel");
    const updated = await updateIntegrationRoute(integrationEnv, {
      integrationId: linked.integration.id,
      group: linked.group,
      actor: linked.actor,
      routeKind: INTEGRATION_ROUTE_KINDS.TWITCH_STREAM_ONLINE_TO_DISCORD,
      enabled: false,
      destination: { channelId: newChannelId }
    });
    expect(updated.route).toMatchObject({
      kind: INTEGRATION_ROUTE_KINDS.TWITCH_STREAM_ONLINE_TO_DISCORD,
      enabled: false,
      destination: { channelId: newChannelId }
    });

    const status = await getIntegrationManagementStatus(integrationEnv, {
      integrationId: linked.integration.id,
      group: linked.group
    });
    expect(status.routes.find(({ kind }) =>
      kind === INTEGRATION_ROUTE_KINDS.TWITCH_STREAM_ONLINE_TO_DISCORD
    )).toMatchObject({ enabled: false, destination: { channelId: newChannelId } });
    expect(await resolveIntegrationRoutes(integrationEnv, {
      sourceGroup: linked.channel,
      routeKind: INTEGRATION_ROUTE_KINDS.TWITCH_STREAM_ONLINE_TO_DISCORD
    })).toEqual({ routes: [] });

    const history = await listIntegrationAudit(integrationEnv, {
      integrationId: linked.integration.id,
      group: linked.group,
      limit: 10
    });
    expect(history.entries[0]).toMatchObject({
      event: "integration.route.updated.v1",
      actor: { platform: "discord", id: linked.actor.id },
      group: linked.group
    });

    const outsider = discordGroup();
    await expect(getIntegrationManagementStatus(integrationEnv, {
      integrationId: linked.integration.id,
      group: outsider
    })).rejects.toMatchObject({ status: 403, code: "integration_group_not_member" });
    await expect(updateIntegrationRoute(integrationEnv, {
      integrationId: linked.integration.id,
      group: outsider,
      actor: discordActor(),
      routeKind: INTEGRATION_ROUTE_KINDS.TWITCH_STREAM_ONLINE_TO_DISCORD,
      enabled: true
    })).rejects.toMatchObject({ status: 403, code: "integration_group_not_member" });
  });

  it("renders bounded status and applies route changes through Discord commands", async () => {
    const linked = await activateIntegration();
    const status = await commands.integration_status.exec(
      commandInteraction(linked, "integration_status", [{
        name: "integration_id", value: linked.integration.id
      }]),
      integrationEnv
    );
    expect(status).toMatchObject({ flags: 64, allowed_mentions: { parse: [] } });
    expect(status.content).toContain(`Integration \`${linked.integration.id}\` is **active**.`);
    expect(status.content).toContain("Effects: none");
    expect(status.content).toContain(INTEGRATION_ROUTE_KINDS.DISCORD_ANNOUNCE_TO_TWITCH);

    const routeResult = await commands.integration_route_set.exec(
      commandInteraction(linked, "integration_route_set", [
        { name: "integration_id", value: linked.integration.id },
        {
          name: "route",
          value: INTEGRATION_ROUTE_KINDS.TWITCH_ANNOUNCE_TO_DISCORD
        },
        { name: "enabled", value: false }
      ]),
      integrationEnv
    );
    expect(routeResult.content).toContain("disabled");
    expect(routeResult.content).toContain(INTEGRATION_ROUTE_KINDS.TWITCH_ANNOUNCE_TO_DISCORD);
  });

  it("shows and switches the Discord guild's default Twitch link", async () => {
    const first = await activateIntegration();
    const second = await activateIntegration({
      group: first.group,
      actor: first.actor
    });

    const before = await commands.integration_list.exec(
      commandInteraction(first, "integration_list"),
      integrationEnv
    );
    const firstLine = before.content.split("\n").find((line) =>
      line.includes(first.integration.id)
    );
    const secondLine = before.content.split("\n").find((line) =>
      line.includes(second.integration.id)
    );
    expect(firstLine).toContain("**default**");
    expect(secondLine).not.toContain("**default**");

    const changed = await commands.integration_default_set.exec(
      commandInteraction(first, "integration_default_set", [{
        name: "integration_id",
        value: second.integration.id
      }]),
      integrationEnv
    );
    expect(changed).toMatchObject({ flags: 64, allowed_mentions: { parse: [] } });
    expect(changed.content).toContain("as this server's default Twitch link");

    expect((await getIntegrationDefaultLink(integrationEnv, {
      sourceGroup: first.group,
      targetPlatform: "twitch"
    })).defaultLink).toMatchObject({
      integration: { id: second.integration.id },
      targetGroup: second.channel
    });

    const unchanged = await commands.integration_default_set.exec(
      commandInteraction(first, "integration_default_set", [{
        name: "integration_id",
        value: second.integration.id
      }]),
      integrationEnv
    );
    expect(unchanged.content).toContain("is already this server's default Twitch link");
  });
});
