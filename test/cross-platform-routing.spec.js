import nacl from "tweetnacl";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/index.js";
import {
  completeIntegrationInvitation,
  createIntegrationInvitation,
  defaultDiscordTwitchRoutes,
  getIntegrationExecution,
  integrationCoordinatorStub,
  reserveIntegrationInvitation
} from "../src/integrations/index.js";
import { commands as twitchCommands } from "../src/platforms/twitch/commands.js";
import { commands as discordCommands } from "../src/platforms/discord/commands.js";
import {
  SCHEDULED_TWITCH_ANNOUNCEMENT_KIND
} from "../src/features/scheduled-twitch-announcements/feature.js";
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
const uniqueId = (prefix) => `${prefix}-cross-platform-${++sequence}`;

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signedDiscordRequest(interaction, keyPair) {
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const body = JSON.stringify(interaction);
  const signature = nacl.sign.detached(
    new TextEncoder().encode(timestamp + body),
    keyPair.secretKey
  );
  return new Request("https://example.com/discord", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-Ed25519": toHex(signature),
      "X-Signature-Timestamp": timestamp
    },
    body
  });
}

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
    routes: defaultDiscordTwitchRoutes(channelId)
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

async function stubIntegrationDelivery(linked, kind, deliver) {
  await runInDurableObject(
    integrationCoordinatorStub(integrationEnv, linked.integration.id),
    async (instance) => {
      const handler = instance.effectHandlers[kind];
      instance.effectHandlers = Object.freeze({
        ...instance.effectHandlers,
        [kind]: Object.freeze({ ...handler, deliver })
      });
    }
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord-to-Twitch vertical slice", () => {
  it("routes an authorized Discord announcement through the Twitch outbox", async () => {
    const linked = await activateRoutedIntegration();
    const twitchDelivery = vi.fn(async (_env, effect) => {
      expect(effect).toMatchObject({
        kind: "twitch.chat.send.v1",
        target: {
          group: {
            platform: "twitch",
            kind: "channel",
            id: linked.broadcasterId
          }
        },
        payload: { message: "Hello linked Twitch chat!" }
      });
      return { messageId: "twitch-message-id" };
    });
    await stubIntegrationDelivery(
      linked,
      "twitch.chat.send.v1",
      twitchDelivery
    );
    const interaction = {
      id: uniqueId("discord-interaction"),
      type: 2,
      application_id: "discord-app-id",
      token: uniqueId("interaction-token"),
      guild_id: linked.guildId,
      channel_id: linked.channelId,
      member: {
        user: { id: uniqueId("discord-moderator") },
        permissions: "8192",
        roles: []
      },
      data: {
        name: "integration_announce_twitch",
        options: [{ name: "message", value: "Hello linked Twitch chat!" }]
      }
    };
    const keyPair = nacl.sign.keyPair();
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toContain(
        `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`
      );
      expect(JSON.parse(init.body).content)
        .toBe("Announcement queued for 1 Twitch channel.");
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      signedDiscordRequest(interaction, keyPair),
      { ...integrationEnv, PUBLIC_KEY: toHex(keyPair.publicKey) },
      ctx
    );
    expect(await response.json()).toEqual({
      type: 5,
      data: { flags: 64, allowed_mentions: { parse: [] } }
    });
    await waitOnExecutionContext(ctx);
    const sourceEventId = `discord:interaction:${interaction.id}`;
    // The test runtime may run a due Durable Object alarm automatically. Calling
    // the alarm explicitly is safe after either outcome: it delivers pending
    // work or observes that the outbox effect has already completed.
    await deliverIntegrationEffects(linked);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(twitchDelivery).toHaveBeenCalledOnce();
    expect(await getIntegrationExecution(
      integrationEnv,
      linked.integration.id,
      sourceEventId
    )).toMatchObject({
      sourceGroupKey: `discord:guild:${linked.guildId}`,
      state: "completed",
      effects: [{
        kind: "twitch.chat.send.v1",
        targetGroupKey: `twitch:channel:${linked.broadcasterId}`,
        state: "delivered",
        attempts: 1,
        result: { messageId: "twitch-message-id" }
      }]
    });
  });

  it("persists and replays a bounded-random routed-action occurrence plan", async () => {
    const linked = await activateRoutedIntegration();
    await stubIntegrationDelivery(
      linked,
      "twitch.chat.send.v1",
      async () => ({ messageId: "scheduled-twitch-message" })
    );
    const interaction = {
      id: uniqueId("scheduled-interaction"),
      guild_id: linked.guildId,
      channel_id: linked.channelId,
      member: { user: { id: uniqueId("discord-moderator") } },
      data: {
        name: "integration_schedule_twitch",
        options: [
          { name: "message", value: "A recurring linked announcement" },
          { name: "min_interval", value: 600 },
          { name: "max_interval", value: 600 }
        ]
      }
    };
    const reply = await discordCommands.integration_schedule_twitch.exec(
      interaction,
      integrationEnv,
      "integration_schedule_twitch",
      {
        sourceInteraction: interaction,
        authorizedCapability: "integration.announcement.publish"
      }
    );
    expect(reply.content).toContain("✅ Scheduled job");
    expect(reply.content).toContain("Repeats randomly");

    const scheduler = integrationEnv.SCHEDULER.get(
      integrationEnv.SCHEDULER.idFromName(`discord:guild:${linked.guildId}`)
    );
    let occurrenceSourceEventId;
    let persistedPlanJson;
    await runInDurableObject(scheduler, async (instance, state) => {
      const row = state.storage.sql.exec(
        "SELECT id, job_json FROM scheduler_jobs LIMIT 1"
      ).one();
      const job = JSON.parse(row.job_json);
      job.timestamp = Math.floor(Date.now() / 1000) - 1;
      job.runAtMs = job.timestamp * 1000;
      job.delivery.nextAttemptAtMs = job.runAtMs;
      state.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET next_attempt_at_ms = ?, run_at_ms = ?, job_json = ?
         WHERE id = ?`,
        job.runAtMs,
        job.runAtMs,
        JSON.stringify(job),
        job.id
      );

      const original = instance.jobHandlers[SCHEDULED_TWITCH_ANNOUNCEMENT_KIND];
      instance.jobHandlers = Object.freeze({
        ...instance.jobHandlers,
        [SCHEDULED_TWITCH_ANNOUNCEMENT_KIND]: Object.freeze({
          ...original,
          deliver: async () => {
            throw new Error("temporary coordinator outage");
          }
        })
      });
      await instance.alarm();

      const afterFailure = JSON.parse(state.storage.sql.exec(
        "SELECT job_json FROM scheduler_jobs WHERE id = ?",
        job.id
      ).one().job_json);
      expect(afterFailure.occurrencePlan).toMatchObject({
        schemaVersion: 1,
        actionKind: "integration.announcement.publish.v1",
        actionArgs: { message: "A recurring linked announcement" },
        routes: [{
          kind: "discord.announce-to-twitch.v1",
          targetGroup: { id: linked.broadcasterId }
        }],
        effects: [{
          kind: "twitch.chat.send.v1",
          payload: { message: "A recurring linked announcement" }
        }]
      });
      occurrenceSourceEventId = afterFailure.occurrencePlan.sourceEventId;
      persistedPlanJson = JSON.stringify(afterFailure.occurrencePlan);

      afterFailure.delivery.nextAttemptAtMs = Date.now() - 1;
      state.storage.sql.exec(
        `UPDATE scheduler_jobs
         SET next_attempt_at_ms = ?, job_json = ?
         WHERE id = ?`,
        afterFailure.delivery.nextAttemptAtMs,
        JSON.stringify(afterFailure),
        job.id
      );
      instance.jobHandlers = Object.freeze({
        ...instance.jobHandlers,
        [SCHEDULED_TWITCH_ANNOUNCEMENT_KIND]: original
      });
      await instance.alarm();

      const nextOccurrence = JSON.parse(state.storage.sql.exec(
        "SELECT job_json FROM scheduler_jobs WHERE id = ?",
        job.id
      ).one().job_json);
      expect(nextOccurrence.timestamp).toBeGreaterThan(job.timestamp);
      expect(nextOccurrence.occurrencePlan).toBeNull();
    });

    expect(persistedPlanJson).toContain(occurrenceSourceEventId);
    await deliverIntegrationEffects(linked);
    expect(await getIntegrationExecution(
      integrationEnv,
      linked.integration.id,
      occurrenceSourceEventId
    )).toMatchObject({
      sourceGroupKey: `discord:guild:${linked.guildId}`,
      state: "completed",
      effects: [{
        kind: "twitch.chat.send.v1",
        state: "delivered"
      }]
    });
  });
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
