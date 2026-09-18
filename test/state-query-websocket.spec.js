import {
  env,
  evictDurableObject,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { featureRegistry } from "../src/features/index.js";
import {
  createCommandInvocation,
  createPlatformGroupRef
} from "../src/integrations/contracts.js";
import {
  issueStateQueryGrant,
  revokeStateQueryCredential
} from "../src/state-querying/grant-client.js";
import {
  drainStateQueryGrantInvalidations,
  handleStateQueryGrantStorageRequest
} from "../src/state-querying/grant-storage.js";
import { grantPermissionsForExportList } from "../src/state-querying/grants.js";
import { handleStateQueryRequest } from "../src/state-querying/http.js";
import { stateQueryOperationalSnapshot } from "../src/state-querying/operations.js";
import { stateQueryObserverObjectName } from
  "../src/state-querying/source-notifications.js";
import {
  STATE_QUERY_SOCKET_CLOSE_CODES,
  STATE_QUERY_SOCKET_LIMITS,
  STATE_QUERY_SOCKET_MESSAGE_TYPES,
  STATE_QUERY_SOCKET_PING,
  STATE_QUERY_SOCKET_PONG,
  STATE_QUERY_SOCKET_PROTOCOL
} from "../src/state-querying/stream-contract.js";
import { shareableStateRealmStub } from "../src/shareable-state/index.js";

const socketEnv = {
  ...env,
  STATE_QUERY_PUBLIC_ORIGIN: "https://example.com",
  STATE_QUERY_STREAMS_ENABLED: "true",
  STATE_QUERY_STREAM_TRANSPORT: "hibernating_websocket",
  STATE_QUERY_CREDENTIAL_SIGNING_SECRET:
    "test-state-query-signing-secret-32-bytes-minimum"
};
let sequence = 0;

function selectedTarget() {
  return { platform: "discord", groupId: `discord-state-query-socket-${++sequence}` };
}

function group(target) {
  return createPlatformGroupRef({
    platform: target.platform,
    kind: target.platform === "discord" ? "guild" : "channel",
    id: target.groupId
  });
}

function countQuery(target) {
  return {
    version: 1,
    target,
    bindings: {
      count: {
        read: { feature: "fun.deaths", export: "count", version: 1 },
        arguments: { game: { literal: "Hades" } }
      }
    },
    select: { deaths: { ref: "count", path: ["count"] } }
  };
}

async function issue(target) {
  return await issueStateQueryGrant(socketEnv, featureRegistry, {
    target,
    permissions: grantPermissionsForExportList(
      featureRegistry,
      target.platform,
      "fun.deaths:count:v1"
    ),
    expiresInSeconds: 3600
  }, { actor: { platform: target.platform, id: "operator" } });
}

function servicesFor(target) {
  return createFeatureServiceRuntime(socketEnv, createCommandInvocation({
    kind: "test.state-query.socket.v1",
    origin: {
      group: group(target),
      actor: { platform: target.platform, id: "operator", claims: [] }
    },
    sourceEventId: `discord:state-query-socket:${++sequence}`
  })).featureServices;
}

async function setCount(target, value) {
  const services = servicesFor(target);
  const scope = await services.shareableState.current(
    "fun.deaths",
    "twitch",
    "game_deaths"
  );
  await services.shareableState.boundedCounter("fun.deaths", scope, {
    name: "game",
    subject: "hades",
    subjectLabel: "Hades",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    initial: 0
  }, "set", value);
  return scope;
}

function observerStub(target) {
  return socketEnv.STATE_QUERY_OBSERVER.get(socketEnv.STATE_QUERY_OBSERVER.idFromName(
    stateQueryObserverObjectName(env.STATE_QUERY_DEPLOYMENT_ENVIRONMENT, group(target))
  ));
}

function groupConfigStub(target) {
  return socketEnv.CONFIG.get(socketEnv.CONFIG.idFromName(group(target).key));
}

async function acknowledge(socket, target, event) {
  socket.send(JSON.stringify({
    protocol: STATE_QUERY_SOCKET_PROTOCOL,
    type: STATE_QUERY_SOCKET_MESSAGE_TYPES.acknowledge,
    cursor: event.cursor
  }));
  await vi.waitFor(async () => {
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      const attachment = state.getWebSockets().find((candidate) =>
        candidate.deserializeAttachment()?.subscriptionId === event.payload.subscriptionId
      )?.deserializeAttachment();
      expect(attachment?.acknowledgedSequence).toBe(event.sequence);
    });
  });
}

async function drainMutation(target, scope, rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await runInDurableObject(shareableStateRealmStub(socketEnv, scope.realm),
      async (instance) => { await instance.alarm(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runInDurableObject(observerStub(target),
      async (instance) => { await instance.alarm(); });
  }
}

function nextSocketEvent(socket, type = "message") {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for WebSocket ${type}.`)),
      2_000
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

async function openSocket(target, credential, {
  cookie = false,
  origin,
  selectedEnv = socketEnv
} = {}) {
  const headers = { upgrade: "websocket" };
  if (cookie) headers.cookie = `elmybot_state_query=${credential}`;
  else if (credential) headers.authorization = `Bearer ${credential}`;
  if (origin) headers.origin = origin;
  const response = await handleStateQueryRequest(new Request(
    "https://example.com/state-query/socket",
    { method: "GET", headers }
  ), selectedEnv);
  if (response.status !== 101) return { response, socket: null };
  response.webSocket.accept();
  return { response, socket: response.webSocket };
}

async function register(socket, target, recovery = {}) {
  const received = nextMessage(socket);
  socket.send(JSON.stringify({
    protocol: STATE_QUERY_SOCKET_PROTOCOL,
    type: STATE_QUERY_SOCKET_MESSAGE_TYPES.register,
    queries: [{ id: "deaths", query: countQuery(target) }],
    ...recovery
  }));
  return await received;
}

function closeQuietly(socket) {
  try { socket?.close(1000, "Test complete"); } catch { /* already closed */ }
}

describe("hibernating state-query WebSockets", () => {
  it("commits revocation intent atomically and retries failed invalidation delivery", async () => {
    const revokedTarget = selectedTarget();
    const stub = groupConfigStub(revokedTarget);
    await runInDurableObject(stub, async (_instance, state) => {
      const nowMs = Date.now();
      const request = (body) => new Request("https://group-config/internal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const grantId = crypto.randomUUID();
      const secretDigest = "test-secret-digest";
      const common = {
        grantId,
        secretDigest,
        environment: env.STATE_QUERY_DEPLOYMENT_ENVIRONMENT,
        target: revokedTarget
      };
      await handleStateQueryGrantStorageRequest(state, request({
        grantId,
        secretDigest,
        grant: {
          environment: env.STATE_QUERY_DEPLOYMENT_ENVIRONMENT,
          target: revokedTarget,
          permissions: {},
          limits: {},
          issuedAtMs: nowMs,
          expiresAtMs: nowMs + 3_600_000
        },
        actor: { platform: revokedTarget.platform, id: "operator" }
      }), "/internal/state-query/grants/issue");
      await handleStateQueryGrantStorageRequest(state, request({
        ...common,
        nowMs: nowMs + 1
      }), "/internal/state-query/grants/revoke");
      await state.storage.deleteAlarm();
      expect(state.storage.sql.exec(
        `SELECT revoked_at_ms FROM state_query_read_grants WHERE grant_id = ?`,
        grantId
      ).one().revoked_at_ms).toBe(nowMs + 1);
      expect(Number(state.storage.sql.exec(
        `SELECT COUNT(*) AS total FROM state_query_grant_invalidation_outbox
         WHERE grant_id = ?`,
        grantId
      ).one().total)).toBe(1);

      const unavailableEnv = {
        ...socketEnv,
        STATE_QUERY_OBSERVER: {
          idFromName: (name) => name,
          get: () => ({ fetch: async () => new Response("unavailable", { status: 503 }) })
        }
      };
      await drainStateQueryGrantInvalidations(state, unavailableEnv);
      expect(state.storage.sql.exec(
        `SELECT attempt_count, next_attempt_at_ms
         FROM state_query_grant_invalidation_outbox WHERE grant_id = ?`,
        grantId
      ).one()).toMatchObject({ attempt_count: 1 });
      state.storage.sql.exec(
        `UPDATE state_query_grant_invalidation_outbox SET next_attempt_at_ms = 0
         WHERE grant_id = ?`,
        grantId
      );
      await drainStateQueryGrantInvalidations(state, socketEnv);
      expect(Number(state.storage.sql.exec(
        `SELECT COUNT(*) AS total FROM state_query_grant_invalidation_outbox
         WHERE grant_id = ?`,
        grantId
      ).one().total)).toBe(0);
    });
  });

  it("enforces transport, authentication, URL, and cookie-origin boundaries", async () => {
    const target = selectedTarget();
    const grant = await issue(target);
    const request = (headers = {}, suffix = "") => new Request(
      `https://example.com/state-query/socket${suffix}`,
      { method: "GET", headers: { upgrade: "websocket", ...headers } }
    );

    const disabled = await handleStateQueryRequest(request(), {
      ...socketEnv, STATE_QUERY_STREAMS_ENABLED: "false"
    });
    expect(disabled.status).toBe(403);
    expect((await disabled.json()).error.code).toBe("state_query_subscriptions_disabled");

    const polling = await handleStateQueryRequest(request(), {
      ...socketEnv, STATE_QUERY_STREAM_TRANSPORT: "polling_sse"
    });
    expect(polling.status).toBe(503);
    expect((await polling.json()).error.code).toBe("state_query_transport_unavailable");

    expect((await handleStateQueryRequest(request(), socketEnv)).status).toBe(403);
    expect((await handleStateQueryRequest(request({
      cookie: `elmybot_state_query=${grant.credential}`
    }), socketEnv)).status).toBe(403);
    expect((await handleStateQueryRequest(request({
      authorization: `Bearer ${grant.credential}`
    }, "?credential=forbidden"), socketEnv)).status).toBe(400);
    const subprotocol = await handleStateQueryRequest(request({
      authorization: `Bearer ${grant.credential}`,
      "sec-websocket-protocol": grant.credential
    }), socketEnv);
    expect(subprotocol.status).toBe(400);
    expect(await subprotocol.text()).not.toContain(grant.credential);

    const { response, socket } = await openSocket(target, grant.credential, {
      cookie: true,
      origin: "https://example.com"
    });
    expect(response.status).toBe(101);
    closeQuietly(socket);
  });

  it.each([
    {
      label: "the master switch",
      override: { STATE_QUERY_STREAMS_ENABLED: "false" },
      code: "state_query_subscriptions_disabled",
      status: 403
    },
    {
      label: "the polling rollback selector",
      override: { STATE_QUERY_STREAM_TRANSPORT: "polling_sse" },
      code: "state_query_transport_unavailable",
      status: 503
    }
  ])("retires existing sockets when $label is deployed", async ({ override, code, status }) => {
    const target = selectedTarget();
    await setCount(target, 3);
    const grant = await issue(target);
    const active = await openSocket(target, grant.credential);
    const initial = await register(active.socket, target);
    await acknowledge(active.socket, target, initial.event);

    const terminal = nextMessage(active.socket);
    const closed = nextSocketEvent(active.socket, "close");
    const rollbackEnv = { ...socketEnv, ...override };
    await runInDurableObject(observerStub(target), async (instance, state) => {
      const original = instance.env;
      try {
        instance.env = rollbackEnv;
        await instance.alarm();
        expect(stateQueryOperationalSnapshot(state)).toMatchObject({
          activeSubscriptions: 0,
          activeQueries: 0,
          sourceEdges: 0,
          historyEvents: 0
        });
      } finally {
        instance.env = original;
      }
    });

    expect(await terminal).toMatchObject({
      protocol: STATE_QUERY_SOCKET_PROTOCOL,
      type: STATE_QUERY_SOCKET_MESSAGE_TYPES.error,
      error: { code }
    });
    expect((await closed).code).toBe(STATE_QUERY_SOCKET_CLOSE_CODES.policyViolation);
    await vi.waitFor(async () => {
      expect(await runInDurableObject(observerStub(target), async (_instance, state) =>
        state.getWebSockets().length)).toBe(0);
    });

    const rejected = await openSocket(target, grant.credential, {
      selectedEnv: rollbackEnv
    });
    expect(rejected.response.status).toBe(status);
    expect((await rejected.response.json()).error.code).toBe(code);
  });

  it("delivers a snapshot and committed replacement without observer polling", async () => {
    const target = selectedTarget();
    await setCount(target, 7);
    const grant = await issue(target);
    const { response, socket } = await openSocket(target, grant.credential);
    expect(response.status).toBe(101);
    try {
      const initial = await register(socket, target);
      expect(initial).toMatchObject({
        protocol: STATE_QUERY_SOCKET_PROTOCOL,
        type: STATE_QUERY_SOCKET_MESSAGE_TYPES.event,
        event: {
          sequence: 1,
          eventType: "snapshot",
          payload: {
            protocol: "state-query-stream/v1",
            results: [{
              queryId: "deaths",
              status: "ready",
              reason: "initial",
              result: { data: { deaths: { state: "present", value: 7 } } }
            }]
          }
        }
      });

      const pong = nextSocketEvent(socket);
      socket.send(STATE_QUERY_SOCKET_PING);
      expect((await pong).data).toBe(STATE_QUERY_SOCKET_PONG);

      socket.send(JSON.stringify({
        protocol: STATE_QUERY_SOCKET_PROTOCOL,
        type: STATE_QUERY_SOCKET_MESSAGE_TYPES.acknowledge,
        cursor: initial.event.cursor
      }));
      await vi.waitFor(async () => {
        await runInDurableObject(observerStub(target), async (_instance, state) => {
          const attachment = state.getWebSockets()[0].deserializeAttachment();
          expect(attachment).toMatchObject({
            registered: true,
            subscriptionId: initial.event.payload.subscriptionId,
            acknowledgedSequence: 1
          });
          expect(JSON.stringify(attachment)).not.toContain(grant.credential);
          expect(attachment).not.toHaveProperty("queries");
        });
      });

      const updateMessage = nextMessage(socket);
      const scope = await setCount(target, 8);
      await drainMutation(target, scope);
      expect(await updateMessage).toMatchObject({
        protocol: STATE_QUERY_SOCKET_PROTOCOL,
        type: STATE_QUERY_SOCKET_MESSAGE_TYPES.event,
        event: {
          eventType: "update",
          payload: { results: [{
            queryId: "deaths",
            result: { data: { deaths: { state: "present", value: 8 } } }
          }] }
        }
      });
      await runInDurableObject(observerStub(target), async (_instance, state) => {
        expect(stateQueryOperationalSnapshot(state).counters.polls ?? 0).toBe(0);
      });
    } finally {
      closeQuietly(socket);
    }

    await vi.waitFor(async () => {
      await runInDurableObject(observerStub(target), async (_instance, state) => {
        expect(Number(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM state_query_stream_queries"
        ).one().total)).toBe(0);
      });
    });
  });

  it("coalesces durable replacements while one socket event is unacknowledged", async () => {
    const target = selectedTarget();
    await setCount(target, 1);
    const grant = await issue(target);
    const { socket } = await openSocket(target, grant.credential);
    try {
      const initial = await register(socket, target);
      const forgedCursor = initial.event.cursor.replace(/\.1$/, ".99");
      socket.send(JSON.stringify({
        protocol: STATE_QUERY_SOCKET_PROTOCOL,
        type: STATE_QUERY_SOCKET_MESSAGE_TYPES.acknowledge,
        cursor: forgedCursor
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      await drainMutation(target, await setCount(target, 2));
      await drainMutation(target, await setCount(target, 3));
      await runInDurableObject(observerStub(target), async (_instance, state) => {
        const attachment = state.getWebSockets()[0].deserializeAttachment();
        expect(attachment.sentSequence).toBe(1);
        expect(attachment.acknowledgedSequence).toBeUndefined();
        expect(Number(state.storage.sql.exec(
          `SELECT next_sequence FROM state_query_stream_subscriptions
           WHERE subscription_id = ?`,
          initial.event.payload.subscriptionId
        ).one().next_sequence)).toBe(4);
      });

      const replacementMessage = nextMessage(socket);
      await acknowledge(socket, target, initial.event);
      const replacement = await replacementMessage;
      expect(replacement).toMatchObject({
        type: STATE_QUERY_SOCKET_MESSAGE_TYPES.event,
        event: {
          sequence: 3,
          eventType: "update",
          payload: { results: [{
            queryId: "deaths",
            result: { data: { deaths: { value: 3 } } }
          }] }
        }
      });
      await runInDurableObject(observerStub(target), async (_instance, state) => {
        const snapshot = stateQueryOperationalSnapshot(state);
        expect(snapshot.counters.backpressureCoalesced).toBe(1);
      });
    } finally {
      closeQuietly(socket);
    }
  });

  it("renews leases only while a socket is attached and expires lost interest", async () => {
    const target = selectedTarget();
    const grant = await issue(target);
    const { socket } = await openSocket(target, grant.credential);
    const initial = await register(socket, target);
    await acknowledge(socket, target, initial.event);
    const subscriptionId = initial.event.payload.subscriptionId;
    const shortExpiry = Date.now() + 1_000;
    await runInDurableObject(observerStub(target), async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE state_query_stream_subscriptions
         SET expires_at_ms = ?, next_maintenance_at_ms = 0
         WHERE subscription_id = ?`,
        shortExpiry,
        subscriptionId
      );
      state.storage.sql.exec(
        `UPDATE state_query_observer_queries
         SET lease_expires_at_ms = ?`,
        shortExpiry
      );
      await instance.alarm();
      const renewed = state.storage.sql.exec(
        `SELECT expires_at_ms, next_maintenance_at_ms
         FROM state_query_stream_subscriptions WHERE subscription_id = ?`,
        subscriptionId
      ).one();
      expect(Number(renewed.expires_at_ms)).toBeGreaterThan(shortExpiry);
      expect(Number(renewed.next_maintenance_at_ms)).toBeGreaterThan(Date.now());
      const query = state.storage.sql.exec(
        `SELECT authorization_mode, next_authorization_at_ms, grant_expires_at_ms
         FROM state_query_observer_queries`
      ).one();
      expect(query.authorization_mode).toBe("event_driven");
      expect(Number(query.next_authorization_at_ms)).toBe(
        Number(query.grant_expires_at_ms)
      );
    });

    closeQuietly(socket);
    await vi.waitFor(async () => {
      await runInDurableObject(observerStub(target), async (_instance, state) => {
        expect(Number(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM state_query_stream_queries"
        ).one().total)).toBe(0);
      });
    });
    await runInDurableObject(observerStub(target), async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE state_query_stream_subscriptions
         SET expires_at_ms = 0, next_maintenance_at_ms = 0
         WHERE subscription_id = ?`,
        subscriptionId
      );
      await instance.alarm();
      expect(Number(state.storage.sql.exec(
        `SELECT COUNT(*) AS total FROM state_query_stream_subscriptions
         WHERE subscription_id = ?`,
        subscriptionId
      ).one().total)).toBe(0);
    });
  });

  it("bounds a revoked socket that never acknowledges its initial event", async () => {
    const target = selectedTarget();
    const grant = await issue(target);
    const { socket } = await openSocket(target, grant.credential);
    const initial = await register(socket, target);
    const closed = nextSocketEvent(socket, "close");
    await revokeStateQueryCredential(socketEnv, grant.credential);
    await runInDurableObject(groupConfigStub(target), async (instance) => {
      await instance.alarm();
    });
    await runInDurableObject(observerStub(target), async (instance, state) => {
      const attachment = state.getWebSockets()[0].deserializeAttachment();
      expect(attachment.sentSequence).toBe(initial.event.sequence);
      expect(attachment.acknowledgedSequence).toBeUndefined();
      expect(state.storage.sql.exec(
        "SELECT query_state FROM state_query_observer_queries"
      ).one().query_state).toBe("denied");
      state.storage.sql.exec(
        `UPDATE state_query_stream_subscriptions
         SET expires_at_ms = 0, next_maintenance_at_ms = 0
         WHERE subscription_id = ?`,
        initial.event.payload.subscriptionId
      );
      await instance.alarm();
    });
    expect((await closed).code).toBe(STATE_QUERY_SOCKET_CLOSE_CODES.policyViolation);
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_stream_subscriptions"
      ).one().total)).toBe(0);
    });
  });

  it("terminates an acknowledged socket at its durable grant expiry", async () => {
    const target = selectedTarget();
    const grant = await issue(target);
    const { socket } = await openSocket(target, grant.credential);
    const initial = await register(socket, target);
    await acknowledge(socket, target, initial.event);
    const terminal = nextMessage(socket);
    const closed = nextSocketEvent(socket, "close");
    await runInDurableObject(observerStub(target), async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE state_query_stream_subscriptions
         SET grant_expires_at_ms = 0, next_maintenance_at_ms = 0
         WHERE subscription_id = ?`,
        initial.event.payload.subscriptionId
      );
      state.storage.sql.exec(
        `UPDATE state_query_observer_queries
         SET grant_expires_at_ms = 0, next_authorization_at_ms = 0`
      );
      await instance.alarm();
    });
    expect(await terminal).toMatchObject({
      type: STATE_QUERY_SOCKET_MESSAGE_TYPES.event,
      event: {
        eventType: "status",
        payload: { results: [{
          status: "denied",
          reason: "query_grant_expired"
        }] }
      }
    });
    expect((await closed).code).toBe(STATE_QUERY_SOCKET_CLOSE_CODES.policyViolation);
    await vi.waitFor(async () => {
      await runInDurableObject(observerStub(target), async (_instance, state) => {
        expect(state.getWebSockets().length).toBe(0);
      });
    });
  });

  it("recovers an attached socket after observer eviction and resynchronizes reconnects", async () => {
    const target = selectedTarget();
    await setCount(target, 2);
    const grant = await issue(target);
    const first = await openSocket(target, grant.credential);
    const initial = await register(first.socket, target);
    const subscriptionId = initial.event.payload.subscriptionId;
    try {
      await acknowledge(first.socket, target, initial.event);
      await evictDurableObject(observerStub(target));
      const afterRestart = nextMessage(first.socket);
      await drainMutation(target, await setCount(target, 3));
      expect(await afterRestart).toMatchObject({
        event: { payload: { results: [{
          result: { data: { deaths: { value: 3 } } }
        }] } }
      });
    } finally {
      closeQuietly(first.socket);
    }

    await setCount(target, 9);
    const second = await openSocket(target, grant.credential);
    try {
      const recovered = await register(second.socket, target, {
        subscriptionId,
        cursor: initial.event.cursor
      });
      expect(recovered).toMatchObject({
        event: {
          eventType: "snapshot",
          payload: {
            subscriptionId,
            results: [{
              reason: "resynchronized",
              result: { data: { deaths: { value: 9 } } }
            }]
          }
        }
      });
    } finally {
      closeQuietly(second.socket);
    }
  });

  it("rejects malformed and oversized registration frames with bounded errors", async () => {
    const target = selectedTarget();
    const grant = await issue(target);

    const malformed = await openSocket(target, grant.credential);
    const malformedError = nextMessage(malformed.socket);
    const malformedClose = nextSocketEvent(malformed.socket, "close");
    malformed.socket.send(JSON.stringify({
      protocol: STATE_QUERY_SOCKET_PROTOCOL,
      type: STATE_QUERY_SOCKET_MESSAGE_TYPES.register,
      queries: [],
      credential: grant.credential
    }));
    expect(await malformedError).toEqual({
      protocol: STATE_QUERY_SOCKET_PROTOCOL,
      type: STATE_QUERY_SOCKET_MESSAGE_TYPES.error,
      error: {
        code: "state_query_stream_invalid",
        message: "State-query socket registration is invalid."
      }
    });
    expect((await malformedClose).code).toBe(
      STATE_QUERY_SOCKET_CLOSE_CODES.policyViolation
    );

    const oversized = await openSocket(target, grant.credential);
    const oversizedError = nextMessage(oversized.socket);
    const oversizedClose = nextSocketEvent(oversized.socket, "close");
    oversized.socket.send("x".repeat(
      STATE_QUERY_SOCKET_LIMITS.maxRegistrationFrameBytes + 1
    ));
    expect(await oversizedError).toMatchObject({
      protocol: STATE_QUERY_SOCKET_PROTOCOL,
      type: STATE_QUERY_SOCKET_MESSAGE_TYPES.error,
      error: { code: "state_query_stream_invalid" }
    });
    expect((await oversizedClose).code).toBe(
      STATE_QUERY_SOCKET_CLOSE_CODES.messageTooLarge
    );

    const binary = await openSocket(target, grant.credential);
    const binaryError = nextMessage(binary.socket);
    const binaryClose = nextSocketEvent(binary.socket, "close");
    binary.socket.send(new Uint8Array([1, 2, 3]));
    expect(await binaryError).toMatchObject({
      protocol: STATE_QUERY_SOCKET_PROTOCOL,
      type: STATE_QUERY_SOCKET_MESSAGE_TYPES.error
    });
    expect((await binaryClose).code).toBe(
      STATE_QUERY_SOCKET_CLOSE_CODES.messageTooLarge
    );
  });

  it("bounds accepted connections and sends a terminal status on revocation", async () => {
    const target = selectedTarget();
    await setCount(target, 4);
    const grant = await issue(target);
    const accepted = [];
    try {
      for (let index = 0; index < 20; index += 1) {
        const opened = await openSocket(target, grant.credential);
        expect(opened.response.status).toBe(101);
        accepted.push(opened.socket);
      }
      const excess = await openSocket(target, grant.credential);
      expect(excess.response.status).toBe(429);
    } finally {
      for (const socket of accepted) closeQuietly(socket);
    }

    await vi.waitFor(async () => {
      expect((await runInDurableObject(observerStub(target), async (_instance, state) =>
        state.getWebSockets().length))).toBe(0);
    });

    const active = await openSocket(target, grant.credential);
    const initial = await register(active.socket, target);
    await acknowledge(active.socket, target, initial.event);
    const terminal = nextMessage(active.socket);
    const closed = nextSocketEvent(active.socket, "close");
    await revokeStateQueryCredential(socketEnv, grant.credential);
    await runInDurableObject(groupConfigStub(target), async (instance) => {
      await instance.alarm();
    });
    expect(await terminal).toMatchObject({
      type: STATE_QUERY_SOCKET_MESSAGE_TYPES.event,
      event: {
        eventType: "status",
        payload: { results: [{ status: "denied", reason: "query_grant_revoked" }] }
      }
    });
    expect((await closed).code).toBe(STATE_QUERY_SOCKET_CLOSE_CODES.policyViolation);
    await vi.waitFor(async () => {
      await runInDurableObject(observerStub(target), async (_instance, state) => {
        expect(state.getWebSockets().length).toBe(0);
        expect(Number(state.storage.sql.exec(
          "SELECT COUNT(*) AS total FROM state_query_stream_queries"
        ).one().total)).toBe(0);
      });
    });
  }, 10_000);
});
