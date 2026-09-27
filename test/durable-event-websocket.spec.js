import {
  env,
  evictDurableObject,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  defineDurableEventStream,
  defineFeature,
  frameworkApiVersion
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import {
  durableEventId,
  durableEventRouteId,
  sha256Hex
} from "../src/durable-events/contract.js";
import {
  issueDurableEventGrant,
  revokeDurableEventCredential
} from "../src/durable-events/grant-client.js";
import { handleDurableEventRequest } from "../src/durable-events/http.js";
import {
  DURABLE_EVENT_APPEND_PATH,
  durableEventInternalHeaders
} from "../src/durable-events/stream.js";
import {
  DURABLE_EVENT_SOCKET_CLOSE_CODES,
  DURABLE_EVENT_SOCKET_PING,
  DURABLE_EVENT_SOCKET_PONG,
  DURABLE_EVENT_SOCKET_PROTOCOL,
  DURABLE_EVENT_SOCKET_STATUS,
  DURABLE_EVENT_SOCKET_TYPES
} from "../src/durable-events/socket-contract.js";

const socketEnv = {
  ...env,
  DURABLE_EVENT_STREAMS_ENABLED: "true",
  DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT: "test",
  DURABLE_EVENT_PUBLIC_ORIGIN: "https://example.com",
  DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET:
    "test-durable-event-signing-secret-32-bytes-minimum"
};

let sequence = 800_000;

function target() {
  sequence += 1;
  return { platform: "discord", groupId: String(sequence) };
}

function registry() {
  return createFeatureRegistry([defineFeature({
    apiVersion: frameworkApiVersion,
    id: "test.events",
    description: "Tests durable event sockets.",
    eventStreams: [defineDurableEventStream({
      id: "updates",
      version: 1,
      label: "Updates",
      description: "Test event updates.",
      platforms: ["discord", "twitch"],
      scope: { kind: "group_local" },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: { data: { type: "string", minLength: 1, maxLength: 400 } },
          required: ["data"]
        }
      }
    })]
  })]);
}

async function routeFor(selectedTarget) {
  const descriptor = {
    deploymentEnvironment: "test",
    scopeKind: "group_local",
    realmIdentity: `discord:guild:${selectedTarget.groupId}`,
    featureId: "test.events",
    streamId: "updates",
    version: 1
  };
  return {
    routeId: await durableEventRouteId(descriptor),
    bindingRevision: 0,
    descriptor
  };
}

async function setup() {
  const selectedTarget = target();
  const selectedRegistry = registry();
  const route = await routeFor(selectedTarget);
  const stub = socketEnv.DURABLE_EVENT_STREAM.get(
    socketEnv.DURABLE_EVENT_STREAM.idFromName(route.routeId)
  );
  await runInDurableObject(stub, async (instance) => {
    instance.env = socketEnv;
    instance.registry = selectedRegistry;
  });
  const issued = await issueDurableEventGrant(socketEnv, selectedRegistry, {
    target: selectedTarget,
    stream: "test.events:updates:v1",
    expiresInSeconds: 3_600,
    resetBacklog: false
  }, {
    actor: { platform: "discord", id: "operator" }
  });
  return { selectedTarget, selectedRegistry, route, stub, issued };
}

function nextSocketEvent(socket, type = "message", timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for WebSocket ${type}.`)),
      timeoutMs
    );
    socket.addEventListener(type, (event) => {
      clearTimeout(timeout);
      resolve(event);
    }, { once: true });
  });
}

async function nextMessage(socket) {
  const event = await nextSocketEvent(socket);
  return JSON.parse(event.data);
}

async function nextData(socket) {
  return (await nextSocketEvent(socket)).data;
}

async function openSocket(credential, {
  cookie = false,
  origin,
  path = "/event-stream/socket"
} = {}) {
  const headers = { upgrade: "websocket" };
  if (cookie) headers.cookie = `elmybot_durable_event=${credential}`;
  else headers.authorization = `Bearer ${credential}`;
  if (origin) headers.origin = origin;
  const response = await handleDurableEventRequest(
    new Request(`https://example.com${path}`, { method: "GET", headers }),
    socketEnv
  );
  if (response.status !== 101) return { response, socket: null };
  response.webSocket.accept();
  return { response, socket: response.webSocket };
}

async function register(socket) {
  const ready = nextMessage(socket);
  socket.send(JSON.stringify({
    protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
    type: DURABLE_EVENT_SOCKET_TYPES.register
  }));
  return await ready;
}

async function append(fixture, data) {
  sequence += 1;
  const payload = JSON.stringify({ data });
  const eventId = await durableEventId({
    featureId: "test.events",
    streamId: "updates",
    version: 1,
    originGroupKey: `discord:guild:${fixture.selectedTarget.groupId}`,
    sourceEventId: `discord:interaction:${sequence}`
  });
  let response;
  await runInDurableObject(fixture.stub, async (instance) => {
    instance.env = socketEnv;
    instance.registry = fixture.selectedRegistry;
    response = await instance.fetch(new Request(
      `https://durable-event-stream${DURABLE_EVENT_APPEND_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...durableEventInternalHeaders },
        body: JSON.stringify({
          eventId,
          fingerprint: await sha256Hex(payload),
          featureId: "test.events",
          streamId: "updates",
          version: 1,
          route: fixture.route,
          payload
        })
      }
    ));
  });
  return response;
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

describe("durable event hibernating WebSocket protocol", () => {
  it("authenticates a credential without URL data and enforces cookie origin", async () => {
    const fixture = await setup();
    const query = await openSocket(fixture.issued.credential, {
      path: "/event-stream/socket?credential=forbidden"
    });
    expect(query.response.status).toBe(404);

    const crossOrigin = await openSocket(fixture.issued.credential, {
      cookie: true,
      origin: "https://attacker.example"
    });
    expect(crossOrigin.response.status).toBe(403);

    const opened = await openSocket(fixture.issued.credential, {
      cookie: true,
      origin: "https://example.com"
    });
    expect(opened.response.status).toBe(101);
    closeQuietly(opened.socket);
  });

  it("uses auto-response heartbeat and durably becomes ready after exact registration", async () => {
    const fixture = await setup();
    const { socket } = await openSocket(fixture.issued.credential);
    const pong = nextData(socket);
    socket.send(DURABLE_EVENT_SOCKET_PING);
    expect(await pong).toBe(DURABLE_EVENT_SOCKET_PONG);

    expect(await register(socket)).toEqual({
      protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
      type: DURABLE_EVENT_SOCKET_TYPES.ready,
      stream: { feature: "test.events", stream: "updates", version: 1 },
      delivery: {
        kind: "bounded_at_least_once",
        retentionSeconds: 1_800,
        maxRetainedEvents: 1_000,
        maxRetainedBytes: 1_048_576
      }
    });
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      const meta = state.storage.sql.exec(
        `SELECT consumer_ready, consumer_epoch, consumer_grant_id
         FROM durable_event_stream_metadata WHERE singleton = 1`
      ).one();
      expect(meta).toMatchObject({
        consumer_ready: 1,
        consumer_epoch: 1,
        consumer_grant_id: fixture.issued.grant.id
      });
      expect(await state.storage.getAlarm()).toBe(fixture.issued.grant.expiresAtMs);
    });
    closeQuietly(socket);
  });

  it("delivers one event at a time in order and accepts exact or duplicate acknowledgements", async () => {
    const fixture = await setup();
    const { socket } = await openSocket(fixture.issued.credential);
    await register(socket);
    const firstMessage = nextMessage(socket);
    expect((await append(fixture, "first")).status).toBe(200);
    const first = await firstMessage;
    expect(first).toMatchObject({ type: "event", sequence: 1, payload: { data: "first" } });

    expect((await append(fixture, "second")).status).toBe(200);
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      expect(state.getWebSockets()[0].deserializeAttachment()).toMatchObject({
        sentSequence: 1,
        acknowledgedSequence: 0
      });
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(2);
    });

    const secondMessage = nextMessage(socket);
    acknowledge(socket, first.cursor);
    const second = await secondMessage;
    expect(second).toMatchObject({ type: "event", sequence: 2, payload: { data: "second" } });
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM durable_event_stream_receipts WHERE cursor = ?",
        first.cursor
      );
    });
    acknowledge(socket, first.cursor);
    await new Promise((resolve) => setTimeout(resolve, 20));
    acknowledge(socket, second.cursor);
    await vi.waitFor(async () => {
      await runInDurableObject(fixture.stub, async (_instance, state) => {
        expect(state.storage.sql.exec(
          `SELECT acknowledged_sequence, retained_count
           FROM durable_event_stream_metadata WHERE singleton = 1`
        ).one()).toMatchObject({ acknowledged_sequence: 2, retained_count: 0 });
      });
    });
    closeQuietly(socket);
  });

  it("replays an unacknowledged event and continues across object eviction", async () => {
    const fixture = await setup();
    let opened = await openSocket(fixture.issued.credential);
    await register(opened.socket);
    const originalMessage = nextMessage(opened.socket);
    await append(fixture, "replay-me");
    const original = await originalMessage;
    closeQuietly(opened.socket);
    await vi.waitFor(async () => {
      await runInDurableObject(fixture.stub, async (_instance, state) => {
        expect(state.storage.sql.exec(
          "SELECT consumer_ready FROM durable_event_stream_metadata WHERE singleton = 1"
        ).one().consumer_ready).toBe(0);
      });
    });

    opened = await openSocket(fixture.issued.credential);
    const messages = [];
    opened.socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data));
    });
    opened.socket.send(JSON.stringify({
      protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
      type: DURABLE_EVENT_SOCKET_TYPES.register
    }));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0].type).toBe("ready");
    expect(messages[1]).toEqual(original);

    await evictDurableObject(fixture.stub);
    acknowledge(opened.socket, original.cursor);
    await vi.waitFor(async () => {
      await runInDurableObject(fixture.stub, async (_instance, state) => {
        expect(state.storage.sql.exec(
          "SELECT retained_count FROM durable_event_stream_metadata WHERE singleton = 1"
        ).one().retained_count).toBe(0);
      });
    });
    closeQuietly(opened.socket);
  });

  it("supersedes one consumer without allowing its delayed close to detach the new one", async () => {
    const fixture = await setup();
    const first = await openSocket(fixture.issued.credential);
    await register(first.socket);
    const replaced = nextMessage(first.socket);
    const second = await openSocket(fixture.issued.credential);
    await register(second.socket);
    expect(await replaced).toMatchObject({
      type: "status",
      code: DURABLE_EVENT_SOCKET_STATUS.consumerReplaced,
      terminal: true
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT consumer_ready, consumer_epoch FROM durable_event_stream_metadata
         WHERE singleton = 1`
      ).one()).toMatchObject({ consumer_ready: 1, consumer_epoch: 2 });
    });
    closeQuietly(second.socket);
  });

  it("delivers terminal replacement, revocation, expiry, movement, and retention-gap status", async () => {
    const replacement = await setup();
    const first = await openSocket(replacement.issued.credential);
    await register(first.socket);
    const replacedStatus = nextMessage(first.socket);
    await issueDurableEventGrant(socketEnv, replacement.selectedRegistry, {
      target: replacement.selectedTarget,
      stream: "test.events:updates:v1",
      expiresInSeconds: 3_600,
      resetBacklog: false
    }, { actor: { platform: "discord", id: "operator" } });
    expect(await replacedStatus).toMatchObject({ code: "grant_replaced", terminal: true });

    const revoked = await setup();
    const revokedSocket = await openSocket(revoked.issued.credential);
    await register(revokedSocket.socket);
    const revokedStatus = nextMessage(revokedSocket.socket);
    await revokeDurableEventCredential(socketEnv, revoked.issued.credential);
    expect(await revokedStatus).toMatchObject({ code: "grant_revoked", terminal: true });

    const expired = await setup();
    const expiredSocket = await openSocket(expired.issued.credential);
    await register(expiredSocket.socket);
    const expiredStatus = nextMessage(expiredSocket.socket);
    await runInDurableObject(expired.stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE durable_event_stream_grants SET expires_at_ms = ? WHERE grant_id = ?",
        Date.now() - 1,
        expired.issued.grant.id
      );
      await instance.alarm();
    });
    expect(await expiredStatus).toMatchObject({ code: "grant_expired", terminal: true });

    const moved = await setup();
    const movedSocket = await openSocket(moved.issued.credential);
    await register(movedSocket.socket);
    const movedStatus = nextMessage(movedSocket.socket);
    await runInDurableObject(moved.stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO durable_event_stream_bindings
         (source_group_key, target_platform, binding_revision, source_key,
          status, reason, updated_at_ms)
         VALUES (?, 'twitch', 1, NULL, 'moved', 'test', ?)`,
        `discord:guild:${moved.selectedTarget.groupId}`,
        Date.now()
      );
      await instance.alarm();
    });
    expect(await movedStatus).toMatchObject({ code: "stream_moved", terminal: true });

    const draining = await setup();
    const drainingSocket = await openSocket(draining.issued.credential);
    await register(drainingSocket.socket);
    const drainingEvent = nextMessage(drainingSocket.socket);
    await append(draining, "drain-before-move");
    const retained = await drainingEvent;
    await runInDurableObject(draining.stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO durable_event_stream_bindings
         (source_group_key, target_platform, binding_revision, source_key,
          status, reason, updated_at_ms)
         VALUES (?, 'twitch', 1, NULL, 'moved', 'test', ?)`,
        `discord:guild:${draining.selectedTarget.groupId}`,
        Date.now()
      );
      state.storage.sql.exec(
        "UPDATE durable_event_stream_metadata SET consumer_ready = 0 WHERE singleton = 1"
      );
    });
    const drainedStatus = nextMessage(drainingSocket.socket);
    acknowledge(drainingSocket.socket, retained.cursor);
    expect(await drainedStatus).toMatchObject({ code: "stream_moved", terminal: true });

    const gap = await setup();
    const gapSocket = await openSocket(gap.issued.credential);
    await register(gapSocket.socket);
    const eventMessage = nextMessage(gapSocket.socket);
    await append(gap, "expire-me");
    await eventMessage;
    const gapStatus = nextMessage(gapSocket.socket);
    await runInDurableObject(gap.stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE durable_event_stream_events SET expires_at_ms = ?",
        Date.now() - 1
      );
      await instance.alarm();
    });
    expect(await gapStatus).toMatchObject({ code: "retention_gap", terminal: true });
  });

  it("rejects oversized and unknown acknowledgement frames without advancing state", async () => {
    const oversized = await setup();
    const oversizedSocket = await openSocket(oversized.issued.credential);
    const closed = nextSocketEvent(oversizedSocket.socket, "close");
    oversizedSocket.socket.send("x".repeat(1_025));
    expect((await closed).code).toBe(DURABLE_EVENT_SOCKET_CLOSE_CODES.messageTooLarge);

    const invalid = await setup();
    const invalidSocket = await openSocket(invalid.issued.credential);
    await register(invalidSocket.socket);
    const eventMessage = nextMessage(invalidSocket.socket);
    await append(invalid, "protected");
    await eventMessage;
    const invalidClose = nextSocketEvent(invalidSocket.socket, "close");
    acknowledge(invalidSocket.socket, `dec1.${"A".repeat(43)}`);
    expect((await invalidClose).code).toBe(DURABLE_EVENT_SOCKET_CLOSE_CODES.policyViolation);
    await runInDurableObject(invalid.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT acknowledged_sequence, retained_count
         FROM durable_event_stream_metadata WHERE singleton = 1`
      ).one()).toMatchObject({ acknowledged_sequence: 0, retained_count: 1 });
    });
  });

  it("recovers capacity after acknowledgement without polling", async () => {
    const fixture = await setup();
    const { socket } = await openSocket(fixture.issued.credential);
    await register(socket);
    const eventMessage = nextMessage(socket);
    await append(fixture, "held");
    const held = await eventMessage;
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE durable_event_stream_metadata SET retained_count = 1000
         WHERE singleton = 1`
      );
    });
    expect((await append(fixture, "blocked")).status).toBe(429);
    acknowledge(socket, held.cursor);
    await vi.waitFor(async () => {
      await runInDurableObject(fixture.stub, async (_instance, state) => {
        expect(state.storage.sql.exec(
          "SELECT acknowledged_sequence FROM durable_event_stream_metadata WHERE singleton = 1"
        ).one().acknowledged_sequence).toBe(1);
      });
    });
    const recoveredMessage = nextMessage(socket);
    expect((await append(fixture, "recovered")).status).toBe(200);
    expect(await recoveredMessage).toMatchObject({ payload: { data: "recovered" } });
    closeQuietly(socket);
  });
});
