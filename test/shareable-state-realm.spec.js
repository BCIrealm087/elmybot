import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { defineFeature, frameworkApiVersion } from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/internal.js";
import {
  cloneShareableStateSnapshot,
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  requestStandaloneRealmState,
  shareableStateSnapshotHasMeaningfulState,
  shareableStateSnapshotsEqual,
  ShareableStateRealmBackend,
  shareableStateRealmObjectName,
  shareableStateRealmStub,
  snapshotShareableStateNamespace,
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
          collisionSummary: { kind: "entry_count" },
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
  return identityRealmRequest(
    backend,
    createStandaloneRealmIdentity(group),
    namespaceId,
    operation,
    storage
  );
}

function identityRealmRequest(
  backend,
  realm,
  namespaceId,
  operation,
  storage = {}
) {
  return backend.fetch(new Request(
    `https://shareable-state/internal/shareable-state/realm/${operation}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        realm,
        namespace: { featureId: "test.score", namespaceId },
        storage
      })
    }
  ));
}

function clientEnvironment(backend) {
  return {
    SHAREABLE_STATE_REALM: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (url, init) => backend.fetch(new Request(url, init))
      })
    }
  };
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

  it("captures immutable, deterministic, safely summarized snapshots", async () => {
    const group = discordGroup();
    const identity = createStandaloneRealmIdentity(group);
    const stub = standaloneRealmStub(env, identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const clientEnv = clientEnvironment(backend);
      const capture = (namespaceId = "score") =>
        snapshotShareableStateNamespace(clientEnv, {
          realm: identity,
          featureId: "test.score",
          namespaceId
        });

      const empty = await capture();
      expect(empty).toMatchObject({
        formatVersion: 1,
        namespace: {
          featureId: "test.score",
          namespaceId: "score",
          schemaVersion: 1
        },
        mutationVersion: 0,
        meaningful: false,
        summary: { kind: "presence", used: false },
        entries: []
      });
      expect(empty.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.isFrozen(empty)).toBe(true);
      expect(Object.isFrozen(empty.namespace)).toBe(true);
      expect(Object.isFrozen(empty.summary)).toBe(true);
      expect(Object.isFrozen(empty.entries)).toBe(true);
      expect(shareableStateSnapshotHasMeaningfulState(empty)).toBe(false);

      await realmRequest(backend, group, "score", "set", {
        key: "value",
        value: { z: 1, a: [2, { y: true, x: false }] }
      });
      const first = await capture();
      expect(first.mutationVersion).toBe(1);
      expect(first.meaningful).toBe(true);
      expect(first.summary).toEqual({ kind: "presence", used: true });
      expect(Object.isFrozen(first.entries[0])).toBe(true);
      expect(Object.isFrozen(first.entries[0].value)).toBe(true);
      expect(Object.isFrozen(first.entries[0].value.a)).toBe(true);

      await realmRequest(backend, group, "score", "set", {
        key: "value",
        value: { a: [2, { x: false, y: true }], z: 1 }
      });
      const canonicalNoOp = await capture();
      expect(canonicalNoOp.mutationVersion).toBe(1);
      expect(canonicalNoOp.fingerprint).toBe(first.fingerprint);
      expect(shareableStateSnapshotsEqual(first, canonicalNoOp)).toBe(true);

      await realmRequest(backend, group, "counter", "set", {
        key: "one",
        value: 1
      });
      await realmRequest(backend, group, "counter", "set", {
        key: "two",
        value: 2
      });
      const counted = await capture("counter");
      expect(counted.summary).toEqual({
        kind: "entry_count",
        used: true,
        entryCount: 2
      });
    });
  });

  it("clones a verified snapshot into a fresh realm and preserves its source", async () => {
    const sourceIdentity = createStandaloneRealmIdentity(discordGroup());
    const sourceStub = shareableStateRealmStub(env, sourceIdentity);
    let sourceSnapshot;
    await runInDurableObject(sourceStub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      await identityRealmRequest(backend, sourceIdentity, "score", "set", {
        key: "alpha",
        value: { z: 3, a: 1 }
      });
      await identityRealmRequest(backend, sourceIdentity, "score", "set", {
        key: "beta",
        value: 2
      });
      sourceSnapshot = await snapshotShareableStateNamespace(
        clientEnvironment(backend),
        {
          realm: sourceIdentity,
          featureId: "test.score",
          namespaceId: "score"
        }
      );
      expect(sourceSnapshot.mutationVersion).toBe(2);
    });

    const targetIdentity = createIntegrationRealmIdentity({
      id: uniqueId("integration")
    });
    const targetStub = shareableStateRealmStub(env, targetIdentity);
    await runInDurableObject(targetStub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const clientEnv = clientEnvironment(backend);
      const tampered = JSON.parse(JSON.stringify(sourceSnapshot));
      tampered.entries[0].value = 99;
      await expect(cloneShareableStateSnapshot(clientEnv, {
        realm: targetIdentity,
        snapshot: tampered
      })).rejects.toMatchObject({
        status: 409,
        code: "shareable_state_snapshot_fingerprint_mismatch"
      });
      expect((await snapshotShareableStateNamespace(clientEnv, {
        realm: targetIdentity,
        featureId: "test.score",
        namespaceId: "score"
      })).mutationVersion).toBe(0);

      await expect(cloneShareableStateSnapshot(clientEnv, {
        realm: targetIdentity,
        snapshot: sourceSnapshot,
        expectedTargetMutationVersion: 1
      })).rejects.toMatchObject({
        status: 409,
        code: "shareable_state_clone_target_stale"
      });

      expect(await cloneShareableStateSnapshot(clientEnv, {
        realm: targetIdentity,
        snapshot: sourceSnapshot
      })).toEqual({
        cloned: true,
        mutationVersion: 1,
        fingerprint: sourceSnapshot.fingerprint
      });
      const cloned = await snapshotShareableStateNamespace(clientEnv, {
        realm: targetIdentity,
        featureId: "test.score",
        namespaceId: "score"
      });
      expect(cloned.mutationVersion).toBe(1);
      expect(cloned.entries).toEqual(sourceSnapshot.entries);
      expect(shareableStateSnapshotsEqual(sourceSnapshot, cloned)).toBe(true);

      await expect(cloneShareableStateSnapshot(clientEnv, {
        realm: targetIdentity,
        snapshot: sourceSnapshot
      })).rejects.toMatchObject({
        status: 409,
        code: "shareable_state_clone_target_stale"
      });
      await identityRealmRequest(backend, targetIdentity, "score", "set", {
        key: "alpha",
        value: 7
      });
      const diverged = await snapshotShareableStateNamespace(clientEnv, {
        realm: targetIdentity,
        featureId: "test.score",
        namespaceId: "score"
      });
      expect(diverged.mutationVersion).toBe(2);
      expect(shareableStateSnapshotsEqual(sourceSnapshot, diverged)).toBe(false);
    });

    await runInDurableObject(sourceStub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const unchanged = await snapshotShareableStateNamespace(
        clientEnvironment(backend),
        {
          realm: sourceIdentity,
          featureId: "test.score",
          namespaceId: "score"
        }
      );
      expect(unchanged.mutationVersion).toBe(2);
      expect(shareableStateSnapshotsEqual(sourceSnapshot, unchanged)).toBe(true);
    });
  });

  it("records empty clone initialization as a monotonic target version", async () => {
    const sourceIdentity = createStandaloneRealmIdentity(twitchGroup());
    const sourceStub = shareableStateRealmStub(env, sourceIdentity);
    let empty;
    await runInDurableObject(sourceStub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      empty = await snapshotShareableStateNamespace(clientEnvironment(backend), {
        realm: sourceIdentity,
        featureId: "test.score",
        namespaceId: "score"
      });
    });

    const targetIdentity = createIntegrationRealmIdentity({ id: uniqueId("empty") });
    const targetStub = shareableStateRealmStub(env, targetIdentity);
    await runInDurableObject(targetStub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const clientEnv = clientEnvironment(backend);
      expect((await cloneShareableStateSnapshot(clientEnv, {
        realm: targetIdentity,
        snapshot: empty
      })).mutationVersion).toBe(1);
      const cloned = await snapshotShareableStateNamespace(clientEnv, {
        realm: targetIdentity,
        featureId: "test.score",
        namespaceId: "score"
      });
      expect(cloned).toMatchObject({ mutationVersion: 1, meaningful: false });
      expect(shareableStateSnapshotsEqual(empty, cloned)).toBe(true);
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
      expect(state.storage.sql.exec(
        `SELECT mutation_version FROM shareable_state_realm_namespaces
         WHERE feature_id = 'test.score' AND namespace_id = 'score'`
      ).one().mutation_version).toBe(2);

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
