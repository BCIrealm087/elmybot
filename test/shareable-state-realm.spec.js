import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { defineFeature, frameworkApiVersion } from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/internal.js";
import {
  cloneShareableStateSnapshot,
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  freezeShareableStateNamespace,
  initializeEmptyShareableStateNamespace,
  inventoryShareableStateNamespaces,
  releaseShareableStateNamespaceSeal,
  requestStandaloneRealmState,
  shareableStateSnapshotHasMeaningfulState,
  shareableStateSnapshotsEqual,
  ShareableStateRealmBackend,
  shareableStateRealmObjectName,
  shareableStateRealmStub,
  sealShareableStateNamespace,
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

  it("inventories every declared namespace without exposing stored entries", async () => {
    const identity = createStandaloneRealmIdentity(discordGroup());
    const stub = shareableStateRealmStub(env, identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const clientEnv = clientEnvironment(backend);
      await requestStandaloneRealmState(clientEnv, {
        group: identity.ownerGroup,
        featureId: "test.score",
        namespaceId: "score",
        operation: "set",
        storage: { key: "private_key", value: "private value" }
      });

      const inventory = await inventoryShareableStateNamespaces(clientEnv, {
        realm: identity
      });
      expect(Object.isFrozen(inventory)).toBe(true);
      expect(Object.isFrozen(inventory.namespaces)).toBe(true);
      expect(inventory.namespaces.map((namespace) => namespace.namespaceId))
        .toEqual(["counter", "score", "tiny"]);
      expect(inventory.namespaces.find((namespace) => namespace.namespaceId === "score"))
        .toMatchObject({
          featureId: "test.score",
          featureLabel: "Exercises standalone shareable-state realms.",
          namespaceLabel: "Shared score",
          schemaVersion: 1,
          mutationVersion: 1,
          meaningful: true,
          summary: { kind: "presence", used: true }
        });
      expect(JSON.stringify(inventory)).not.toContain("private_key");
      expect(JSON.stringify(inventory)).not.toContain("private value");
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
        "query-read",
        { key: "value" }
      ))).data).toEqual({ found: false });
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
        "score",
        "query-read",
        { key: "value" }
      ))).data).toEqual({ found: true, value: { a: 2, z: 1 } });
      expect((await responseData(await realmRequest(
        backend,
        group,
        "score",
        "revision"
      ))).data).toEqual({ mutationVersion: 1 });

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
      await identityRealmRequest(backend, sourceIdentity, "score", "bounded-counter", {
        name: "deaths",
        subject: "dark souls",
        subjectLabel: "Dark Souls",
        min: 0,
        max: 10,
        initial: 0,
        operation: "set",
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
        snapshot: sourceSnapshot,
        idempotencyKey: "materialize:test:score"
      })).toEqual({
        cloned: true,
        replayed: false,
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
      expect(cloned.counterSubjects).toEqual(sourceSnapshot.counterSubjects);
      expect(shareableStateSnapshotsEqual(sourceSnapshot, cloned)).toBe(true);

      expect(await cloneShareableStateSnapshot(clientEnv, {
        realm: targetIdentity,
        snapshot: sourceSnapshot,
        idempotencyKey: "materialize:test:score"
      })).toEqual({
        cloned: false,
        replayed: true,
        mutationVersion: 1,
        fingerprint: sourceSnapshot.fingerprint
      });
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

  it("seals candidate mutations while allowing reads and idempotent release", async () => {
    const identity = createStandaloneRealmIdentity(discordGroup());
    const stub = shareableStateRealmStub(env, identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const clientEnv = clientEnvironment(backend);
      await identityRealmRequest(backend, identity, "score", "set", {
        key: "value",
        value: 1
      });
      const sealId = "integration-finalize:test:score";
      const expiresAtMs = Date.now() + 60_000;
      const sealed = await sealShareableStateNamespace(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        sealId,
        expiresAtMs
      });
      expect(sealed).toMatchObject({
        sealId,
        expiresAtMs,
        snapshot: {
          mutationVersion: 1,
          entries: [{ key: "value", value: 1 }]
        }
      });
      await expect(sealShareableStateNamespace(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        sealId: "integration-finalize:other:score",
        expiresAtMs
      })).rejects.toMatchObject({
        status: 409,
        code: "shareable_state_transition_sealed"
      });
      expect((await responseData(await identityRealmRequest(
        backend,
        identity,
        "score",
        "get",
        { key: "value" }
      ))).data).toEqual({ value: 1 });
      expect(await responseData(await identityRealmRequest(
        backend,
        identity,
        "score",
        "set",
        { key: "value", value: 2 }
      ))).toMatchObject({
        status: 409,
        data: { code: "shareable_state_transition_sealed" }
      });
      await expect(releaseShareableStateNamespaceSeal(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        sealId: "integration-finalize:other:score"
      })).rejects.toMatchObject({
        status: 409,
        code: "shareable_state_transition_seal_mismatch"
      });
      await expect(releaseShareableStateNamespaceSeal(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        sealId
      })).resolves.toEqual({ released: true });
      await expect(releaseShareableStateNamespaceSeal(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        sealId
      })).resolves.toEqual({ released: false });
      expect((await responseData(await identityRealmRequest(
        backend,
        identity,
        "score",
        "set",
        { key: "value", value: 2 }
      ))).status).toBe(200);
    });
  });

  it("permanently freezes revoked integration namespaces with replay-safe snapshots", async () => {
    const identity = createIntegrationRealmIdentity({ id: uniqueId("revoked") });
    const stub = shareableStateRealmStub(env, identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const clientEnv = clientEnvironment(backend);
      await identityRealmRequest(backend, identity, "score", "set", {
        key: "value",
        value: 7
      });
      const freezeId = "revoke:test-integration:test.score:score";
      const frozen = await freezeShareableStateNamespace(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        freezeId
      });
      expect(frozen).toMatchObject({
        freezeId,
        snapshot: {
          mutationVersion: 1,
          entries: [{ key: "value", value: 7 }]
        }
      });
      await expect(freezeShareableStateNamespace(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        freezeId
      })).resolves.toEqual(frozen);
      await expect(freezeShareableStateNamespace(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        freezeId: "revoke:other:test.score:score"
      })).rejects.toMatchObject({
        status: 409,
        code: "shareable_state_realm_frozen"
      });
      expect((await responseData(await identityRealmRequest(
        backend,
        identity,
        "score",
        "get",
        { key: "value" }
      ))).data).toEqual({ value: 7 });
      expect(await responseData(await identityRealmRequest(
        backend,
        identity,
        "score",
        "set",
        { key: "value", value: 8 }
      ))).toMatchObject({
        status: 409,
        data: { code: "shareable_state_realm_frozen" }
      });
      expect(await responseData(await identityRealmRequest(
        backend,
        identity,
        "score",
        "bounded-counter",
        {
          name: "deaths",
          subject: "game",
          min: 0,
          operation: "increment",
          amount: 1
        }
      ))).toMatchObject({
        status: 409,
        data: { code: "shareable_state_realm_frozen" }
      });
    });
  });

  it("initializes reset selections once in a fresh integration realm", async () => {
    const identity = createIntegrationRealmIdentity({ id: uniqueId("reset") });
    const stub = shareableStateRealmStub(env, identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const clientEnv = clientEnvironment(backend);
      const input = {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score",
        idempotencyKey: "materialize:reset:score"
      };
      await expect(initializeEmptyShareableStateNamespace(clientEnv, input))
        .resolves.toMatchObject({ cloned: true, replayed: false });
      await expect(initializeEmptyShareableStateNamespace(clientEnv, input))
        .resolves.toMatchObject({ cloned: false, replayed: true });
      await expect(snapshotShareableStateNamespace(clientEnv, {
        realm: identity,
        featureId: "test.score",
        namespaceId: "score"
      })).resolves.toMatchObject({ mutationVersion: 1, meaningful: false });
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

  it("enumerates known counter subjects and explicitly reports legacy gaps", async () => {
    const group = twitchGroup();
    const stub = standaloneRealmStub(env, createStandaloneRealmIdentity(group));
    await runInDurableObject(stub, async (_instance, state) => {
      const backend = new ShareableStateRealmBackend(state, env, featureRegistry());
      const counter = (subject, operation, values = {}) => realmRequest(
        backend,
        group,
        "counter",
        "bounded-counter",
        {
          name: "deaths",
          subject,
          min: 0,
          max: 10,
          initial: 0,
          operation,
          ...values
        }
      );
      const subjects = () => realmRequest(
        backend,
        group,
        "counter",
        "bounded-counter-subjects",
        { name: "deaths" }
      );

      await counter("legacy game", "set", { value: 4 });
      expect((await responseData(await counter("legacy game", "get"))).data)
        .toEqual({ value: 4 });
      expect((await responseData(await subjects())).data).toEqual({
        subjects: [],
        coverage: {
          complete: false,
          identifiedCount: 0,
          unidentifiedCount: 1
        }
      });

      await counter("legacy game", "set", {
        value: 4,
        subjectLabel: "Legacy Game"
      });
      expect((await responseData(await subjects())).data).toEqual({
        subjects: [{ identity: "legacy game", label: "Legacy Game", value: 4 }],
        coverage: {
          complete: true,
          identifiedCount: 1,
          unidentifiedCount: 0
        }
      });

      await counter("legacy game", "reset", { subjectLabel: "Legacy Game" });
      expect((await responseData(await subjects())).data).toEqual({
        subjects: [],
        coverage: {
          complete: true,
          identifiedCount: 0,
          unidentifiedCount: 0
        }
      });
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
