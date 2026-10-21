import { afterEach, describe, expect, it, vi } from "vitest";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { cleanupDeliveryFixtures, deliveryFixture } from "./helpers/state-event-delivery-fixture.js";
import { closeCostMeters, measuredDeliveryFixture } from "./helpers/state-event-cost-meter.js";
import { stateEventRequestGuard } from "./helpers/state-event-request-guard.js";
import { STATE_EVENT_WORK_LIMITS, createStateEventWorkBudget } from "../src/state-events/relay-work-budget.js";
import { relayStreamRequest } from "../src/state-events/relay-client.js";

afterEach(async () => { vi.restoreAllMocks(); await closeCostMeters(); await cleanupDeliveryFixtures(); });

async function guardedFixture(options) {
  const f = await measuredDeliveryFixture(options);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  let guard, fault;
  f.intercept((kind, url, init, send) => {
    const path = new URL(url).pathname;
    const call = () => fault ? fault(kind, path, init, send) : send();
    return guard ? guard.request(path, call) : call();
  });
  async function alarm({ depth = 2, inject } = {}) {
    const due = f.meter.due(f.ownerStub, f.ownerRole);
    expect(due).not.toBeNull();
    clock.mockReturnValue(Math.max(Date.now(), due));
    guard = stateEventRequestGuard({ calls: STATE_EVENT_WORK_LIMITS.remoteCalls, depth }); fault = inject;
    try {
      const measured = await f.meter.phase(() => f.meter.handler(f.ownerStub, f.ownerRole, "alarm", () =>
        runInDurableObject(f.ownerStub, (instance) => instance.alarm())));
      return { measured, guard };
    } finally { guard = null; fault = null; }
  }
  return { ...f, alarm, clock };
}

describe("state/event invocation work budgets", () => {
  it.each([false, true])("drains an ordered burst through durable continuations under enforced call/nesting limits (shared=%s)", async (shared) => {
    const f = await guardedFixture({ shared }), accepted = [], inputs = [];
    const clock = f.clock;
    for (let index = 0; index < 6; index++) {
      const input = f.invocation(); inputs.push(input); accepted.push(await f.commit(input));
      clock.mockReturnValue(Date.now() + 1100);
    }
    for (let index = 0; index < 6; index++) {
      const { guard, measured } = await f.alarm();
      expect(guard.rejected).toBe(0); expect(guard.total).toBe(measured.requests);
      expect(guard.total).toBeLessThanOrEqual(STATE_EVENT_WORK_LIMITS.remoteCalls);
      expect(guard.peak).toBeLessThanOrEqual(2);
      expect(guard.paths.some((path) => path.endsWith("delivery/proof"))).toBe(false);
      const events = await f.rows(f.streamStub, "durable_event_stream_events");
      expect(events).toHaveLength(index + 1);
      const rows = await f.rows(f.ownerStub, "state_event_outbox");
      expect(rows.filter((row) => row.attempts === 0 && row.lease_token === null)).toHaveLength(5 - index);
      expect(rows.every((row) => row.attempts <= 1 && row.lease_token === null)).toBe(true);
      const due = f.meter.due(f.ownerStub, f.ownerRole);
      expect(due).toBeGreaterThan(Date.now());
      if (index < 5) expect(due - Date.now()).toBe(STATE_EVENT_WORK_LIMITS.continuationMs);
    }
    const events = (await f.rows(f.streamStub, "durable_event_stream_events")).sort((a, b) => a.sequence - b.sequence);
    expect(events.map((event) => event.event_id)).toEqual(accepted.map((receipt) => receipt.eventId));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await f.commit(inputs[0])).toEqual(accepted[0]);
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(6);
  });

  it.each([false, true])("retains an unknown append lease and recovers once under the call limit (replyLost=%s)", async (replyLost) => {
    const f = await guardedFixture({ shared: true });
    const accepted = await f.commit();
    const first = await f.alarm({ inject: async (kind, path, _init, send) => {
      if (path.endsWith("/probe")) throw Error("Synthetic probe outage");
      if (kind === "DURABLE_EVENT_STREAM" && path.endsWith("combined/append")) {
        if (replyLost) await send();
        throw Error("Synthetic transport failure");
      }
      return send();
    } });
    expect(first.guard.rejected).toBe(0);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row).toMatchObject({ uncertain: 1, attempts: 1, state: "pending" });
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBe(row.lease_until_ms);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(replyLost ? 1 : 0);
    const recovered = await f.alarm();
    expect(recovered.guard.rejected).toBe(0);
    const events = await f.rows(f.streamStub, "durable_event_stream_events");
    expect(events).toHaveLength(1); expect(events[0].event_id).toBe(accepted.eventId);
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ state: "appended", uncertain: 0, lease_token: null });
  });

  it.each([false, true])("bounds confirmation/outcome/retirement/release work after ACK without leaking obligations (shared=%s)", async (shared) => {
    const f = await guardedFixture({ shared });
    await f.commit(); f.clock.mockReturnValue(Date.now() + 1100); await f.commit();
    await f.alarm(); await f.alarm();
    await f.connect(); await f.ack(); await f.ack(); await f.streamAlarm();
    const paths = [];
    for (let index = 0; index < 2 && (await f.rows(f.ownerStub, "state_event_outbox")).length; index++) {
      const pass = await f.alarm(); paths.push(...pass.guard.paths);
      expect(pass.guard.rejected).toBe(0);
      expect(pass.guard.total).toBeLessThanOrEqual(STATE_EVENT_WORK_LIMITS.remoteCalls);
    }
    expect(paths.some((path) => path.endsWith("combined/outcome"))).toBe(true);
    expect(paths.some((path) => path.endsWith("combined/interest-release"))).toBe(true);
    if (shared) expect(paths.some((path) => path.endsWith("origin/retire"))).toBe(true);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBeNull();
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });

  it("labels a deliberately too-small synthetic depth budget and preserves recovery authority", async () => {
    const f = await guardedFixture({ shared: true }), accepted = await f.commit();
    const constrained = await f.alarm({ depth: 1 });
    expect(constrained.guard.rejected).toBeGreaterThan(0);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ state: "pending", uncertain: 1 });
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    const recovered = await f.alarm(); expect(recovered.guard.rejected).toBe(0);
    expect((await f.rows(f.streamStub, "durable_event_stream_events"))[0].event_id).toBe(accepted.eventId);
  });

  it("accounts for an old registry fence plus new append rejection and its recovery fence", async () => {
    const f = await guardedFixture({ shared: true }); await f.commit();
    await f.alarm({ inject: (kind, path, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && path.endsWith("combined/append")) throw Error("Synthetic lost request");
      return send();
    } });
    const barriers = await f.rows(f.registryStub, "state_event_commit_barriers");
    expect(barriers).toHaveLength(1);
    expect(JSON.stringify(barriers)).not.toContain("sourceSnapshot");
    expect(JSON.stringify(barriers)).not.toContain("payload");
    await runInDurableObject(f.streamStub, (_instance, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
    const retry = await f.alarm();
    expect(retry.guard.rejected).toBe(0); expect(retry.guard.total).toBe(4);
    expect(retry.guard.paths.filter((path) => path.endsWith("combined/fence"))).toHaveLength(2);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({
      state: "pending", lease_token: null, uncertain: 0, last_error: "durable_event_stream_full"
    });
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
  });

  it.each([false, true])("retains a native continuation alarm across owner eviction (shared=%s)", async (shared) => {
    const f = await deliveryFixture({ shared, streams: 2, suppressLocalCommitAlarm: true });
    const now = Date.now() + 120_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await f.commit(0); await f.commit(1);
    const due = await runInDurableObject(f.ownerStub, async (instance, state) => {
      instance.env = f.testEnv;
      state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = ?", now);
      await instance.alarm();
      const rows = state.storage.sql.exec("SELECT attempts, next_wakeup_at_ms FROM state_event_outbox ORDER BY operation_sequence").toArray();
      expect(rows.filter((row) => row.attempts === 0)).toHaveLength(1);
      expect(rows.find((row) => row.attempts === 0).next_wakeup_at_ms).toBe(now + STATE_EVENT_WORK_LIMITS.continuationMs);
      return state.storage.getAlarm();
    });
    expect(due).toBe(now + STATE_EVENT_WORK_LIMITS.continuationMs);
    await evictDurableObject(f.ownerStub);
    expect(await runInDurableObject(f.ownerStub, (_instance, state) => state.storage.getAlarm())).toBe(due);
  });

  it("refuses an unbudgeted remote stage before sending and reserves complete shared paths", () => {
    const budget = createStateEventWorkBudget();
    const row = { state: "pending", intent_json: JSON.stringify({ route: { kind: "effective_shareable" } }) };
    const record = budget.start(row);
    for (const stage of ["interest", "authority.append", "authority.probe", "confirm", "origin.retire", "interest-release"]) record.take(stage);
    expect(budget.reserved).toBe(19); expect(budget.reason(row)).toBe("publication_quantum");
    const send = vi.fn(), environment = { DURABLE_EVENT_STREAM: { idFromName: (id) => id, get: () => ({ fetch: send }) } };
    expect(() => relayStreamRequest(environment, "route", "append", {}, Date.now() + 5000, record)).toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(() => record.take("unaccounted")).toThrow();
  });
});
