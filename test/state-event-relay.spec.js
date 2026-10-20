import { afterEach, describe, expect, it, vi } from "vitest";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { cleanupDeliveryFixtures, deliveryFixture } from "./helpers/state-event-delivery-fixture.js";
import { queueProducerWakeup, drainProducerWakeup } from "../src/state-events/producer-wakeup.js";
import { boundedStateEventRequest } from "../src/state-events/relay-client.js";
import { wakeStateEventRelay, runStateEventRelay } from "../src/state-events/relay.js";
import { drainStateEventRelay } from "../src/state-events/delivery-source.js";

const fixture = (options = {}) => deliveryFixture({ suppressLocalCommitAlarm: true, ...options });
afterEach(async () => { vi.restoreAllMocks(); await cleanupDeliveryFixtures(); });
const edit = (f, sql, ...args) => runInDurableObject(f.ownerStub, (_i, state) => state.storage.sql.exec(sql, ...args).toArray());
async function drain(f, force = true) {
  return runInDurableObject(f.ownerStub, async (instance, state) => {
    instance.env = f.testEnv;
    if (force) state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE lease_token IS NULL");
    // Exercise one handler deterministically; alarm installation is covered by
    // the native alarm/reconnect tests, which use the real storage object.
    const controlled = { id: state.id, storage: new Proxy(state.storage, { get(target, key) {
      if (key === "setAlarm") return async () => {};
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    const result = await drainStateEventRelay(controlled, f.testEnv);
    await state.storage.deleteAlarm();
    return result;
  });
}
async function stop(f) { await runInDurableObject(f.ownerStub, (_i, state) => state.storage.deleteAlarm()); }
async function drainPublications(f, passes) {
  let attempted = 0;
  for (let index = 0; index < passes; index++) {
    await edit(f, "UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE state IN ('pending', 'parked', 'gap_pending') AND (lease_until_ms IS NULL OR lease_until_ms <= ?)", Date.now());
    attempted += (await drain(f, false)).attempted;
  }
  return attempted;
}
function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("socket message timed out")), 3000);
    socket.addEventListener("message", ({ data }) => { clearTimeout(timer); resolve(JSON.parse(data)); }, { once: true });
  });
}
describe("bounded state/event relay and producer wakeups", () => {
  it.each([false, true].flatMap((shared) => [false, true].map((lostReply) => ({ shared, lostReply }))))(
    "confirms a recorded gap before retiring its proof after restart (%j)", async ({ shared, lostReply }) => {
      const f = await fixture({ shared }), accepted = await f.commit(); await stop(f);
      const clock = vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1);
      let confirmations = 0;
      f.intercept(async (kind, input, _init, send) => {
        if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/confirm")) {
          confirmations++;
          if (lostReply) await send();
          throw Error("confirmation interrupted");
        }
        return send();
      });
      await drain(f);
      expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ state: "gap_recorded", destination_confirmed: 0 });
      const receipt = (await f.rows(f.streamStub, "state_event_destination_records"))[0];
      expect(receipt.expires_at_ms === null).toBe(!lostReply);
      if (lostReply) {
        clock.mockReturnValue(accepted.receipt.committedAtMs + 7_200_001);
        await runInDurableObject(f.streamStub, async (instance, state) => { instance.env = f.testEnv; await instance.alarm(); await state.storage.deleteAlarm(); });
        expect(await f.rows(f.streamStub, "state_event_destination_records")).toEqual([]);
      }
      await evictDurableObject(f.ownerStub);
      await edit(f, "UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0");
      await drain(f, false);
      // The second interruption must retain the proof and charged source row.
      expect(confirmations).toBe(2);
      expect(await f.rows(f.ownerStub, "state_event_outbox")).toHaveLength(1);
      const owner = (await f.rows(f.ownerStub, "state_event_records")).find((row) => row.record_key === `owner:${accepted.operationId}`);
      expect(JSON.parse(owner.metadata_json).pendingDelivery).toBe(true);
      f.intercept(null);
      await edit(f, "UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0");
      await drain(f, false);
      expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
      expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
      const confirmed = await f.rows(f.streamStub, "state_event_destination_records");
      if (lostReply) expect(confirmed).toEqual([]);
      else expect(confirmed[0].expires_at_ms).not.toBeNull();
      expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
      clock.mockReturnValue(accepted.receipt.committedAtMs + 7_200_001);
      await runInDurableObject(f.streamStub, async (instance, state) => { instance.env = f.testEnv; await instance.alarm(); await state.storage.deleteAlarm(); });
      expect(await f.rows(f.streamStub, "state_event_destination_records")).toEqual([]);
      expect((await f.rows(f.streamStub, "state_event_destination_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
    });
  it.each([false, true])("automatically drains local/shared work through the owner alarm (shared=%s)", async (shared) => {
    const f = await fixture({ shared, suppressLocalCommitAlarm: false }), accepted = await f.commit();
    await edit(f, "UPDATE state_event_outbox SET next_wakeup_at_ms = 0");
    await runInDurableObject(f.ownerStub, (instance) => { instance.env = f.testEnv; return instance.alarm(); });
    const pending = await f.rows(f.ownerStub, "state_event_outbox");
    expect(pending[0]).toMatchObject({ state: "appended", attempts: 1, destination_confirmed: 1 });
    expect(pending[0].next_wakeup_at_ms).toBe(accepted.receipt.expiresAtMs);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
  });
  it("parks under retained-capacity pressure and performs no consumer polling while idle", async () => {
    const f = await fixture(); await f.commit(); await stop(f);
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
    let outbound = 0;
    f.intercept(async (kind, _input, _init, send) => { if (kind === "DURABLE_EVENT_STREAM") outbound++; return send(); });
    await drain(f); const first = outbound;
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row.next_wakeup_at_ms).toBe(row.deadline_ms);
    const clock = vi.spyOn(Date, "now");
    for (let minute = 1; minute < 29; minute++) { clock.mockReturnValue(row.deadline_ms - (30 - minute) * 60_000); await drain(f, false); }
    expect(outbound).toBe(first); expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].attempts).toBe(1);
  });
  it("does not schedule repeated attempts after a confirmed offline append", async () => {
    const f = await fixture(); await f.commit(); await drain(f);
    let calls = 0; f.intercept(async (kind, _input, _init, send) => { if (kind === "DURABLE_EVENT_STREAM") calls++; return send(); });
    for (let i = 0; i < 20; i++) await drain(f, false);
    expect(calls).toBe(0);
  });
  it("cleans acknowledged obligations, retires receipts and removes the source alarm", async () => {
    const f = await fixture(), accepted = await f.commit(); await drain(f);
    const grant = f.grant(); expect((await f.streamCall("grants/issue", grant)).status).toBe(201);
    const socket = await f.openSocket(grant.grantId), frames = [];
    const event = new Promise((resolve) => socket.addEventListener("message", ({ data }) => { const value = JSON.parse(data); frames.push(value); if (value.type === "event") resolve(value); }));
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
    const impact = await event; socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: impact.cursor }));
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("SELECT 1"));
    await drain(f);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    const owner = (await f.rows(f.ownerStub, "state_event_records")).find((row) => row.record_key === `owner:${accepted.operationId}`);
    expect(JSON.parse(owner.metadata_json).pendingDelivery).toBe(false); expect(owner.prune_at_ms).not.toBeNull();
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
    expect((await f.rows(f.streamStub, "state_event_producer_interest"))[0].active).toBe(0);
    expect(await runInDurableObject(f.ownerStub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });
  it("recovers an in-flight lease after owner eviction without a duplicate append", async () => {
    const f = await fixture(), accepted = await f.commit(); let lost = false;
    f.intercept(async (kind, input, _init, send) => {
      // Keep this regression on the lease/fencing fallback path.
      if (String(input).endsWith("/probe")) throw Error("receipt probe unavailable"); const result = await send();
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append") && !lost) { lost = true; throw Error("reply lost"); } return result; });
    await drain(f);
    const leased = (await f.rows(f.ownerStub, "state_event_outbox"))[0]; expect(leased.lease_token).not.toBeNull();
    await evictDurableObject(f.ownerStub); f.intercept(null);
    expect((await drain(f, false)).attempted).toBe(0);
    await edit(f, "UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0");
    await drain(f, false);
    const events = await f.rows(f.streamStub, "durable_event_stream_events"); expect(events).toHaveLength(1); expect(events[0].event_id).toBe(accepted.receipt.eventId);
  });
  it.each([false, true].flatMap((shared) => [false, true].map((lostReply) => ({ shared, lostReply }))))(
    "recovers interrupted interest release after ACK without replay or uncharged work (%j)", async ({ shared, lostReply }) => {
      // This case drives recovery manually. Registration/ACK also arm real
      // native alarms; keep those in the dispatcher's future so they cannot
      // claim cleanup concurrently and turn the assertion into a timing race.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      const f = await fixture({ shared }), accepted = await f.commit(); await drain(f);
      f.intercept(async (kind, input, _init, send) => {
        if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/interest-release")) {
          if (lostReply) await send();
          throw Error("release interrupted after ACK");
        }
        return send();
      });
      const grant = f.grant(); await f.streamCall("grants/issue", grant);
      const socket = await f.openSocket(grant.grantId);
      const delivered = new Promise((resolve) => socket.addEventListener("message", ({ data }) => { const frame = JSON.parse(data); if (frame.type === "event") resolve(frame); }));
      socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
      const event = await delivered;
      socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: event.cursor }));
      await expect.poll(() => f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
      await drain(f);
      const rows = await f.rows(f.ownerStub, "state_event_outbox"), budget = (await f.rows(f.ownerStub, "state_event_outbox_budget"))[0];
      expect(rows).toHaveLength(1); expect(rows[0].state).toBe("retiring");
      expect(budget).toMatchObject({ rows: rows.length, bytes: rows.reduce((sum, row) => sum + new TextEncoder().encode(row.intent_json).byteLength, 0) });
      await evictDurableObject(f.ownerStub); f.intercept(null);
      await edit(f, "UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0");
      await drain(f, false);
      expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
      expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
      expect((await f.rows(f.streamStub, "state_event_producer_interest"))[0].active).toBe(0);
      const receipt = (await f.rows(f.ownerStub, "state_event_records")).find((row) => row.record_key === `owner:${accepted.operationId}`);
      expect(JSON.parse(receipt.metadata_json)).toMatchObject({ pendingDelivery: false, deliveryOutcome: { terminal: "acknowledged" }, receipt: accepted.receipt });
      expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
      expect(await runInDurableObject(f.ownerStub, (_i, state) => state.storage.getAlarm())).toBeNull();
    });
  it.each([false, true])("does not hold new ordered appends behind an uncertain terminal cleanup lease (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); await f.commit(); await drain(f);
    const grant = f.grant(); await f.streamCall("grants/issue", grant);
    const socket = await f.openSocket(grant.grantId);
    const received = new Promise((resolve) => socket.addEventListener("message", ({ data }) => { const value = JSON.parse(data); if (value.type === "event") resolve(value); }));
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
    const first = await received;
    // Arm the fault before ACK can wake cleanup. Installing it after observing
    // event removal races the real producer wake and can miss interest release.
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/interest-release")) throw Error("cleanup response unavailable");
      return send();
    });
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: first.cursor }));
    await expect.poll(() => f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    await drain(f);
    // A real ACK wakeup can finish its already-claimed cleanup alongside the
    // controlled drain. Observe its durable failure before admitting new work.
    await expect.poll(async () => (await f.rows(f.ownerStub, "state_event_outbox"))[0]?.uncertain).toBe(1);
    const retiring = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(retiring).toMatchObject({ state: "retiring", uncertain: 1 });
    expect(retiring.lease_until_ms).toBeGreaterThan(Date.now() + 20_000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const accepted = [];
    for (let index = 0; index < 6; index++) {
      const next = await f.commit(); accepted.push(next); await stop(f);
      clock.mockReturnValue(next.receipt.committedAtMs + 1100);
      const delivery = nextMessage(socket);
      await drain(f, false);
      const event = await delivery;
      expect(event.eventId).toBe(next.receipt.eventId);
      expect(event.sequence).toBe(index + 2);
      socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: event.cursor }));
      await expect.poll(() => f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
      await drain(f);
      const remaining = await f.rows(f.ownerStub, "state_event_outbox");
      expect(remaining.find((entry) => entry.operation_id === retiring.operation_id)).toMatchObject({ state: "retiring", lease_token: retiring.lease_token, lease_until_ms: retiring.lease_until_ms });
      expect(remaining.find((entry) => entry.operation_id === next.operationId)).toMatchObject({ state: "appended", attempts: 1 });
    }
    // Publication continues beyond the initially fast three/four events, but
    // cleanup remains charged, serialized, and does not discard its old lease.
    const rows = await f.rows(f.ownerStub, "state_event_outbox");
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.lease_token !== null)).toHaveLength(1);
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0].rows).toBe(7);
    f.intercept(null); clock.mockReturnValue(retiring.lease_until_ms + 1);
    for (let index = 0; index < 7; index++) await drain(f);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    const receipts = await f.rows(f.streamStub, "durable_event_stream_receipts");
    expect(receipts).toHaveLength(7);
    expect(new Set(receipts.map((row) => row.event_id)).size).toBe(7);
    for (const next of accepted) expect(receipts.map((row) => row.event_id)).toContain(next.receipt.eventId);
  });
  it.each([false, true])("keeps an uncertain unappended head ordered while cleanup uses another lane (shared=%s)", async (shared) => {
    const f = await fixture({ shared }); f.testEnv.STATE_EVENT_DIAGNOSTICS = "true";
    const logs = [], log = vi.spyOn(console, "log").mockImplementation((value) => {
      try { logs.push(JSON.parse(value)); } catch { /* unrelated logs */ }
    });
    const first = await f.commit(); let lost = false;
    f.intercept(async (kind, input, _init, send) => {
      // Keep this regression on the lease/fencing fallback path.
      if (String(input).endsWith("/probe")) throw Error("receipt probe unavailable");
      const result = await send();
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append") && !lost) { lost = true; throw Error("append reply lost"); }
      return result;
    });
    await drain(f);
    const head = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(head).toMatchObject({ state: "pending", uncertain: 1 });
    const second = await f.commit(); await stop(f);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1100);
    await drain(f, false);
    expect((await f.rows(f.streamStub, "durable_event_stream_events")).map((row) => row.event_id)).toEqual([first.receipt.eventId]);
    const waiting = (await f.rows(f.ownerStub, "state_event_outbox")).find((row) => row.operation_id === second.operationId);
    expect(waiting).toMatchObject({ state: "pending", attempts: 0, next_wakeup_at_ms: head.lease_until_ms });
    expect(logs.some((row) => row.stage === "relay.finish" && row.operationId === first.operationId && row.reason === "uncertain")).toBe(true);
    expect(logs.some((row) => row.stage === "relay.blocked" && row.operationId === second.operationId &&
      row.reason === "ordered_head" && row.blockerOperationId === first.operationId && row.leaseUntilMs === head.lease_until_ms)).toBe(true);
    log.mockRestore();
    f.testEnv.STATE_EVENT_DIAGNOSTICS = "false";
    f.intercept(null); clock.mockReturnValue(head.lease_until_ms + 1);
    await drainPublications(f, 2);
    const delivered = (await f.rows(f.streamStub, "durable_event_stream_events")).sort((a, b) => a.sequence - b.sequence);
    expect(delivered.map((row) => row.event_id)).toEqual([first.receipt.eventId, second.receipt.eventId]);
    expect(delivered.map((row) => row.sequence)).toEqual([1, 2]);
  });
  it("stops automatic retries at twelve while preserving the original deadline", async () => {
    const f = await fixture(); await f.commit(); let calls = 0;
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append")) { calls++; return new Response(JSON.stringify({ code: "durable_event_service_unavailable" }), { status: 503 }); }
      return send();
    });
    for (let i = 0; i < 12; i++) { await edit(f, "UPDATE state_event_outbox SET lease_token = NULL, lease_until_ms = NULL, next_wakeup_at_ms = 0"); await drain(f, false); }
    expect(calls).toBe(12);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0]; expect(row.scheduled_attempts).toBe(12); expect(row.next_wakeup_at_ms).toBe(row.deadline_ms);
    await drain(f, false); expect(calls).toBe(12);
  });
  it("bounds a definite transient retry by the original event deadline", async () => {
    const f = await fixture(), accepted = await f.commit();
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append")) return new Response(JSON.stringify({ code: "durable_event_service_unavailable" }), { status: 503 });
      return send();
    });
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs - 500); await drain(f);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row).toMatchObject({ attempts: 1, next_wakeup_at_ms: accepted.receipt.expiresAtMs, lease_token: null });
  });
  it("reserves the final delivery attempt for expiry and does not reset budgets on wakeup", async () => {
    const f = await fixture(); await f.commit(); await edit(f, "UPDATE state_event_outbox SET attempts = 19, scheduled_attempts = 12");
    await f.source("wake", { version: 1 });
    expect((await drain(f)).attempted).toBe(0);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0]; expect(row.attempts).toBe(19); expect(row.next_wakeup_at_ms).toBe(row.deadline_ms);
  });
  it("lets one blocked stream coexist with fair draining of independent streams", async () => {
    const f = await fixture({ streams: 6 }); for (let i = 0; i < 6; i++) { await f.commit(i); await stop(f); }
    await runInDurableObject(f.streamStubs[0], (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
    const attempted = await drainPublications(f, 6);
    expect({ attempted, rows: (await f.rows(f.ownerStub, "state_event_outbox")).map((r) => ({ state: r.state, error: r.last_error, attempts: r.attempts })) }).toEqual({ attempted: 6, rows: [
      { state: "pending", error: "durable_event_stream_full", attempts: 1 }, ...Array.from({ length: 5 }, () => ({ state: "appended", error: null, attempts: 1 }))
    ] });
    expect(await f.rows(f.streamStubs[0], "durable_event_stream_events")).toEqual([]);
    for (const stub of f.streamStubs.slice(1)) expect(await f.rows(stub, "durable_event_stream_events")).toHaveLength(1);
  });
  it("leaves a large backlog unclaimed after one publication quantum", async () => {
    const f = await fixture({ streams: 6 });
    for (let i = 0; i < 25; i++) {
      if (i) await edit(f, "UPDATE state_event_outbox_budget SET rate_json = '[]'");
      await f.commit(i % 6); await stop(f);
    }
    expect((await drain(f)).attempted).toBe(1);
    let retained = 0; for (const stub of f.streamStubs) retained += (await f.rows(stub, "durable_event_stream_events")).length;
    expect(retained).toBe(1);
    expect((await f.rows(f.ownerStub, "state_event_outbox")).filter((row) => row.attempts === 0 && row.lease_token === null)).toHaveLength(24);
  });
  it("persists producer interest before capacity rejection and wakes on reconnect", async () => {
    const f = await fixture(); await f.commit();
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
    await drain(f); expect((await f.rows(f.streamStub, "state_event_producer_interest"))[0].active).toBe(1);
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 0"));
    const grant = f.grant(); await f.streamCall("grants/issue", grant); const socket = await f.openSocket(grant.grantId), ready = nextMessage(socket);
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" })); expect((await ready).type).toBe("ready");
    // Ready can reach the socket before registration persists its wakeup. Wait
    // for durable interest, then assert the eventual result rather than a
    // transient last_error marker that the native owner alarm may consume.
    await expect.poll(async () => (await f.rows(f.streamStub, "state_event_producer_interest"))[0].version).toBeGreaterThan(0);
    await runInDurableObject(f.streamStub, async (instance, state) => { state.storage.sql.exec("UPDATE state_event_producer_interest SET due_ms = 0"); await instance.alarm(); });
    await expect.poll(() => f.rows(f.streamStub, "durable_event_stream_events"), { timeout: 4000 }).toHaveLength(1);
    expect((await f.rows(f.ownerStub, "state_event_source_streams"))[0].last_wake_version).toBeGreaterThan(0);
  });
  it("deduplicates producer wakeups across retries and object restart", async () => {
    const f = await fixture(); await f.commit(); await stop(f);
    await f.source("wake", { version: 7 }); const before = (await f.rows(f.ownerStub, "state_event_source_streams"))[0];
    await evictDurableObject(f.ownerStub); await f.source("wake", { version: 7 });
    const after = (await f.rows(f.ownerStub, "state_event_source_streams"))[0]; expect(after.wake_generation).toBe(before.wake_generation);
  });
  it("resumes disabled work on an observed enable transition without polling", async () => {
    const f = await fixture(); await f.commit(); f.testEnv.DURABLE_EVENT_STREAMS_ENABLED = "false";
    await drain(f); const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0]; expect(row.next_wakeup_at_ms).toBe(row.deadline_ms);
    f.testEnv.DURABLE_EVENT_STREAMS_ENABLED = "true"; await f.source("status");
    await drain(f, false); await expect.poll(() => f.rows(f.streamStub, "durable_event_stream_events"), { timeout: 4000 }).toHaveLength(1);
  });
  it("retains a useful wakeup that races an in-flight capacity rejection", async () => {
    const f = await fixture(); await f.commit(); let once = false;
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append") && !once) {
        once = true;
        await runInDurableObject(env.CONFIG.get(env.CONFIG.idFromName(f.owner.key)), (_i, state) => wakeStateEventRelay(state, f.route.streamRouteId, 1));
        return new Response(JSON.stringify({ code: "durable_event_stream_full" }), { status: 429 });
      }
      return send();
    });
    await drain(f);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0]; expect(row.next_wakeup_at_ms).toBeLessThan(row.deadline_ms);
    f.intercept(null); await drain(f); expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
  });
  it("coalesces many capacity notifications into at most one wakeup per second", async () => {
    const f = await fixture(); await f.commit(); await drain(f);
    let notifications = 0;
    f.intercept(async (kind, input, _init, send) => { if (kind === "CONFIG" && String(input).endsWith("delivery/wake")) notifications++; return send(); });
    await runInDurableObject(f.streamStub, async (_i, state) => {
      for (let i = 0; i < 100; i++) await queueProducerWakeup(state, async () => {});
      expect((await drainProducerWakeup(state, f.testEnv, async () => {})).attempted).toBe(1);
      for (let i = 0; i < 100; i++) await queueProducerWakeup(state, async () => {});
      expect((await drainProducerWakeup(state, f.testEnv, async () => {})).attempted).toBe(0);
    });
    expect(notifications).toBe(1);
  });
  it("rolls back a wakeup marker when its durable alarm cannot be written", async () => {
    const f = await fixture(); await f.commit(); await drain(f);
    await runInDurableObject(f.streamStub, async (_i, state) => {
      const before = state.storage.sql.exec("SELECT version, due_ms FROM state_event_producer_interest").one(), alarm = await state.storage.getAlarm();
      await expect(queueProducerWakeup(state, async () => { await state.storage.setAlarm(Date.now() + 1000); throw Error("alarm failed"); })).rejects.toThrow("alarm failed");
      expect(state.storage.sql.exec("SELECT version, due_ms FROM state_event_producer_interest").one()).toEqual(before);
      expect(await state.storage.getAlarm()).toBe(alarm);
    });
  });
  it("retries a lost notification acknowledgement after stream eviction without double waking the source", async () => {
    const f = await fixture(); await f.commit(); await drain(f); let lost = false;
    f.intercept(async (kind, input, _init, send) => {
      const response = await send(); if (kind === "CONFIG" && String(input).endsWith("delivery/wake") && !lost) { lost = true; throw Error("wake reply lost"); } return response;
    });
    await runInDurableObject(f.streamStub, async (_i, state) => {
      await queueProducerWakeup(state, async () => {}); await drainProducerWakeup(state, f.testEnv, async () => {}); await state.storage.deleteAlarm();
    });
    const generation = (await f.rows(f.ownerStub, "state_event_source_streams"))[0].wake_generation;
    await evictDurableObject(f.streamStub); f.intercept(null);
    await runInDurableObject(f.streamStub, async (_i, state) => {
      state.storage.sql.exec("UPDATE state_event_producer_interest SET due_ms = 0"); await drainProducerWakeup(state, f.testEnv, async () => {});
    });
    expect((await f.rows(f.ownerStub, "state_event_source_streams"))[0].wake_generation).toBe(generation);
  });
  it("never exceeds four concurrent stream domains, including a competing manual request", async () => {
    const f = await fixture({ streams: 8 }), accepted = [];
    for (let i = 0; i < 8; i++) { accepted.push(await f.commit(i)); await stop(f); }
    const report = await runInDurableObject(f.ownerStub, async (_i, state) => {
      state.storage.sql.exec("UPDATE state_event_source_streams SET registered_epoch = interest_epoch");
      state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0");
      const controlled = controlledState(state); let active = 0, peak = 0, rejected = false, checked = false, release;
      const gate = new Promise((resolve) => { release = resolve; });
      const request = async () => {
        active++; peak = Math.max(peak, active);
        if (active === 4 && !checked) {
          checked = true;
          try { await runStateEventRelay(controlled, f.testEnv, request, { onlyOperationId: accepted[4].operationId }); }
          catch (error) { rejected = error.code === "state_event_attempt_in_progress"; }
          release();
        }
        await gate; active--; throw Object.assign(Error("temporary service rejection"), { code: "durable_event_service_unavailable", status: 503 });
      };
      const outcomes = await Promise.allSettled(accepted.slice(0, 4).map((entry) =>
        runStateEventRelay(controlled, f.testEnv, request, { onlyOperationId: entry.operationId })));
      expect(outcomes.every((entry) => entry.status === "rejected")).toBe(true);
      const attempted = state.storage.sql.exec("SELECT SUM(attempts) AS total FROM state_event_outbox").one().total;
      await state.storage.deleteAlarm(); return { peak, rejected, attempted };
    });
    expect(report).toEqual({ peak: 4, rejected: true, attempted: 4 });
  });
  it("stops starting work after five seconds and retains the timed-out attempt leases", async () => {
    const f = await fixture({ streams: 8 }); for (let i = 0; i < 8; i++) { await f.commit(i); await stop(f); }
    const report = await runInDurableObject(f.ownerStub, async (_i, state) => {
      state.storage.sql.exec("UPDATE state_event_source_streams SET registered_epoch = interest_epoch");
      state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0");
      let release; const gate = new Promise((resolve) => { release = resolve; });
      try {
        const result = await runStateEventRelay(controlledState(state), f.testEnv, async (_state, _env, _owner, _id, _route, options) =>
          boundedStateEventRequest(async () => { await gate; return new Response(JSON.stringify({ state: "appended" })); }, options.deadline));
        const counts = state.storage.sql.exec("SELECT SUM(attempts = 0) AS untouched, SUM(lease_token IS NOT NULL) AS leased FROM state_event_outbox").one();
        return { attempted: result.attempted, ...counts };
      } finally { release(); await state.storage.deleteAlarm(); }
    });
    expect(report).toEqual({ attempted: 1, untouched: 7, leased: 1 });
  }, 15000);
  it("retires shared owner and origin receipts after expiry without changing feature state", async () => {
    const f = await fixture({ shared: true }), accepted = await f.commit(); await drain(f);
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1);
    await drain(f);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    expect((await f.rows(f.ownerStub, "shareable_state_realm_values"))[0].value_json).toBe("1");
    const owner = (await f.rows(f.ownerStub, "state_event_records"))[0]; expect(JSON.parse(owner.metadata_json).pendingDelivery).toBe(false);
    const origin = env.CONFIG.get(env.CONFIG.idFromName(f.group.key));
    expect((await f.rows(origin, "state_event_records")).find((row) => row.record_key.startsWith("origin:")).prune_at_ms).not.toBeNull();
  });
  it("reserves metadata space so terminal cleanup can complete at receipt capacity", async () => {
    const f = await fixture(), accepted = await f.commit(); await drain(f);
    await edit(f, "UPDATE state_event_budget SET metadata_bytes = 16777216 - terminal_reserve_bytes");
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1); await drain(f);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    const budget = (await f.rows(f.ownerStub, "state_event_budget"))[0]; expect(budget.metadata_bytes).toBeLessThanOrEqual(16777216); expect(budget.terminal_reserve_bytes).toBe(0);
  });
  it("retains unresolved gap authority when its reserved final attempt cannot reach the stream", async () => {
    const f = await fixture(), accepted = await f.commit(); await stop(f);
    await edit(f, "UPDATE state_event_outbox SET attempts = 19, scheduled_attempts = 12");
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append")) return new Response(JSON.stringify({ code: "state_event_outcome_unknown" }), { status: 503 });
      return send();
    });
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1); await drain(f);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row).toMatchObject({ state: "gap_pending", attempts: 20, next_wakeup_at_ms: null });
    expect(JSON.parse(row.intent_json)).not.toHaveProperty("payload");
    for (let i = 1; i < 10; i++) await f.source("wake", { version: i });
    expect((await drain(f, false)).attempted).toBe(0);
    expect((await f.source("status")).data.unresolvedGap).toBe(true);
  });
  it("keeps terminal-origin cleanup recoverable across an outage and restart", async () => {
    const f = await fixture({ shared: true }), accepted = await f.commit(); await drain(f);
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "CONFIG" && String(input).endsWith("origin/retire")) return new Response(JSON.stringify({ code: "state_event_outcome_unknown" }), { status: 503 });
      return send();
    });
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1); await drain(f);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].state).toBe("retiring");
    await evictDurableObject(f.ownerStub); f.intercept(null);
    await edit(f, "UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0"); await drain(f, false);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
  });

  it("parks terminal cleanup after twelve automatic failures even after the event deadline", async () => {
    const f = await fixture({ shared: true }), accepted = await f.commit(); await drain(f);
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "CONFIG" && String(input).endsWith("origin/retire")) return new Response(JSON.stringify({ code: "state_event_outcome_unknown" }), { status: 503 });
      return send();
    });
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1); await drain(f);
    await edit(f, "UPDATE state_event_outbox SET control_attempts = 12, control_scheduled = 12, lease_until_ms = 0, next_wakeup_at_ms = 0");
    expect((await drain(f, false)).attempted).toBe(0);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].next_wakeup_at_ms).toBeNull();
    await f.source("wake", { version: 1 });
    await drain(f);
    await expect.poll(async () => (await f.rows(f.ownerStub, "state_event_outbox"))[0].control_attempts).toBe(13);
  });
  it.each([false, true])("repairs an overdue alarm after eviction without releasing an uncertain lease (shared=%s)", async (shared) => {
    const f = await fixture({ shared }), accepted = await f.commit(); await stop(f);
    const now = Date.now() + 120_000, until = now + 30_000, token = crypto.randomUUID();
    await runInDurableObject(f.ownerStub, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE state_event_outbox SET uncertain = 1, lease_token = ?, lease_until_ms = ?,
        next_wakeup_at_ms = ? WHERE operation_id = ?`, token, until, until, accepted.operationId);
      // Future in the native clock, overdue in the controlled application clock.
      await state.storage.setAlarm(now - 1000);
    });
    vi.spyOn(Date, "now").mockReturnValue(now);
    await evictDurableObject(f.ownerStub);
    expect(await runInDurableObject(f.ownerStub, (_instance, state) => state.storage.getAlarm())).toBe(until);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({
      operation_id: accepted.operationId, uncertain: 1, lease_token: token, lease_until_ms: until,
      next_wakeup_at_ms: until, attempts: 0
    });
  });
  it("parks a busy owner's due work until a lease can recover instead of spinning alarms", async () => {
    const f = await fixture({ streams: 5 }); for (let i = 0; i < 5; i++) await f.commit(i);
    const until = Date.now() + 30_000;
    const rows = await f.rows(f.ownerStub, "state_event_outbox");
    for (const row of rows.slice(0, 4)) await edit(f, "UPDATE state_event_outbox SET lease_token = ?, lease_until_ms = ?, next_wakeup_at_ms = ? WHERE operation_id = ?", crypto.randomUUID(), until, until, row.operation_id);
    await edit(f, "UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE lease_token IS NULL");
    await runInDurableObject(f.ownerStub, (instance) => { instance.env = f.testEnv; return instance.alarm(); });
    expect((await f.rows(f.ownerStub, "state_event_outbox")).find((row) => row.lease_token === null).next_wakeup_at_ms).toBe(until);
    expect(await runInDurableObject(f.ownerStub, (_i, state) => state.storage.getAlarm())).toBe(until);
    await edit(f, "UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0");
    expect(await drainPublications(f, 5)).toBe(5);
    expect((await f.rows(f.ownerStub, "state_event_outbox")).every((row) => row.state === "appended" && row.attempts === 1)).toBe(true);
  });
  it("bounds destination notification retries when a producer is unreachable", async () => {
    const f = await fixture(); await f.commit(); await drain(f); let count = 0;
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "CONFIG" && String(input).endsWith("delivery/wake")) { count++; return new Response(JSON.stringify({ code: "state_event_outcome_unknown" }), { status: 503 }); }
      return send();
    });
    await runInDurableObject(f.streamStub, async (_i, state) => {
      await queueProducerWakeup(state, async () => {});
      for (let i = 0; i < 12; i++) { state.storage.sql.exec("UPDATE state_event_producer_interest SET due_ms = 0"); await drainProducerWakeup(state, f.testEnv, async () => {}); }
    });
    expect(count).toBe(12); expect((await f.rows(f.streamStub, "state_event_producer_interest"))[0].due_ms).toBeNull();
  });
  it("restores a reset-discarded lease's wakeup after releasing the reset fence", async () => {
    const f = await fixture(); await f.commit(); const until = Date.now() + 30_000;
    await edit(f, "UPDATE state_event_outbox SET lease_token = 'interrupted', lease_until_ms = ?, next_wakeup_at_ms = ?", until, until);
    expect((await f.streamCall("grants/issue", f.grant(true))).status).toBe(201);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0]; expect(row).toMatchObject({ state: "reset_discarded", next_wakeup_at_ms: until });
    await edit(f, "UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0"); await drain(f, false);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
  });

});

function controlledState(state) {
  return { id: state.id, storage: new Proxy(state.storage, { get(target, key) {
    if (key === "setAlarm") return async () => {};
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
