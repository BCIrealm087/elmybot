import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createStateQueryClient } from "../public/state-query/client.js";
import { createStateQueryTools } from "../public/state-query/query.js";
import { IntegrationRegistry, integrationRegistryStub } from "../src/integrations/index.js";
import { drainStateQueryBindingNotifications } from "../src/state-querying/binding-notifications.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { featureRegistry } from "../src/features/index.js";
import { createCommandInvocation, createPlatformGroupRef } from
  "../src/integrations/contracts.js";
import {
  issueStateQueryGrant,
  revokeStateQueryCredential
} from "../src/state-querying/grant-client.js";
import { grantPermissionsForExportList } from "../src/state-querying/grants.js";
import {
  initializeStateQueryStreamTables,
  pollStateQueryStream,
  publishStateQueryStreamUpdates,
  registerPolledStateQueryStream,
  removePolledStateQueryStream,
  STATE_QUERY_SSE_LIMITS
} from "../src/state-querying/sse.js";
import { handleStateQueryRequest } from "../src/state-querying/http.js";
import { flushStateQueryMetrics, stateQueryOperationalSnapshot } from "../src/state-querying/operations.js";
import { stateQueryObserverObjectName } from "../src/state-querying/source-notifications.js";
import { createIntegrationRealmIdentity, requestShareableStateRealm, shareableStateRealmStub } from "../src/shareable-state/index.js";

const streamEnv = {
  ...env,
  STATE_QUERY_PUBLIC_ORIGIN: "https://example.com",
  STATE_QUERY_CREDENTIAL_SIGNING_SECRET:
    "test-state-query-signing-secret-32-bytes-minimum"
};
let sequence = 0;

function selectedTarget() {
  return { platform: "discord", groupId: `discord-state-query-sse-${++sequence}` };
}

function group(target) {
  return createPlatformGroupRef({ platform: "discord", kind: "guild", id: target.groupId });
}

function countQuery(target, game = "Hades") {
  return {
    version: 1,
    target,
    bindings: {
      count: {
        read: { feature: "fun.deaths", export: "count", version: 1 },
        arguments: { game: { literal: game } }
      }
    },
    select: { deaths: { ref: "count", path: ["count"] } }
  };
}

async function issue(target, exports = "fun.deaths:count:v1") {
  return await issueStateQueryGrant(streamEnv, featureRegistry, {
    target,
    permissions: grantPermissionsForExportList(
      featureRegistry,
      target.platform,
      exports
    ),
    expiresInSeconds: 3600
  }, { actor: { platform: target.platform, id: "operator" } });
}

function servicesFor(target) {
  const selectedGroup = group(target);
  return createFeatureServiceRuntime(streamEnv, createCommandInvocation({
    kind: "test.state-query.sse.v1",
    origin: {
      group: selectedGroup,
      actor: { platform: "discord", id: "operator", claims: [] }
    },
    sourceEventId: `discord:sse:${++sequence}`
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

async function setGameCount(target, game, value, operation = "set") {
  const services = servicesFor(target);
  const scope = await services.shareableState.current(
    "fun.deaths",
    "twitch",
    "game_deaths"
  );
  await services.shareableState.boundedCounter("fun.deaths", scope, {
    name: "game",
    subject: game.toLowerCase(),
    subjectLabel: game,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    initial: 0
  }, operation, value);
  return scope;
}

async function setRememberedGame(target, game) {
  await servicesFor(target).state.set("fun.deaths", "last_game", game);
}

function read(exportId, args) {
  return {
    read: { feature: "fun.deaths", export: exportId, version: 1 },
    ...(args ? { arguments: args } : {})
  };
}

function query(target, bindings, select) {
  return { version: 1, target, bindings, select };
}

function literal(game) {
  return { game: { literal: game } };
}

async function openStream(target, credential, options = {}) {
  return await SELF.fetch("https://elmybot-worker.cutelmy.workers.dev/state-query/stream", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      queries: [{ id: "deaths", query: countQuery(target) }],
      ...options
    })
  });
}

async function readFrame(reader) {
  const timeout = new Promise((_, reject) => setTimeout(
    () => reject(new Error("Timed out waiting for SSE frame.")),
    2_000
  ));
  const chunk = await Promise.race([reader.read(), timeout]);
  expect(chunk.done).toBe(false);
  return new TextDecoder().decode(chunk.value);
}

function frameData(frame) {
  const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
  return JSON.parse(line.slice(6));
}

async function readQueryResult(reader, queryId, maximumFrames = 5) {
  for (let index = 0; index < maximumFrames; index += 1) {
    const frame = frameData(await readFrame(reader));
    const result = frame.results.find((candidate) => candidate.queryId === queryId);
    if (result) return result;
  }
  throw new Error(`Timed out waiting for query result ${queryId}.`);
}

function observerStub(target) {
  return streamEnv.STATE_QUERY_OBSERVER.get(streamEnv.STATE_QUERY_OBSERVER.idFromName(
    stateQueryObserverObjectName(env.STATE_QUERY_DEPLOYMENT_ENVIRONMENT, group(target))
  ));
}

async function drainMutation(target, scope, rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await runInDurableObject(shareableStateRealmStub(streamEnv, scope.realm), async (instance) => {
      await instance.alarm();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runInDurableObject(observerStub(target), async (instance) => {
      await instance.alarm();
    });
  }
}

async function drainLocalMutation(target) {
  const stub = streamEnv.CONFIG.get(streamEnv.CONFIG.idFromName(group(target).key));
  for (let round = 0; round < 3; round += 1) {
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runInDurableObject(observerStub(target), async (instance) => {
      await instance.alarm();
    });
  }
}

describe("public state-query SSE", () => {
  it("disables new and existing subscriptions while keeping snapshots and mutations usable", async () => {
    const target = selectedTarget();
    const grant = await issue(target);
    const response = await openStream(target, grant.credential);
    const reader = response.body.getReader();
    await readFrame(reader);
    const disabledEnv = { ...streamEnv, STATE_QUERY_STREAMS_ENABLED: "false" };
    const rejected = await handleStateQueryRequest(new Request("https://example.com/state-query/stream", {
      method: "POST"
    }), disabledEnv);
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).error.code).toBe("state_query_subscriptions_disabled");
    await setCount(target, 9);
    const snapshot = await handleStateQueryRequest(new Request("https://example.com/state-query/snapshot", {
      method: "POST", headers: { authorization: `Bearer ${grant.credential}`, "content-type": "application/json" },
      body: JSON.stringify(countQuery(target))
    }), disabledEnv);
    expect((await snapshot.json()).data.deaths.value).toBe(9);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await handleStateQueryRequest(new Request("https://example.com/state-query/client.js"), {
        ...disabledEnv, BROWSER_ASSETS: { fetch() { throw new Error(`${grant.credential} Hades`); } }
      });
      expect(failed.status).toBe(503);
      expect(log.mock.calls).toHaveLength(1);
      expect(log.mock.calls[0][0]).not.toContain(grant.credential);
      expect(log.mock.calls[0][0]).not.toContain("Hades");
    } finally { log.mockRestore(); }
    await runInDurableObject(observerStub(target), async (instance, state) => {
      const original = instance.env;
      try {
        instance.env = disabledEnv;
        await instance.alarm();
        expect(stateQueryOperationalSnapshot(state)).toMatchObject({
          activeSubscriptions: 0, activeQueries: 0, sourceEdges: 0, historyEvents: 0
        });
      } finally { instance.env = original; }
    });
    expect((await reader.read()).done).toBe(true);
  });

  it("resynchronizes every query after retention truncates a slow multiplexed stream", async () => {
    const target = selectedTarget();
    const grant = await issue(target);
    const response = await openStream(target, grant.credential, { queries: [
      { id: "busy", query: countQuery(target) }, { id: "quiet", query: countQuery(target, "Celeste") }
    ] });
    const reader = response.body.getReader();
    await readFrame(reader);
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      // Inject committed coordinator replacements to exercise real SQL history
      // retention independently of notification coalescing.
      const change = async (id, value) => {
        const row = state.storage.sql.exec(
          "SELECT query_id, envelope_json FROM state_query_observer_queries WHERE query_id LIKE ?", `%:${id}`
        ).one();
        const envelope = JSON.parse(row.envelope_json);
        envelope.data.deaths.value = value;
        state.storage.sql.exec(
          "UPDATE state_query_observer_queries SET result_sequence = result_sequence + 1, envelope_json = ? WHERE query_id = ?",
          JSON.stringify(envelope), row.query_id
        );
        await publishStateQueryStreamUpdates(state);
      };
      await change("quiet", 7);
      for (let index = 1; index <= 70; index += 1) await change("busy", index);
      expect(stateQueryOperationalSnapshot(state).historyEvents).toBe(64);
    });
    const replacement = frameData(await readFrame(reader));
    expect(replacement.results.map((result) => [result.queryId, result.result.data.deaths.value]))
      .toEqual([["busy", 70], ["quiet", 7]]);
    expect(replacement.results.every((result) => result.reason === "resynchronized")).toBe(true);
    await reader.cancel();
  });

  it("ends an oversized aggregate result and removes expired stream records", async () => {
    const target = selectedTarget();
    const grant = await issue(target);
    const response = await openStream(target, grant.credential);
    const reader = response.body.getReader();
    await readFrame(reader);
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      const row = state.storage.sql.exec("SELECT query_id, envelope_json FROM state_query_observer_queries").one();
      const envelope = JSON.parse(row.envelope_json);
      envelope.data.padding = { state: "present", value: "x".repeat(256 * 1024) };
      state.storage.sql.exec(
        "UPDATE state_query_observer_queries SET result_sequence = result_sequence + 1, envelope_json = ?",
        JSON.stringify(envelope)
      );
      await publishStateQueryStreamUpdates(state);
    });
    const terminal = frameData(await readFrame(reader));
    expect(terminal.results[0].error.code).toBe("query_limit_exceeded");
    expect(JSON.stringify(terminal).length).toBeLessThan(1024);
    expect((await reader.read()).done).toBe(true);
    // Abrupt disconnect: no Worker cancellation call reaches the observer.
    await runInDurableObject(observerStub(target), async (instance, state) => {
      await registerPolledStateQueryStream(state, streamEnv, {
        target, grantId: grant.grant.id, queries: [{ id: "abandoned", query: countQuery(target) }]
      });
      state.storage.sql.exec("UPDATE state_query_stream_subscriptions SET expires_at_ms = 0");
      await instance.alarm();
      expect(stateQueryOperationalSnapshot(state)).toMatchObject({
        activeSubscriptions: 0, activeQueries: 0, sourceEdges: 0, historyEvents: 0
      });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM state_query_stream_queries").one().total).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it.each([1, 20])("measures bounded idle and active work with %i subscribers", async (clients) => {
    const target = selectedTarget();
    const grant = await issue(target);
    const scope = await setCount(target, 0);
    const registrations = [];
    const started = performance.now();
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      for (let index = 0; index < clients; index += 1) {
        registrations.push(await registerPolledStateQueryStream(state, streamEnv, {
          target, grantId: grant.grant.id, queries: [{ id: "count", query: countQuery(target) }]
        }));
      }
      const before = stateQueryOperationalSnapshot(state);
      expect(before).toMatchObject({ activeSubscriptions: clients, activeQueries: clients, sourceEdges: 2 });
      for (let round = 0; round < 5; round += 1) {
        for (const registration of registrations) {
          expect(await pollStateQueryStream(state, streamEnv, {
            subscriptionId: registration.subscriptionId, afterSequence: registration.event.sequence
          })).toEqual({ event: null });
        }
      }
      const idle = stateQueryOperationalSnapshot(state);
      expect(idle.counters.emptyPolls).toBe(5 * clients);
      expect(idle.counters.evaluations ?? 0).toBe(before.counters.evaluations ?? 0);
      expect(idle.historyBytes).toBe(before.historyBytes);
      if (clients === 20) await expect(registerPolledStateQueryStream(state, streamEnv, {
        target, grantId: grant.grant.id, queries: [{ id: "excess", query: countQuery(target) }]
      })).rejects.toMatchObject({ code: "state_query_stream_capacity" });
    });
    const registrationAndIdleMs = performance.now() - started;
    const latencies = [];
    for (let value = 1; value <= 10; value += 1) {
      await setCount(target, value);
      const committed = performance.now();
      await drainMutation(target, scope, 1);
      await vi.waitFor(async () => {
        await runInDurableObject(observerStub(target), async (instance, state) => {
          await instance.alarm();
          for (const registration of registrations) {
            const result = await pollStateQueryStream(state, streamEnv, {
              subscriptionId: registration.subscriptionId, afterSequence: 0
            });
            expect(result.event.payload.results[0].result.data.deaths.value).toBe(value);
          }
        });
      }, { timeout: 5000, interval: 50 });
      latencies.push(performance.now() - committed);
    }
    const report = await runInDurableObject(observerStub(target), async (_instance, state) => {
      const active = stateQueryOperationalSnapshot(state);
      expect(active.historyEvents).toBeLessThanOrEqual(clients * STATE_QUERY_SSE_LIMITS.maxHistoryEvents);
      expect(active.historyBytes).toBeLessThanOrEqual(clients * STATE_QUERY_SSE_LIMITS.maxHistoryBytes);
      // Instrumentation admits only aggregate counters, even if a caller tries
      // to smuggle private values through the environment.
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      try {
        flushStateQueryMetrics(state, { STATE_QUERY_DIAGNOSTICS: "true", credential: grant.credential });
        const message = log.mock.calls[0][0];
        expect(message).not.toContain(grant.credential);
        expect(message).not.toContain(target.groupId);
        expect(message).not.toContain("Hades");
        expect(JSON.parse(message).activeSubscriptions).toBe(clients);
      } finally { clock.mockRestore(); log.mockRestore(); }
      for (const registration of registrations) {
        await removePolledStateQueryStream(state, streamEnv, registration);
      }
      expect(stateQueryOperationalSnapshot(state)).toMatchObject({
        activeSubscriptions: 0, activeQueries: 0, sourceEdges: 0, historyBytes: 0
      });
      expect(await state.storage.getAlarm()).toBeNull();
      latencies.sort((a, b) => a - b);
      return {
        clients, mutations: 10, idlePolls: clients * 5, registrationAndIdleMs,
        localDeliveryP50Ms: latencies[4], localDeliveryP95Ms: latencies[9],
        peakHistoryEvents: active.historyEvents, peakHistoryBytes: active.historyBytes,
        finalActiveQueries: 0, finalSourceEdges: 0
      };
    });
    console.log("state-query-release-load", JSON.stringify(report));
  }, 30_000);

  it("runs the browser client through secure session, game changes, and a real realm handoff", async () => {
    const target = selectedTarget();
    await setRememberedGame(target, "Hades");
    await setGameCount(target, "Hades", 2);
    await setGameCount(target, "Sekiro", 5);
    const grant = await issue(target, "fun.deaths:count:v1,fun.deaths:remembered_game:v1");
    const origin = "https://elmybot-worker.cutelmy.workers.dev";
    let cookie = "";
    const client = createStateQueryClient({ baseUrl: origin, fetch: async (url, init) => {
      const response = await SELF.fetch(url.toString(), { ...init, headers: {
        ...init.headers, origin, ...(cookie ? { cookie } : {})
      } });
      if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      return response;
    } });
    let latest;
    let connectionStatus;
    try {
      await client.session(grant.credential);
      expect((await client.catalog()).target).toEqual(target);
      const document = createStateQueryTools().deaths(target);
      expect((await client.read(document)).data.deaths.value.count).toBe(2);
      client.watch(document, { onResult(value) { latest = value; }, onStatus(value) { connectionStatus = value; } });
      await vi.waitFor(() => expect(latest?.result.data.deaths.value.count).toBe(2), { timeout: 3000 });
      await setRememberedGame(target, "Sekiro");
      await drainLocalMutation(target);
      await vi.waitFor(() => expect(latest?.result.data.deaths.value).toEqual({ game: "Sekiro", count: 5 }), { timeout: 3000 });

      const integrationId = `browser-handoff-${++sequence}`;
      const discord = group(target);
      const twitch = createPlatformGroupRef({ platform: "twitch", kind: "channel", id: integrationId });
      const realm = createIntegrationRealmIdentity({ id: integrationId }, { generation: 1 });
      await requestShareableStateRealm(streamEnv, { realm, featureId: "fun.deaths", namespaceId: "game_deaths", operation: "bounded-counter", storage: {
        name: "game", subject: "sekiro", subjectLabel: "Sekiro", min: 0, max: Number.MAX_SAFE_INTEGER, initial: 0, operation: "set", value: 12
      } });
      await runInDurableObject(integrationRegistryStub(streamEnv), async (_instance, state) => {
        const registry = new IntegrationRegistry(state, streamEnv);
        state.storage.sql.exec(`INSERT INTO integrations
          (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
           created_by_platform, created_by_actor_id, completed_by_platform,
           completed_by_actor_id, shareable_state_generation)
          VALUES (?, 'active', 1, 1, 1, 'discord', 'manager', 'twitch', 'broadcaster', 1)`, integrationId);
        for (const member of [discord, twitch]) state.storage.sql.exec(`INSERT INTO integration_members
          (integration_id, group_key, platform, group_kind, group_id, joined_at_ms)
          VALUES (?, ?, ?, ?, ?, 1)`, integrationId, member.key, member.platform, member.kind, member.id);
        registry.assignDefaultLinkIfAbsent({ sourceGroup: discord, targetGroup: twitch, integrationId, nowMs: Date.now() });
      });
      for (let round = 0; round < 3; round++) {
        await runInDurableObject(integrationRegistryStub(streamEnv), async (_instance, state) => {
          await drainStateQueryBindingNotifications(state, streamEnv);
        });
        await runInDurableObject(observerStub(target), async (instance) => { await instance.alarm(); });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await vi.waitFor(() => expect(latest?.result.data.deaths.value.count).toBe(12), { timeout: 3000 });
      expect(latest.reason).toBe("source_change");
      await drainMutation(target, await setGameCount(target, "Sekiro", 13));
      await vi.waitFor(() => expect(latest?.result.data.deaths.value.count).toBe(13), { timeout: 3000 });
      await revokeStateQueryCredential(streamEnv, grant.credential);
      await runInDurableObject(observerStub(target), async (instance, state) => {
        state.storage.sql.exec("UPDATE state_query_observer_queries SET next_authorization_at_ms = 0");
        await instance.alarm();
      });
      await vi.waitFor(() => expect(connectionStatus?.state).toBe("ended"), { timeout: 3000 });
    } finally { await client.close(); }
  }, 15_000);

  it("coalesces adjacent multiplexed history per query ID", async () => {
    const target = selectedTarget();
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      initializeStateQueryStreamTables(state);
      const subscriptionId = "a".repeat(32);
      const nowMs = Date.now();
      state.storage.sql.exec(
        `INSERT INTO state_query_stream_subscriptions
          (subscription_id, grant_id, query_set_digest, next_sequence,
           expires_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'grant', 'digest', 4, ?, ?, ?)`,
        subscriptionId,
        nowMs + 120_000,
        nowMs,
        nowMs
      );
      for (const [sequence, results] of [
        [1, [{ queryId: "first", sequence: 2 }]],
        [2, [{ queryId: "second", sequence: 3 }]],
        [3, [{ queryId: "first", sequence: 4 }]]
      ]) {
        const payload = JSON.stringify({
          protocol: "state-query-stream/v1",
          subscriptionId,
          results
        });
        state.storage.sql.exec(
          `INSERT INTO state_query_stream_history
            (subscription_id, sequence, event_type, payload_json,
             encoded_bytes, created_at_ms)
           VALUES (?, ?, 'update', ?, ?, ?)`,
          subscriptionId,
          sequence,
          payload,
          new TextEncoder().encode(payload).byteLength,
          nowMs
        );
      }

      const { event } = await pollStateQueryStream(state, streamEnv, {
        subscriptionId,
        afterSequence: 0
      });
      expect(event.sequence).toBe(3);
      expect(event.payload.results).toEqual([
        { queryId: "first", sequence: 4 },
        { queryId: "second", sequence: 3 }
      ]);
    });
  });

  it("streams all five deaths query shapes and their dynamic updates", async () => {
    const target = selectedTarget();
    await setGameCount(target, "Hades", 3);
    await setGameCount(target, "Dark Souls", 2);
    await setGameCount(target, "Sekiro", 1);
    await setRememberedGame(target, "Hades");
    const grant = await issue(target, [
      "fun.deaths:remembered_game:v1",
      "fun.deaths:count:v1",
      "fun.deaths:counts:v1"
    ].join(","));
    const queries = [
      {
        id: "one",
        query: query(target, { count: read("count", literal("Hades")) }, {
          deaths: { ref: "count", path: ["count"] }
        })
      },
      {
        id: "three",
        query: query(target, {
          hades: read("count", literal("Hades")),
          dark_souls: read("count", literal("Dark Souls")),
          sekiro: read("count", literal("Sekiro"))
        }, {
          hades: { ref: "hades", path: ["count"] },
          dark_souls: { ref: "dark_souls", path: ["count"] },
          sekiro: { ref: "sekiro", path: ["count"] }
        })
      },
      {
        id: "remembered",
        query: query(target, { remembered: read("remembered_game") }, {
          game: { ref: "remembered" }
        })
      },
      {
        id: "current",
        query: query(target, {
          remembered: read("remembered_game"),
          current: read("count", { game: { ref: "remembered" } })
        }, { deaths: { ref: "current" } })
      },
      {
        id: "collection",
        query: query(target, { counts: read("counts") }, {
          games: { ref: "counts" }
        })
      }
    ];
    const response = await openStream(target, grant.credential, { queries });
    expect(response.status).toBe(200);
    const reader = response.body.getReader();
    const initial = frameData(await readFrame(reader));
    expect(initial.results.map(({ queryId }) => queryId)).toEqual([
      "one", "three", "remembered", "current", "collection"
    ]);
    expect(initial.results[0].result.data.deaths).toEqual({
      state: "present", value: 3
    });
    expect(initial.results[1].result.data).toEqual({
      dark_souls: { state: "present", value: 2 },
      hades: { state: "present", value: 3 },
      sekiro: { state: "present", value: 1 }
    });
    expect(initial.results[2].result.data.game).toEqual({
      state: "present", value: "Hades"
    });
    expect(initial.results[3].result.data.deaths).toEqual({
      state: "present", value: { game: "Hades", count: 3 }
    });
    expect(initial.results[4].result.data.games.value).toEqual([
      { game: "Dark Souls", count: 2 },
      { game: "Hades", count: 3 },
      { game: "Sekiro", count: 1 }
    ]);

    await setRememberedGame(target, "Sekiro");
    await drainLocalMutation(target);
    const selectionUpdate = await readQueryResult(reader, "current");
    expect(selectionUpdate).toEqual(expect.objectContaining({
      queryId: "current",
      result: expect.objectContaining({
        data: {
          deaths: { state: "present", value: { game: "Sekiro", count: 1 } }
        }
      })
    }));

    const scope = await setGameCount(target, "Dark Souls", undefined, "reset");
    await drainMutation(target, scope, 6);
    const collectionUpdate = await readQueryResult(reader, "collection");
    expect(collectionUpdate).toEqual(expect.objectContaining({
      queryId: "collection",
      result: expect.objectContaining({
        data: {
          games: {
            state: "present",
            value: [
              { game: "Hades", count: 3 },
              { game: "Sekiro", count: 1 }
            ]
          }
        }
      })
    }));
    await reader.cancel();
  }, 10_000);

  it("performs an authorized snapshot-and-attach handshake and cleans up", async () => {
    const target = selectedTarget();
    await setCount(target, 7);
    const grant = await issue(target);
    const response = await openStream(target, grant.credential);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

    const reader = response.body.getReader();
    const frame = await readFrame(reader);
    expect(frame).toContain("event: snapshot\n");
    expect(frame).toMatch(/^id: sq1\.[a-f0-9]{32}\.[a-f0-9]{32}\.1\n/);
    expect(frameData(frame)).toMatchObject({
      protocol: "state-query-stream/v1",
      results: [{
        queryId: "deaths",
        status: "ready",
        reason: "initial",
        result: { data: { deaths: { state: "present", value: 7 } } }
      }]
    });

    await reader.cancel();
    const stub = observerStub(target);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE state_query_observer_queries SET lease_expires_at_ms = 0"
      );
      await instance.alarm();
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_observer_queries"
      ).one().total)).toBe(0);
    });
  });

  it("resynchronizes a reconnect without replaying disconnected source state", async () => {
    const target = selectedTarget();
    await setCount(target, 1);
    const grant = await issue(target);
    const first = await openStream(target, grant.credential);
    const firstReader = first.body.getReader();
    const initial = frameData(await readFrame(firstReader));
    await firstReader.cancel();

    await setCount(target, 9);
    const second = await openStream(target, grant.credential, {
      subscriptionId: initial.subscriptionId
    });
    const secondReader = second.body.getReader();
    const recovered = frameData(await readFrame(secondReader));
    expect(recovered).toMatchObject({
      subscriptionId: initial.subscriptionId,
      results: [{
        reason: "resynchronized",
        result: { data: { deaths: { state: "present", value: 9 } } }
      }]
    });
    await secondReader.cancel();
  });

  it("delivers complete replacements and ignores duplicate or older notifications", async () => {
    const target = selectedTarget();
    await setCount(target, 2);
    const grant = await issue(target);
    const response = await openStream(target, grant.credential);
    const reader = response.body.getReader();
    await readFrame(reader);

    const scope = await setCount(target, 3);
    await drainMutation(target, scope);
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT result_sequence FROM state_query_observer_queries"
      ).one().result_sequence).toBe(2);
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_stream_history"
      ).one().total)).toBe(2);
    });
    const update = await readFrame(reader);
    expect(update).toContain("event: update\n");
    expect(frameData(update)).toMatchObject({
      results: [{
        queryId: "deaths",
        reason: "dependency_change",
        result: { data: { deaths: { state: "present", value: 3 } } }
      }]
    });

    await runInDurableObject(observerStub(target), async (instance, state) => {
      const stored = state.storage.sql.exec(
        `SELECT notification_id, watcher_id, source_kind, source_key, feature_id,
                namespace_id, source_revision, committed_at_ms
         FROM state_query_observer_notifications ORDER BY received_at_ms DESC LIMIT 1`
      ).one();
      const meta = state.storage.sql.exec(
        `SELECT environment, target_platform, target_group_id
         FROM state_query_observer_meta WHERE singleton = 1`
      ).one();
      const notification = {
        version: 1,
        id: stored.notification_id,
        watcherId: stored.watcher_id,
        observer: {
          environment: meta.environment,
          target: { platform: meta.target_platform, groupId: meta.target_group_id }
        },
        source: {
          kind: stored.source_kind,
          key: stored.source_key,
          featureId: stored.feature_id,
          namespaceId: stored.namespace_id
        },
        revision: Number(stored.source_revision),
        committedAtMs: Number(stored.committed_at_ms)
      };
      await instance.fetch(new Request(
        "https://state-query-observer/internal/state-query/notifications/deliver",
        { method: "POST", body: JSON.stringify(notification) }
      ));
      await instance.fetch(new Request(
        "https://state-query-observer/internal/state-query/notifications/deliver",
        { method: "POST", body: JSON.stringify({
          ...notification,
          id: "0".repeat(32),
          revision: Math.max(0, notification.revision - 1)
        }) }
      ));
      await instance.alarm();
    });
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_stream_history"
      ).one().total)).toBe(2);
    });
    await runInDurableObject(observerStub(target), async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_stream_history"
      ).one().total)).toBe(2);
    });
    await reader.cancel();
  });

  it("emits one terminal status and closes after grant revocation", async () => {
    const target = selectedTarget();
    await setCount(target, 4);
    const grant = await issue(target);
    const response = await openStream(target, grant.credential);
    const reader = response.body.getReader();
    await readFrame(reader);
    await revokeStateQueryCredential(streamEnv, grant.credential);
    await runInDurableObject(observerStub(target), async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE state_query_observer_queries SET next_authorization_at_ms = 0"
      );
      await instance.alarm();
    });
    const terminal = await readFrame(reader);
    expect(terminal).toContain("event: status\n");
    expect(frameData(terminal)).toMatchObject({
      results: [{ status: "denied", reason: "query_grant_revoked" }]
    });
    expect((await reader.read()).done).toBe(true);
  });

  it("multiplexes query IDs and rejects an oversized registration", async () => {
    const target = selectedTarget();
    await setCount(target, 6);
    const grant = await issue(target);
    const response = await openStream(target, grant.credential, {
      queries: [
        { id: "first", query: countQuery(target) },
        { id: "second", query: countQuery(target) }
      ]
    });
    const reader = response.body.getReader();
    expect(frameData(await readFrame(reader)).results.map(({ queryId }) => queryId))
      .toEqual(["first", "second"]);
    await reader.cancel();

    const tooMany = await openStream(target, grant.credential, {
      queries: Array.from({ length: 21 }, (_, index) => ({
        id: `query-${index}`,
        query: countQuery(target)
      }))
    });
    expect(tooMany.status).toBe(413);
    expect((await tooMany.json()).error.code).toBe("query_limit_exceeded");
  });

  it("keeps a slow reader bounded and converges to the latest replacement", async () => {
    const target = selectedTarget();
    await setCount(target, 1);
    const grant = await issue(target);
    const response = await openStream(target, grant.credential);
    const reader = response.body.getReader();
    await readFrame(reader);
    await drainMutation(target, await setCount(target, 5));
    await drainMutation(target, await setCount(target, 8));

    let latest;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      latest = frameData(await readFrame(reader));
      if (latest.results[0].result.data.deaths.value === 8) break;
    }
    expect(latest.results[0].result.data.deaths).toEqual({
      state: "present",
      value: 8
    });
    await reader.cancel();
  });
});
