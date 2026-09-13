import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { featureRegistry } from "../src/features/index.js";
import {
  createPlatformGroupRef,
  IntegrationRegistry,
  integrationRegistryStub
} from "../src/integrations/index.js";
import {
  createIntegrationRealmIdentity,
  requestShareableStateRealm,
  shareableStateRealmStub
} from "../src/shareable-state/index.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { issueStateQueryGrant, revokeStateQueryCredential, stateQueryEnvironment } from
  "../src/state-querying/grant-client.js";
import { grantPermissionsForExportList } from "../src/state-querying/grants.js";
import {
  drainStateQueryBindingNotifications
} from "../src/state-querying/binding-notifications.js";
import {
  stateQueryObserverObjectName
} from "../src/state-querying/source-notifications.js";
import {
  attachLiveStateQuery,
  getLiveStateQuery,
  STATE_QUERY_LIVE_LIMITS
} from "../src/state-querying/index.js";

let sequence = 0;
const unique = (prefix) => `${prefix}-live-${++sequence}`;
const liveEnv = {
  ...env,
  STATE_QUERY_CREDENTIAL_SIGNING_SECRET:
    "test-state-query-signing-secret-32-bytes-minimum"
};

function target(platform = "discord") {
  return { platform, groupId: unique(platform) };
}

function group(selectedTarget) {
  return createPlatformGroupRef({
    platform: selectedTarget.platform,
    kind: selectedTarget.platform === "discord" ? "guild" : "channel",
    id: selectedTarget.groupId
  });
}

function read(exportId, args) {
  return {
    read: { feature: "fun.deaths", export: exportId, version: 1 },
    ...(args ? { arguments: args } : {})
  };
}

function query(selectedTarget, bindings, select) {
  return { version: 1, target: selectedTarget, bindings, select };
}

async function issue(selectedTarget, exports) {
  return await issueStateQueryGrant(liveEnv, featureRegistry, {
    target: selectedTarget,
    permissions: grantPermissionsForExportList(
      featureRegistry,
      selectedTarget.platform,
      exports
    ),
    expiresInSeconds: 3600
  }, {
    actor: { platform: selectedTarget.platform, id: "operator" }
  });
}

function servicesFor(selectedTarget) {
  const selectedGroup = group(selectedTarget);
  return createFeatureServiceRuntime(liveEnv, createCommandInvocation({
    kind: "test.state-query.live.v1",
    origin: {
      group: selectedGroup,
      actor: { platform: selectedTarget.platform, id: "operator", claims: [] }
    },
    sourceEventId: `${selectedTarget.platform}:${unique("event")}`
  })).featureServices;
}

async function shareableScope(selectedTarget) {
  return await servicesFor(selectedTarget).shareableState.current(
    "fun.deaths",
    selectedTarget.platform === "discord" ? "twitch" : "discord",
    "game_deaths"
  );
}

async function setCount(selectedTarget, game, value) {
  const services = servicesFor(selectedTarget);
  const scope = await services.shareableState.current(
    "fun.deaths",
    selectedTarget.platform === "discord" ? "twitch" : "discord",
    "game_deaths"
  );
  await services.shareableState.boundedCounter(
    "fun.deaths",
    scope,
    {
      name: "game",
      subject: game.toLowerCase(),
      subjectLabel: game,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      initial: 0
    },
    "set",
    value
  );
}

async function resetCount(selectedTarget, game) {
  const services = servicesFor(selectedTarget);
  const scope = await services.shareableState.current(
    "fun.deaths",
    selectedTarget.platform === "discord" ? "twitch" : "discord",
    "game_deaths"
  );
  await services.shareableState.boundedCounter(
    "fun.deaths",
    scope,
    {
      name: "game",
      subject: game.toLowerCase(),
      subjectLabel: game,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      initial: 0
    },
    "reset"
  );
}

function observerStub(selectedTarget) {
  const selectedGroup = group(selectedTarget);
  const name = stateQueryObserverObjectName(stateQueryEnvironment(env), selectedGroup);
  return liveEnv.STATE_QUERY_OBSERVER.get(
    liveEnv.STATE_QUERY_OBSERVER.idFromName(name)
  );
}

async function drainObserver(selectedTarget) {
  await runInDurableObject(observerStub(selectedTarget), async (instance) => {
    await instance.alarm();
  });
}

async function drainLocal(selectedTarget) {
  const selectedGroup = group(selectedTarget);
  const stub = liveEnv.CONFIG.get(liveEnv.CONFIG.idFromName(selectedGroup.key));
  await runInDurableObject(stub, async (instance) => {
    await instance.alarm();
  });
}

async function drainShareable(selectedTarget) {
  const scope = await shareableScope(selectedTarget);
  await runInDurableObject(
    shareableStateRealmStub(liveEnv, scope.realm),
    async (instance) => {
      await instance.alarm();
    }
  );
}

async function current(selectedTarget, selectedQueryId) {
  return (await getLiveStateQuery(liveEnv, selectedTarget, {
    queryId: selectedQueryId
  })).query;
}

function installIntegration(state, registry, {
  integrationId,
  discord,
  twitch,
  createdAtMs,
  assignDiscordDefault
}) {
  state.storage.sql.exec(
    `INSERT INTO integrations
      (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
       created_by_platform, created_by_actor_id, completed_by_platform,
       completed_by_actor_id, shareable_state_generation)
     VALUES (?, 'active', ?, ?, ?, 'discord', 'manager', 'twitch',
             'broadcaster', 1)`,
    integrationId,
    createdAtMs,
    createdAtMs,
    createdAtMs
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
      createdAtMs
    );
  }
  if (assignDiscordDefault) {
    registry.assignDefaultLinkIfAbsent({
      sourceGroup: discord,
      targetGroup: twitch,
      integrationId,
      nowMs: createdAtMs
    });
  }
}

async function setRealmCount(realm, game, value) {
  await requestShareableStateRealm(liveEnv, {
    realm,
    featureId: "fun.deaths",
    namespaceId: "game_deaths",
    operation: "bounded-counter",
    storage: {
      name: "game",
      subject: game.toLowerCase(),
      subjectLabel: game,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      initial: 0,
      operation: "set",
      value
    }
  });
}

describe("live state-query dependency coordination", () => {
  it("starts blocked and attaches the selected counter when one appears", async () => {
    const selectedTarget = target();
    const grant = await issue(
      selectedTarget,
      "fun.deaths:remembered_game:v1,fun.deaths:count:v1"
    );
    const selectedQueryId = unique("absent-selection");
    const document = query(selectedTarget, {
      remembered: read("remembered_game"),
      current: read("count", { game: { ref: "remembered" } })
    }, {
      game: { ref: "remembered" },
      count: { ref: "current", path: ["count"] }
    });
    const attached = await attachLiveStateQuery(liveEnv, {
      queryId: selectedQueryId,
      grantId: grant.grant.id,
      query: document
    });
    expect(attached.envelope.data).toMatchObject({
      game: { state: "unselected" },
      count: { state: "blocked", reason: "unselected", binding: "remembered" }
    });
    expect(attached.envelope.status).toBe("ready");

    await setCount(selectedTarget, "Hades", 6);
    await servicesFor(selectedTarget).state.set("fun.deaths", "last_game", "Hades");
    await drainLocal(selectedTarget);
    await drainObserver(selectedTarget);
    const selected = await current(selectedTarget, selectedQueryId);
    expect(selected.envelope.data).toMatchObject({
      game: { state: "present", value: "Hades" },
      count: { state: "present", value: 6 }
    });
    expect(selected.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bounded_counter", subject: "hades" })
    ]));
  });

  it("switches a dynamic counter dependency and ignores the old value", async () => {
    const selectedTarget = target();
    const services = servicesFor(selectedTarget);
    await services.state.set("fun.deaths", "last_game", "Hades");
    await setCount(selectedTarget, "Hades", 4);
    await setCount(selectedTarget, "Sekiro", 8);
    const grant = await issue(
      selectedTarget,
      "fun.deaths:remembered_game:v1,fun.deaths:count:v1"
    );
    const selectedQueryId = unique("dynamic");
    const document = query(selectedTarget, {
      remembered: read("remembered_game"),
      current: read("count", { game: { ref: "remembered" } })
    }, {
      game: { ref: "remembered" },
      count: { ref: "current", path: ["count"] }
    });
    const attached = await attachLiveStateQuery(liveEnv, {
      queryId: selectedQueryId,
      grantId: grant.grant.id,
      query: document,
      leaseSeconds: 120
    });
    expect(attached.envelope.data.count.value).toBe(4);

    await services.state.set("fun.deaths", "last_game", "Sekiro");
    await drainLocal(selectedTarget);
    await drainObserver(selectedTarget);
    const switched = await current(selectedTarget, selectedQueryId);
    expect(switched.envelope.data).toMatchObject({
      game: { state: "present", value: "Sekiro" },
      count: { state: "present", value: 8 }
    });
    expect(switched.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bounded_counter", subject: "sekiro" })
    ]));

    await setCount(selectedTarget, "Hades", 99);
    await drainShareable(selectedTarget);
    await drainObserver(selectedTarget);
    const afterOld = await current(selectedTarget, selectedQueryId);
    expect(afterOld.envelope.data.count.value).toBe(8);
    expect(afterOld.sequence).toBe(switched.sequence);

    await setCount(selectedTarget, "Sekiro", 9);
    await drainShareable(selectedTarget);
    await drainObserver(selectedTarget);
    const afterCurrent = await current(selectedTarget, selectedQueryId);
    expect(afterCurrent.envelope.data.count.value).toBe(9);
    expect(afterCurrent.sequence).toBe(switched.sequence + 1);
  });

  it("observes collection insertion and removal with no authored query preset", async () => {
    const selectedTarget = target();
    const grant = await issue(selectedTarget, "fun.deaths:counts:v1");
    const selectedQueryId = unique("collection");
    const document = query(selectedTarget, {
      counts: read("counts")
    }, { counts: { ref: "counts" } });
    const attached = await attachLiveStateQuery(liveEnv, {
      queryId: selectedQueryId,
      grantId: grant.grant.id,
      query: document
    });
    expect(attached.envelope.data.counts.value).toEqual([]);

    await setCount(selectedTarget, "Hades", 3);
    await drainShareable(selectedTarget);
    await drainObserver(selectedTarget);
    expect((await current(selectedTarget, selectedQueryId)).envelope.data.counts.value)
      .toEqual([{ game: "Hades", count: 3 }]);

    await resetCount(selectedTarget, "Hades");
    await drainShareable(selectedTarget);
    await drainObserver(selectedTarget);
    expect((await current(selectedTarget, selectedQueryId)).envelope.data.counts.value)
      .toEqual([]);
  });

  it("shares source interest while preserving per-grant revocation", async () => {
    const selectedTarget = target();
    await servicesFor(selectedTarget).state.set("fun.deaths", "last_game", "Hades");
    const firstGrant = await issue(selectedTarget, "fun.deaths:remembered_game:v1");
    const secondGrant = await issue(selectedTarget, "fun.deaths:remembered_game:v1");
    const document = query(selectedTarget, {
      remembered: read("remembered_game")
    }, { game: { ref: "remembered" } });
    await attachLiveStateQuery(liveEnv, {
      queryId: "shared-first",
      grantId: firstGrant.grant.id,
      query: document
    });
    await attachLiveStateQuery(liveEnv, {
      queryId: "shared-second",
      grantId: secondGrant.grant.id,
      query: document
    });
    await runInDurableObject(observerStub(selectedTarget), async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_observer_sources"
      ).one().total).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_observer_query_sources"
      ).one().total).toBe(2);
    });

    await revokeStateQueryCredential(liveEnv, firstGrant.credential);
    await runInDurableObject(observerStub(selectedTarget), async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE state_query_observer_queries SET next_authorization_at_ms = 0
         WHERE query_id = 'shared-first'`
      );
      await instance.alarm();
    });
    expect((await current(selectedTarget, "shared-first"))).toMatchObject({
      state: "denied",
      errorCode: "query_grant_revoked"
    });
    expect((await current(selectedTarget, "shared-second"))).toMatchObject({
      state: "active",
      envelope: { data: { game: { value: "Hades" } } }
    });
    await runInDurableObject(observerStub(selectedTarget), async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_observer_sources"
      ).one().total).toBe(1);
    });
  });

  it("attaches a replacement realm before retiring a same-value old source", async () => {
    const selectedTarget = target();
    const discord = group(selectedTarget);
    const firstTwitch = createPlatformGroupRef({
      platform: "twitch",
      kind: "channel",
      id: unique("first-twitch")
    });
    const secondTwitch = createPlatformGroupRef({
      platform: "twitch",
      kind: "channel",
      id: unique("second-twitch")
    });
    const firstId = unique("first-integration");
    const secondId = unique("second-integration");
    await runInDurableObject(
      integrationRegistryStub(liveEnv),
      async (_instance, state) => {
        const registry = new IntegrationRegistry(state, liveEnv);
        installIntegration(state, registry, {
          integrationId: firstId,
          discord,
          twitch: firstTwitch,
          createdAtMs: 1,
          assignDiscordDefault: true
        });
        installIntegration(state, registry, {
          integrationId: secondId,
          discord,
          twitch: secondTwitch,
          createdAtMs: 2,
          assignDiscordDefault: false
        });
      }
    );
    const firstRealm = createIntegrationRealmIdentity(
      { id: firstId },
      { generation: 1 }
    );
    const secondRealm = createIntegrationRealmIdentity(
      { id: secondId },
      { generation: 1 }
    );
    await setRealmCount(firstRealm, "Hades", 7);
    await setRealmCount(secondRealm, "Hades", 7);
    const grant = await issue(selectedTarget, "fun.deaths:count:v1");
    const document = query(selectedTarget, {
      count: read("count", { game: { literal: "Hades" } })
    }, { count: { ref: "count", path: ["count"] } });
    const attached = await attachLiveStateQuery(liveEnv, {
      queryId: "source-handoff",
      grantId: grant.grant.id,
      query: document
    });
    expect(attached.envelope.data.count.value).toBe(7);

    await runInDurableObject(
      integrationRegistryStub(liveEnv),
      async (_instance, state) => {
        const registry = new IntegrationRegistry(state, liveEnv);
        registry.setDefaultLink({
          sourceGroup: discord,
          targetGroup: secondTwitch,
          integrationId: secondId,
          actor: { platform: "discord", id: "manager", claims: [] }
        });
        await drainStateQueryBindingNotifications(state, liveEnv);
      }
    );
    await drainObserver(selectedTarget);
    const switched = await current(selectedTarget, "source-handoff");
    expect(switched.envelope.data.count.value).toBe(7);
    expect(switched.sequence).toBe(attached.sequence + 1);
    expect(switched.envelope.bindingRevision)
      .not.toBe(attached.envelope.bindingRevision);
    await runInDurableObject(observerStub(selectedTarget), async (_instance, state) => {
      const sources = state.storage.sql.exec(
        `SELECT source_kind, attachment_json
         FROM state_query_observer_sources ORDER BY source_kind`
      ).toArray();
      expect(sources).toHaveLength(2);
      expect(sources.find(({ source_kind }) => source_kind === "shareable")
        .attachment_json).toContain(secondId);
      expect(JSON.stringify(sources)).not.toContain(firstId);
    });
  });

  it("expires query leases and removes their orphaned source interest", async () => {
    const selectedTarget = target();
    await servicesFor(selectedTarget).state.set("fun.deaths", "last_game", "Hades");
    const grant = await issue(selectedTarget, "fun.deaths:remembered_game:v1");
    const selectedQueryId = unique("expired");
    await attachLiveStateQuery(liveEnv, {
      queryId: selectedQueryId,
      grantId: grant.grant.id,
      query: query(selectedTarget, {
        remembered: read("remembered_game")
      }, { game: { ref: "remembered" } })
    });
    await runInDurableObject(observerStub(selectedTarget), async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE state_query_observer_queries SET lease_expires_at_ms = 0
         WHERE query_id = ?`,
        selectedQueryId
      );
      await instance.alarm();
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_observer_sources"
      ).one().total).toBe(0);
    });
    expect(await current(selectedTarget, selectedQueryId)).toBeNull();
  });

  it("rejects new work explicitly when the active-query budget is exhausted", async () => {
    const selectedTarget = target();
    await servicesFor(selectedTarget).state.set("fun.deaths", "last_game", "Hades");
    const grant = await issue(selectedTarget, "fun.deaths:remembered_game:v1");
    const document = query(selectedTarget, {
      remembered: read("remembered_game")
    }, { game: { ref: "remembered" } });
    await attachLiveStateQuery(liveEnv, {
      queryId: "capacity-first",
      grantId: grant.grant.id,
      query: document
    });
    await runInDurableObject(observerStub(selectedTarget), async (_instance, state) => {
      for (let index = 1; index < STATE_QUERY_LIVE_LIMITS.maxActiveQueries; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO state_query_observer_queries
            (query_id, grant_id, query_digest, query_json, envelope_json,
             dependencies_json, result_revision, result_sequence, query_state,
             error_code, pending_reason, attempt_count, next_attempt_at_ms,
             next_authorization_at_ms, lease_expires_at_ms, created_at_ms,
             updated_at_ms)
           SELECT ?, grant_id, ?, query_json, envelope_json, dependencies_json,
                  result_revision, result_sequence, query_state, error_code,
                  pending_reason, attempt_count, next_attempt_at_ms,
                  next_authorization_at_ms, lease_expires_at_ms, created_at_ms,
                  updated_at_ms
           FROM state_query_observer_queries WHERE query_id = 'capacity-first'`,
          `capacity-seed-${index}`,
          `capacity-digest-${index}`
        );
      }
    });

    await expect(attachLiveStateQuery(liveEnv, {
      queryId: "capacity-overflow",
      grantId: grant.grant.id,
      query: document
    })).rejects.toMatchObject({
      code: "state_query_live_capacity",
      status: 429
    });
  });
});
