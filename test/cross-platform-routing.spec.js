import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  completeIntegrationInvitation,
  createIntegrationInvitation,
  defaultTwitchToDiscordRoutes,
  getIntegrationExecution,
  integrationCoordinatorStub,
  reserveIntegrationInvitation
} from "../src/integrations/index.js";
import { commands as twitchCommands } from "../src/platforms/twitch/commands.js";
import {
  processTwitchStreamOnlineNotification
} from "../src/platforms/twitch/eventsub-definitions.js";

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

let sequence = 0;
const uniqueId = (prefix) => `${prefix}-${++sequence}`;

function invitationToken(invitation) {
  return new URL(invitation.invitationUrl).hash.slice("#invite=".length);
}

async function activateRoutedIntegration({
  broadcasterId = uniqueId("broadcaster"),
  guildId = uniqueId("guild"),
  channelId = uniqueId("discord-channel")
} = {}) {
  const invitation = await createIntegrationInvitation(integrationEnv, {
    group: { platform: "discord", kind: "guild", id: guildId },
    actor: { platform: "discord", id: uniqueId("discord-user"), claims: [] },
    connectUrl: "https://example.com/twitch/integrations/connect",
    routes: defaultTwitchToDiscordRoutes(channelId)
  });
  const reservationId = crypto.randomUUID();
  const reservation = await reserveIntegrationInvitation(integrationEnv, {
    token: invitationToken(invitation),
    reservationId,
    reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
  });
  const result = await completeIntegrationInvitation(integrationEnv, {
    invitationId: reservation.invitationId,
    reservationId,
    group: { platform: "twitch", kind: "channel", id: broadcasterId },
    actor: {
      platform: "twitch",
      id: broadcasterId,
      claims: ["twitch.broadcaster"]
    },
    groupLabel: "linked_channel"
  });
  return {
    broadcasterId,
    guildId,
    channelId,
    integration: result.integration
  };
}

async function deliverIntegrationEffects(linked) {
  await runInDurableObject(
    integrationCoordinatorStub(integrationEnv, linked.integration.id),
    async (instance) => instance.alarm()
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Twitch-to-Discord vertical slices", () => {
  it("routes an authorized Twitch !announce through the durable Discord outbox", async () => {
    const linked = await activateRoutedIntegration();
    const messageId = uniqueId("announce-message");
    const reply = await twitchCommands.announce.exec({
      broadcaster_user_id: linked.broadcasterId,
      chatter_user_id: uniqueId("moderator"),
      badges: [{ set_id: "moderator" }]
    }, integrationEnv, {
      messageId,
      argsText: "Hello linked Discord!"
    });

    expect(reply).toBe("Announcement queued for 1 Discord channel.");
    const sourceEventId = `twitch:eventsub:${messageId}`;
    expect(await getIntegrationExecution(
      integrationEnv,
      linked.integration.id,
      sourceEventId
    )).toMatchObject({
      state: "pending",
      effects: [{
        kind: "discord.message.send.v1",
        state: "pending",
        targetGroupKey: `discord:guild:${linked.guildId}`
      }]
    });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverIntegrationEffects(linked);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://discord.com/api/v10/channels/${linked.channelId}/messages`
    );
    expect(JSON.parse(init.body)).toEqual({
      content: "Hello linked Discord!",
      allowed_mentions: { parse: [] }
    });
  });

  it("does not publish !announce for an ordinary Twitch chatter", async () => {
    const linked = await activateRoutedIntegration();
    const reply = await twitchCommands.announce.exec({
      broadcaster_user_id: linked.broadcasterId,
      chatter_user_id: uniqueId("chatter"),
      badges: []
    }, integrationEnv, {
      messageId: uniqueId("unauthorized-message"),
      argsText: "This should not leave Twitch"
    });

    expect(reply).toBe("Only the broadcaster or a moderator can use !announce.");
    await runInDurableObject(
      integrationCoordinatorStub(integrationEnv, linked.integration.id),
      async (_instance, state) => {
        expect(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM integration_executions"
        ).one().total).toBe(0);
      }
    );
  });

  it("routes stream.online EventSub events to the configured Discord channel", async () => {
    const linked = await activateRoutedIntegration();
    const messageId = uniqueId("stream-online-message");
    const startedAt = "2026-08-28T18:00:00Z";

    await processTwitchStreamOnlineNotification({
      subscription: {
        type: "stream.online",
        version: "1",
        condition: { broadcaster_user_id: linked.broadcasterId }
      },
      event: {
        id: uniqueId("stream"),
        broadcaster_user_id: linked.broadcasterId,
        broadcaster_user_login: "linked_channel",
        broadcaster_user_name: "Linked_Channel",
        type: "live",
        started_at: startedAt
      }
    }, integrationEnv, messageId, startedAt);

    const sourceEventId = `twitch:eventsub:${messageId}`;
    expect(await getIntegrationExecution(
      integrationEnv,
      linked.integration.id,
      sourceEventId
    )).toMatchObject({
      state: "pending",
      effects: [{ kind: "discord.message.send.v1", state: "pending" }]
    });

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverIntegrationEffects(linked);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://discord.com/api/v10/channels/${linked.channelId}/messages`
    );
    expect(JSON.parse(init.body)).toEqual({
      content: "🔴 Linked_Channel is live on Twitch! " +
        "https://www.twitch.tv/linked_channel",
      allowed_mentions: { parse: [] }
    });
  });

  it("fans one Twitch announcement out across independently linked guilds", async () => {
    const broadcasterId = uniqueId("shared-broadcaster");
    const first = await activateRoutedIntegration({ broadcasterId });
    const second = await activateRoutedIntegration({ broadcasterId });
    const messageId = uniqueId("fanout-message");

    const reply = await twitchCommands.announce.exec({
      broadcaster_user_id: broadcasterId,
      chatter_user_id: broadcasterId,
      badges: [{ set_id: "broadcaster" }]
    }, integrationEnv, {
      messageId,
      argsText: "Hello every linked server"
    });

    expect(reply).toBe("Announcement queued for 2 Discord channels.");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await deliverIntegrationEffects(first);
    await deliverIntegrationEffects(second);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual([
      `https://discord.com/api/v10/channels/${first.channelId}/messages`,
      `https://discord.com/api/v10/channels/${second.channelId}/messages`
    ].sort());
  });
});
