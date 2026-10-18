import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { featureRegistry } from "../src/features/index.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { executeAction, createActionRegistry } from "../src/actions/registry.js";
import { createCommandInvocation, createPlatformGroupRef } from "../src/integrations/contracts.js";
import { evaluateStateQuery } from "../src/state-querying/evaluator.js";
import { resolveStateEventSharedRoute } from "../src/state-events/shared-publication.js";

let serial = 0;
const objects = new Map();
afterEach(async () => { vi.restoreAllMocks(); for (const { kind, id } of objects.values()) await runInDurableObject(env[kind].get(id), (_i, state) => state.storage.deleteAlarm()); objects.clear(); });
async function fixture() {
  const suffix = `${Date.now()}-${++serial}`;
  const discord = createPlatformGroupRef({ platform: "discord", kind: "guild", id: `health-discord-${suffix}` });
  const twitch = createPlatformGroupRef({ platform: "twitch", kind: "channel", id: `health-twitch-${suffix}` });
  const registryId = env.INTEGRATION_REGISTRY.idFromName(`health-${suffix}`);
  const tracked = (kind, id) => { objects.set(`${kind}:${id}`, { kind, id }); return env[kind].get(id); };
  let intercept = null;
  const bindings = Object.fromEntries(["CONFIG", "SHAREABLE_STATE_REALM", "DURABLE_EVENT_STREAM", "INTEGRATION_REGISTRY"].map((kind) => [kind, {
    idFromName: (key) => kind === "INTEGRATION_REGISTRY" ? registryId : env[kind].idFromName(key), get: (id) => ({ fetch: async (input, init) => {
      await runInDurableObject(tracked(kind, id), (instance) => { instance.env = testEnv; });
      const send = () => env[kind].get(id).fetch(input, init);
      return intercept ? intercept(kind, input, init, send) : send();
    } })
  }]));
  const testEnv = { ...env, ...bindings, STATE_EVENT_OPERATIONS_ENABLED: "true", DURABLE_EVENT_STREAMS_ENABLED: "true" };
  function invocation(group = discord, args = { operation: "damage", amount: 15 }) {
    return createCommandInvocation({ kind: "fun.health.impact.v2", args, sourceEventId: `${group.platform}:health:${suffix}:${++serial}`, sourceCreatedAtMs: Date.now(),
      origin: { group, actor: { platform: group.platform, id: "moderator", claims: [] } } });
  }
  const command = (input, allowed = true) => executeAction(createActionRegistry(featureRegistry.actions), input, {
    ...createFeatureServiceRuntime(testEnv, input, featureRegistry), authorize: async () => allowed
  });
  async function read(group = discord) {
    const result = await evaluateStateQuery(featureRegistry, { version: 1, target: { platform: group.platform, groupId: group.id }, bindings: {
      current: { read: { feature: "fun.health", export: "current", version: 1 } } }, select: { health: { ref: "current" } } }, { env: testEnv });
    expect(result.envelope.status).toBe("ready"); return result.envelope.data.health;
  }
  async function route(group = discord) {
    return resolveStateEventSharedRoute(testEnv, { sourceGroup: group, targetPlatform: group.platform === "discord" ? "twitch" : "discord", featureId: "fun.health", namespaceId: "health", schemaVersion: 1,
      stream: featureRegistry.eventStreams["fun.health:impacts:v2"].definition });
  }
  async function owner(group = discord) { const selected = await route(group); return tracked("SHAREABLE_STATE_REALM", env.SHAREABLE_STATE_REALM.idFromName(selected.key)); }
  async function rows(table, group = discord) { return runInDurableObject(await owner(group), (_i, state) => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()); }
  async function link({ symmetric = true } = {}) {
    const id = crypto.randomUUID();
    await runInDurableObject(tracked("INTEGRATION_REGISTRY", registryId), (instance, state) => {
      instance.env = testEnv; const now = Date.now();
      state.storage.sql.exec(`INSERT INTO integrations (integration_id, status, created_at_ms, updated_at_ms, activated_at_ms, created_by_platform, created_by_actor_id,
        completed_by_platform, completed_by_actor_id, shareable_state_generation) VALUES (?, 'active', ?, ?, ?, 'discord', 'manager', 'twitch', 'manager', 1)`, id, now, now, now);
      for (const group of [discord, twitch]) state.storage.sql.exec("INSERT INTO integration_members (integration_id, group_key, platform, group_kind, group_id, joined_at_ms) VALUES (?, ?, ?, ?, ?, ?)", id, group.key, group.platform, group.kind, group.id, now);
    });
    for (const [sourceGroup, targetGroup] of [[discord, twitch], ...(symmetric ? [[twitch, discord]] : [])]) {
      const response = await bindings.INTEGRATION_REGISTRY.get(registryId).fetch("https://registry/default-links/set", { method: "POST", body: JSON.stringify({ sourceGroup, targetGroup, integrationId: id, actor: { platform: sourceGroup.platform, id: "manager", claims: [] } }) });
      expect(response.status).toBe(200);
    }
  }
  return { discord, twitch, env: testEnv, invocation, command, read, route, owner, rows, link, tracked, intercept(value) { intercept = value; } };
}
describe("installed health command and durable state/event integration", () => {
  it("commits offline, exposes bot health, and appends its correlated v2 event through the native alarm", async () => {
    const f = await fixture(), input = f.invocation();
    expect((await f.command(input)).output.message).toBe("Health saved and impact queued.");
    expect((await f.read()).value).toBe(85);
    const owner = await f.owner(); await runInDurableObject(owner, (instance, state) => { instance.env = f.env; state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0"); return instance.alarm(); });
    const route = await f.route(), stream = f.tracked("DURABLE_EVENT_STREAM", env.DURABLE_EVENT_STREAM.idFromName(route.streamRouteId));
    const events = await runInDurableObject(stream, (_i, state) => state.storage.sql.exec("SELECT payload_json, state_event_json FROM durable_event_stream_events").toArray());
    expect(events).toHaveLength(1); expect(JSON.parse(events[0].payload_json)).toMatchObject({ operation: "damage", before: 100, after: 85, requestedAmount: 15, appliedAmount: 15 });
    expect(JSON.parse(events[0].state_event_json)).toMatchObject({ ...(await f.read()).stateEvent, operationId: expect.stringMatching(/^seo1\./) });
    await evictDurableObject(owner); expect((await f.read()).value).toBe(85);
  });
  it.each([undefined, false, "TRUE", "false"])("rejects fresh acceptance when the switch is not literal true (%s)", async (flag) => {
    const f = await fixture(); f.env.STATE_EVENT_OPERATIONS_ENABLED = flag;
    await expect(f.command(f.invocation())).rejects.toMatchObject({ code: "state_event_service_unavailable" }); expect((await f.read()).value).toBe(100);
    expect(await f.rows("state_event_outbox")).toEqual([]);
  });
  it("recovers a lost acceptance reply without a second mutation or cooldown, even after disabling both switches", async () => {
    const f = await fixture(), input = f.invocation(); let lost = false;
    f.intercept(async (kind, url, _init, send) => {
      const response = await send(); if (kind === "CONFIG" && String(url).endsWith("command/invoke") && !lost) { lost = true; throw Error("acceptance reply lost"); } return response;
    });
    await expect(f.command(input)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    f.intercept(null); f.env.STATE_EVENT_OPERATIONS_ENABLED = "false"; f.env.DURABLE_EVENT_STREAMS_ENABLED = "false";
    expect((await f.command(input)).output.message).toBe("Health saved and impact queued.");
    expect((await f.read()).value).toBe(85); expect(await f.rows("state_event_outbox")).toHaveLength(1);
  });
  it("preserves moderator authorization and amount validation without changing health", async () => {
    const f = await fixture(); await expect(f.command(f.invocation(), false)).rejects.toMatchObject({ code: "action_forbidden" });
    await expect(f.command(f.invocation(f.twitch, { operation: "damage", amount: 0 }))).rejects.toMatchObject({ code: "action_arguments_invalid" });
    expect((await f.read()).value).toBe(100);
  });
  it.each([true, false])("uses directional defaults for both origins (symmetric=%s)", async (symmetric) => {
    const f = await fixture(); await f.link({ symmetric });
    await f.command(f.invocation(f.discord, { operation: "damage", amount: 20 }));
    await f.command(f.invocation(f.twitch, { operation: "damage", amount: 10 }));
    expect((await f.read(f.discord)).value).toBe(symmetric ? 70 : 80);
    expect((await f.read(f.twitch)).value).toBe(symmetric ? 70 : 90);
  });
  it("rejects source capacity before mutation and keeps the requested operation recoverable", async () => {
    const f = await fixture(); await f.read();
    await runInDurableObject(await f.owner(), (_i, state) => state.storage.sql.exec("UPDATE state_event_outbox_budget SET rows = 100"));
    const input = f.invocation(); await expect(f.command(input)).rejects.toMatchObject({ code: "state_event_outbox_capacity" }); expect((await f.read()).value).toBe(100);
    await runInDurableObject(await f.owner(), (_i, state) => state.storage.sql.exec("UPDATE state_event_outbox_budget SET rows = 0"));
    await f.command(input); expect((await f.read()).value).toBe(85);
  });
  it("returns an original result after later healing without repeating the earlier damage", async () => {
    const f = await fixture(), input = f.invocation(); await f.command(input);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1100);
    await f.command(f.invocation(f.discord, { operation: "heal", amount: 10 }));
    await f.command(input); expect((await f.read()).value).toBe(95);
    expect((await f.read()).stateEvent.operationSequence).toBe(2);
    await expect(f.command({ ...input, args: { operation: "damage", amount: 20 } })).rejects.toMatchObject({ code: "state_event_source_conflict" });
    clock.mockRestore();
  });
  it("enforces one-second cooldown for new sources and preserves clamped no-op receipts", async () => {
    const f = await fixture(), input = f.invocation(f.discord, { operation: "heal" }); await f.command(input);
    const first = await f.read(); expect(first).toMatchObject({ value: 100, stateEvent: { operationSequence: 1 } });
    await f.command(input); expect((await f.read()).stateEvent).toEqual(first.stateEvent);
    await expect(f.command(f.invocation())).rejects.toMatchObject({ code: "action_cooldown_active" });
  });
});
