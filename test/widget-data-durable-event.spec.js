import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { actionRegistry, executeAction } from "../src/actions/index.js";
import { featureRegistry } from "../src/features/index.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import {
  IntegrationRegistry,
  integrationRegistryStub
} from "../src/integrations/index.js";
import {
  issueDurableEventGrant,
  parseDurableEventCredential
} from "../src/durable-events/grant-client.js";
import { handleDurableEventRequest } from "../src/durable-events/http.js";
import {
  DURABLE_EVENT_SOCKET_PROTOCOL,
  DURABLE_EVENT_SOCKET_TYPES
} from "../src/durable-events/socket-contract.js";
import { commands as discordCommands } from "../src/platforms/discord/commands.js";
import { commands as twitchCommands } from "../src/platforms/twitch/commands.js";

const widgetEnv = {
  ...env,
  DURABLE_EVENT_STREAMS_ENABLED: "true",
  DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT: "test",
  DURABLE_EVENT_PUBLIC_ORIGIN: "https://example.com",
  DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET:
    "test-durable-event-signing-secret-32-bytes-minimum"
};

let sequence = 950_000;

function nextId() {
  sequence += 1;
  return String(sequence);
}

function group(platform, id) {
  return {
    platform,
    kind: platform === "discord" ? "guild" : "channel",
    id,
    key: `${platform}:${platform === "discord" ? "guild" : "channel"}:${id}`
  };
}

async function installSymmetricIntegration(discord, twitch) {
  const integrationId = crypto.randomUUID();
  await runInDurableObject(
    integrationRegistryStub(widgetEnv),
    async (instance, state) => {
      const nowMs = Date.now();
      state.storage.sql.exec(
        `INSERT INTO integrations
         (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
          created_by_platform, created_by_actor_id, completed_by_platform,
          completed_by_actor_id, shareable_state_generation)
         VALUES (?, 'active', ?, ?, ?, 'discord', 'manager', 'twitch',
                 'broadcaster', 1)`,
        integrationId,
        nowMs,
        nowMs,
        nowMs
      );
      for (const member of [discord, twitch]) {
        state.storage.sql.exec(
          `INSERT INTO integration_members
           (integration_id, group_key, platform, group_kind, group_id, joined_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
          integrationId,
          member.key,
          member.platform,
          member.kind,
          member.id,
          nowMs
        );
      }
      const registry = new IntegrationRegistry(state, widgetEnv);
      registry.assignDefaultLinkIfAbsent({
        sourceGroup: discord,
        targetGroup: twitch,
        integrationId,
        nowMs
      });
      registry.assignDefaultLinkIfAbsent({
        sourceGroup: twitch,
        targetGroup: discord,
        integrationId,
        nowMs
      });
      instance.env = widgetEnv;
    }
  );
  return integrationId;
}

function nextMessage(socket, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for a widget event.")),
      timeoutMs
    );
    socket.addEventListener("message", (message) => {
      clearTimeout(timeout);
      resolve(JSON.parse(message.data));
    }, { once: true });
  });
}

async function openConsumer(credential) {
  const parsed = await parseDurableEventCredential(widgetEnv, credential);
  const stub = widgetEnv.DURABLE_EVENT_STREAM.get(
    widgetEnv.DURABLE_EVENT_STREAM.idFromName(parsed.routeId)
  );
  await runInDurableObject(stub, async (instance) => {
    instance.env = widgetEnv;
    instance.registry = featureRegistry;
  });
  const response = await handleDurableEventRequest(new Request(
    "https://example.com/event-stream/socket",
    { headers: { upgrade: "websocket", authorization: `Bearer ${credential}` } }
  ), widgetEnv, { registry: featureRegistry });
  if (response.status !== 101) {
    throw new Error(`Consumer socket failed (${response.status}): ${await response.text()}`);
  }
  response.webSocket.accept();
  const ready = nextMessage(response.webSocket);
  response.webSocket.send(JSON.stringify({
    protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
    type: DURABLE_EVENT_SOCKET_TYPES.register
  }));
  expect(await ready).toMatchObject({
    protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
    type: DURABLE_EVENT_SOCKET_TYPES.ready,
    stream: { feature: "widget.data", stream: "updates", version: 1 }
  });
  return response.webSocket;
}

function acknowledge(socket, cursor) {
  socket.send(JSON.stringify({
    protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
    type: DURABLE_EVENT_SOCKET_TYPES.acknowledge,
    cursor
  }));
}

function closeQuietly(socket) {
  try { socket?.close(1000, "Test complete"); } catch { /* already closed */ }
}

async function discordCommand(discord, data) {
  const interaction = {
    id: crypto.randomUUID(),
    type: 2,
    guild_id: discord.id,
    channel_id: nextId(),
    data: {
      name: "widget_data",
      options: [{ name: "data", value: data }]
    },
    member: {
      permissions: "8192",
      roles: [],
      user: { id: nextId() }
    }
  };
  return await discordCommands.widget_data.exec(
    interaction,
    widgetEnv,
    "widget_data",
    {
      sourceInteraction: interaction,
      authorizedCapability: "framework.moderators"
    }
  );
}

async function twitchCommand(twitch, data) {
  const broadcaster = twitch.id;
  return await twitchCommands.widgetdata.exec({
    broadcaster_user_id: broadcaster,
    chatter_user_id: broadcaster,
    badges: [{ set_id: "broadcaster" }]
  }, widgetEnv, {
    messageId: crypto.randomUUID(),
    argsText: data
  });
}

describe("widget-data durable event migration", () => {
  it("installs one event stream and no legacy state-query or shareable-state surface", () => {
    expect(featureRegistry.eventStreams["widget.data:updates:v1"]).toMatchObject({
      featureId: "widget.data",
      definition: {
        id: "updates",
        version: 1,
        scope: { kind: "effective_shareable" }
      }
    });
    expect(featureRegistry.readableState["widget.data:latest:v1"]).toBeUndefined();
    expect(featureRegistry.featuresById["widget.data"].shareableState).toEqual([]);
    expect(featureRegistry.actions["widget.data.emit.v2"]).toMatchObject({
      uses: { services: ["eventStreams"] }
    });
    expect(featureRegistry.actions["widget.data.publish.v1"]).toBeUndefined();
  });

  it("delivers linked Discord and Twitch commands in order and replays an unacked event", async () => {
    const discord = group("discord", nextId());
    const twitch = group("twitch", nextId());
    await installSymmetricIntegration(discord, twitch);
    const issued = await issueDurableEventGrant(widgetEnv, featureRegistry, {
      target: { platform: "discord", groupId: discord.id },
      stream: "widget.data:updates:v1",
      expiresInSeconds: 3_600,
      resetBacklog: false
    }, { actor: { platform: "discord", id: nextId() } });
    const socket = await openConsumer(issued.credential);

    try {
      const firstMessage = nextMessage(socket);
      await expect(discordCommand(discord, "same consumer string")).resolves.toEqual({
        content: "Widget event queued.",
        allowed_mentions: { parse: [] }
      });
      const first = await firstMessage;
      expect(first).toMatchObject({
        type: DURABLE_EVENT_SOCKET_TYPES.event,
        sequence: 1,
        payload: { data: "same consumer string", origin: "discord" }
      });
      acknowledge(socket, first.cursor);

      const secondMessage = nextMessage(socket);
      await expect(twitchCommand(twitch, "same consumer string"))
        .resolves.toBe("Widget event queued.");
      const second = await secondMessage;
      expect(second).toMatchObject({
        type: DURABLE_EVENT_SOCKET_TYPES.event,
        sequence: 2,
        payload: { data: "same consumer string", origin: "twitch" }
      });
      expect(second.eventId).not.toBe(first.eventId);

      closeQuietly(socket);
      const replaySocket = await openConsumer(issued.credential);
      try {
        const replay = await nextMessage(replaySocket);
        expect(replay).toMatchObject({
          type: DURABLE_EVENT_SOCKET_TYPES.event,
          eventId: second.eventId,
          sequence: 2,
          payload: second.payload
        });
        acknowledge(replaySocket, replay.cursor);
      } finally {
        closeQuietly(replaySocket);
      }

      const parsed = await parseDurableEventCredential(widgetEnv, issued.credential);
      const stub = widgetEnv.DURABLE_EVENT_STREAM.get(
        widgetEnv.DURABLE_EVENT_STREAM.idFromName(parsed.routeId)
      );
      await vi.waitFor(async () => {
        await runInDurableObject(stub, async (_instance, state) => {
          expect(state.storage.sql.exec(
            `SELECT acknowledged_sequence, retained_count
             FROM durable_event_stream_metadata WHERE singleton = 1`
          ).one()).toMatchObject({ acknowledged_sequence: 2, retained_count: 0 });
        });
      });
    } finally {
      closeQuietly(socket);
    }
  }, 15_000);

  it("commits one logical widget event for a same-source action retry", async () => {
    const discord = group("discord", nextId());
    const issued = await issueDurableEventGrant(widgetEnv, featureRegistry, {
      target: { platform: "discord", groupId: discord.id },
      stream: "widget.data:updates:v1",
      expiresInSeconds: 3_600,
      resetBacklog: false
    }, { actor: { platform: "discord", id: nextId() } });
    const socket = await openConsumer(issued.credential);
    const invocation = createCommandInvocation({
      kind: "widget.data.emit.v2",
      origin: {
        group: discord,
        actor: { platform: "discord", id: nextId(), claims: [] }
      },
      args: { data: "retry payload" },
      sourceEventId: "discord:interaction:same-widget-command"
    });
    const runtime = createFeatureServiceRuntime(widgetEnv, invocation, featureRegistry);
    const execute = () => executeAction(actionRegistry, invocation, {
      triggerKind: "command",
      featureServices: runtime.featureServices,
      authorize: async () => true,
      claimFeatureCooldown: async () => ({ allowed: true, retryAfterSeconds: 0 })
    });

    try {
      const delivered = nextMessage(socket);
      await expect(execute()).resolves.toMatchObject({
        output: { message: "Widget event queued." }
      });
      await expect(execute()).resolves.toMatchObject({
        output: { message: "Widget event queued." }
      });
      const event = await delivered;
      expect(event.payload).toEqual({
        data: "retry payload",
        origin: "discord"
      });

      const parsed = await parseDurableEventCredential(widgetEnv, issued.credential);
      const stub = widgetEnv.DURABLE_EVENT_STREAM.get(
        widgetEnv.DURABLE_EVENT_STREAM.idFromName(parsed.routeId)
      );
      await runInDurableObject(stub, async (_instance, state) => {
        expect(Number(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM durable_event_stream_events"
        ).one().total)).toBe(1);
        expect(Number(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM durable_event_stream_receipts"
        ).one().total)).toBe(1);
        expect(Number(state.storage.sql.exec(
          `SELECT next_sequence FROM durable_event_stream_metadata
           WHERE singleton = 1`
        ).one().next_sequence)).toBe(2);
      });
    } finally {
      closeQuietly(socket);
    }
  }, 10_000);
});
