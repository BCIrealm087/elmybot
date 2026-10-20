import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { cleanupDeliveryFixtures } from "./helpers/state-event-delivery-fixture.js";
import { closeCostMeters, measuredDeliveryFixture } from "./helpers/state-event-cost-meter.js";
import { defineDurableEventStream, defineFeature, frameworkApiVersion } from "../src/framework/index.js";
import { durableEventRouteId } from "../src/durable-events/contract.js";
import { createDurableEventStreamRuntime } from "../src/durable-events/publisher.js";
import { registerLocalStateQueryWatcher, registerShareableStateQueryWatcher } from "../src/state-querying/watcher-client.js";
import { drainStateQueryNotifications } from "../src/state-querying/source-notifications.js";
import { feature as healthFeature } from "../packages/features/fun-health/src/feature.js";
import { executeAction, createActionRegistry } from "../src/actions/registry.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";

const tick = (clock, ms = 1100) => clock.mockReturnValue(Date.now() + ms);
const emptyWork = (value) => {
  expect(value).toMatchObject({ rowsRead: 0, rowsWritten: 0, requests: 0, alarms: { writes: 0, invocations: 0 } });
};
function baselineFeature(shared) {
  return defineFeature({ id: "cost.baseline", apiVersion: frameworkApiVersion, description: "Independent event baseline for cost measurements",
    eventStreams: [defineDurableEventStream({ id: "updates", version: 1, label: "Updates", description: "Same small integer payload",
      platforms: ["discord", "twitch"], scope: { kind: shared ? "effective_shareable" : "group_local" }, access: { kind: "operator_grant" },
      payload: { schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } } })] });
}
async function baseline(f, { featureId = "cost.baseline", streamId = "updates", version = 1, payload = { value: 1 } } = {}) {
  const baseGrant = f.grant(), descriptor = { ...baseGrant.grant.route.descriptor, featureId, streamId, version };
  const routeId = await durableEventRouteId(descriptor), route = { ...f.route, streamRouteId: routeId };
  const grant = { ...baseGrant, grant: { ...baseGrant.grant, stream: { feature: featureId, stream: streamId, version },
    route: { ...baseGrant.grant.route, routeId, descriptor } } };
  grant.grant.expiresAtMs = Date.now() + 86400_000;
  await f.connect(route, grant);
  const stream = env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(routeId));
  async function state() {
    const shared = f.owner.kind === "effective_shareable", binding = shared ? f.testEnv.SHAREABLE_STATE_REALM : f.testEnv.CONFIG;
    const url = shared ? "/internal/shareable-state/realm/increment" : "/internal/framework/state/increment";
    const body = shared ? { realm: f.route.realm, namespace: f.route.namespace, storage: { key: "health", amount: 1 } }
      : { featureId: "test.delivery", key: "health", amount: 1 };
    const response = await binding.get(binding.idFromName(f.route.key)).fetch(`https://state${url}`, { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) throw Error(`Baseline state failed: ${await response.text()}`);
    await response.json();
  }
  async function event() {
    const runtime = createDurableEventStreamRuntime(f.testEnv, f.invocation(), f.registry);
    const handle = f.owner.kind === "group_local" ? await runtime.local(featureId, streamId) : await runtime.current(featureId, "twitch", streamId);
    await handle.publish(payload);
    await f.meter.handler(stream, "DURABLE_EVENT_STREAM", "ack", () => runInDurableObject(stream, (instance, state) => {
      const event = state.storage.sql.exec("SELECT cursor FROM durable_event_stream_events ORDER BY sequence LIMIT 1").one();
      return instance.webSocketMessage(state.getWebSockets()[0], JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: event.cursor }));
    }));
  }
  return { state, event };
}

function healthCommand(f) {
  let source = 0;
  return (operation = "damage", amount = 15) => {
    const input = createCommandInvocation({ kind: "fun.health.impact.v2", args: { operation, amount }, sourceCreatedAtMs: Date.now(),
      sourceEventId: `discord:health-cost:${++source}`,
      origin: { group: f.group, actor: { platform: "discord", id: "moderator", claims: [] } } });
    return executeAction(createActionRegistry(f.registry.actions), input,
      { ...createFeatureServiceRuntime(f.testEnv, input, f.registry), authorize: async () => true });
  };
}

afterEach(async () => { vi.restoreAllMocks(); await closeCostMeters(); await cleanupDeliveryFixtures(); });
describe("measured state/event operation budgets", () => {
  it("calibrates native SQL counters for indexes, triggers and deletes", async ({ task }) => {
    const f = await measuredDeliveryFixture();
    const result = await runInDurableObject(f.ownerStub, (_i, state) => {
      state.storage.sql.exec(`CREATE TABLE cost_probe (id INTEGER PRIMARY KEY, n INTEGER); CREATE INDEX cost_probe_n ON cost_probe(n);
        CREATE TABLE cost_probe_count (n INTEGER); INSERT INTO cost_probe_count VALUES (0);
        CREATE TRIGGER cost_probe_insert AFTER INSERT ON cost_probe BEGIN UPDATE cost_probe_count SET n = n + CASE WHEN 1 THEN 1 ELSE 0 END; SELECT ';'; END;`);
      const insert = state.storage.sql.exec("INSERT INTO cost_probe VALUES (1, 7)");
      const written = insert.rowsWritten;
      const deletion = state.storage.sql.exec("DELETE FROM cost_probe WHERE id = 1");
      const deleted = deletion.rowsWritten;
      const batch = state.storage.sql.exec("INSERT INTO cost_probe VALUES (2, 8); INSERT INTO cost_probe VALUES (3, 9)");
      return { written, deleted, batchWritten: batch.rowsWritten };
    });
    expect(result.written).toBeGreaterThanOrEqual(3); expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.batchWritten).toBe(3);
    const measured = await f.meter.phase(() => runInDurableObject(f.ownerStub, (instance) => {
      instance.state.storage.sql.exec("INSERT INTO cost_probe VALUES (4, 10); /* batch; */ INSERT INTO cost_probe VALUES (5, 11)").toArray();
    }));
    expect(measured.rowsWritten).toBe(6);
    task.meta.stateEventCost = { calibration: { ...result, measuredBatchWritten: measured.rowsWritten } };
  });
  it.for([false, true])("records actual command, duplicate and offline-delivery work (shared=%s)", async (shared, { task }) => {
    const f = await measuredDeliveryFixture({ shared }), input = f.invocation();
    const accepted = await f.meter.phase(() => f.commit(input));
    const duplicate = await f.meter.phase(() => f.commit(input));
    const append = await f.meter.phase(() => f.drain());
    expect(accepted.rowsWritten).toBeGreaterThan(0); expect(append.rowsWritten).toBeGreaterThan(0);
    expect(accepted.rowsWritten).toBeLessThanOrEqual(shared ? 120 : 95);
    expect(append.rowsWritten).toBeLessThanOrEqual(shared ? 80 : 70);
    expect(duplicate.rowsWritten).toBe(0);
    expect(duplicate.rowsRead).toBeLessThanOrEqual(64); expect(duplicate.requests).toBe(1); expect(duplicate.alarms.writes).toBe(0);
    task.meta.stateEventCost = { shared, accepted, duplicate, append };
  });
  it.for([false, true])("does not wake confirmed offline events when more commands arrive (shared=%s)", async (shared, { task }) => {
    const f = await measuredDeliveryFixture({ shared });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let count = 0; count < 25; count++) {
      await f.commit(); await f.drain(); clock.mockReturnValue(Date.now() + 1100);
    }
    const next = await f.meter.phase(() => f.commit());
    const rows = await f.rows(f.ownerStub, "state_event_outbox");
    expect(rows.filter((row) => row.state === "appended")).toHaveLength(25);
    expect(rows.filter((row) => row.state === "appended" && row.next_wakeup_at_ms !== row.deadline_ms)).toEqual([]);
    expect(rows.filter((row) => row.state === "appended").every((row) => row.attempts === 1)).toBe(true);
    expect(next.rowsWritten).toBeLessThanOrEqual(shared ? 52 : 45);
    task.meta.stateEventCost = { shared, acceptedWith25Appended: next };
  }, 15000);
  it.for([false, true])("compares independent primitives with the complete online cycle (shared=%s)", async (shared, { task }) => {
    const f = await measuredDeliveryFixture({ shared, extraFeatures: [baselineFeature(shared)] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const independent = await baseline(f); await independent.state(); await independent.event();
    const stateOnly = await f.meter.phase(() => independent.state());
    const eventOnly = await f.meter.phase(() => independent.event());
    await f.connect();
    const coldAccept = await f.meter.phase(() => f.commit());
    const append = await f.meter.phase(() => f.drain());
    const ackAndCleanup = await f.meter.phase(async () => { await f.ack(); tick(clock); await f.streamAlarm(); await f.drain(false); });
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    tick(clock);
    const warmOnline = await f.meter.phase(async () => { await f.commit(); await f.drain(); await f.ack(); tick(clock); await f.streamAlarm(); await f.drain(false); });
    task.meta.stateEventCost = { shared, stateOnly, eventOnly, coldAccept, append, ackAndCleanup, warmOnline };
    expect(warmOnline.rowsWritten).toBeLessThanOrEqual(shared ? 135 : 120);
    expect(warmOnline.requests).toBeLessThanOrEqual(shared ? 20 : 12);
    expect(warmOnline.rowsRead).toBeLessThanOrEqual(5000);
    // Step 2 writes repaired overdue/claim deadlines and reconciles completion;
    // account for those finite writes instead of preserving stale alarms.
    expect(warmOnline.alarms.writes).toBeLessThanOrEqual(16);
    expect(stateOnly.requests).toBe(1); expect(eventOnly.incomingMessages).toBe(1);
  });
  it.for([false, true])("bounds a real six-stream admission burst and relay batch (shared=%s)", async (shared, { task }) => {
    const f = await measuredDeliveryFixture({ shared, streams: 6 });
    const accepted = await f.meter.phase(() => Promise.all(Array.from({ length: 6 }, (_, index) => f.commit(f.invocation(index)))));
    const drain = await f.meter.phase(async () => { for (let index = 0; index < 6; index++) await f.drain(); });
    task.meta.stateEventCost = { shared, burstSize: 6, accepted, drain };
    expect(drain.alarms.invocations).toBe(6);
    expect(drain.peakAppends).toBeLessThanOrEqual(1);
    expect(drain.peakAppends).toBeGreaterThan(0);
    const rows = await f.rows(f.ownerStub, "state_event_outbox");
    expect(rows).toHaveLength(6); expect(rows.every((row) => row.state === "appended" && row.attempts === 1)).toBe(true);
    expect(accepted.rowsWritten).toBeLessThanOrEqual(shared ? 440 : 380);
    expect(drain.rowsWritten).toBeLessThanOrEqual(shared ? 440 : 380);
    expect(drain.requests).toBeLessThanOrEqual(shared ? 32 : 24);
  });
  it("measures installed health v2, legacy v1 delivery and clamped no-ops", async ({ task }) => {
    const f = await measuredDeliveryFixture({ shared: true, extraFeatures: [healthFeature],
      featureStream: { featureId: "fun.health", streamId: "impacts", version: 2 } });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const legacy = await baseline(f, { featureId: "fun.health", streamId: "impacts", payload: { operation: "damage", amount: 15 } });
    await legacy.event();
    const eventOnly = await f.meter.phase(() => legacy.event());
    async function state(operation) {
      const response = await f.testEnv.SHAREABLE_STATE_REALM.get(f.testEnv.SHAREABLE_STATE_REALM.idFromName(f.route.key)).fetch("https://realm/internal/shareable-state/realm/bounded-counter", {
        method: "POST", body: JSON.stringify({ realm: f.route.realm, namespace: f.route.namespace,
          storage: { name: "health", subject: "current", min: 0, max: 100, initial: 100, operation, amount: 15, ...(operation === "set" ? { value: 100 } : {}) } }) });
      if (!response.ok) throw Error(await response.text()); await response.json();
    }
    await state("get");
    const stateOnly = await f.meter.phase(() => state("decrement")); await state("set");
    await f.connect();
    const command = healthCommand(f);
    const coldAccept = await f.meter.phase(() => command());
    await f.drain(); await f.ack(); tick(clock); await f.streamAlarm(); await f.drain(false); tick(clock);
    const cycle = async (operation, amount) => { await command(operation, amount); await f.drain(); await f.ack(); tick(clock); await f.streamAlarm(); await f.drain(false); };
    const warmOnline = await f.meter.phase(() => cycle("heal", 15)); tick(clock);
    const clampedNoop = await f.meter.phase(() => cycle("heal", 100));
    expect(warmOnline.rowsWritten).toBeLessThanOrEqual(140); expect(warmOnline.requests).toBeLessThanOrEqual(20);
    expect(clampedNoop.rowsWritten).toBeLessThanOrEqual(140);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    task.meta.stateEventCost = { installedHealth: true, shared: true, eventOnly, stateOnly, coldAccept, warmOnline, clampedNoop };
  });
  it.for([{ shared: false }, { shared: true }, { shared: true, installedHealth: true }])(
    "measures immediate publication through ACK and cleanup (%j)", async ({ shared, installedHealth = false }, { task }) => {
      const f = await measuredDeliveryFixture({ shared, immediate: true, ...(installedHealth ? {
        extraFeatures: [healthFeature], featureStream: { featureId: "fun.health", streamId: "impacts", version: 2 }
      } : {}) });
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      await f.connect();
      const command = installedHealth ? healthCommand(f) : () => f.commit();
      const cycle = async (operation, amount) => {
        await command(operation, amount); await f.meter.settle();
        expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ state: "appended", destination_confirmed: 1, lease_token: null });
        expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
        await f.ack(); tick(clock); await f.streamAlarm(); await f.meter.settle();
        expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
        expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
      };
      const coldOnline = await f.meter.phase(() => cycle()); tick(clock);
      const warmOnline = await f.meter.phase(() => cycle());
      expect(coldOnline.rowsWritten).toBeLessThanOrEqual(shared ? 210 : 180);
      expect(warmOnline.rowsWritten).toBeLessThanOrEqual(shared ? 125 : 112);
      expect(warmOnline.requests).toBeLessThanOrEqual(shared ? 15 : 9);
      expect(warmOnline.rowsRead).toBeLessThanOrEqual(5000);
      expect(warmOnline.alarms.writes).toBeLessThanOrEqual(14);
      expect(warmOnline.alarms.invocations).toBe(1);
      expect(warmOnline.incomingMessages).toBe(1);
      let clampedNoop;
      if (installedHealth) {
        tick(clock); await cycle("heal", 100); tick(clock);
        clampedNoop = await f.meter.phase(() => cycle("heal", 100));
        expect(clampedNoop.rowsWritten).toBeLessThanOrEqual(125);
      }
      task.meta.stateEventCost = { immediate: true, installedHealth, shared, coldOnline, warmOnline, ...(clampedNoop ? { clampedNoop } : {}) };
    });
  it("keeps command recovery and new admission independent of ten thousand historical receipts", async ({ task }) => {
    const f = await measuredDeliveryFixture(); const input = f.invocation(); await f.commit(input); await f.drain();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1100);
    const before = await f.meter.phase(() => f.commit()); await f.drain();
    const duplicateBefore = await f.meter.phase(() => f.commit(input));
    await runInDurableObject(f.ownerStub, (_i, state) => {
      state.storage.sql.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 10000)
        INSERT INTO state_event_records SELECT 'history:' || i, '{}', 2, NULL, 0, 0, ? FROM n`, Date.now() + 7_200_000);
      state.storage.sql.exec("UPDATE state_event_budget SET rows = rows + 10000, metadata_bytes = metadata_bytes + 20000");
    });
    tick(clock);
    const after = await f.meter.phase(() => f.commit());
    const duplicateAfter = await f.meter.phase(() => f.commit(input));
    expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 100);
    expect(after.rowsWritten).toBeLessThanOrEqual(before.rowsWritten + 20);
    expect(duplicateAfter.rowsRead).toBe(duplicateBefore.rowsRead);
    expect(duplicateAfter.rowsWritten).toBe(0);
    task.meta.stateEventCost = { historyRows: 10000, before, after, duplicateBefore, duplicateAfter };
  });
  it.for([false, true])("measures delayed receipt deletes as well as immediate delivery (shared=%s)", async (shared, { task }) => {
    const f = await measuredDeliveryFixture({ shared, extraFeatures: [baselineFeature(shared)] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const independent = await baseline(f), grant = f.grant(); grant.grant.expiresAtMs = Date.now() + 86400_000;
    await f.connect(f.route, grant);
    let warmAccept, warmEvent;
    for (let count = 0; count < 10; count++) {
      warmEvent = await f.meter.phase(() => independent.event());
      warmAccept = await f.meter.phase(() => f.commit());
      await f.drain(); await f.ack(); tick(clock); await f.streamAlarm(); await f.drain(false); tick(clock);
    }
    tick(clock, 7_200_001);
    const sourcePrune = await f.meter.phase(() => f.commit());
    const destinationPrune = await f.meter.phase(() => f.streamAlarm());
    const eventPrune = await f.meter.phase(() => independent.event());
    const sourceExtra = sourcePrune.rowsWritten - warmAccept.rowsWritten;
    const combinedRowsPerOperation = (sourceExtra + destinationPrune.rowsWritten + destinationPrune.alarms.writes + destinationPrune.alarms.deletes) / 10;
    const eventRowsPerOperation = (eventPrune.rowsWritten - warmEvent.rowsWritten) / 10;
    expect(sourceExtra).toBeGreaterThan(0); expect(destinationPrune.deleteRowsWritten).toBeGreaterThan(0);
    expect(combinedRowsPerOperation).toBeLessThanOrEqual(8);
    expect(eventRowsPerOperation).toBeLessThanOrEqual(3);
    task.meta.stateEventCost = { shared, retiredOperations: 10, warmAccept, warmEvent, sourcePrune, destinationPrune, eventPrune,
      cleanupAllowance: { combinedRowsPerOperation, eventRowsPerOperation } };
  }, 15000);
  it("performs no offline polling across thirty days and clears finite retained work", async ({ task }) => {
    const f = await measuredDeliveryFixture(); let accepted;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const accept = await f.meter.phase(async () => { accepted = await f.commit(); });
    const append = await f.meter.phase(() => f.drain());
    const leaseWake = await f.meter.phase(() => f.meter.runUntil(Date.now() + 31_000, clock));
    expect(leaseWake.requests).toBe(0); expect(leaseWake.alarms.invocations).toBeLessThanOrEqual(1);
    const quiet = await f.meter.phase(() => f.meter.runUntil(accepted.expiresAtMs - 1, clock)); emptyWork(quiet);
    const expiry = await f.meter.phase(() => f.meter.runUntil(accepted.committedAtMs + 30 * 86400_000, clock));
    expect(expiry.alarms.invocations).toBeLessThanOrEqual(4);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    expect(await f.rows(f.streamStub, "state_event_destination_records")).toEqual([]);
    const anotherMonth = await f.meter.phase(() => f.meter.runUntil(Date.now() + 30 * 86400_000, clock)); emptyWork(anotherMonth);
    task.meta.stateEventCost = { offlineDays: 30, accept, append, leaseWake, quiet, expiry, anotherMonth };
  });
  it("bounds both physical receipt ledgers during a large combined-stream cleanup", async ({ task }) => {
    const f = await measuredDeliveryFixture(); await f.commit(); await f.drain();
    await runInDurableObject(f.streamStub, (_i, state) => {
      const expired = Date.now() - 1;
      state.storage.sql.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 1000)
        INSERT INTO durable_event_stream_receipts SELECT 'cost-event:' || i, 'fingerprint', 'cost-cursor:' || i, i + 1, ?, ?, 2 FROM n`, expired - 7_200_000, expired);
      state.storage.sql.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 1000)
        INSERT INTO state_event_destination_records SELECT 'cost-op:' || i, 'cost-event:' || i, 'fingerprint', '{"state":"gap"}', '[]', ?, 2, i + 1 FROM n`, expired);
      state.storage.sql.exec("UPDATE state_event_destination_budget SET rows = rows + 1000, bytes = bytes + 2000");
    });
    const cleanup = await f.meter.phase(() => f.streamAlarm());
    task.meta.stateEventCost = { syntheticExpiredReceiptPairs: 1000, cleanup };
    expect(await f.rows(f.streamStub, "durable_event_stream_receipts")).toHaveLength(981);
    expect(await f.rows(f.streamStub, "state_event_destination_records")).toHaveLength(981);
    expect(cleanup.rowsWritten).toBeLessThanOrEqual(80);
    expect((await f.rows(f.streamStub, "state_event_destination_budget"))[0].rows).toBe(1962);
  });
  it("parks capacity pressure until a useful reconnect and drains without periodic probes", async ({ task }) => {
    const f = await measuredDeliveryFixture(); const accepted = await f.commit();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
    const parked = await f.meter.phase(() => f.drain());
    const leaseWake = await f.meter.phase(() => f.meter.runUntil(Date.now() + 31_000, clock)); expect(leaseWake.requests).toBe(0);
    const quiet = await f.meter.phase(() => f.meter.runUntil(accepted.expiresAtMs - 60_000, clock)); emptyWork(quiet);
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 0"));
    const reconnect = await f.meter.phase(async () => { await f.connect(); tick(clock); await f.streamAlarm(); await f.drain(false); });
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].state).toBe("appended");
    task.meta.stateEventCost = { pressure: "synthetic full retained-count boundary", parked, leaseWake, quiet, reconnect };
  });
  it("caps a sustained destination outage and makes the expiry outcome explicit", async ({ task }) => {
    const f = await measuredDeliveryFixture(); const accepted = await f.commit();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now()); let calls = 0;
    f.intercept(async (role, url, _init, send) => {
      if (role === "DURABLE_EVENT_STREAM" && String(url).endsWith("combined/append")) { calls++; return Response.json({ code: "durable_event_service_unavailable" }, { status: 503 }); }
      return send();
    });
    const outage = await f.meter.phase(async () => {
      for (let count = 0; count < 12; count++) {
        await f.drain(count === 0);
        const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
        if (count < 11) clock.mockReturnValue(row.next_wakeup_at_ms);
      }
    });
    expect(calls).toBe(12);
    const leaseWake = await f.meter.phase(() => f.meter.runUntil(Date.now() + 31_000, clock)); expect(leaseWake.requests).toBe(0);
    const quiet = await f.meter.phase(() => f.meter.runUntil(accepted.expiresAtMs - 1, clock)); emptyWork(quiet);
    const expiry = await f.meter.phase(() => f.meter.runUntil(accepted.expiresAtMs + 86400_000, clock));
    expect(calls).toBe(13);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row).toMatchObject({ state: "gap_pending", next_wakeup_at_ms: null, attempts: 13 });
    expect(JSON.parse(row.intent_json)).not.toHaveProperty("payload");
    task.meta.stateEventCost = { outage, leaseWake, quiet, expiry, attempts: calls };
  });
  it.for([false, true])("counts existing watcher mutation and delivery work separately (shared=%s)", async (shared, { task }) => {
    const f = await measuredDeliveryFixture({ shared }); await f.commit(); await f.drain();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1100);
    const withoutWatcher = await f.meter.phase(() => f.commit());
    await f.drain();
    const input = { featureId: "test.delivery", watcherId: "cost-watch", target: f.group, expectedRevision: 2, leaseSeconds: 300 };
    if (shared) await registerShareableStateQueryWatcher(f.testEnv, { ...input, realm: f.route.realm, namespaceId: "health" });
    else await registerLocalStateQueryWatcher(f.testEnv, { ...input, sourceGroup: f.group });
    tick(clock);
    const withWatcher = await f.meter.phase(() => f.commit());
    const notify = await f.meter.phase(() => runInDurableObject(f.ownerStub, (instance) => drainStateQueryNotifications(instance.state, f.testEnv)));
    expect(notify.requests).toBe(1);
    expect(withWatcher.rowsWritten).toBeGreaterThan(withoutWatcher.rowsWritten);
    task.meta.stateEventCost = { shared, watcherCount: 1, withoutWatcher, withWatcher, notify };
  });
  it("scales independent groups with traffic rather than discovering idle owners", async ({ task }) => {
    const measurements = [];
    for (let group = 0; group < 12; group++) {
      const f = await measuredDeliveryFixture();
      const accept = await f.meter.phase(() => f.commit());
      expect(accept.requests).toBe(2); expect(accept.rowsWritten).toBeLessThanOrEqual(95);
      measurements.push({ rowsRead: accept.rowsRead, rowsWritten: accept.rowsWritten, requests: accept.requests });
    }
    expect(new Set(measurements.map((entry) => entry.rowsRead)).size).toBe(1);
    task.meta.stateEventCost = { groups: 12, measurements };
  });
});
