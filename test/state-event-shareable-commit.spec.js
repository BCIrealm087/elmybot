import { afterEach, describe, expect, it } from "vitest";
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  defineAction, defineDurableEventStream, defineFeature, defineStateEventOperation, discordActionCommand,
  frameworkApiVersion, schema
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import { prepareStateEventOperation } from "../src/framework/state-event-operation.js";
import { createCommandInvocation, createPlatformGroupRef } from "../src/integrations/contracts.js";
import { resolveStateEventSharedRoute } from "../src/state-events/shared-publication.js";
import { createStateEventIdentity } from "../src/state-events/identity.js";
import { prepareStateEventOrigin } from "../src/state-events/storage.js";
import { createStateEventRecovery } from "../src/state-events/recovery.js";
import { createStateEventOwnerClient } from "../src/state-events/owner-client.js";
import { STATE_EVENT_AUTHORITY_HEADER, STATE_EVENT_AUTHORITY_VALUE } from "../src/state-events/shareable-commit.js";
import { STATE_EVENT_BARRIER_LIMITS } from "../src/state-events/binding-authority.js";
import { shareableStateRealmObjectName } from "../src/shareable-state/realm-client.js";

import { registerShareableStateQueryWatcher, listStateQueryNotifications } from "../src/state-querying/watcher-client.js";

let sequence = 0;
const unique = (label) => `${label}-${Date.now()}-${++sequence}`;
const cleanup = new Map();
function track(kind, id) { cleanup.set(`${kind}:${id}`, { kind, id }); }
afterEach(async () => {
  for (const { kind, id } of cleanup.values()) await runInDurableObject(env[kind].get(id), (_i, state) => state.storage.deleteAlarm());
  cleanup.clear();
});
function group(platform) { return createPlatformGroupRef({ platform, kind: platform === "discord" ? "guild" : "channel", id: unique(platform) }); }
function declarations({ payloadMinimum = 0, schemaVersion = 1, adoptLegacyIntegrationState = false, namespaceId = "score" } = {}) {
  const featureId = "test.atomic-shared";
  const operationId = namespaceId === "score" ? "change" : `change-${namespaceId}`;
  const streamId = namespaceId === "score" ? "changes" : `changes-${namespaceId}`;
  const operation = defineStateEventOperation({ id: operationId, scope: { kind: "effective_shareable", namespace: namespaceId },
    input: schema.object({ amount: schema.integer({ min: 1, max: 100 }) }), stream: { id: streamId, version: 1 },
    mutation: { kind: "bounded_counter", name: "score", subject: { literal: "current" }, subjectLabel: "Current score",
      operation: "increment", amount: { input: "amount" }, min: 0, max: 100, initial: 0 },
    event: { score: { result: "after" }, applied: { result: "appliedAmount" }, changed: { result: "changed" } } });
  const stream = defineDurableEventStream({ id: streamId, version: 1, label: "Changes", description: "Atomic shareable changes",
    platforms: ["discord", "twitch"], scope: { kind: "effective_shareable" },
    publication: { kind: "state_event", source: operation.scope }, access: { kind: "operator_grant" },
    payload: { schema: { type: "object", properties: {
      score: { type: "integer", minimum: payloadMinimum, maximum: 100 }, applied: { type: "integer", minimum: 0, maximum: 100 },
      changed: { type: "boolean" } }, required: ["score", "applied", "changed"] } } });
  const action = defineAction({ kind: `${featureId}.${operationId}.v1`, supportedOrigins: ["discord", "twitch"], input: operation.input,
    uses: { services: ["stateEvents"], stateEvents: [operationId] }, cooldown: { scope: "group", seconds: 1 }, async execute() { throw new Error("command remains blocked"); } });
  const feature = defineFeature({ id: featureId, apiVersion: frameworkApiVersion, description: "Shared atomic fixture",
    shareableState: [{ id: namespaceId, label: "Score", schemaVersion, compatibleVersions: schemaVersion === 1 ? [1] : [1, 2], ...(adoptLegacyIntegrationState ? { adoptLegacyIntegrationState: true } : {}),
      limits: { maxEntries: 100, maxValueBytes: 1024 } }], stateEvents: [operation], eventStreams: [stream], actions: [action],
    commands: { discord: [discordActionCommand({ name: namespaceId === "score" ? "change" : namespaceId, description: "Change score", availability: "guild", actionKind: action.kind })] } });
  return { registry: createFeatureRegistry([feature], { availableServices: ["stateEvents"] }), featureId, operation, stream, action, feature };
}
async function fixture(options = {}) {
  const d = declarations(options);
  const registryId = env.INTEGRATION_REGISTRY.idFromName(unique("atomic-registry"));
  const registryStub = env.INTEGRATION_REGISTRY.get(registryId); track("INTEGRATION_REGISTRY", registryId);
  let interceptor = null;
  const rawRealm = (key) => { const id = env.SHAREABLE_STATE_REALM.idFromName(key); const stub = env.SHAREABLE_STATE_REALM.get(id); track("SHAREABLE_STATE_REALM", id); return stub; };
  const realmBinding = {
    idFromName: (key) => env.SHAREABLE_STATE_REALM.idFromName(key),
    get: (id) => {
      const actual = env.SHAREABLE_STATE_REALM.get(id); track("SHAREABLE_STATE_REALM", id);
      return { fetch: async (input, init) => {
        await runInDurableObject(actual, (instance) => { instance.featureRegistry = d.registry; instance.env = testEnv; });
        const send = () => env.SHAREABLE_STATE_REALM.get(id).fetch(input, init);
        return interceptor ? interceptor(input, init, send) : send();
      } };
    }
  };
  const testEnv = { ...env, SHAREABLE_STATE_REALM: realmBinding,
    INTEGRATION_REGISTRY: { idFromName: () => registryId, get: () => env.INTEGRATION_REGISTRY.get(registryId) } };
  const initRegistry = () => runInDurableObject(env.INTEGRATION_REGISTRY.get(registryId), (instance) => { instance.env = testEnv; });
  await initRegistry();
  const registryCall = async (path, input) => {
    const response = await env.INTEGRATION_REGISTRY.get(registryId).fetch(`https://registry${path}`, { method: "POST", body: JSON.stringify(input) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? data.userFacingError), { code: data.code, status: response.status });
    return data;
  };
  const origin = (source) => { const id = env.CONFIG.idFromName(source.key); const stub = env.CONFIG.get(id); track("CONFIG", id); return stub; };
  const schemaVersion = () => d.registry.featuresById[d.featureId].shareableState.find((ns) => ns.id === d.operation.scope.namespace).schemaVersion;
  const resolve = (source) => resolveStateEventSharedRoute(testEnv, { sourceGroup: source, targetPlatform: source.platform === "discord" ? "twitch" : "discord",
    featureId: d.featureId, namespaceId: d.operation.scope.namespace, schemaVersion: schemaVersion(), stream: d.stream });
  const prepare = async (source, amount = 1) => {
    const invocation = createCommandInvocation({ kind: d.action.kind, args: { amount }, sourceCreatedAtMs: Date.now(),
      sourceEventId: `${source.platform}:${source.platform === "discord" ? "interaction" : "eventsub"}:${unique("source")}`,
      origin: { group: source, actor: { platform: source.platform, id: "actor", claims: [] } } });
    const identity = await createStateEventIdentity({ environment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT, featureId: d.featureId,
      invocation, declaration: { stream: d.operation.stream, mutation: d.operation.mutation, namespaceVersion: schemaVersion() } });
    const request = prepareStateEventOperation(d.operation, { amount });
    const route = await resolve(source);
    return runInDurableObject(origin(source), (_i, state) => {
      state.storage.sql.exec("DELETE FROM framework_feature_cooldowns");
      return prepareStateEventOrigin(state, { identity, request, route, cooldownSeconds: 1 });
    });
  };
  const commit = async (source, record) => {
    const stub = origin(source);
    await runInDurableObject(stub, (instance) => { instance.env = testEnv; });
    const response = await stub.fetch("https://origin/internal/state-events/origin/commit-shared", {
      method: "POST", body: JSON.stringify({ attempt: record.attempt, request: record.request }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? data.userFacingError), { code: data.code, status: response.status });
    return data;
  };
  const realmCall = async (route, operation, storage = {}, authorized = false) => {
    const response = await realmBinding.get(realmBinding.idFromName(route.key)).fetch(`https://realm/internal/shareable-state/realm/${operation}`, {
      method: "POST", headers: authorized ? { [STATE_EVENT_AUTHORITY_HEADER]: STATE_EVENT_AUTHORITY_VALUE } : {},
      body: JSON.stringify({ realm: route.realm, namespace: route.namespace, storage }) });
    return { status: response.status, data: await response.json() };
  };
  const inspect = (route) => runInDurableObject(rawRealm(route.key), async (_i, state) => {
    const rows = (table) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = ?", table).toArray().length
      ? state.storage.sql.exec(`SELECT * FROM ${table}`).toArray() : [];
    return { values: rows("shareable_state_realm_values"), namespaces: rows("shareable_state_realm_namespaces"),
      outbox: rows("state_event_outbox"), partitions: rows("state_event_partitions"), records: rows("state_event_records"),
      notifications: rows("state_query_notification_outbox"), alarm: await state.storage.getAlarm() };
  });
  const install = (discord, twitch, { id = unique("integration"), discordDefault = true, twitchDefault = true } = {}) => runInDurableObject(registryStub, (instance, state) => {
    const now = Date.now();
    state.storage.sql.exec(`INSERT INTO integrations (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms,
      created_by_platform, created_by_actor_id, completed_by_platform, completed_by_actor_id, shareable_state_generation)
      VALUES (?, 'active', ?, ?, ?, 'discord', 'manager', 'twitch', 'broadcaster', 1)`, id, now, now, now);
    for (const source of [discord, twitch]) state.storage.sql.exec("INSERT INTO integration_members (integration_id, group_key, platform, group_kind, group_id, joined_at_ms) VALUES (?, ?, ?, ?, ?, ?)", id, source.key, source.platform, source.kind, source.id, now);
    if (discordDefault) instance.assignDefaultLinkIfAbsent({ sourceGroup: discord, targetGroup: twitch, integrationId: id, nowMs: now });
    if (twitchDefault) instance.assignDefaultLinkIfAbsent({ sourceGroup: twitch, targetGroup: discord, integrationId: id, nowMs: now });
    return id;
  });
  const setDefault = (source, target, integrationId) => registryCall("/default-links/set", { sourceGroup: source, targetGroup: target, integrationId,
    actor: { platform: source.platform, id: "manager", claims: [] } });
  const revoke = (integrationId, source) => registryCall("/integrations/revoke", { integrationId, group: source,
    actor: { platform: source.platform, id: "manager", claims: [] } });
  return { ...d, env: testEnv, registryStub, registryCall, initRegistry, rawRealm, origin, resolve, prepare, commit, realmCall, inspect, install, setDefault, revoke,
    setRegistry(value) { d.registry = value; },
    setDeclarations(value) { Object.assign(d, value); },
    intercept(fn) { interceptor = fn; } };
}

function isCommit(input) { return new URL(typeof input === "string" ? input : input.url).pathname.endsWith("/state-event-commit"); }

describe("shareable atomic state/event acceptance and lifecycle", () => {
  it("keeps standalone owners isolated and confirms the original result at its origin", async () => {
    const f = await fixture(); const a = group("discord"), b = group("discord");
    const first = await f.prepare(a, 5); const second = await f.prepare(b, 2);
    const accepted = await f.commit(a, first); await f.commit(b, second);
    expect(accepted.receipt.result).toMatchObject({ before: 0, after: 5, appliedAmount: 5 });
    expect(first.attempt.route.key).not.toBe(second.attempt.route.key);
    const stored = await f.inspect(first.attempt.route);
    expect(JSON.parse(stored.values[0].value_json)).toBe(5); expect(stored.outbox).toHaveLength(1);
    expect(stored.alarm).not.toBeNull();
    expect(await f.commit(a, first)).toEqual(accepted);
  });

  it("retries a lost origin acknowledgement without another acceptance call", async () => {
    const f = await fixture(); const a = group("discord"), record = await f.prepare(a, 2);
    f.intercept(async (input, _init, send) => {
      if (new URL(input).pathname.endsWith("state-event-confirm")) throw new Error("lost acknowledgement");
      return send();
    });
    const accepted = await f.commit(a, record);
    expect(JSON.parse((await f.inspect(record.attempt.route)).records[0].metadata_json).originConfirmed).toBe(false);
    f.intercept(async (input, _init, send) => { if (isCommit(input)) throw new Error("unexpected second acceptance"); return send(); });
    expect(await f.commit(a, record)).toEqual(accepted);
    const stored = await f.inspect(record.attempt.route);
    expect(JSON.parse(stored.records[0].metadata_json).originConfirmed).toBe(true);
    expect(stored.outbox).toHaveLength(1); expect(stored.values[0].value_json).toBe("2");
  });

  it("recovers and parks an outbox after owner eviction without requiring watcher tables", async () => {
    const f = await fixture(); const a = group("discord"), record = await f.prepare(a, 2);
    const accepted = await f.commit(a, record); const owner = f.rawRealm(record.attempt.route.key);
    await evictDurableObject(owner);
    await runInDurableObject(owner, (_i, state) => state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0"));
    expect(await runDurableObjectAlarm(owner)).toBe(true);
    const stored = await f.inspect(record.attempt.route);
    expect(stored.outbox[0].attempts).toBe(1); expect(stored.alarm).not.toBeNull(); expect(stored.alarm).toBeLessThan(accepted.receipt.expiresAtMs);
    expect(stored.values[0].value_json).toBe("2");
    expect((await createStateEventOwnerClient(f.env).lookup(record.attempt)).receipt).toEqual(accepted.receipt);
  });

  it("serializes Discord and Twitch against one integration partition with symmetric defaults", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"); await f.install(a, b);
    const first = await f.prepare(a, 5), second = await f.prepare(b, 7);
    expect(first.attempt.route.key).toBe(second.attempt.route.key);
    const [x, y] = await Promise.all([f.commit(a, first), f.commit(b, second)]);
    expect([x.receipt.stateEvent.operationSequence, y.receipt.stateEvent.operationSequence].sort()).toEqual([1, 2]);
    expect(x.receipt.stateEvent.scopeToken).toBe(y.receipt.stateEvent.scopeToken);
    const stored = await f.inspect(first.attempt.route);
    expect(JSON.parse(stored.values[0].value_json)).toBe(12); expect(stored.outbox).toHaveLength(2);
    expect(stored.namespaces[0].mutation_version).toBe(2);
    expect(stored.records.every((row) => row.record_key.startsWith("owner:"))).toBe(true);
  });

  it("keeps asymmetric defaults on their independently selected integration owners", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("discord");
    await f.install(a, b); const other = await f.install(c, b); await f.setDefault(b, c, other);
    const x = await f.prepare(a, 3), y = await f.prepare(b, 8); await f.commit(a, x); await f.commit(b, y);
    expect(x.attempt.route.key).not.toBe(y.attempt.route.key);
    expect(JSON.parse((await f.inspect(x.attempt.route)).values[0].value_json)).toBe(3);
    expect(JSON.parse((await f.inspect(y.attempt.route)).values[0].value_json)).toBe(8);
  });

  it("fences a stale uncommitted route before repinning to a newly selected default", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("twitch");
    await f.install(a, b); const nextId = await f.install(a, c); const old = await f.prepare(a, 4);
    await f.setDefault(a, c, nextId);
    await expect(f.commit(a, old)).rejects.toMatchObject({ code: "state_event_binding_changed" });
    const route = await f.resolve(a);
    const next = await runInDurableObject(f.origin(a), (_i, state) => createStateEventRecovery(state, createStateEventOwnerClient(f.env))
      .repin(old.attempt.identity, () => route));
    expect(next.attempt.epoch).toBe(2); expect((await f.commit(a, next)).receipt.result.after).toBe(4);
    const delayed = await f.realmCall(old.attempt.route, "state-event-commit", { attempt: old.attempt, request: old.request }, true);
    expect(delayed.data.code).toBe("state_event_attempt_fenced");
    expect((await f.inspect(old.attempt.route)).values).toEqual([]);
  });

  it("rejects direct owner/registry admission bypasses and missing durable origin preparation", async () => {
    const f = await fixture(); const a = group("discord"), pending = await f.prepare(a);
    expect((await f.realmCall(pending.attempt.route, "state-event-commit", { attempt: pending.attempt, request: pending.request })).status).toBe(403);
    await expect(f.registryCall("/state-events/commit", { attempt: pending.attempt, request: pending.request })).rejects.toMatchObject({ code: "state_event_origin_required" });
    await runInDurableObject(f.origin(a), (_i, state) => state.storage.sql.exec("DELETE FROM state_event_records"));
    await expect(f.commit(a, pending)).rejects.toMatchObject({ code: "state_event_missing_origin" });
    expect((await f.inspect(pending.attempt.route)).values).toEqual([]);
  });

  it("checks seals at the mutation boundary and permits frozen receipt recovery", async () => {
    const f = await fixture(); const a = group("discord"), first = await f.prepare(a, 6); const accepted = await f.commit(a, first);
    const next = await f.prepare(a, 4);
    expect((await f.realmCall(first.attempt.route, "seal-snapshot", { sealId: "transition", expiresAtMs: Date.now() + 60_000 })).status).toBe(200);
    await expect(f.commit(a, next)).rejects.toMatchObject({ code: "shareable_state_transition_sealed" });
    expect((await f.inspect(first.attempt.route)).outbox).toHaveLength(1);
    expect((await f.realmCall(first.attempt.route, "freeze-snapshot", { freezeId: "revoked" })).status).toBe(200);
    const recovered = await createStateEventOwnerClient(f.env).lookup(first.attempt);
    expect(recovered.receipt).toEqual(accepted.receipt);
    expect((await f.inspect(first.attempt.route)).values[0].value_json).toBe("6");
  });

  it("rolls back shared state, revision, notification, receipt, intent and alarm on invalid payload", async () => {
    const f = await fixture({ payloadMinimum: 50 }); const a = group("discord"), pending = await f.prepare(a, 1);
    const before = await f.inspect(pending.attempt.route);
    const rejected = await f.realmCall(pending.attempt.route, "state-event-commit", { attempt: pending.attempt, request: pending.request }, true);
    expect(rejected.data.code).toBe("durable_event_payload_invalid");
    const after = await f.inspect(pending.attempt.route);
    expect(after).toEqual(before);
  });

  it("recovers a lost committed reply after registry eviction and a default change without writing a second owner", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("twitch");
    await f.install(a, b); const id = await f.install(a, c); const pending = await f.prepare(a, 9);
    let lost = false;
    f.intercept(async (input, _init, send) => {
      const response = await send();
      if (isCommit(input) && !lost) { lost = true; throw new Error("commit reply lost"); }
      return response;
    });
    await expect(f.commit(a, pending)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    await evictDurableObject(f.registryStub); await f.initRegistry(); f.intercept(null);
    await f.setDefault(a, c, id);
    const recovered = await f.commit(a, pending);
    expect(recovered.receipt.result.after).toBe(9);
    expect((await f.inspect(pending.attempt.route)).outbox).toHaveLength(1);
    const selected = await f.resolve(a); expect((await f.inspect(selected)).outbox).toHaveLength(0);
  });

  it("serializes an in-flight commit before a default movement", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("twitch");
    const initialId = await f.install(a, b); const id = await f.install(a, c); const pending = await f.prepare(a, 3);
    let entered, release;
    const arrived = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    f.intercept(async (input, _init, send) => { if (isCommit(input)) { entered(); await gate; } return send(); });
    const committing = f.commit(a, pending); await arrived;
    const moving = f.setDefault(a, c, id);
    const current = await f.registryCall("/default-links/get", { sourceGroup: a, targetPlatform: "twitch" });
    expect(current.defaultLink.integration.id).toBe(initialId);
    release(); const [accepted] = await Promise.all([committing, moving]);
    expect(accepted.receipt.result.after).toBe(3);
    expect((await f.resolve(a)).key).not.toBe(pending.attempt.route.key);
  });
  it("blocks only affected lifecycle changes while an old owner is unreachable, including after registry restart", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("twitch");
    await f.install(a, b); const nextId = await f.install(a, c); const pending = await f.prepare(a, 4);
    let delayed;
    f.intercept(async (input, init) => { if (isCommit(input)) delayed = { input, init }; throw new Error("owner unavailable"); });
    await expect(f.commit(a, pending)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    await evictDurableObject(f.registryStub); await f.initRegistry();
    await expect(f.setDefault(a, c, nextId)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    const x = group("discord"), y = group("twitch"), z = group("twitch");
    await f.install(x, y); const unrelated = await f.install(x, z);
    expect((await f.setDefault(x, z, unrelated)).changed).toBe(true);
    f.intercept(null); await f.setDefault(a, c, nextId);
    const late = await f.env.SHAREABLE_STATE_REALM.get(f.env.SHAREABLE_STATE_REALM.idFromName(pending.attempt.route.key)).fetch(delayed.input, delayed.init);
    expect(late.status).toBe(409); expect((await late.json()).code).toBe("state_event_attempt_fenced");
    expect((await f.inspect(pending.attempt.route)).values).toEqual([]);
  });

  it("freezes accepted obligations at revocation and clones only feature state into standalone successors", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"); const id = await f.install(a, b);
    const pending = await f.prepare(a, 5); const accepted = await f.commit(a, pending);
    await f.revoke(id, a);
    const successor = await f.resolve(a);
    expect(successor.realm.kind).toBe("standalone"); expect(successor.realm.generation).toBe(2);
    const cloned = await f.inspect(successor);
    expect(JSON.parse(cloned.values[0].value_json)).toBe(5);
    expect(cloned.outbox).toEqual([]); expect(cloned.records).toEqual([]); expect(cloned.partitions).toEqual([]);
    const newRecord = await f.prepare(a, 2); const newAccepted = await f.commit(a, newRecord);
    expect(newAccepted.receipt.result.after).toBe(7); expect(newAccepted.receipt.stateEvent.operationSequence).toBe(1);
    expect(newAccepted.receipt.stateEvent.scopeToken).not.toBe(accepted.receipt.stateEvent.scopeToken);
    expect(await f.commit(a, pending)).toEqual(accepted);
    expect((await createStateEventOwnerClient(f.env).lookup(pending.attempt)).receipt).toEqual(accepted.receipt);
    const archived = await f.inspect(pending.attempt.route);
    expect(archived.namespaces[0].freeze_id).not.toBeNull(); expect(archived.outbox).toHaveLength(1);
    expect(JSON.parse(archived.outbox[0].intent_json).route.key).toBe(pending.attempt.route.key);
    const bRecord = await f.prepare(b, 1); expect((await f.commit(b, bRecord)).receipt.result.after).toBe(6);
    expect((await f.inspect(successor)).values[0].value_json).toBe("7");
  });

  it("uses an existing fallback integration without moving an archived event or replaying its mutation", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("twitch");
    const oldId = await f.install(a, b); const fallback = await f.install(a, c);
    const old = await f.prepare(a, 5); const accepted = await f.commit(a, old);
    const other = await f.prepare(c, 10); await f.commit(c, other);
    await f.revoke(oldId, a);
    const selected = await f.resolve(a);
    expect(selected.realm.ownerIntegration.id).toBe(fallback);
    expect((await f.commit(a, await f.prepare(a, 2))).receipt.result.after).toBe(12);
    expect(await f.commit(a, old)).toEqual(accepted);
    expect((await f.inspect(old.attempt.route)).outbox).toHaveLength(1);
    expect((await f.inspect(selected)).outbox).toHaveLength(2);
  });

  it("handles collision selection, revocation and relinking without cloning receipts, payloads or producer history", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch");
    const oldA = await f.prepare(a, 3), oldB = await f.prepare(b, 8); await f.commit(a, oldA); await f.commit(b, oldB);
    async function link(selection) {
      const invite = await f.registryCall("/invitations", { group: a, actor: { platform: "discord", id: "manager", claims: [] },
        connectUrl: "https://example.com/twitch/integrations/connect" });
      const reservation = await f.registryCall("/invitations/reserve", { token: new URL(invite.invitationUrl).hash.slice("#invite=".length),
        reservationId: crypto.randomUUID(), reservationExpiresAtMs: Date.now() + 600_000 });
      const verification = await f.registryCall("/invitations/verify-twitch", { invitationId: reservation.invitationId,
        reservationId: reservation.reservationId, group: b, actor: { platform: "twitch", id: b.id, claims: ["twitch.broadcaster"] } });
      if (selection) await f.registryCall("/invitations/resolve-state", { reservationId: reservation.reservationId,
        discoveryVersion: verification.pendingIntegration.stateDiscovery.version,
        selections: [{ featureId: f.featureId, namespaceId: "score", selection }] });
      return f.registryCall("/invitations/activate", { invitationId: reservation.invitationId, reservationId: reservation.reservationId });
    }
    await link("discord");
    const joined = await f.resolve(a); expect(joined.realm.kind).toBe("integration");
    const fresh = await f.inspect(joined); expect(fresh.values[0].value_json).toBe("3");
    expect(fresh.outbox).toEqual([]); expect(fresh.records).toEqual([]); expect(fresh.partitions).toEqual([]);
    const accepted = await f.commit(a, await f.prepare(a, 2)); expect(accepted.receipt.result.after).toBe(5);
    expect(accepted.receipt.stateEvent.operationSequence).toBe(1);
    expect((await f.inspect(oldA.attempt.route)).outbox).toHaveLength(1); expect((await f.inspect(oldB.attempt.route)).outbox).toHaveLength(1);
    await f.revoke(joined.realm.ownerIntegration.id, a);
    await f.commit(a, await f.prepare(a, 2)); await f.commit(b, await f.prepare(b, 1));
    await link("twitch");
    const relinked = await f.resolve(a); expect(relinked.key).not.toBe(joined.key);
    const restored = await f.inspect(relinked);
    expect(restored.values[0].value_json).toBe("6"); expect(restored.outbox).toEqual([]); expect(restored.records).toEqual([]);
    const last = await f.commit(a, await f.prepare(a, 1)); expect(last.receipt.result.after).toBe(7);
    expect(last.receipt.stateEvent.operationSequence).toBe(1); expect(last.receipt.stateEvent.scopeToken).not.toBe(accepted.receipt.stateEvent.scopeToken);
  });

  it("preserves original receipts across compatible declaration changes and rejects new stale schema pins", async () => {
    const f = await fixture(); const a = group("discord"); const first = await f.prepare(a, 2); const accepted = await f.commit(a, first);
    const next = await f.prepare(a, 3); f.setRegistry(declarations({ schemaVersion: 2 }).registry);
    expect((await createStateEventOwnerClient(f.env).lookup(first.attempt)).receipt).toEqual(accepted.receipt);
    await expect(f.commit(a, next)).rejects.toMatchObject({ code: "state_event_schema_changed" });
    const stored = await f.inspect(first.attempt.route); expect(stored.namespaces[0].schema_version).toBe(1); expect(stored.outbox).toHaveLength(1);
  });

  it("recovers an original receipt after its feature declaration is removed", async () => {
    const f = await fixture(); const a = group("discord"), record = await f.prepare(a, 2);
    const accepted = await f.commit(a, record); const before = await f.inspect(record.attempt.route);
    f.setRegistry(createFeatureRegistry([], { availableServices: ["stateEvents"] }));
    expect((await createStateEventOwnerClient(f.env).lookup(record.attempt)).receipt).toEqual(accepted.receipt);
    expect(await f.inspect(record.attempt.route)).toEqual(before);
  });

  it("releases registry uncertainty capacity after fencing a definite owner rejection", async () => {
    const f = await fixture({ payloadMinimum: 20 }); const a = group("discord"), record = await f.prepare(a, 2);
    await expect(f.commit(a, record)).rejects.toMatchObject({ code: "durable_event_payload_invalid" });
    const budget = await runInDurableObject(f.registryStub, (_i, state) => state.storage.sql.exec("SELECT rows, bytes FROM state_event_barrier_budget").one());
    expect(budget).toEqual({ rows: 0, bytes: 0 });
    expect((await createStateEventOwnerClient(f.env).lookup(record.attempt)).state).toBe("fenced");
    expect((await f.inspect(record.attempt.route)).outbox).toEqual([]);
  });

  it("requires legacy adoption to finish separately instead of partially migrating during failed acceptance", async () => {
    const f = await fixture({ adoptLegacyIntegrationState: true }); const a = group("discord"), b = group("twitch"); await f.install(a, b);
    const next = await f.prepare(a, 1); const before = await f.inspect(next.attempt.route);
    const rejected = await f.realmCall(next.attempt.route, "state-event-commit", { attempt: next.attempt, request: next.request }, true);
    expect(rejected.data.code).toBe("state_event_legacy_adoption_required");
    expect(await f.inspect(next.attempt.route)).toEqual(before);
  });

  it("bounds durable uncertain-call storage and leaves a rejected operation uncommitted", async () => {
    const f = await fixture(); const a = group("discord"); await f.commit(a, await f.prepare(a, 2));
    await runInDurableObject(f.registryStub, (_i, state) => state.storage.sql.exec("UPDATE state_event_barrier_budget SET rows = ?", STATE_EVENT_BARRIER_LIMITS.rows));
    const next = await f.prepare(a, 1); const before = await f.inspect(next.attempt.route);
    await expect(f.commit(a, next)).rejects.toMatchObject({ code: "state_event_authority_capacity" }); expect(await f.inspect(next.attempt.route)).toEqual(before);
  });

  it("binds a shared commit to the physical realm object before persisting its identity", async () => {
    const f = await fixture(); const a = group("discord"), pending = await f.prepare(a);
    const otherRealm = { kind: "standalone", generation: 1, ownerGroup: group("discord") };
    const wrong = { ...pending.attempt.route, key: shareableStateRealmObjectName(otherRealm) };
    const response = await f.realmCall(wrong, "state-event-commit", { attempt: pending.attempt, request: pending.request }, true);
    expect(response.status).toBe(422); expect(response.data.code).toBe("state_event_wrong_owner");
    expect((await f.inspect(wrong)).namespaces).toEqual([]);
  });

  it("accepts a clamped no-op, advances its watermark, and delivers the normal shared revision notification", async () => {
    const f = await fixture(); const a = group("discord"); const first = await f.prepare(a, 100); await f.commit(a, first);
    await registerShareableStateQueryWatcher(f.env, { realm: first.attempt.route.realm, featureId: f.featureId, namespaceId: "score",
      target: a, watcherId: "shared-noop", expectedRevision: 1, leaseSeconds: 120 });
    const next = await f.prepare(a, 10); const accepted = await f.commit(a, next);
    expect(accepted.receipt.result).toMatchObject({ before: 100, after: 100, changed: false, appliedAmount: 0 });
    expect(accepted.receipt.stateEvent).toMatchObject({ operationSequence: 2, stateRevision: 2 });
    await runInDurableObject(f.rawRealm(first.attempt.route.key), (instance) => instance.alarm());
    const delivered = await listStateQueryNotifications(f.env, a);
    expect(delivered.notifications).toHaveLength(1); expect(delivered.notifications[0]).toMatchObject({ watcherId: "shared-noop", revision: 2 });
    expect((await f.inspect(first.attempt.route)).outbox).toHaveLength(2);
  });

  it("bounds recovery work before a lifecycle mutation and resumes it on the next request", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("twitch");
    await f.install(a, b); const other = await f.install(a, c);
    // Initialize the additive authority schema through one real accepted call.
    await f.commit(a, await f.prepare(a, 1));
    const pending = [];
    for (let i = 0; i <= STATE_EVENT_BARRIER_LIMITS.batch; i++) pending.push(await f.prepare(a, 1));
    await runInDurableObject(f.registryStub, (_i, state) => {
      let bytes = 0;
      for (const record of pending) {
        const json = JSON.stringify(record.attempt), size = new TextEncoder().encode(json).byteLength; bytes += size;
        state.storage.sql.exec("INSERT INTO state_event_commit_barriers VALUES (?, ?, ?, ?, ?)", record.attempt.identity.operationId, a.key, record.attempt.route.key, json, size);
      }
      state.storage.sql.exec("UPDATE state_event_barrier_budget SET rows = ?, bytes = ?", pending.length, bytes);
    });
    await expect(f.setDefault(a, c, other)).rejects.toMatchObject({ code: "state_event_recovery_pending" });
    const counts = await runInDurableObject(f.registryStub, (_i, state) => state.storage.sql.exec("SELECT rows FROM state_event_barrier_budget").one().rows);
    expect(counts).toBe(1); await f.setDefault(a, c, other);
    const late = await f.realmCall(pending[0].attempt.route, "state-event-commit", { attempt: pending[0].attempt, request: pending[0].request }, true);
    expect(late.data.code).toBe("state_event_attempt_fenced");
  });

  it("retains a timed-out authority call until fencing prevents its delayed execution", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"), c = group("twitch");
    await f.install(a, b); const nextId = await f.install(a, c); const record = await f.prepare(a, 3);
    let release, finished;
    const held = new Promise((resolve) => { release = resolve; });
    const late = new Promise((resolve) => { finished = resolve; });
    f.intercept(async (input, _init, send) => {
      if (!isCommit(input)) return send();
      await held; const response = await send(); finished(await response.clone().json()); return response;
    });
    await expect(f.commit(a, record)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    f.intercept(null); await f.setDefault(a, c, nextId); release();
    expect((await late).code).toBe("state_event_attempt_fenced");
    expect((await f.inspect(record.attempt.route)).values).toEqual([]);
  }, 15000);

  it("recovers uncertain peer calls before group revocation begins", async () => {
    const f = await fixture(); const a = group("discord"), b = group("twitch"); await f.install(a, b);
    const record = await f.prepare(b, 4);
    f.intercept(async (input, _init, send) => { if (isCommit(input)) throw new Error("lost before owner"); return send(); });
    await expect(f.commit(b, record)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    f.intercept(null);
    await f.registryCall("/groups/revoke", { group: a, actor: { platform: "discord", id: "manager", claims: [] } });
    const late = await f.realmCall(record.attempt.route, "state-event-commit", { attempt: record.attempt, request: record.request }, true);
    expect(late.data.code).toBe("state_event_attempt_fenced");
    expect((await f.inspect(record.attempt.route)).outbox).toEqual([]);
  });

  it("rolls back state and sequence when the shared outbox or receipt budget is full", async () => {
    for (const limit of ["outbox", "receipt"]) {
      const f = await fixture(); const a = group("discord"); const seed = await f.prepare(a, 1); await f.commit(a, seed);
      await runInDurableObject(f.rawRealm(seed.attempt.route.key), (_i, state) => {
        if (limit === "outbox") state.storage.sql.exec("UPDATE state_event_outbox_budget SET bytes = ?", 512 * 1024);
        else state.storage.sql.exec("UPDATE state_event_budget SET metadata_bytes = ?", 16 * 1024 * 1024);
      });
      const next = await f.prepare(a, 1); const before = await f.inspect(next.attempt.route);
      await expect(f.commit(a, next)).rejects.toMatchObject({ code: limit === "outbox" ? "state_event_outbox_capacity" : "state_event_capacity" });
      expect(await f.inspect(next.attempt.route)).toEqual(before);
    }
  });

  it("forbids repinning a prepared operation onto a different namespace schema version", async () => {
    const f = await fixture(); const a = group("discord"), record = await f.prepare(a);
    const changed = { ...record.attempt.route, namespace: { ...record.attempt.route.namespace, schemaVersion: 2 } };
    await expect(runInDurableObject(f.origin(a), (_i, state) => createStateEventRecovery(state, createStateEventOwnerClient(f.env))
      .repin(record.attempt.identity, () => changed))).rejects.toMatchObject({ code: "state_event_route_conflict" });
    expect((await f.inspect(record.attempt.route)).values).toEqual([]);
  });

  it("keeps namespace watermarks separate while sharing the physical owner's event budget", async () => {
    const f = await fixture(); const a = group("discord"); const score = await f.prepare(a, 3); const x = await f.commit(a, score);
    const reserve = declarations({ namespaceId: "reserve" });
    const both = defineFeature({ id: f.featureId, apiVersion: frameworkApiVersion, description: "Two partitions",
      shareableState: [...f.feature.shareableState, ...reserve.feature.shareableState],
      stateEvents: [f.operation, reserve.operation], eventStreams: [f.stream, reserve.stream], actions: [f.action, reserve.action],
      commands: { discord: [...f.feature.commands.discord, ...reserve.feature.commands.discord] } });
    f.setDeclarations({ ...reserve, registry: createFeatureRegistry([both], { availableServices: ["stateEvents"] }) });
    const record = await f.prepare(a, 7); const y = await f.commit(a, record);
    expect(score.attempt.route.key).toBe(record.attempt.route.key);
    expect(x.receipt.stateEvent.operationSequence).toBe(1); expect(y.receipt.stateEvent.operationSequence).toBe(1);
    expect(x.receipt.stateEvent.scopeToken).not.toBe(y.receipt.stateEvent.scopeToken);
    const saved = await f.inspect(record.attempt.route);
    expect(saved.partitions).toHaveLength(2); expect(saved.outbox).toHaveLength(2);
    expect(saved.values.find((row) => row.namespace_id === "score").value_json).toBe("3");
    expect(saved.values.find((row) => row.namespace_id === "reserve").value_json).toBe("7");
  });

  it("upgrades a compatible namespace only inside a successful new-schema operation", async () => {
    const f = await fixture(); const a = group("discord"); const initial = await f.prepare(a, 2); await f.commit(a, initial);
    f.setRegistry(declarations({ schemaVersion: 2 }).registry);
    const next = await f.prepare(a, 1); expect(next.attempt.route.namespace.schemaVersion).toBe(2);
    const accepted = await f.commit(a, next);
    expect(accepted.receipt.result).toMatchObject({ before: 2, after: 3 }); expect(accepted.receipt.stateEvent.stateRevision).toBe(3);
    const saved = await f.inspect(next.attempt.route); expect(saved.namespaces[0].schema_version).toBe(2); expect(saved.outbox).toHaveLength(2);
  });

});
