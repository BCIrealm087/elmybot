import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineAction, defineDurableEventStream, defineFeature, defineStateEventOperation, discordActionCommand,
  frameworkApiVersion, schema
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import { prepareStateEventOperation } from "../src/framework/state-event-operation.js";
import { createStateEventIdentity, newAttempt, fingerprint } from "../src/state-events/identity.js";
import { prepareStateEventOrigin, lookupStateEventOwner } from "../src/state-events/storage.js";
import { commitLocalStateEvent } from "../src/state-events/local-commit.js";
import { maintainStateEventOutbox, STATE_EVENT_OUTBOX_LIMITS as LIMITS } from "../src/state-events/outbox.js";
import { durableEventRouteId } from "../src/durable-events/contract.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { recoverStateQueryGrantInvalidations } from "../src/state-querying/grant-storage.js";
import { recoverStateQueryNotificationDelivery, initializeLocalStateNotificationTables } from "../src/state-querying/source-notifications.js";
import { listStateQueryNotifications, registerLocalStateQueryWatcher } from "../src/state-querying/watcher-client.js";
import { GroupConfig } from "../src/group-configuration.js";

let sequence = 0;
const fixtureStubs = new Set();
afterEach(async () => {
  for (const stub of fixtureStubs) await runInDurableObject(stub, (_i, state) => state.storage.deleteAlarm());
  fixtureStubs.clear();
});
const unique = (name) => `${name}-${Date.now()}-${++sequence}`;
const environment = { ...env, DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT: "test" };
function registryFixture({ mutation, event, payload, config = false, featureId = "test.atomic" } = {}) {
  const operation = defineStateEventOperation({ id: "change", scope: { kind: "group_local" },
    input: schema.object({ amount: schema.integer({ min: -1000, max: 1000, optional: true, default: 10 }) }),
    stream: { id: "impacts", version: 2 }, mutation: mutation ?? { kind: "bounded_counter", name: "health",
      subject: { literal: "current" }, min: 0, max: 100, initial: 100,
      operation: "decrement", amount: { input: "amount" } },
    event: event ?? { health: { result: "after" }, applied: { result: "appliedAmount" }, changed: { result: "changed" } } });
  const stream = defineDurableEventStream({ id: "impacts", version: 2, label: "Impacts", description: "Atomic test impacts",
    platforms: ["discord", "twitch"], scope: { kind: "group_local" },
    publication: { kind: "state_event", source: { kind: "group_local" } }, access: { kind: "operator_grant" },
    payload: { schema: payload ?? { type: "object", properties: {
      health: { type: "integer", minimum: 0, maximum: 100 }, applied: { type: "integer", minimum: 0, maximum: 100 },
      changed: { type: "boolean" } }, required: ["health", "applied", "changed"] } } });
  const action = defineAction({ kind: `${featureId}.change.v1`, supportedOrigins: ["discord"], input: operation.input,
    uses: { services: ["stateEvents", ...(config ? ["config"] : [])], stateEvents: ["change"] },
    cooldown: { scope: "group", seconds: 1 }, async execute() { throw new Error("feature execution remains blocked"); } });
  const registry = createFeatureRegistry([defineFeature({ id: featureId, apiVersion: frameworkApiVersion,
    description: "Atomic local test", stateEvents: [operation], eventStreams: [stream], actions: [action],
    commands: { discord: [discordActionCommand({ name: "change", description: "Change atomic state", availability: "guild", actionKind: action.kind })] } })],
  { availableServices: ["stateEvents", "config"] });
  return { registry, operation, action, featureId };
}
async function fixture(options = {}) {
  const declarations = registryFixture(options);
  const group = { platform: "discord", kind: "guild", id: unique("atomic") };
  const key = `discord:guild:${group.id}`;
  const stub = env.CONFIG.get(env.CONFIG.idFromName(key));
  fixtureStubs.add(stub);
  const prepare = async ({ args = { amount: 10 }, config = {}, sourceId = unique("source"), route = {} } = {}) => {
    const invocation = createCommandInvocation({ kind: declarations.action.kind, args, sourceCreatedAtMs: Date.now(),
      sourceEventId: `discord:interaction:${sourceId}`, origin: { group, actor: { platform: "discord", id: "actor", claims: [] } } });
    const identity = await createStateEventIdentity({ environment: "test", featureId: declarations.featureId, invocation,
      declaration: { mutation: declarations.operation.mutation, event: declarations.operation.event, stream: declarations.operation.stream } });
    const request = prepareStateEventOperation(declarations.operation, args, config);
    const pinned = { kind: "group_local", key, bindingRevision: 0, streamRouteId: await durableEventRouteId({
      deploymentEnvironment: "test", scopeKind: "group_local", realmIdentity: key, featureId: declarations.featureId,
      streamId: "impacts", version: 2 }), ...route };
    // Tests can admit multiple distinct invocations without waiting on wall time.
    await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("DELETE FROM framework_feature_cooldowns"));
    return runInDurableObject(stub, (_i, state) => prepareStateEventOrigin(state,
      { identity, request, route: pinned, cooldownSeconds: 1 }));
  };
  const commit = (record, registry = declarations.registry) => runInDurableObject(stub, (_i, state) =>
    commitLocalStateEvent(state, environment, registry, { attempt: record.attempt, request: record.request }));
  const snapshot = () => runInDurableObject(stub, async (_i, state) => {
    const table = (name) => state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = ?", name).toArray().length;
    return { values: state.storage.sql.exec("SELECT * FROM framework_feature_values WHERE value_kind = 'state'").toArray(),
      versions: state.storage.sql.exec("SELECT * FROM framework_feature_state_versions").toArray(),
      records: table("state_event_records") ? state.storage.sql.exec("SELECT * FROM state_event_records ORDER BY record_key").toArray() : [],
      outbox: table("state_event_outbox") ? state.storage.sql.exec("SELECT * FROM state_event_outbox ORDER BY operation_sequence").toArray() : [],
      budget: table("state_event_outbox_budget") ? state.storage.sql.exec("SELECT * FROM state_event_outbox_budget").toArray() : [],
      alarm: await state.storage.getAlarm() };
  });
  return { ...declarations, group, key, stub, prepare, commit, snapshot };
}

describe("group-local atomic state/event commit", () => {
  it("atomically saves a clamped mutation, original receipt, watermark, event and durable wakeup", async () => {
    const f = await fixture(); const first = await f.prepare({ args: { amount: 80 } });
    const accepted = await f.commit(first);
    expect(accepted.receipt.result).toEqual({ before: 100, after: 20, changed: true, appliedAmount: 80 });
    const second = await f.commit(await f.prepare({ args: { amount: 80 } }));
    expect(second.receipt.result).toEqual({ before: 20, after: 0, changed: true, appliedAmount: 20 });
    const snapshot = await f.snapshot();
    expect(snapshot.values).toHaveLength(1); expect(JSON.parse(snapshot.values[0].value_json)).toBe(0);
    expect(snapshot.versions[0].mutation_version).toBe(2); expect(snapshot.outbox).toHaveLength(2);
    expect(snapshot.records.filter((row) => row.record_key.startsWith("owner:"))).toHaveLength(2);
    const origins = snapshot.records.filter((row) => row.record_key.startsWith("origin:"));
    expect(origins.every((row) => row.request_json === null && JSON.parse(row.metadata_json).ownerConfirmed === true)).toBe(true);
    const intent = JSON.parse(snapshot.outbox[1].intent_json);
    expect(intent.stateEvent).toEqual(second.receipt.stateEvent);
    expect(intent.payload).toEqual({ health: 0, applied: 20, changed: true });
    expect(intent.expiresAtMs - intent.committedAtMs).toBe(LIMITS.retentionMs);
    expect(second.receipt.expiresAtMs).toBe(intent.expiresAtMs);
    expect(second.receipt.committedAtMs).toBe(intent.committedAtMs);
    expect(intent.stateEvent).toMatchObject({ version: 1, operationSequence: 2, stateRevision: 2 });
    expect(intent.stateEvent.scopeToken).toMatch(/^ses1\.[\w-]{22}$/);
    expect(snapshot.alarm).not.toBeNull(); expect(snapshot.alarm).toBeLessThanOrEqual(intent.committedAtMs + 1000);
  });

  it("accepts a no-op once, advances the readable revision, and preserves an existing watcher notification", async () => {
    const f = await fixture(); await f.commit(await f.prepare({ args: { amount: 100 } }));
    await registerLocalStateQueryWatcher(env, { sourceGroup: f.group, target: f.group, featureId: f.featureId,
      watcherId: "atomic-watcher", expectedRevision: 1, leaseSeconds: 120 });
    const pending = await f.prepare();
    const accepted = await f.commit(pending);
    expect(accepted.receipt.result).toEqual({ before: 0, after: 0, changed: false, appliedAmount: 0 });
    expect(await f.commit(pending)).toEqual(accepted);
    const snapshot = await f.snapshot(); expect(snapshot.versions[0].mutation_version).toBe(2);
    expect(snapshot.outbox).toHaveLength(2);
    await runInDurableObject(f.stub, (instance) => instance.alarm());
    const delivered = await listStateQueryNotifications(env, f.group);
    expect(delivered.notifications).toHaveLength(1);
    expect(delivered.notifications[0]).toMatchObject({ watcherId: "atomic-watcher", revision: 2,
      source: { kind: "group_local", key: f.key, featureId: f.featureId } });
  });

  it("serializes distinct concurrent commits and returns one result for duplicate invocations", async () => {
    const f = await fixture(); const a = await f.prepare(); const b = await f.prepare();
    const results = await Promise.all([f.commit(a), f.commit(a), f.commit(b), f.commit(a)]);
    expect(results[0]).toEqual(results[1]); expect(results[0]).toEqual(results[3]);
    const snapshot = await f.snapshot(); expect(JSON.parse(snapshot.values[0].value_json)).toBe(80);
    expect(snapshot.versions[0].mutation_version).toBe(2); expect(snapshot.outbox).toHaveLength(2);
  });

  it("rolls back value, notification, sequence, outbox, receipt and alarm when the resulting payload is invalid", async () => {
    const f = await fixture({ payload: { type: "object", properties: {
      health: { type: "integer", minimum: 95, maximum: 100 }, applied: { type: "integer", minimum: 0, maximum: 100 },
      changed: { type: "boolean" } }, required: ["health", "applied", "changed"] } });
    const pending = await f.prepare();
    await runInDurableObject(f.stub, (_i, state) => initializeLocalStateNotificationTables(state));
    const before = await f.snapshot();
    await expect(f.commit(pending)).rejects.toMatchObject({ code: "durable_event_payload_invalid" });
    expect(await f.snapshot()).toEqual(before);
    await runInDurableObject(f.stub, (_i, state) => expect(state.storage.sql.exec("SELECT * FROM state_query_notification_outbox").toArray()).toEqual([]));
  });

  it("rolls back the real state mutation and notification when receipt capacity fails after those writes", async () => {
    const f = await fixture(); const pending = await f.prepare();
    await registerLocalStateQueryWatcher(env, { sourceGroup: f.group, target: f.group, featureId: f.featureId,
      watcherId: "rollback-watcher", expectedRevision: 0, leaseSeconds: 120 });
    await runInDurableObject(f.stub, (_i, state) => state.storage.sql.exec("UPDATE state_event_budget SET metadata_bytes = ?", 16 * 1024 * 1024));
    const before = await f.snapshot(); await expect(f.commit(pending)).rejects.toMatchObject({ code: "state_event_capacity" });
    expect(await f.snapshot()).toEqual(before);
    await runInDurableObject(f.stub, (_i, state) => {
      expect(state.storage.sql.exec("SELECT * FROM state_query_notification_outbox").toArray()).toEqual([]);
      expect(lookupStateEventOwner(state, pending.attempt, f.key)).toEqual({ state: "absent" });
    });
  });

  it.each(["before", "after"])("rolls back an otherwise valid commit when failure occurs %s the alarm write", async (when) => {
    const f = await fixture(); const pending = await f.prepare(); const before = await f.snapshot();
    await runInDurableObject(f.stub, async (_i, state) => {
      const failing = { ...state, id: state.id, storage: new Proxy(state.storage, { get(target, key) {
        if (key === "setAlarm") return async (...args) => {
          if (when === "after") await target.setAlarm(...args);
          throw new Error("alarm storage failed");
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } }) };
      await expect(commitLocalStateEvent(failing, environment, f.registry, { attempt: pending.attempt, request: pending.request })).rejects.toThrow("alarm storage failed");
    });
    expect(await f.snapshot()).toEqual(before);
  });

  it("recovers the original queued operation and wakeup after eviction immediately following commit", async () => {
    const f = await fixture(); const pending = await f.prepare(); const accepted = await f.commit(pending);
    await evictDurableObject(f.stub);
    expect(await f.commit(pending)).toEqual(accepted);
    await runInDurableObject(f.stub, (_i, state) => state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0"));
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    const parked = await f.snapshot(); expect(parked.outbox).toHaveLength(1); expect(parked.outbox[0].attempts).toBe(1);
    expect(parked.alarm).not.toBeNull(); expect(parked.alarm).toBeLessThan(accepted.receipt.expiresAtMs);
    expect(JSON.parse(parked.values[0].value_json)).toBe(90);
  });

  it("cannot lose the outbox wakeup when either legacy notification scheduler runs", async () => {
    const f = await fixture(); await f.commit(await f.prepare());
    const before = await f.snapshot();
    await runInDurableObject(f.stub, async (_i, state) => {
      initializeLocalStateNotificationTables(state);
      await recoverStateQueryGrantInvalidations(state); await recoverStateQueryNotificationDelivery(state);
    });
    expect((await f.snapshot()).alarm).toBe(before.alarm);
    await runInDurableObject(f.stub, (_i, state) => state.storage.deleteAlarm());
    await evictDurableObject(f.stub);
    const response = await f.stub.fetch("https://config/internal/framework/state/revision", {
      method: "POST", body: JSON.stringify({ featureId: f.featureId }) });
    expect(response.status).toBe(200);
    expect((await f.snapshot()).alarm).not.toBeNull();
  });

  it("expires payloads at the original deadline and retains bounded gap-pending metadata without polling", async () => {
    const f = await fixture(); const pending = await f.prepare(); const accepted = await f.commit(pending);
    await runInDurableObject(f.stub, (_i, state) => maintainStateEventOutbox(state, accepted.receipt.expiresAtMs));
    const expired = await f.snapshot(); expect(expired.outbox[0].state).toBe("gap_pending");
    expect(JSON.parse(expired.outbox[0].intent_json)).not.toHaveProperty("payload");
    expect(JSON.parse(expired.outbox[0].intent_json).gapPending).toBe(true); expect(expired.alarm).not.toBeNull();
    expect(await f.commit(pending)).toEqual(accepted); expect((await f.snapshot()).outbox).toHaveLength(1);
  });
  it("checks a committed receipt before changed declarations, configuration or state can recompute a result", async () => {
    const f = await fixture(); const pending = await f.prepare(); const accepted = await f.commit(pending);
    expect(await f.commit(pending, null)).toEqual(accepted);
    const forged = { ...pending, request: { ...pending.request, input: { amount: 20 } } };
    await expect(f.commit(forged)).rejects.toMatchObject({ code: "state_event_source_conflict" });
    expect((await f.snapshot()).outbox).toHaveLength(1);
  });

  it("requires durable origin preparation and validates the pinned stream, declarations and request", async () => {
    const f = await fixture(); const pending = await f.prepare();
    const route = { ...pending.attempt.route, streamRouteId: `des1.${"a".repeat(43)}` };
    await expect(f.commit({ ...pending, attempt: { ...pending.attempt, route } }))
      .rejects.toMatchObject({ code: "state_event_invalid_route" });
    const request = { ...pending.request, mutation: { ...pending.request.mutation, max: 200 } };
    await expect(f.commit({ attempt: { ...pending.attempt, preparedFingerprint: await fingerprint(request) }, request }))
      .rejects.toMatchObject({ code: "state_event_invalid_request" });
    const attempt = newAttempt(pending.attempt.identity, pending.attempt.preparedFingerprint, pending.attempt.route);
    await runInDurableObject(f.stub, (_i, state) => state.storage.sql.exec("DELETE FROM state_event_records"));
    await expect(f.commit({ attempt, request: pending.request })).rejects.toMatchObject({ code: "state_event_missing_origin" });
    expect((await f.snapshot()).values).toEqual([]);
  });

  it.each([
    ["set", { kind: "set", key: { literal: "score" }, value: { literal: 7 } }, 7, true],
    ["increment", { kind: "increment", key: { literal: "score" }, amount: { literal: -3 } }, -3, true],
    ["zero increment", { kind: "increment", key: { literal: "score" }, amount: { literal: 0 } }, 0, false],
    ["missing delete", { kind: "delete", key: { literal: "score" } }, null, false],
    ["counter set", { kind: "bounded_counter", name: "health", subject: { literal: "current" }, min: 0, max: 100,
      initial: 100, operation: "set", value: { literal: 33 }, subjectLabel: "Current health" }, 33, true],
    ["counter reset", { kind: "bounded_counter", name: "health", subject: { literal: "current" }, min: 0, max: 100,
      initial: 100, operation: "reset" }, 100, false],
    ["counter ceiling", { kind: "bounded_counter", name: "health", subject: { literal: "current" }, min: 0, max: 100,
      initial: 100, operation: "increment", amount: { literal: 5 } }, 100, false]
  ])("persists %s with existing semantics and one combined revision", async (_label, mutation, after, changed) => {
    const f = await fixture({ mutation, event: { changed: { result: "changed" } },
      payload: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"] } });
    const accepted = await f.commit(await f.prepare());
    expect(accepted.receipt.result).toMatchObject({ after, changed });
    expect(accepted.receipt.stateEvent.stateRevision).toBe(1); expect((await f.snapshot()).outbox).toHaveLength(1);
    if (mutation.subjectLabel) await runInDurableObject(f.stub, (_i, state) => {
      expect(state.storage.sql.exec("SELECT subject_label FROM framework_feature_counter_subjects").one().subject_label).toBe(mutation.subjectLabel);
    });
  });

  it("supports replace/delete of an existing value and rejects unsafe legacy numeric state", async () => {
    const f = await fixture({ mutation: { kind: "delete", key: { literal: "score" } }, event: { changed: { result: "changed" } },
      payload: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"] } });
    const set = (value) => f.stub.fetch("https://config/internal/framework/state/set", { method: "POST",
      body: JSON.stringify({ featureId: f.featureId, key: "score", value }) });
    await set(5);
    const accepted = await f.commit(await f.prepare());
    expect(accepted.receipt.result).toMatchObject({ before: 5, after: null, changed: true });
    expect((await f.snapshot()).values).toEqual([]);
    const g = await fixture({ mutation: { kind: "increment", key: { literal: "score" }, amount: { literal: 1 } },
      event: { changed: { result: "changed" } }, payload: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"] } });
    await g.stub.fetch("https://config/internal/framework/state/set", { method: "POST",
      body: JSON.stringify({ featureId: g.featureId, key: "score", value: Number.MAX_SAFE_INTEGER }) });
    const pending = await g.prepare(); const before = await g.snapshot();
    await expect(g.commit(pending)).rejects.toBeDefined(); expect(await g.snapshot()).toEqual(before);
  });

  it("uses frozen configuration projections and rejects mismatched repeated configuration selectors", async () => {
    const f = await fixture({ config: true, mutation: { kind: "increment", key: { literal: "score" }, amount: { config: "step" } },
      event: { amount: { config: "step" } }, payload: { type: "object", properties: { amount: { type: "integer", minimum: 0, maximum: 100 } }, required: ["amount"] } });
    const pending = await f.prepare({ config: { step: 3 } });
    const accepted = await f.commit(pending); expect(accepted.receipt.result.after).toBe(3);
    expect(JSON.parse((await f.snapshot()).outbox[0].intent_json).payload).toEqual({ amount: 3 });
    const next = await f.prepare({ config: { step: 5 } });
    const request = { ...next.request, event: { amount: { literal: 9 } } };
    await expect(f.commit({ attempt: { ...next.attempt, preparedFingerprint: await fingerprint(request) }, request }))
      .rejects.toMatchObject({ code: "state_event_invalid_request" });
  });

  it.each(["rows", "bytes", "partitions"])("rejects exhausted %s capacity without changing any authoritative state", async (limit) => {
    const f = await fixture(); const seed = await f.prepare(); await f.commit(seed);
    await runInDurableObject(f.stub, (_i, state) => {
      state.storage.sql.exec("UPDATE state_event_outbox_budget SET rate_json = '[]'");
      if (limit === "rows") state.storage.sql.exec("UPDATE state_event_outbox_budget SET rows = ?", LIMITS.rows);
      if (limit === "bytes") state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = ?", LIMITS.bytes);
      if (limit === "partitions") {
        state.storage.sql.exec("UPDATE state_event_outbox_budget SET partitions = ?", LIMITS.partitions);
        state.storage.sql.exec("DELETE FROM state_event_partitions");
      }
    });
    const pending = await f.prepare(); const before = await f.snapshot();
    await expect(f.commit(pending)).rejects.toMatchObject({ code: limit === "partitions" ? "state_event_partition_capacity" : "state_event_outbox_capacity" });
    expect(await f.snapshot()).toEqual(before); expect(await f.commit(seed)).toMatchObject({ state: "committed" });
  });

  it("enforces the owner admission rate without charging duplicate recovery", async () => {
    const f = await fixture(); const pending = await f.prepare(); const accepted = await f.commit(pending);
    await runInDurableObject(f.stub, (_i, state) => state.storage.sql.exec("UPDATE state_event_outbox_budget SET rate_json = ?", JSON.stringify(new Array(10).fill(Date.now()))));
    expect(await f.commit(pending)).toEqual(accepted);
    const next = await f.prepare(); const before = await f.snapshot();
    await expect(f.commit(next)).rejects.toMatchObject({ code: "state_event_rate_limited" }); expect(await f.snapshot()).toEqual(before);
  });

  it.each(["operation sequence", "state revision"])("rejects exhausted %s instead of wrapping", async (kind) => {
    const f = await fixture(); await f.commit(await f.prepare());
    await runInDurableObject(f.stub, (_i, state) => {
      if (kind === "operation sequence") state.storage.sql.exec("UPDATE state_event_partitions SET operation_sequence = ?", Number.MAX_SAFE_INTEGER);
      else state.storage.sql.exec("UPDATE framework_feature_state_versions SET mutation_version = ?", Number.MAX_SAFE_INTEGER);
    });
    const next = await f.prepare(); const before = await f.snapshot();
    await expect(f.commit(next)).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before);
  });

  it("runs the actual GroupConfig internal commit handler with an installed registry", async () => {
    const f = await fixture(); const pending = await f.prepare();
    await runInDurableObject(f.stub, async (_i, state) => {
      const backend = new GroupConfig(state, environment, f.registry);
      const response = await backend.fetch(new Request("https://config/internal/state-events/owner/commit", {
        method: "POST", body: JSON.stringify({ attempt: pending.attempt, request: pending.request }) }));
      expect(response.status).toBe(200); expect((await response.json()).receipt.result.after).toBe(90);
    });
  });

  it("rejects an oversized projected payload and oversized saved result without changing state", async () => {
    const f = await fixture({ config: true, event: { message: { config: "message" } },
      payload: { type: "object", properties: { message: { type: "string", maxLength: 5000 } }, required: ["message"] } });
    const pending = await f.prepare({ config: { message: "x".repeat(4090) } }); const before = await f.snapshot();
    await expect(f.commit(pending)).rejects.toMatchObject({ code: "durable_event_payload_invalid" });
    expect(await f.snapshot()).toEqual(before);
    const g = await fixture({ mutation: { kind: "delete", key: { literal: "score" } }, event: { changed: { result: "changed" } },
      payload: { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"] } });
    await g.stub.fetch("https://config/internal/framework/state/set", { method: "POST",
      body: JSON.stringify({ featureId: g.featureId, key: "score", value: "x".repeat(4500) }) });
    const next = await g.prepare(); const prior = await g.snapshot();
    await expect(g.commit(next)).rejects.toMatchObject({ code: "state_event_invalid_result" }); expect(await g.snapshot()).toEqual(prior);
  });

  it("preserves the legacy feature value capacity and additive schema initialization", async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, (_i, state) => {
      for (let i = 0; i < 100; i++) state.storage.sql.exec("INSERT INTO framework_feature_values VALUES ('state', ?, ?, '1', ?)", f.featureId, `key_${i}`, Date.now());
    });
    const pending = await f.prepare(); const before = await f.snapshot();
    await expect(f.commit(pending)).rejects.toMatchObject({ status: 409 }); expect(await f.snapshot()).toEqual(before);
    await runInDurableObject(f.stub, (_i, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'state_event_outbox%'").toArray()).toEqual([]);
    });
  });

  it("limits maintenance to twenty intents and keeps every distinct accepted event", async () => {
    const f = await fixture();
    for (let i = 0; i < 21; i++) {
      const pending = await f.prepare({ args: { amount: 1 } });
      await runInDurableObject(f.stub, (_i, state) => {
        const exists = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'state_event_outbox_budget'").toArray();
        if (exists.length) state.storage.sql.exec("UPDATE state_event_outbox_budget SET rate_json = '[]'");
      });
      await f.commit(pending);
    }
    await runInDurableObject(f.stub, async (_i, state) => {
      state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0, deadline_ms = 0");
      expect(await maintainStateEventOutbox(state)).toEqual({ examined: 20 });
      await maintainStateEventOutbox(state);
    });
    const snapshot = await f.snapshot(); expect(snapshot.outbox).toHaveLength(21);
    expect(new Set(snapshot.outbox.map((row) => JSON.parse(row.intent_json).eventId)).size).toBe(21);
  });

});
