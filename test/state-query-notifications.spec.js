import { describe, expect, it } from "vitest";
import {
  env,
  runInDurableObject
} from "cloudflare:test";
import { createPlatformGroupRef } from "../src/integrations/contracts.js";
import {
  createStandaloneRealmIdentity,
  requestShareableStateRealm,
  shareableStateRealmStub
} from "../src/shareable-state/index.js";
import { stateQueryEnvironment } from "../src/state-querying/grant-client.js";
import { STATE_QUERY_OBSERVER_PATHS } from "../src/state-querying/observer.js";
import {
  drainStateQueryNotifications,
  recoverStateQueryNotificationDelivery,
  stateQueryObserverObjectName
} from "../src/state-querying/source-notifications.js";
import {
  acknowledgeStateQueryNotifications,
  listStateQueryNotifications,
  registerLocalStateQueryWatcher,
  registerShareableStateQueryWatcher
} from "../src/state-querying/watcher-client.js";

let idCounter = 0;

function discordGroup(prefix = "notification-guild") {
  idCounter += 1;
  return createPlatformGroupRef({
    platform: "discord",
    kind: "guild",
    id: `${prefix}-${idCounter}`
  });
}

function localStub(group) {
  return env.CONFIG.get(env.CONFIG.idFromName(group.key));
}

async function drainSource(stub, environment = env) {
  await runInDurableObject(stub, async (instance, _state) => {
    instance.env = environment;
    await instance.alarm();
  });
}

async function localState(group, operation, body) {
  return localStub(group).fetch(`https://group-config/internal/framework/state/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: "test.notifications", ...body })
  });
}

async function localRevision(group) {
  const response = await localState(group, "revision", {});
  return (await response.json()).mutationVersion;
}

function watcher(group, watcherId, expectedRevision) {
  return {
    sourceGroup: group,
    target: group,
    featureId: "test.notifications",
    watcherId,
    expectedRevision,
    leaseSeconds: 120
  };
}

describe("recoverable state-query notifications", () => {
  it("closes the local snapshot/register race and emits only committed changes", async () => {
    const group = discordGroup();
    expect((await localState(group, "set", { key: "score", value: 1 })).status).toBe(200);

    const attached = await registerLocalStateQueryWatcher(
      env,
      watcher(group, "local-race", 0)
    );
    expect(attached).toMatchObject({
      currentRevision: 1,
      revisionMatched: false,
      watcherId: "local-race"
    });

    expect((await localState(group, "set", { key: "score", value: 2 })).status).toBe(200);
    await runInDurableObject(localStub(group), async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_source_watchers"
      ).one().total).toBe(1);
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS total,
                MIN(source_revision) AS source_revision
         FROM state_query_notification_outbox`
      ).one()).toMatchObject({ total: 1, source_revision: 2 });
      expect(state.storage.sql.exec(
        `SELECT mutation_version
         FROM framework_feature_state_versions
         WHERE feature_id = ?`,
        "test.notifications"
      ).one().mutation_version).toBe(2);
    });
    await drainSource(localStub(group));
    const delivered = await listStateQueryNotifications(env, group);
    expect(delivered.notifications).toHaveLength(1);
    expect(delivered.notifications[0]).toMatchObject({
      watcherId: "local-race",
      source: {
        kind: "group_local",
        key: group.key,
        featureId: "test.notifications"
      },
      revision: 2
    });

    await acknowledgeStateQueryNotifications(
      env,
      group,
      delivered.notifications.map((notification) => notification.id)
    );
    expect((await localState(group, "set", { key: "score", value: 2 })).status).toBe(200);
    expect(await localRevision(group)).toBe(2);
    await drainSource(localStub(group));
    expect((await listStateQueryNotifications(env, group)).notifications).toEqual([]);
  });

  it("records local subject-metadata changes even when the counter value is unchanged", async () => {
    const group = discordGroup();
    const input = watcher(group, "local-metadata", 0);
    expect((await registerLocalStateQueryWatcher(env, input)).revisionMatched).toBe(true);
    const counter = {
      name: "deaths",
      subject: "hades",
      min: 0,
      max: 100,
      initial: 0,
      operation: "set",
      value: 4
    };
    expect((await localState(group, "bounded-counter", counter)).status).toBe(200);
    await drainSource(localStub(group));
    const first = await listStateQueryNotifications(env, group);
    await acknowledgeStateQueryNotifications(env, group, [first.notifications[0].id]);

    expect((await localState(group, "bounded-counter", {
      ...counter,
      subjectLabel: "Hades"
    })).status).toBe(200);
    await drainSource(localStub(group));
    const second = await listStateQueryNotifications(env, group);
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0].revision).toBe(2);
  });

  it("notifies shareable collection insertion and removal from the same realm revision", async () => {
    const group = discordGroup("shareable-notification-guild");
    const realm = createStandaloneRealmIdentity(group);
    const revision = await requestShareableStateRealm(env, {
      realm,
      featureId: "fun.deaths",
      namespaceId: "game_deaths",
      operation: "revision"
    });
    const attached = await registerShareableStateQueryWatcher(env, {
      realm,
      target: group,
      featureId: "fun.deaths",
      namespaceId: "game_deaths",
      watcherId: "shareable-collection",
      expectedRevision: revision.mutationVersion,
      leaseSeconds: 120
    });
    expect(attached.revisionMatched).toBe(true);

    const mutate = (operation, extra = {}) => requestShareableStateRealm(env, {
      realm,
      featureId: "fun.deaths",
      namespaceId: "game_deaths",
      operation: "bounded-counter",
      storage: {
        name: "game",
        subject: "hades",
        subjectLabel: "Hades",
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        initial: 0,
        operation,
        ...extra
      }
    });
    await mutate("set", { value: 4 });
    const stub = shareableStateRealmStub(env, realm);
    await drainSource(stub);
    const inserted = await listStateQueryNotifications(env, group);
    expect(inserted.notifications).toHaveLength(1);
    expect(inserted.notifications[0]).toMatchObject({
      source: {
        kind: "shareable",
        featureId: "fun.deaths",
        namespaceId: "game_deaths"
      },
      revision: revision.mutationVersion + 1
    });
    await acknowledgeStateQueryNotifications(env, group, [inserted.notifications[0].id]);

    await mutate("set", { value: 4 });
    await drainSource(stub);
    expect((await listStateQueryNotifications(env, group)).notifications).toEqual([]);
    expect((await requestShareableStateRealm(env, {
      realm,
      featureId: "fun.deaths",
      namespaceId: "game_deaths",
      operation: "revision"
    })).mutationVersion).toBe(revision.mutationVersion + 1);

    await mutate("reset");
    await drainSource(stub);
    const removed = await listStateQueryNotifications(env, group);
    expect(removed.notifications).toHaveLength(1);
    expect(removed.notifications[0].revision).toBe(revision.mutationVersion + 2);
  });

  it("keeps a failed delivery durable and recovers it after a source restart", async () => {
    const group = discordGroup();
    const stub = localStub(group);
    await registerLocalStateQueryWatcher(env, watcher(group, "retry-after-restart", 0));
    await runInDurableObject(stub, async (instance) => {
      instance.env = {
        ...env,
        STATE_QUERY_OBSERVER: {
          idFromName: () => "failing-observer",
          get: () => ({
            fetch: async () => new Response("Unavailable", { status: 503 })
          })
        }
      };
    });

    const mutation = await localState(group, "set", { key: "score", value: 3 });
    expect(mutation.status).toBe(200);
    await runInDurableObject(stub, async (instance, _state) => {
      await instance.alarm();
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec(
        `SELECT attempt_count FROM state_query_notification_outbox`
      ).one();
      expect(row.attempt_count).toBe(1);
    });

    expect((await localState(group, "set", { key: "score", value: 4 })).status).toBe(200);
    await runInDurableObject(stub, async (instance, state) => {
      const pending = state.storage.sql.exec(
        `SELECT COUNT(*) AS total, source_revision, attempt_count
         FROM state_query_notification_outbox`
      ).one();
      expect(pending).toMatchObject({ total: 1, source_revision: 2, attempt_count: 0 });
      await state.storage.deleteAlarm();
      await recoverStateQueryNotificationDelivery(state);
      expect(await state.storage.getAlarm()).not.toBeNull();
      state.storage.sql.exec(
        "UPDATE state_query_notification_outbox SET next_attempt_at_ms = 0"
      );
      await state.storage.setAlarm(Date.now());
      instance.env = env;
      await drainStateQueryNotifications(state, env);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_notification_outbox"
      ).one().total).toBe(0);
    });
    const recovered = await listStateQueryNotifications(env, group);
    expect(recovered.notifications).toHaveLength(1);
    expect(recovered.notifications[0].revision).toBe(2);
  });

  it("deduplicates retries and expires stale watcher and outbox records", async () => {
    const group = discordGroup();
    const normalized = createPlatformGroupRef(group);
    const observerKey = stateQueryObserverObjectName(
      stateQueryEnvironment(env),
      normalized
    );
    const observer = env.STATE_QUERY_OBSERVER.get(
      env.STATE_QUERY_OBSERVER.idFromName(observerKey)
    );
    const notification = {
      version: 1,
      id: "a".repeat(32),
      watcherId: "duplicate-delivery",
      observer: {
        environment: stateQueryEnvironment(env),
        target: { platform: group.platform, groupId: group.id }
      },
      source: {
        kind: "group_local",
        key: group.key,
        featureId: "test.notifications"
      },
      revision: 1,
      committedAtMs: Date.now()
    };
    const deliver = (value = notification) => observer.fetch(
      `https://observer${STATE_QUERY_OBSERVER_PATHS.deliver}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value)
      }
    );
    expect(await (await deliver()).json()).toEqual({ accepted: true, duplicate: false });
    expect(await (await deliver()).json()).toEqual({ accepted: true, duplicate: true });
    expect(await (await deliver({
      ...notification,
      id: "b".repeat(32),
      revision: 2
    })).json()).toEqual({ accepted: true, duplicate: false });
    expect(await (await deliver({
      ...notification,
      id: "c".repeat(32),
      revision: 1
    })).json()).toEqual({ accepted: true, duplicate: false });
    const coalesced = await listStateQueryNotifications(env, group);
    expect(coalesced.notifications).toHaveLength(1);
    expect(coalesced.notifications[0]).toMatchObject({
      id: "b".repeat(32),
      revision: 2
    });

    const sourceGroup = discordGroup("expiring-source");
    const sourceStub = localStub(sourceGroup);
    await registerLocalStateQueryWatcher(
      env,
      watcher(sourceGroup, "expiring-watcher", 0)
    );
    await runInDurableObject(sourceStub, async (instance) => {
      instance.env = {
        ...env,
        STATE_QUERY_OBSERVER: {
          idFromName: () => "expiring-failing-observer",
          get: () => ({ fetch: async () => new Response(null, { status: 503 }) })
        }
      };
    });
    expect((await localState(sourceGroup, "set", { key: "score", value: 1 })).status)
      .toBe(200);
    await runInDurableObject(sourceStub, async (instance) => {
      await instance.alarm();
    });
    await runInDurableObject(sourceStub, async (instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_notification_outbox"
      ).one().total).toBe(1);
      state.storage.sql.exec(
        "UPDATE state_query_source_watchers SET lease_expires_at_ms = 0"
      );
      state.storage.sql.exec(
        "UPDATE state_query_notification_outbox SET lease_expires_at_ms = 0"
      );
      await state.storage.setAlarm(Date.now());
      instance.env = env;
    });
    await drainSource(sourceStub);
    await runInDurableObject(sourceStub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_source_watchers"
      ).one().total).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM state_query_notification_outbox"
      ).one().total).toBe(0);
    });
  });

  it("does not create notification work when a state source has no interest", async () => {
    const group = discordGroup();
    const stub = localStub(group);
    expect((await localState(group, "set", { key: "score", value: 1 })).status).toBe(200);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS total FROM sqlite_master
         WHERE type = 'table' AND name = 'state_query_notification_outbox'`
      ).one().total).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
