import { afterEach, describe, expect, it, vi } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { nativeHealthFixture, cleanupNativeHealthFixtures } from "./helpers/installed-health-native-fixture.js";
import { installedHealthFaults } from "./helpers/installed-health-faults.js";
import { createStateEventCoordinator } from "../public/event-stream/state-event.js";
import { createHealthEffectQueue } from "../public/health-widget/effects.js";

const controls = [], queues = [];
const protocol = "durable-event-socket/v1";
afterEach(async () => {
  for (const q of queues) q.close(); queues.length = 0;
  for (const control of controls) await control.restore(); controls.length = 0;
  await cleanupNativeHealthFixtures(); vi.restoreAllMocks();
});
async function consumer(f) {
  const socket = await f.openSocket(), frames = [], statuses = [];
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === "event") frames.push({ ...frame, receivedAtMs: Date.now() });
    else statuses.push(frame);
  });
  socket.send(JSON.stringify({ protocol, type: "register" }));
  await expect.poll(() => statuses.some((frame) => frame.type === "ready")).toBe(true);
  return { socket, frames };
}
async function ack(f, c, index) {
  const frame = c.frames[index]; c.socket.send(JSON.stringify({ protocol, type: "ack", cursor: frame.cursor }));
  await expect.poll(async () => (await f.rows(f.streamStub, "durable_event_stream_metadata"))[0].acknowledged_sequence).toBe(frame.sequence);
}
async function faultFixture(options) {
  const f = await nativeHealthFixture(options);
  // Future application time prevents the native dispatcher racing our explicit
  // long-boundary clock. This is not real pacing or a platform latency measure.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  const fault = await installedHealthFaults(f, clock); controls.push(fault);
  return { f, clock, fault };
}
async function verifyClean(f, fault, count, value) {
  await fault.runUntil(Date.now() + 10_000);
  expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
  expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
  expect((await f.rows(f.streamStub, "state_event_producer_interest"))[0].active).toBe(0);
  expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(count);
  const readAtMs = Date.now(), dispatchesBeforeRead = fault.dispatches.length;
  expect(await f.read()).toMatchObject({ value, stateEvent: { operationSequence: count } });
  const receipts = await f.rows(f.streamStub, "state_event_destination_records");
  expect(receipts).toHaveLength(count);
  expect(new Set(receipts.map((row) => row.event_id)).size).toBe(count);
  expect(receipts.every((row) => row.expires_at_ms !== null)).toBe(true);
  expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  const owners = (await f.rows(f.ownerStub, "state_event_records")).filter((row) => row.record_key.startsWith("owner:"));
  expect(owners).toHaveLength(count);
  expect(owners.every((row) => JSON.parse(row.metadata_json).pendingDelivery === false)).toBe(true);
  // The native registry is shared with other fixture groups. Only this
  // owner's obligations belong to this cleanup assertion.
  expect((await f.rows(f.registryStub, "state_event_commit_barriers"))
    .filter((row) => row.owner_key === f.route.key)).toEqual([]);
  // Resolving the snapshot's shared binding schedules one registry safety
  // check while the event grant's binding watcher is active. It is addressed
  // work from our read, not idle polling. Require exactly that wake, then start
  // the idle window only after the last useful request has settled.
  const callsBeforeSettle = fault.calls.length;
  await fault.runUntil(Date.now() + 2000);
  expect(fault.dispatches.slice(dispatchesBeforeRead)).toEqual([{
    kind: "INTEGRATION_REGISTRY", dueMs: readAtMs + 1000, startedAtMs: readAtMs + 1000
  }]);
  expect(fault.calls.length).toBe(callsBeforeSettle);
  const before = fault.calls.length, alarmsBefore = fault.dispatches.length;
  await fault.runUntil(Date.now() + 60_000);
  expect(fault.dispatches.slice(alarmsBefore)).toEqual([]);
  expect(fault.calls.length).toBe(before); // No idle consumer/receipt polling.
}

describe("installed health combined lifecycle regression", () => {
  it("keeps faults observable after eviction without reinstalling controls and forbids backward time", async () => {
    const { f, fault } = await faultFixture({ linked: true });
    await f.command(f.invocation());
    let rejected = 0;
    fault.intercept((_kind, url, _init, send) => {
      if (String(url).endsWith("/state-events/append")) { rejected++; throw Error("Injected authority failure after eviction"); }
      return send();
    });
    await evictDurableObject(f.ownerStub); // Deliberately do not call fault.install().
    await fault.runUntil(Date.now() + 2000);
    expect(rejected).toBe(1);
    expect(fault.dispatches.some((row) => row.kind === "SHAREABLE_STATE_REALM")).toBe(true);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ attempts: 1, uncertain: 1 });
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    const now = Date.now(), before = fault.dispatches.length;
    await expect(fault.runUntil(now - 1)).rejects.toThrow("cannot move backward");
    expect(Date.now()).toBe(now); expect(fault.dispatches).toHaveLength(before);
  });

  it.each([
    { linked: false, platform: "discord", spacing: 5000, snapshotFirst: true },
    { linked: false, platform: "twitch", spacing: 15000, snapshotFirst: false },
    { linked: true, platform: "discord", spacing: 15000, snapshotFirst: false },
    { linked: true, platform: "twitch", spacing: 5000, snapshotFirst: true }
  ])("uses native pacing, both arrival orders and restart/reconnect without an animation-held ACK (%j)", async (options) => {
    const f = await nativeHealthFixture({ ...options, immediate: true });
    let displayed, starts = 0;
    const effects = createHealthEffectQueue({ isHidden: () => false, animate() {
      starts++; return { finished: new Promise(() => {}), cancel() {} };
    } }); queues.push(effects);
    const coordinator = createStateEventCoordinator({ onSnapshot: (cell) => { displayed = cell.value; }, onEvent: effects.accept });
    coordinator.initialize(await f.read());
    let c = await consumer(f), previousAt;
    for (let index = 0; index < 2; index++) {
      if (index) {
        const remaining = previousAt + options.spacing - Date.now();
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      const group = options.linked && index ? (options.platform === "discord" ? f.twitch : f.discord) : f.group;
      const input = f.invocation(group); previousAt = input.sourceCreatedAtMs;
      expect((await f.command(input)).output.message).toBe("Health saved and impact queued.");
      await expect.poll(() => c.frames.length, { timeout: 4500 }).toBe(1);
      const frame = c.frames[0], snapshot = await f.read();
      expect(frame.sequence).toBe(index + 1);
      expect(frame.receivedAtMs - input.sourceCreatedAtMs).toBeLessThan(4500);
      expect(snapshot).toMatchObject({ value: 99 - index, stateEvent: { operationSequence: index + 1 } });
      expect(frame).toMatchObject({ stateEvent: snapshot.stateEvent, payload: {
        operation: "damage", requestedAmount: 1, appliedAmount: 1, before: 100 - index, after: 99 - index, changed: true
      } });
      if (options.snapshotFirst) coordinator.update(snapshot);
      await coordinator.handle(frame);
      if (!options.snapshotFirst) {
        expect(displayed).toBe(100 - index); // Events never reconstruct health.
        coordinator.update(snapshot);
      }
      expect(displayed).toBe(99 - index);
      await ack(f, c, 0); // Native ACK while animation.finished never resolves.
      expect(await coordinator.handle(frame)).toMatchObject({ duplicate: true });
      await f.command(input); // Same source: no mutation or append after ACK.
      expect(await f.read()).toEqual(snapshot);
      if (!index) {
        effects.clear("reconnecting");
        c.socket.close(); await evictDurableObject(f.ownerStub);
        c = await consumer(f);
      }
    }
    expect(starts).toBe(2); expect(effects.pendingCount).toBe(0);
    expect(effects.runningCount).toBe(1);
    expect((await f.rows(f.streamStub, "durable_event_stream_metadata"))[0]).toMatchObject({ next_sequence: 3, acknowledged_sequence: 2 });
    await expect.poll(() => f.rows(f.ownerStub, "state_event_outbox"), { timeout: 4500 }).toEqual([]);
  }, 35_000);

  it.each([{ linked: false, platform: "twitch" }, { linked: true, platform: "discord" }])(
    "recovers an idle burst after missed activation, late alarm and owner eviction (%j)", async (options) => {
      const { f, clock, fault } = await faultFixture(options), inputs = [];
      for (let index = 0; index < 3; index++) {
        const group = options.linked && index % 2 ? f.twitch : f.group;
        const input = f.invocation(group); inputs.push(input); await f.command(input);
        clock.mockReturnValue(Date.now() + 1100);
      }
      const pending = await f.rows(f.ownerStub, "state_event_outbox");
      expect(pending.map((row) => row.attempts)).toEqual([0, 0, 0]);
      expect(await f.read()).toMatchObject({ value: 97, stateEvent: { operationSequence: 3 } });
      await evictDurableObject(f.ownerStub); await fault.install();
      clock.mockReturnValue(Date.now() + 60_000); // Deliberately late dispatch.
      await fault.runUntil(Date.now() + 10_000);
      const appended = await f.rows(f.ownerStub, "state_event_outbox");
      expect(appended).toHaveLength(3);
      expect(appended.every((row) => row.state === "appended" && row.attempts === 1)).toBe(true);
      const before = fault.calls.length, alarmsBefore = fault.dispatches.length;
      await fault.runUntil(Date.now() + 60_000);
      expect(fault.dispatches.slice(alarmsBefore)).toEqual([]); expect(fault.calls.length).toBe(before);
      const c = await consumer(f);
      for (let index = 0; index < 3; index++) {
        await expect.poll(() => c.frames.length).toBe(index + 1);
        expect(c.frames[index]).toMatchObject({ sequence: index + 1, stateEvent: { operationSequence: index + 1 }, payload: { after: 99 - index } });
        await ack(f, c, index); await f.command(inputs[index]);
      }
      await verifyClean(f, fault, 3, 97);
    });

  it.each([{ linked: false, platform: "discord" }, { linked: true, platform: "twitch" }])(
    "keeps an uncertain head ahead of its successor when a depth-rejected original arrives late (%j)", async (options) => {
      const { f, clock, fault } = await faultFixture(options), original = f.invocation();
      let delayed;
      fault.intercept((_kind, url, _init, send) => {
        if (String(url).endsWith("combined/append") && !delayed) {
          delayed = send; throw Error("Synthetic depth rejection with delayed original request");
        }
        return send();
      });
      await f.command(original); await fault.runUntil(Date.now() + 2000);
      const head = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
      expect(head).toMatchObject({ uncertain: 1, probe_state: 2, attempts: 1 });
      expect(await f.rows(f.streamStub, "state_event_destination_records")).toEqual([]);
      fault.intercept(null); expect((await delayed()).ok).toBe(true);
      clock.mockReturnValue(Date.now() + 1100);
      const next = f.invocation(options.linked ? f.discord : f.group); await f.command(next);
      await fault.runUntil(head.lease_until_ms - 1);
      expect((await f.rows(f.streamStub, "durable_event_stream_events")).map((row) => row.sequence)).toEqual([1]);
      expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ lease_token: head.lease_token, attempts: 1 });
      await evictDurableObject(f.ownerStub); await fault.install();
      await fault.runUntil(head.lease_until_ms + 10_000);
      const events = await f.rows(f.streamStub, "durable_event_stream_events");
      expect(events.map((row) => row.sequence).sort()).toEqual([1, 2]);
      expect(new Set(events.map((row) => row.event_id)).size).toBe(2);
      const c = await consumer(f);
      for (let index = 0; index < 2; index++) { await expect.poll(() => c.frames.length).toBe(index + 1); await ack(f, c, index); }
      await f.command(original); await f.command(next);
      await verifyClean(f, fault, 2, 98);
    });

  it.each([{ linked: false, platform: "twitch" }, { linked: true, platform: "discord" }])(
    "survives destination capacity, lost confirmation and post-ACK cleanup failure (%j)", async (options) => {
      const { f, clock, fault } = await faultFixture(options), input = f.invocation();
      await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
      await f.command(input); await fault.runUntil(Date.now() + 2000);
      const parked = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
      expect(parked).toMatchObject({ state: "pending", last_error: "durable_event_stream_full", attempts: 1 });
      expect(parked.next_wakeup_at_ms).toBe(parked.deadline_ms);
      const before = fault.calls.length, alarmsBefore = fault.dispatches.length;
      await fault.runUntil(Date.now() + 60_000);
      expect(fault.dispatches.slice(alarmsBefore)).toEqual([]); expect(fault.calls.length).toBe(before);
      await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 0"));
      let confirmFailed = false, releaseFailed = false;
      fault.intercept(async (_kind, url, _init, send) => {
        const result = await send();
        if (String(url).endsWith("combined/confirm") && !confirmFailed) { confirmFailed = true; throw Error("Synthetic confirmation reply loss"); }
        if (String(url).endsWith("combined/interest-release") && !releaseFailed) { releaseFailed = true; throw Error("Synthetic cleanup reply loss"); }
        return result;
      });
      const c = await consumer(f); await fault.runUntil(Date.now() + 2000);
      await expect.poll(() => c.frames.length).toBe(1);
      expect(confirmFailed).toBe(true);
      expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ destination_confirmed: 0 });
      await ack(f, c, 0);
      await evictDurableObject(f.ownerStub); await fault.install();
      // Follow durable leases and continuations; never zero a deadline/counter.
      clock.mockReturnValue(Date.now() + 30_001); await fault.runUntil(Date.now() + 5000);
      expect(releaseFailed).toBe(true);
      const retained = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
      expect(retained).toMatchObject({ state: "retiring" });
      expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0].rows).toBe(1);
      await evictDurableObject(f.ownerStub); await fault.install();
      await fault.runUntil(retained.lease_until_ms + 10_000);
      await f.command(input); await verifyClean(f, fault, 1, 99);
    });
});
