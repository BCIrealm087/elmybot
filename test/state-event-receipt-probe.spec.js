import { afterEach, describe, expect, it, vi } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { closeCostMeters, measuredDeliveryFixture } from "./helpers/state-event-cost-meter.js";
import { cleanupDeliveryFixtures } from "./helpers/state-event-delivery-fixture.js";
import { stateEventRequestGuard } from "./helpers/state-event-request-guard.js";
import { deliveryReceiptFingerprint } from "../src/state-events/delivery-snapshot.js";
import { drainStateEventRelay } from "../src/state-events/delivery-source.js";
import { STATE_EVENT_WORK_LIMITS } from "../src/state-events/relay-work-budget.js";

const alarm = (f) => f.meter.handler(f.ownerStub, f.ownerRole, "alarm", () =>
  runInDurableObject(f.ownerStub, (instance) => instance.alarm()));
const first = async (f) => (await f.rows(f.ownerStub, "state_event_outbox"))[0];
async function fixture(options) {
  const f = await measuredDeliveryFixture(options);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  return { ...f, clock };
}
async function input(f) {
  const intent = JSON.parse((await first(f)).intent_json);
  return { owner: f.owner, routeId: f.route.streamRouteId, operationId: intent.operationId,
    eventId: intent.eventId, fingerprint: await deliveryReceiptFingerprint(intent) };
}
afterEach(async () => { vi.restoreAllMocks(); await closeCostMeters(); await cleanupDeliveryFixtures(); });

describe("finite early receipt reconciliation", () => {
  it.for([false, true])("recovers a lost reply in the original pass, clears authority and preserves identity (shared=%s)", async (shared, { task }) => {
    const f = await fixture({ shared }), invocation = f.invocation(), accepted = await f.commit(invocation);
    const guard = stateEventRequestGuard({ calls: 20, depth: 2 });
    let probes = 0;
    f.intercept((_kind, url, _init, send) => guard.request(new URL(url).pathname, async () => {
      if (String(url).endsWith("combined/probe")) probes++;
      const response = await send();
      if (String(url).endsWith("combined/append")) throw Error("reply lost after durable append");
      return response;
    }));
    const measured = await f.meter.phase(() => f.drain());
    expect(await first(f)).toMatchObject({ state: "appended", attempts: 1, uncertain: 0, probe_state: 2, lease_token: null });
    expect(probes).toBe(1); expect(guard.rejected).toBe(0); expect(guard.total).toBeLessThanOrEqual(20);
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBe(accepted.expiresAtMs);
    const events = await f.rows(f.streamStub, "durable_event_stream_events");
    expect(events).toHaveLength(1); expect(events[0].event_id).toBe(accepted.eventId);
    expect(events[0].accepted_at_ms).toBe(Date.now());
    expect((await f.rows(f.streamStub, "state_event_destination_records"))[0].expires_at_ms).not.toBeNull();
    if (shared) expect(await f.rows(f.registryStub, "state_event_commit_barriers")).toEqual([]);
    expect(await f.commit(invocation)).toEqual(accepted);
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
    task.meta.stateEventCost = { receiptProbeRecovery: true, shared, measured };
  });

  it.each([false, true])("an absent probe cannot fence a delayed original append or unblock its successor (shared=%s)", async (shared) => {
    const f = await fixture({ shared }), accepted = await f.commit();
    let delayed;
    f.intercept((_kind, url, init, send) => {
      if (String(url).endsWith("combined/append")) { delayed = { url, init }; throw Error("original call delayed"); }
      return send();
    });
    await f.drain(); const uncertain = await first(f);
    expect(uncertain).toMatchObject({ state: "pending", probe_state: 2, uncertain: 1, attempts: 1 });
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBe(uncertain.lease_until_ms);
    expect(await f.rows(f.streamStub, "state_event_destination_records")).toEqual([]);
    f.intercept(null);
    const response = await f.testEnv.DURABLE_EVENT_STREAM.get(f.streamStub.id).fetch(delayed.url, delayed.init);
    expect(response.ok).toBe(true);
    f.clock.mockReturnValue(Date.now() + 1100); const next = await f.commit();
    await alarm(f);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
    expect((await f.rows(f.ownerStub, "state_event_outbox")).find((r) => r.operation_id === accepted.operationId))
      .toMatchObject({ lease_token: uncertain.lease_token, uncertain: 1, attempts: 1 });
    await f.meter.runUntil(uncertain.lease_until_ms + 5000, f.clock);
    const events = (await f.rows(f.streamStub, "durable_event_stream_events")).sort((a, b) => a.sequence - b.sequence);
    expect(events.map((e) => e.event_id)).toEqual([accepted.eventId, next.eventId]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it.each([false, true])("defers an exhausted invocation's single probe to its durable continuation (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); await f.commit();
    let probes = 0;
    f.intercept(async (_kind, url, _init, send) => {
      if (String(url).endsWith("combined/probe")) probes++;
      const response = await send();
      if (String(url).endsWith("combined/append")) { f.clock.mockReturnValue(Date.now() + 5001); throw Error("reply timed out"); }
      return response;
    });
    await f.drain(); const deferred = await first(f);
    expect(deferred).toMatchObject({ probe_state: 1, uncertain: 1, attempts: 1 });
    expect(deferred.next_wakeup_at_ms).toBe(Date.now() + STATE_EVENT_WORK_LIMITS.continuationMs);
    expect(deferred.probe_fallback_ms).toBe(deferred.lease_until_ms); expect(probes).toBe(0);
    f.clock.mockReturnValue(deferred.next_wakeup_at_ms);
    await alarm(f);
    expect(await first(f)).toMatchObject({ state: "appended", probe_state: 2, probe_fallback_ms: null, attempts: 1, uncertain: 0, lease_token: null });
    expect(probes).toBe(1);
  });

  it.each([false, true])("spends failed probes durably across restart and keeps normal fencing recovery (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); const accepted = await f.commit(); let probes = 0;
    f.intercept(async (_kind, url, _init, send) => {
      if (String(url).endsWith("/probe")) { probes++; throw Error("probe unavailable"); }
      const response = await send();
      if (String(url).endsWith("combined/append")) throw Error("append reply lost");
      return response;
    });
    await f.drain(); const row = await first(f);
    expect(row).toMatchObject({ probe_state: 2, uncertain: 1, attempts: 1 });
    expect(row.next_wakeup_at_ms).toBe(row.lease_until_ms);
    await evictDurableObject(f.ownerStub);
    expect(await first(f)).toMatchObject({ probe_state: 2, lease_token: row.lease_token, next_wakeup_at_ms: row.lease_until_ms });
    expect(await runInDurableObject(f.ownerStub, (_i, state) => state.storage.getAlarm())).toBe(row.lease_until_ms);
    // Duplicate useful wakeups cannot recreate a probe or shorten this lease.
    for (let i = 1; i <= 3; i++) await f.source("wake", { version: i });
    expect(await first(f)).toMatchObject({ probe_state: 2, lease_token: row.lease_token, next_wakeup_at_ms: row.lease_until_ms });
    f.intercept(null); f.clock.mockReturnValue(row.lease_until_ms);
    await runInDurableObject(f.ownerStub, (instance) => drainStateEventRelay(instance.state, f.testEnv));
    expect(await first(f)).toMatchObject({ state: "appended", lease_token: null, uncertain: 0, probe_state: 2 });
    expect(probes).toBe(1);
    expect((await f.rows(f.streamStub, "durable_event_stream_events"))[0].event_id).toBe(accepted.eventId);
    if (shared) expect(await f.rows(f.registryStub, "state_event_commit_barriers")).toEqual([]);
  });

  it.each(["fingerprint", "eventId", "operationId", "sequence"])("rejects a mismatched or malformed positive %s without clearing uncertainty", async (field) => {
    const f = await fixture({ shared: true }); await f.commit();
    f.intercept(async (_kind, url, _init, send) => {
      const response = await send();
      if (String(url).endsWith("combined/append")) throw Error("lost reply");
      if (String(url).endsWith("combined/probe")) {
        const data = await response.json();
        if (field === "sequence") data.outcome.sequence = 0;
        else if (field === "operationId") data.outcome.operationId = `seo1.${"x".repeat(43)}`;
        else data[field] = field === "eventId" ? `dev1.${"x".repeat(43)}` : "f".repeat(64);
        return Response.json(data);
      }
      return response;
    });
    await f.drain(); const row = await first(f);
    expect(row).toMatchObject({ probe_state: 2, state: "pending", uncertain: 1, attempts: 1 });
    expect(row.next_wakeup_at_ms).toBe(row.lease_until_ms);
    expect(await f.rows(f.registryStub, "state_event_commit_barriers")).toHaveLength(1);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
  });

  it("coalesces competing deferred probes without another publication attempt", async () => {
    const f = await fixture(); await f.commit(); let probes = 0;
    f.intercept(async (_kind, url, _init, send) => {
      if (String(url).endsWith("combined/probe")) {
        probes++; await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const response = await send();
      if (String(url).endsWith("combined/append")) { f.clock.mockReturnValue(Date.now() + 5001); throw Error("timeout"); }
      return response;
    });
    await f.drain(); const row = await first(f); f.clock.mockReturnValue(row.next_wakeup_at_ms);
    await runInDurableObject(f.ownerStub, async (instance) => {
      await Promise.all([drainStateEventRelay(instance.state, f.testEnv), drainStateEventRelay(instance.state, f.testEnv)]);
    });
    expect(probes).toBe(1);
    expect(await first(f)).toMatchObject({ state: "appended", probe_state: 2, attempts: 1, lease_token: null });
  });

  it("does not overwrite a coordinated reset with an in-flight positive probe", async () => {
    const f = await fixture(); const accepted = await f.commit(); let reset = false;
    f.intercept(async (_kind, url, _init, send) => {
      if (String(url).endsWith("combined/probe") && !reset) {
        reset = true; expect((await f.streamCall("grants/issue", f.grant(true))).status).toBe(201);
      }
      const response = await send();
      if (String(url).endsWith("combined/append")) throw Error("lost reply");
      return response;
    });
    await f.drain(); const row = await first(f);
    expect(row).toMatchObject({ operation_id: accepted.operationId, state: "reset_discarded", probe_state: 2, uncertain: 1 });
    expect(row.lease_token).not.toBeNull();
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
  });

  it.for([false, true])("the destination probe leaves storage and alarms unchanged (positive=%s)", async (positive, { task }) => {
    const f = await fixture(); await f.commit();
    if (positive) await f.drain();
    const request = await input(f);
    const snapshot = () => runInDurableObject(f.streamStub, async (instance, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'state_event_%' ORDER BY name").toArray();
      return { tables: tables.map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM ${name}`).toArray()]), alarm: await instance.state.storage.getAlarm() };
    });
    const before = await snapshot(); let result;
    const measured = await f.meter.phase(async () => { result = await f.streamCall("combined/probe", request); });
    expect(result.status).toBe(200); expect(result.data.version === 1).toBe(positive);
    expect(measured.rowsWritten).toBe(0); expect(measured.requests).toBe(1);
    expect(measured.alarms).toMatchObject({ reads: 0, writes: 0, deletes: 0, invocations: 0 });
    expect(Object.keys(measured.byRole)).toEqual(["DURABLE_EVENT_STREAM"]);
    expect(await snapshot()).toEqual(before);
    task.meta.stateEventCost = { destinationReceiptProbe: true, positive, measured };
  });
  it.each([false, true])("recovers a terminal ACK receipt and retires its obligation early (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); const accepted = await f.commit(); await f.connect();
    f.intercept(async (_kind, url, _init, send) => {
      const response = await send();
      if (String(url).endsWith("combined/append")) {
        f.clock.mockReturnValue(Date.now() + 5001); throw Error("lost appended reply");
      }
      return response;
    });
    await f.drain(); const pending = await first(f);
    expect(pending.probe_state).toBe(1);
    await f.ack();
    f.clock.mockReturnValue(pending.next_wakeup_at_ms); await alarm(f);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
    const saved = (await f.rows(f.ownerStub, "state_event_records")).find((r) => r.record_key === `owner:${accepted.operationId}`);
    expect(JSON.parse(saved.metadata_json)).toMatchObject({ pendingDelivery: false, deliveryOutcome: { terminal: "acknowledged" } });
    if (shared) expect(await f.rows(f.registryStub, "state_event_commit_barriers")).toEqual([]);
  });

  it.each([false, true])("reconciles a durable retention gap without creating an event (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); const accepted = await f.commit(); f.clock.mockReturnValue(accepted.expiresAtMs + 1);
    f.intercept(async (_kind, url, _init, send) => {
      const response = await send();
      if (String(url).endsWith("combined/append")) throw Error("lost gap reply");
      return response;
    });
    await f.drain();
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    const record = (await f.rows(f.streamStub, "state_event_destination_records"))[0];
    expect(JSON.parse(record.outcome_json)).toMatchObject({ state: "gap", reason: "retention", operationId: accepted.operationId });
    expect(record.expires_at_ms).not.toBeNull();
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
  });

  it.each([false, true])("recovers a pending durable probe after owner eviction (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); await f.commit(); let probes = 0;
    f.intercept(async (_kind, url, _init, send) => {
      if (String(url).endsWith("combined/probe")) probes++;
      const response = await send();
      if (String(url).endsWith("combined/append")) { f.clock.mockReturnValue(Date.now() + 5001); throw Error("timeout"); }
      return response;
    });
    await f.drain(); const pending = await first(f); expect(pending.probe_state).toBe(1);
    await evictDurableObject(f.ownerStub);
    expect(await runInDurableObject(f.ownerStub, (_i, state) => state.storage.getAlarm())).toBe(pending.next_wakeup_at_ms);
    f.clock.mockReturnValue(pending.next_wakeup_at_ms);
    await runInDurableObject(f.ownerStub, (instance) => {
      instance.env = f.testEnv; instance.featureRegistry = f.registry; instance.registry = f.registry;
      return instance.alarm();
    });
    expect(await first(f)).toMatchObject({ state: "appended", probe_state: 2, attempts: 1, uncertain: 0, lease_token: null });
    expect(Date.now()).toBeLessThan(pending.lease_until_ms); expect(probes).toBe(1);
  });

  it.each([false, true])("upgrades old SQL rows without inventing a probe or releasing their lease (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); const accepted = await f.commit(), until = Date.now() + 30_000;
    await runInDurableObject(f.ownerStub, (_i, state) => {
      state.storage.sql.exec("UPDATE state_event_outbox SET attempts = 1, scheduled_attempts = 1, uncertain = 1, lease_token = 'old-token', lease_until_ms = ?, next_wakeup_at_ms = ?", until, until);
      state.storage.sql.exec("DROP INDEX state_event_outbox_probe");
      state.storage.sql.exec("ALTER TABLE state_event_outbox DROP COLUMN probe_state");
      state.storage.sql.exec("ALTER TABLE state_event_outbox DROP COLUMN probe_fallback_ms");
    });
    await evictDurableObject(f.ownerStub);
    expect(await runInDurableObject(f.ownerStub, (_i, state) => state.storage.getAlarm())).toBe(until);
    await runInDurableObject(f.ownerStub, (instance) => {
      instance.env = f.testEnv; instance.featureRegistry = f.registry; instance.registry = f.registry;
      return instance.alarm();
    });
    expect(await first(f)).toMatchObject({ probe_state: 0, probe_fallback_ms: null, uncertain: 1, lease_token: "old-token", next_wakeup_at_ms: until });
    f.clock.mockReturnValue(until);
    await runInDurableObject(f.ownerStub, (instance) => {
      instance.env = f.testEnv; instance.featureRegistry = f.registry; instance.registry = f.registry;
      return instance.alarm();
    });
    expect(await first(f)).toMatchObject({ state: "appended", probe_state: 0, uncertain: 0 });
    expect((await f.rows(f.streamStub, "durable_event_stream_events"))[0].event_id).toBe(accepted.eventId);
  });

  it("uses a pending probe for manual recovery without charging or renewing publication", async () => {
    const f = await fixture({ shared: true }); const accepted = await f.commit();
    f.intercept(async (_kind, url, _init, send) => {
      const response = await send();
      if (String(url).endsWith("combined/append")) { f.clock.mockReturnValue(Date.now() + 5001); throw Error("timeout"); }
      return response;
    });
    await f.drain(); const row = await first(f);
    expect(row.probe_state).toBe(1); expect(Date.now()).toBeLessThan(row.next_wakeup_at_ms);
    const response = await f.testEnv.SHAREABLE_STATE_REALM.get(f.ownerStub.id).fetch("https://owner/internal/state-events/delivery/reconcile", {
      method: "POST", headers: { "x-elmybot-state-event-delivery": "v1" },
      body: JSON.stringify({ owner: f.owner, routeId: f.route.streamRouteId, operationId: accepted.operationId })
    });
    expect(response.ok).toBe(true);
    expect(await first(f)).toMatchObject({ probe_state: 2, state: "appended", attempts: 1, lease_token: null, uncertain: 0 });
    expect((await f.rows(f.streamStub, "durable_event_stream_events"))[0].expires_at_ms).toBe(accepted.expiresAtMs);
  });

  it("restores a null fallback after the final failed attempt without a recurring alarm", async () => {
    const f = await fixture(); const accepted = await f.commit();
    f.clock.mockReturnValue(accepted.expiresAtMs + 1);
    await runInDurableObject(f.ownerStub, (_i, state) => state.storage.sql.exec("UPDATE state_event_outbox SET attempts = 19, scheduled_attempts = 12"));
    let probes = 0;
    f.intercept((_kind, url, _init, send) => {
      if (String(url).endsWith("combined/append")) { f.clock.mockReturnValue(Date.now() + 5001); throw Error("final attempt uncertain"); }
      if (String(url).endsWith("combined/probe")) probes++;
      return send();
    });
    await f.drain(); const pending = await first(f);
    expect(pending).toMatchObject({ probe_state: 1, attempts: 20, probe_fallback_ms: null });
    f.clock.mockReturnValue(pending.next_wakeup_at_ms); await alarm(f);
    expect(await first(f)).toMatchObject({ probe_state: 2, attempts: 20, next_wakeup_at_ms: null, uncertain: 1, lease_token: pending.lease_token });
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBeNull(); expect(probes).toBe(1);
    f.clock.mockReturnValue(Date.now() + 60_000); await f.drain(false);
    expect(probes).toBe(1); expect((await first(f)).attempts).toBe(20);
  });

});
