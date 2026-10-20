import { afterEach, describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { cleanupDeliveryFixtures } from "./helpers/state-event-delivery-fixture.js";
import { closeCostMeters, measuredDeliveryFixture } from "./helpers/state-event-cost-meter.js";
import { nativeHealthFixture, cleanupNativeHealthFixtures } from "./helpers/installed-health-native-fixture.js";
import { stateEventRequestGuard } from "./helpers/state-event-request-guard.js";
import { STATE_EVENT_WORK_LIMITS } from "../src/state-events/relay-work-budget.js";
import { drainStateEventRelay } from "../src/state-events/delivery-source.js";
import { requestStateEventActivation } from "../src/state-events/activation.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const settled = (f, count = 1) => expect.poll(async () => {
  const rows = await f.rows(f.ownerStub, "state_event_outbox");
  return rows.filter((row) => row.state === "appended" && row.destination_confirmed && !row.lease_token).length;
}, { timeout: 4000 }).toBe(count);
const alarm = (f) => f.meter.handler(f.ownerStub, f.ownerRole, "alarm", () =>
  runInDurableObject(f.ownerStub, (instance) => instance.alarm()));
afterEach(async () => { vi.restoreAllMocks(); await closeCostMeters(); await cleanupDeliveryFixtures(); await cleanupNativeHealthFixtures(); });

describe("immediate bounded state/event activation", () => {
  it.each([false, true])("publishes before fallback is due without dispatching alarms (shared=%s)", async (shared) => {
    const f = await measuredDeliveryFixture({ shared, immediate: true });
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    const guard = stateEventRequestGuard({ calls: STATE_EVENT_WORK_LIMITS.remoteCalls, depth: 2 });
    f.intercept((_kind, url, _init, send) => {
      const path = new URL(url).pathname;
      return path.includes("/combined/") || path === "/state-events/append" ? guard.request(path, send) : send();
    });
    const input = f.invocation(), receipt = await f.commit(input);
    await settled(f);
    expect(receipt.committedAtMs).toBe(now);
    const event = (await f.rows(f.streamStub, "durable_event_stream_events"))[0];
    expect(event.event_id).toBe(receipt.eventId); expect(event.accepted_at_ms).toBe(now);
    expect(guard.rejected).toBe(0); expect(guard.peak).toBeLessThanOrEqual(2);
    expect(guard.total).toBeLessThanOrEqual(STATE_EVENT_WORK_LIMITS.remoteCalls);
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBe(receipt.expiresAtMs);
    expect(await f.commit(input)).toEqual(receipt);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].attempts).toBe(1);
  });

  it("lets the registry commit release its queue and the command finish while append is blocked", async () => {
    const f = await measuredDeliveryFixture({ shared: true, immediate: true });
    let ownerReturned = false, appendFinished = false, appendStarted = false;
    f.intercept(async (kind, url, _init, send) => {
      const path = new URL(url).pathname;
      if (kind === "SHAREABLE_STATE_REALM" && path.endsWith("/state-event-commit")) {
        const response = await send();
        // Timer belongs to the calling DO context; externally resolved test
        // promises can incorrectly transfer workerd I/O ownership.
        await new Promise((resolve) => setTimeout(resolve, 100));
        ownerReturned = true; return response;
      }
      if (path.endsWith("/combined/append")) {
        expect(ownerReturned).toBe(true); appendStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await send(); appendFinished = true; return result;
      }
      return send();
    });
    const receipt = await f.commit();
    expect(receipt.stateEvent.operationSequence).toBe(1);
    expect(ownerReturned).toBe(true); expect(appendFinished).toBe(false);
    await settled(f); expect(appendStarted).toBe(true); expect(appendFinished).toBe(true);
  });

  it.each([false, true])("recovers a suppressed activation through the persisted fallback with the same identity (shared=%s)", async (shared) => {
    const f = await measuredDeliveryFixture({ shared });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const input = f.invocation(), receipt = await f.commit(input);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row).toMatchObject({ attempts: 0, lease_token: null, state: "pending" });
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBe(row.next_wakeup_at_ms);
    clock.mockReturnValue(row.next_wakeup_at_ms);
    await alarm(f); await settled(f);
    expect((await f.rows(f.streamStub, "durable_event_stream_events"))[0].event_id).toBe(receipt.eventId);
    expect(await f.commit(input)).toEqual(receipt);
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
  });

  it.each([false, true])("leaves coalesced work durable when another command arrives during a runner (shared=%s)", async (shared) => {
    const f = await measuredDeliveryFixture({ shared, immediate: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    let blocked = false;
    f.intercept(async (_kind, url, _init, send) => {
      if (new URL(url).pathname.endsWith("/combined/interest") && !blocked) {
        blocked = true; await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return send();
    });
    const first = await f.commit(); await expect.poll(() => blocked).toBe(true);
    clock.mockReturnValue(Date.now() + 1100); const second = await f.commit();
    const rows = await f.rows(f.ownerStub, "state_event_outbox");
    expect(rows.map((row) => row.attempts).sort()).toEqual([0, 1]);
    await settled(f);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
    // Shared cleanup can consume the next reservation before publication;
    // follow persisted continuation deadlines rather than forcing another row.
    for (let pass = 0; pass < 4 && (await f.rows(f.streamStub, "durable_event_stream_events")).length < 2; pass++) {
      clock.mockReturnValue(Math.max(Date.now(), f.meter.due(f.ownerStub, f.ownerRole)));
      await alarm(f);
    }
    await settled(f, 2);
    const events = (await f.rows(f.streamStub, "durable_event_stream_events")).sort((a, b) => a.sequence - b.sequence);
    expect(events.map((event) => event.event_id)).toEqual([first.eventId, second.eventId]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("prioritizes a new shared commit before eligible cleanup consumes its immediate budget", async () => {
    const f = await measuredDeliveryFixture({ shared: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await f.commit(); await f.drain(); await f.connect(); await f.ack(); await f.streamAlarm();
    const cleanup = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(cleanup).toMatchObject({ state: "appended", lease_token: null });
    expect(cleanup.next_wakeup_at_ms).toBeLessThanOrEqual(Date.now());
    clock.mockReturnValue(Date.now() + 1100);
    delete f.testEnv.STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED;
    const next = await f.commit();
    await expect.poll(async () => (await f.rows(f.streamStub, "durable_event_stream_events"))[0]?.event_id).toBe(next.eventId);
    await expect.poll(async () => (await f.rows(f.ownerStub, "state_event_outbox"))
      .find((row) => row.operation_id === next.operationId)?.lease_token).toBeNull();
    expect((await f.rows(f.ownerStub, "state_event_outbox")).find((row) => row.operation_id === next.operationId))
      .toMatchObject({ state: "appended", attempts: 1 });
    // The old terminal obligation stays charged for its own bounded recovery;
    // this first-publication preference does not claim a cleanup reservation.
    expect((await f.rows(f.ownerStub, "state_event_outbox")).some((row) => row.operation_id === cleanup.operation_id)).toBe(true);
  });

  it("does not suppress a new commit activation while ACK cleanup is awaiting origin retirement", async () => {
    const f = await measuredDeliveryFixture({ shared: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await f.commit(); await f.drain(); await f.connect(); await f.ack(); await f.streamAlarm();
    delete f.testEnv.STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED;
    let retiring = false;
    f.intercept(async (_kind, url, _init, send) => {
      if (String(url).endsWith("origin/retire")) {
        retiring = true; await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return send();
    });
    const wake = await f.testEnv.SHAREABLE_STATE_REALM.get(f.ownerStub.id).fetch("https://owner/internal/state-events/delivery/wake", {
      method: "POST", headers: { "x-elmybot-state-event-delivery": "v1" },
      body: JSON.stringify({ owner: f.owner, routeId: f.route.streamRouteId, version: 100 })
    });
    expect(wake.ok).toBe(true); await expect.poll(() => retiring).toBe(true);
    clock.mockReturnValue(Date.now() + 1100);
    const next = await f.commit();
    await expect.poll(async () => (await f.rows(f.streamStub, "durable_event_stream_events"))[0]?.event_id).toBe(next.eventId);
    await expect.poll(async () => (await f.rows(f.ownerStub, "state_event_outbox"))
      .find((row) => row.operation_id === next.operationId)?.lease_token).toBeNull();
    // Let the deliberately delayed RPC finish before fixture teardown.
    await expect.poll(() => f.rows(f.ownerStub, "state_event_outbox"), { timeout: 3000 }).toHaveLength(1);
  });

  it.each([false, true])("retains a lease after a failed immediate append and recovers through an alarm (replyLost=%s)", async (replyLost) => {
    const f = await measuredDeliveryFixture({ shared: true, immediate: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    f.intercept(async (_kind, url, _init, send) => {
      if (new URL(url).pathname.endsWith("/probe")) throw Error("receipt probe unavailable");
      if (new URL(url).pathname.endsWith("/combined/append")) {
        if (replyLost) await send();
        throw Error("private transport details");
      }
      return send();
    });
    const receipt = await f.commit();
    await expect.poll(async () => (await f.rows(f.ownerStub, "state_event_outbox"))[0].uncertain).toBe(1);
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row.attempts).toBe(1); expect(f.meter.due(f.ownerStub, f.ownerRole)).toBe(row.lease_until_ms);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(replyLost ? 1 : 0);
    f.intercept(null); clock.mockReturnValue(row.lease_until_ms); await alarm(f); await settled(f);
    const events = await f.rows(f.streamStub, "durable_event_stream_events");
    expect(events).toHaveLength(1); expect(events[0].event_id).toBe(receipt.eventId);
  });

  it.each(["offline", "full", "disabled", "reset"])("keeps %s work bounded without background polling", async (mode) => {
    const f = await measuredDeliveryFixture({ immediate: mode !== "disabled" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    if (mode === "full") await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
    if (mode === "reset") f.intercept((_kind, url, _init, send) => new URL(url).pathname.endsWith("/combined/append")
      ? Promise.resolve(Response.json({ code: "durable_event_gap_requires_reset" }, { status: 409 })) : send());
    const receipt = await f.commit();
    if (mode === "disabled") {
      f.testEnv.DURABLE_EVENT_STREAMS_ENABLED = "false";
      delete f.testEnv.STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED;
      await runInDurableObject(f.ownerStub, (instance) => requestStateEventActivation(instance.state, f.testEnv, "relay", () =>
        drainStateEventRelay(instance.state, f.testEnv, { activation: true })));
    }
    await expect.poll(async () => {
      const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
      return row.attempts === 1 && row.lease_token === null;
    }).toBe(true);
    const parked = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(parked.next_wakeup_at_ms).toBe(receipt.expiresAtMs);
    let requests = 0; f.intercept((_kind, _url, _init, send) => { requests++; return send(); });
    clock.mockReturnValue(Date.now() + 60_000); await alarm(f);
    expect(requests).toBe(0);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].attempts).toBe(1);
  });

  it("uses immediate reconnect/ACK wakeups and keeps their coalescing deadline durable", async () => {
    const f = await measuredDeliveryFixture({ immediate: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await f.commit(); await settled(f);
    await f.connect();
    // A charged attempt is visible before its wake RPC has completed. Wait
    // for completion before testing ACK inside the idle coalescing window; an
    // in-flight wake correctly retains its existing 30-second lease.
    await expect.poll(async () => {
      const interest = (await f.rows(f.streamStub, "state_event_producer_interest"))[0];
      return interest.attempts === 1 && interest.lease_token === null;
    }).toBe(true);
    // ACK inside the existing wake-coalescing window must not start another
    // local loop; the queued destination wake is still durably scheduled.
    await f.ack();
    const wake = (await f.rows(f.streamStub, "state_event_producer_interest"))[0];
    expect(wake.due_ms).toBe(Date.now() + 1000);
    clock.mockReturnValue(wake.due_ms); await f.streamAlarm();
    await expect.poll(() => f.rows(f.ownerStub, "state_event_outbox"), { timeout: 4000 }).toEqual([]);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });

  it.each([false, true])("delivers installed health over native bindings while alarms remain in the future (linked=%s)", async (linked) => {
    const f = await nativeHealthFixture({ linked, immediate: true }), socket = await f.openSocket(), frames = [];
    socket.addEventListener("message", ({ data }) => { const frame = JSON.parse(data); if (frame.type === "event") frames.push(frame); });
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
    // Only the application clock moves. The native dispatcher cannot fire the
    // resulting fallback alarm two minutes in its real-clock future.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    for (let index = 0; index < 8; index++) {
      const group = linked && index % 2 ? f.twitch : f.discord;
      const input = f.invocation(group); await f.command(input);
      try { await expect.poll(() => frames.length, { timeout: 4000 }).toBe(index + 1); }
      catch (error) {
        const snapshot = await runInDurableObject(f.ownerStub, (instance, state) => ({
          activationMode: instance.env.STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED,
          rows: state.storage.sql.exec("SELECT operation_sequence, state, attempts, lease_until_ms, next_wakeup_at_ms FROM state_event_outbox ORDER BY operation_sequence").toArray()
        }));
        console.error("Native activation scheduling failure", JSON.stringify(snapshot)); throw error;
      }
      expect(Date.parse(frames[index].acceptedAt)).toBe(Date.now());
      expect(frames[index].sequence).toBe(index + 1);
      await expect.poll(async () => (await f.rows(f.ownerStub, "state_event_outbox"))
        .some((row) => row.operation_id === frames[index].stateEvent.operationId && row.destination_confirmed && !row.lease_token)).toBe(true);
      socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: frames[index].cursor }));
      await expect.poll(() => f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
      clock.mockReturnValue(Date.now() + 1100);
    }
    expect(await f.read()).toMatchObject({ state: "present", value: 92, stateEvent: { operationSequence: 8 } });
  });

  it("does not claim through an active reset and resumes after the reset releases", async () => {
    const f = await measuredDeliveryFixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await f.commit(); const resetId = crypto.randomUUID();
    const request = async (operation) => {
      const response = await f.testEnv.CONFIG.get(f.ownerStub.id).fetch(`https://owner/internal/state-events/delivery/${operation}`, {
        method: "POST", headers: { "x-elmybot-state-event-delivery": "v1" },
        body: JSON.stringify({ owner: f.owner, routeId: f.route.streamRouteId, resetId })
      });
      expect(response.ok).toBe(true); return response.json();
    };
    await request("reset-prepare"); delete f.testEnv.STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED;
    await runInDurableObject(f.ownerStub, async (instance) => {
      const tasks = [], state = new Proxy(instance.state, { get(target, key) {
        if (key === "waitUntil") return (task) => tasks.push(task);
        return Reflect.get(target, key);
      } });
      requestStateEventActivation(state, f.testEnv, "relay", () => drainStateEventRelay(state, f.testEnv, { activation: true }));
      await Promise.all(tasks);
    });
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0]).toMatchObject({ attempts: 0, next_wakeup_at_ms: null });
    expect(f.meter.due(f.ownerStub, f.ownerRole)).toBeNull();
    await request("reset-commit"); await request("reset-release");
    await expect.poll(() => f.rows(f.ownerStub, "state_event_outbox"), { timeout: 4000 }).toEqual([]);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });

  it.for([false, true])("measures immediate command delivery without an extra relay request (shared=%s)", async (shared, { task }) => {
    const f = await measuredDeliveryFixture({ shared, immediate: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const cold = await f.meter.phase(async () => { await f.commit(); await settled(f); });
    clock.mockReturnValue(Date.now() + 1100);
    const warm = await f.meter.phase(async () => { await f.commit(); await settled(f, 2); });
    expect(cold.alarms.invocations).toBe(0); expect(warm.alarms.invocations).toBe(0);
    expect(Object.keys(warm.requestPaths).some((path) => path.endsWith("/activate"))).toBe(false);
    task.meta.stateEventCost = { shared, immediate: true, cold, warm };
  });

  it("swallows activation errors, suppresses duplicate runners, and never chains another pass", async () => {
    const gate = deferred(), tasks = [], state = { waitUntil: (task) => tasks.push(task) };
    const run = vi.fn(async () => { await gate.promise; throw Error("sensitive details"); });
    expect(requestStateEventActivation(state, {}, "relay", run)).toBe(true);
    expect(requestStateEventActivation(state, {}, "relay", run)).toBe(false);
    gate.resolve(); await Promise.all(tasks);
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestStateEventActivation({ waitUntil() { throw Error("registration failed"); } }, {}, "relay", async () => {})).toBe(true);
  });
});
