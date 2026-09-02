import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { defineFeature, frameworkApiVersion } from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/internal.js";
import {
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  requestStandaloneRealmState,
  ShareableStateRealmBackend,
  shareableStateRealmObjectName,
  shareableStateRealmStub,
  standaloneRealmObjectName,
  standaloneRealmStub
} from "../src/shareable-state/index.js";

let idCounter = 0;
const uniqueId = (prefix) => `${prefix}-${++idCounter}`;
const discordGroup = (id = uniqueId("guild")) => ({
  platform: "discord",
  kind: "guild",
  id
});
const twitchGroup = (id = uniqueId("channel")) => ({
  platform: "twitch",
  kind: "channel",
  id
});

function featureRegistry({ schemaVersion = 1, compatibleVersions = [1] } = {}) {
  return createFeatureRegistry([
    defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.score",
      description: "Exercises standalone shareable-state realms.",
      shareableState: [
        {
          id: "score",
          label: "Shared score",
          schemaVersion,
          compatibleVersions,
          limits: { maxEntries: 2, maxValueBytes: 64 }
        },
        {
          id: "counter",
          label: "Shared counter",
          schemaVersion: 1,
          limits: { maxEntries: 20, maxValueBytes: 64 }
        },
        {
          id: "tiny",
          label: "Tiny numeric state",
          schemaVersion: 1,
          limits: { maxEntries: 2, maxValueBytes: 1 }
        }
      ]
    })
  ]);
}

function realmRequest(backend, group, namespaceId, operation, storage = {}) {
  return backend.fetch(new Request(
    `https://shareable-state/internal/shareable-state/realm/${operation}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        realm: createStandaloneRealmIdentity(group),
        namespace: { featureId: "test.score", namespaceId },
        storage
      })
    }
  ));
}

async function responseData(response) {
  return { status: response.status, data: await response.json() };
}

describe("Standalone shareable-state realms", () => {
  it("derives stable, group-isolated object identities", () => {
    const first = createStandaloneRealmIdentity(discordGroup("one"));
    const same = createStandaloneRealmIdentity(discordGroup("one"));
    const other = createStandaloneRealmIdentity(twitchGroup("one"));

    expect(first).toEqual(same);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.ownerGroup)).toBe(true);
    expect(standaloneRealmObjectName(first)).toBe(
      "shareable-state:standalone:g1:discord:guild:one"
    );
    expect(standaloneRealmObjectName(other)).not.toBe(
      standaloneRealmObjectName(first)
    );
    const integration = createIntegrationRealmIdentity({ id: "integration-one" });
    expect(shareableStateRealmObjectName(integration)).toBe(
      "shareable-state:integration:g1:integration:integration-one"
    );
    expect(
      env.SHAREABLE_STATE_REALM.idFromName(standaloneRealmObjectName(first)).toString()
    ).not.toBe(
      env.SHAREABLE_STATE_REALM.idFromName(standaloneRealmObjectName(other)).toString()
    );
  });

  it("binds integration realms to one integration owner", async () => {
    const identity = createIntegrationRealmIdentity({ id: uniqueId("integration") });
    const stub = shareableStateRealmStub(env, identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const request = (realm) => backend.fetch(new Request(
        "https://shareable-state/internal/shareable-state/realm/set",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            realm,
            namespace: { featureId: "test.score", namespaceId: "score" },
            storage: { key: "value", value: 1 }
          })
        }
      ));

      expect((await request(identity)).status).toBe(200);
      expect((await responseData(await request(createIntegrationRealmIdentity({
        id: uniqueId("other-integration")
      }))))).toMatchObject({
        status: 409,
        data: { code: "shareable_state_realm_identity_mismatch" }
      });
    });
  });

  it("persists canonical values with namespace isolation and atomic versions", async () => {
    const group = discordGroup();
    const stub = standaloneRealmStub(env, createStandaloneRealmIdentity(group));
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());

      expect(await responseData(await realmRequest(
        backend,
        group,
        "score",
        "get",
        { key: "value" }
      ))).toEqual({ status: 200, data: { value: null } });
      expect((await responseData(await realmRequest(
        backend,
        group,
        "score",
        "set",
        { key: "value", value: { z: 1, a: 2 } }
      ))).data).toEqual({ ok: true });
      expect((await responseData(await realmRequest(
        backend,
        group,
        "score",
        "set",
        { key: "value", value: { a: 2, z: 1 } }
      ))).data).toEqual({ ok: true });

      const stored = state.storage.sql.exec(
        `SELECT value_json FROM shareable_state_realm_values
         WHERE feature_id = 'test.score' AND namespace_id = 'score'
           AND value_key = 'value'`
      ).one();
      expect(stored.value_json).toBe('{"a":2,"z":1}');
      expect(state.storage.sql.exec(
        `SELECT mutation_version FROM shareable_state_realm_namespaces
         WHERE feature_id = 'test.score' AND namespace_id = 'score'`
      ).one().mutation_version).toBe(1);

      expect((await responseData(await realmRequest(
        backend,
        group,
        "counter",
        "get",
        { key: "value" }
      ))).data).toEqual({ value: null });
      await Promise.all(Array.from({ length: 10 }, () => realmRequest(
        backend,
        group,
        "counter",
        "increment",
        { key: "value", amount: 1 }
      )));
      expect((await responseData(await realmRequest(
        backend,
        group,
        "counter",
        "get",
        { key: "value" }
      ))).data).toEqual({ value: 10 });
      expect(state.storage.sql.exec(
        `SELECT mutation_version FROM shareable_state_realm_namespaces
         WHERE feature_id = 'test.score' AND namespace_id = 'counter'`
      ).one().mutation_version).toBe(10);
    });
  });

  it("enforces declarations, identity, entry limits, and byte limits", async () => {
    const group = discordGroup();
    const otherGroup = discordGroup();
    const stub = standaloneRealmStub(env, createStandaloneRealmIdentity(group));
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());

      expect((await realmRequest(
        backend,
        group,
        "score",
        "unknown",
        { key: "value" }
      )).status).toBe(404);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM shareable_state_realm_meta"
      ).one().total).toBe(0);
      expect((await responseData(await realmRequest(
        backend,
        group,
        "missing",
        "get",
        { key: "value" }
      )))).toMatchObject({
        status: 404,
        data: { code: "shareable_state_namespace_not_declared" }
      });
      for (const key of ["one", "two"]) {
        expect((await realmRequest(backend, group, "score", "set", {
          key,
          value: key
        })).status).toBe(200);
      }
      expect((await responseData(await realmRequest(
        backend,
        group,
        "score",
        "set",
        { key: "three", value: 3 }
      )))).toMatchObject({
        status: 409,
        data: { code: "shareable_state_namespace_full" }
      });
      expect((await responseData(await realmRequest(
        backend,
        group,
        "counter",
        "set",
        { key: "large", value: "x".repeat(65) }
      )))).toMatchObject({
        status: 422,
        data: { code: "shareable_state_realm_invalid" }
      });
      expect((await responseData(await realmRequest(
        backend,
        group,
        "tiny",
        "increment",
        { key: "value", amount: 9 }
      ))).data).toEqual({ value: 9 });
      expect((await responseData(await realmRequest(
        backend,
        group,
        "tiny",
        "increment",
        { key: "value", amount: 1 }
      )))).toMatchObject({
        status: 422,
        data: { code: "shareable_state_realm_invalid" }
      });
      expect((await responseData(await realmRequest(
        backend,
        group,
        "tiny",
        "get",
        { key: "value" }
      ))).data).toEqual({ value: 9 });
      expect((await responseData(await realmRequest(
        backend,
        otherGroup,
        "counter",
        "get",
        { key: "value" }
      )))).toMatchObject({
        status: 409,
        data: { code: "shareable_state_realm_identity_mismatch" }
      });
    });
  });

  it("provides bounded counters and canonicalizes reset to an empty entry", async () => {
    const group = twitchGroup();
    const stub = standaloneRealmStub(env, createStandaloneRealmIdentity(group));
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const operation = (name, values = {}) => realmRequest(
        backend,
        group,
        "counter",
        "bounded-counter",
        {
          name: "deaths",
          subject: "Castlevania",
          min: 0,
          max: 10,
          initial: 0,
          operation: name,
          ...values
        }
      );

      expect((await responseData(await operation("get"))).data).toEqual({ value: 0 });
      expect((await responseData(await operation("increment", { amount: 3 }))).data)
        .toEqual({ value: 3 });
      expect((await responseData(await operation("decrement", { amount: 5 }))).data)
        .toEqual({ value: 0 });
      expect((await responseData(await operation("set", { value: 7 }))).data)
        .toEqual({ value: 7 });
      expect((await responseData(await operation("reset"))).data).toEqual({ value: 0 });
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS total FROM shareable_state_realm_values
         WHERE feature_id = 'test.score' AND namespace_id = 'counter'`
      ).one().total).toBe(0);
      expect((await responseData(await operation("get"))).data).toEqual({ value: 0 });
    });
  });

  it("identity-upgrades compatible schemas and rejects incompatible ones", async () => {
    const group = discordGroup();
    const stub = standaloneRealmStub(env, createStandaloneRealmIdentity(group));
    await runInDurableObject(stub, async (_instance, state) => {
      const versionOne = new ShareableStateRealmBackend(
        state,
        env,
        featureRegistry()
      );
      expect((await realmRequest(versionOne, group, "score", "set", {
        key: "value",
        value: 4
      })).status).toBe(200);

      const versionTwo = new ShareableStateRealmBackend(
        state,
        env,
        featureRegistry({ schemaVersion: 2, compatibleVersions: [1, 2] })
      );
      expect((await responseData(await realmRequest(
        versionTwo,
        group,
        "score",
        "get",
        { key: "value" }
      ))).data).toEqual({ value: 4 });
      expect(state.storage.sql.exec(
        `SELECT schema_version FROM shareable_state_realm_namespaces
         WHERE feature_id = 'test.score' AND namespace_id = 'score'`
      ).one().schema_version).toBe(2);

      const incompatible = new ShareableStateRealmBackend(
        state,
        env,
        featureRegistry({ schemaVersion: 3, compatibleVersions: [3] })
      );
      expect((await responseData(await realmRequest(
        incompatible,
        group,
        "score",
        "get",
        { key: "value" }
      )))).toMatchObject({
        status: 409,
        data: { code: "shareable_state_schema_unsupported" }
      });
    });
  });

  it("keeps the production client declaration-gated", async () => {
    await expect(requestStandaloneRealmState(env, {
      group: discordGroup(),
      featureId: "test.not-installed",
      namespaceId: "score",
      operation: "get",
      storage: { key: "value" }
    })).rejects.toMatchObject({
      status: 404,
      code: "shareable_state_namespace_not_declared"
    });
  });
});
