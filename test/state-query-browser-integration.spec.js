import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createStateQueryClient } from "../public/state-query/client.js";
import { createStateQueryTools } from "../public/state-query/query.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { featureRegistry } from "../src/features/index.js";
import {
  createCommandInvocation,
  createPlatformGroupRef
} from "../src/integrations/contracts.js";
import {
  IntegrationRegistry,
  integrationRegistryStub
} from "../src/integrations/index.js";
import { drainStateQueryBindingNotifications } from
  "../src/state-querying/binding-notifications.js";
import {
  issueStateQueryGrant,
  revokeStateQueryCredential
} from "../src/state-querying/grant-client.js";
import { grantPermissionsForExportList } from "../src/state-querying/grants.js";
import { handleStateQueryRequest } from "../src/state-querying/http.js";
import { stateQueryObserverObjectName } from
  "../src/state-querying/source-notifications.js";
import {
  createIntegrationRealmIdentity,
  requestShareableStateRealm,
  shareableStateRealmStub
} from "../src/shareable-state/index.js";

const streamEnv = {
  ...env,
  STATE_QUERY_PUBLIC_ORIGIN: "https://example.com",
  STATE_QUERY_CREDENTIAL_SIGNING_SECRET:
    "test-state-query-signing-secret-32-bytes-minimum"
};
let sequence = 0;

function selectedTarget() {
  return { platform: "discord", groupId: `discord-state-query-browser-${++sequence}` };
}

function group(target) {
  return createPlatformGroupRef({
    platform: "discord",
    kind: "guild",
    id: target.groupId
  });
}

async function issue(target, exports) {
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
  return createFeatureServiceRuntime(streamEnv, createCommandInvocation({
    kind: "test.state-query.browser.v1",
    origin: {
      group: group(target),
      actor: { platform: "discord", id: "operator", claims: [] }
    },
    sourceEventId: `discord:state-query-browser:${++sequence}`
  })).featureServices;
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

function observerStub(target) {
  return streamEnv.STATE_QUERY_OBSERVER.get(streamEnv.STATE_QUERY_OBSERVER.idFromName(
    stateQueryObserverObjectName(env.STATE_QUERY_DEPLOYMENT_ENVIRONMENT, group(target))
  ));
}

async function drainMutation(target, scope, rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await runInDurableObject(shareableStateRealmStub(streamEnv, scope.realm),
      async (instance) => { await instance.alarm(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runInDurableObject(observerStub(target),
      async (instance) => { await instance.alarm(); });
  }
}

async function drainLocalMutation(target) {
  const stub = streamEnv.CONFIG.get(streamEnv.CONFIG.idFromName(group(target).key));
  for (let round = 0; round < 3; round += 1) {
    await runInDurableObject(stub, async (instance) => { await instance.alarm(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runInDurableObject(observerStub(target),
      async (instance) => { await instance.alarm(); });
  }
}

describe("state-query browser WebSocket integration", () => {
  it("follows local changes, a realm handoff, and grant revocation", async () => {
    const target = selectedTarget();
    await setRememberedGame(target, "Hades");
    await setGameCount(target, "Hades", 2);
    await setGameCount(target, "Sekiro", 5);
    const grant = await issue(
      target,
      "fun.deaths:count:v1,fun.deaths:remembered_game:v1"
    );
    const origin = "https://elmybot-worker.cutelmy.workers.dev";
    let cookie = "";
    const client = createStateQueryClient({
      baseUrl: origin,
      fetch: async (url, init) => {
        const response = await SELF.fetch(url.toString(), {
          ...init,
          headers: { ...init.headers, origin, ...(cookie ? { cookie } : {}) }
        });
        if (response.headers.has("set-cookie")) {
          cookie = response.headers.get("set-cookie").split(";")[0];
        }
        return response;
      },
      openWebSocket: async (url) => {
        const requestUrl = new URL(url);
        requestUrl.protocol = "https:";
        const response = await handleStateQueryRequest(new Request(requestUrl, {
          headers: { upgrade: "websocket", origin, cookie }
        }), {
          ...streamEnv,
          STATE_QUERY_PUBLIC_ORIGIN: origin,
          STATE_QUERY_STREAMS_ENABLED: "true"
        });
        expect(response.status).toBe(101);
        response.webSocket.accept();
        return response.webSocket;
      }
    });
    let latest;
    let connectionStatus;
    try {
      await client.session(grant.credential);
      expect((await client.catalog()).target).toEqual(target);
      const document = createStateQueryTools().deaths(target);
      expect((await client.read(document)).data.deaths.value.count).toBe(2);
      client.watch(document, {
        onResult(value) { latest = value; },
        onStatus(value) { connectionStatus = value; }
      });
      await vi.waitFor(
        () => expect(latest?.result.data.deaths.value.count).toBe(2),
        { timeout: 3000 }
      );

      await setRememberedGame(target, "Sekiro");
      await drainLocalMutation(target);
      await vi.waitFor(
        () => expect(latest?.result.data.deaths.value).toEqual({ game: "Sekiro", count: 5 }),
        { timeout: 3000 }
      );

      const integrationId = `browser-handoff-${++sequence}`;
      const discord = group(target);
      const twitch = createPlatformGroupRef({
        platform: "twitch",
        kind: "channel",
        id: integrationId
      });
      const realm = createIntegrationRealmIdentity({ id: integrationId }, { generation: 1 });
      await requestShareableStateRealm(streamEnv, {
        realm,
        featureId: "fun.deaths",
        namespaceId: "game_deaths",
        operation: "bounded-counter",
        storage: {
          name: "game",
          subject: "sekiro",
          subjectLabel: "Sekiro",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          initial: 0,
          operation: "set",
          value: 12
        }
      });
      await runInDurableObject(integrationRegistryStub(streamEnv), async (_instance, state) => {
        const registry = new IntegrationRegistry(state, streamEnv);
        state.storage.sql.exec(`INSERT INTO integrations
          (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
           created_by_platform, created_by_actor_id, completed_by_platform,
           completed_by_actor_id, shareable_state_generation)
          VALUES (?, 'active', 1, 1, 1, 'discord', 'manager', 'twitch', 'broadcaster', 1)`,
        integrationId);
        for (const member of [discord, twitch]) {
          state.storage.sql.exec(`INSERT INTO integration_members
            (integration_id, group_key, platform, group_kind, group_id, joined_at_ms)
            VALUES (?, ?, ?, ?, ?, 1)`,
          integrationId, member.key, member.platform, member.kind, member.id);
        }
        registry.assignDefaultLinkIfAbsent({
          sourceGroup: discord,
          targetGroup: twitch,
          integrationId,
          nowMs: Date.now()
        });
      });
      for (let round = 0; round < 3; round += 1) {
        await runInDurableObject(integrationRegistryStub(streamEnv), async (_instance, state) => {
          await drainStateQueryBindingNotifications(state, streamEnv);
        });
        await runInDurableObject(observerStub(target),
          async (instance) => { await instance.alarm(); });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await vi.waitFor(
        () => expect(latest?.result.data.deaths.value.count).toBe(12),
        { timeout: 3000 }
      );
      expect(latest.reason).toBe("source_change");
      await drainMutation(target, await setGameCount(target, "Sekiro", 13));
      await vi.waitFor(
        () => expect(latest?.result.data.deaths.value.count).toBe(13),
        { timeout: 3000 }
      );

      await revokeStateQueryCredential(streamEnv, grant.credential);
      await runInDurableObject(observerStub(target), async (instance, state) => {
        state.storage.sql.exec(
          "UPDATE state_query_observer_queries SET next_authorization_at_ms = 0"
        );
        await instance.alarm();
      });
      await vi.waitFor(
        () => expect(connectionStatus?.state).toBe("ended"),
        { timeout: 3000 }
      );
    } finally {
      await client.close();
    }
  }, 15_000);
});
