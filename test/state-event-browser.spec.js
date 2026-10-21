import { describe, expect, it, vi } from "vitest";
import { createStateEventCoordinator, watchStateEvents } from "../public/event-stream/state-event.js";
import { validStateEvent } from "../public/event-stream/correlation.js";
const token = "ses1." + "a".repeat(22);
const marker = (sequence, stateRevision = sequence, scopeToken = token) => ({ version: 1, scopeToken, operationSequence: sequence, stateRevision });
const cell = (sequence, value = 100 - sequence, revision = sequence) => ({ state: "present", value, stateEvent: marker(sequence, revision) });
const event = (sequence) => ({ eventId: "dev1." + String(sequence).padStart(43, "a"), stateEvent: { ...marker(sequence), operationId: "seo1." + String(sequence).padStart(43, "b") }, payload: { after: 100 - sequence } });
function setup(options = {}) {
  const snapshots = [], impacts = [];
  const coordinator = createStateEventCoordinator({ storage: null, onSnapshot: (value) => snapshots.push(value), onEvent: (value, metadata) => impacts.push({ value, metadata }), ...options });
  return { coordinator, snapshots, impacts };
}
describe("state/event browser correlation", () => {
  it.each(["event", "snapshot"])("buffers startup history safely when %s arrives first", async (order) => {
    const { coordinator: c, impacts } = setup();
    if (order === "snapshot") c.initialize(cell(3));
    const handled = c.handle(event(2));
    if (order === "event") { await Promise.resolve(); expect(impacts).toEqual([]); c.initialize(cell(3)); }
    expect(await handled).toMatchObject({ historical: true }); expect(impacts).toEqual([]); c.close();
  });
  it("uses the newest watch result when the initial HTTP snapshot arrives late", async () => {
    const { coordinator: c, snapshots, impacts } = setup();
    const pending = c.handle(event(4)); c.update(cell(5)); c.initialize(cell(3));
    expect(await pending).toMatchObject({ historical: true }); expect(snapshots.at(-1).value).toBe(95); expect(impacts).toEqual([]); c.close();
  });
  it.each(["event", "snapshot"])("handles a live operation once when %s arrives first", async (order) => {
    const { coordinator: c, snapshots, impacts } = setup(); c.initialize(cell(0));
    if (order === "snapshot") c.update(cell(2));
    await c.handle(event(1));
    expect(impacts).toHaveLength(1); expect(impacts[0].metadata.stateIncluded).toBe(order === "snapshot");
    c.update(cell(1)); c.update(cell(2)); expect(snapshots.at(-1).value).toBe(98);
    expect(await c.handle(event(1))).toMatchObject({ duplicate: true }); expect(impacts).toHaveLength(1); c.close();
  });
  it("handles rapid updates and accepted zero-applied impacts without moving state backward", async () => {
    const { coordinator: c, snapshots, impacts } = setup(); c.initialize(cell(0, 100)); c.update(cell(3, 100));
    for (let i = 1; i <= 3; i++) { const value = event(i); value.payload = { after: 100, changed: false, appliedAmount: 0 }; await c.handle(value); }
    c.update(cell(2, 99)); expect(snapshots.at(-1).value).toBe(100); expect(impacts).toHaveLength(3); c.close();
  });
  it("requires a replacement baseline on reconnect and deliberately omits missed animations", async () => {
    const { coordinator: c, impacts } = setup(); c.initialize(cell(1)); await c.handle(event(2)); c.pause();
    const pending = c.handle(event(3)); c.initialize(cell(4)); expect(await pending).toMatchObject({ historical: true });
    await c.handle(event(5)); expect(impacts.map(({ value }) => value.stateEvent.operationSequence)).toEqual([2, 5]); c.close();
  });
  it("rejects scope changes instead of comparing unrelated sequences or acknowledging old-owner events", async () => {
    const { coordinator: c } = setup(); c.initialize(cell(1));
    const changed = event(2); changed.stateEvent.scopeToken = "ses1." + "b".repeat(22);
    await expect(c.handle(changed)).rejects.toMatchObject({ code: "state_event_scope_changed" });
    expect(() => c.update({ ...cell(2), stateEvent: changed.stateEvent })).toThrow("ownership changed"); c.close();
  });
  it("bounds buffering and times out when the separately authorized snapshot never arrives", async () => {
    const { coordinator: c } = setup({ snapshotTimeoutMs: 10 });
    const pending = c.handle(event(1)); const checked = expect(pending).rejects.toMatchObject({ code: "state_event_snapshot_timeout" });
    await expect(c.handle(event(2))).rejects.toMatchObject({ code: "state_event_backpressure" }); await checked; c.close();
  });
  it("does not remember a failed animation, and preserves bounded ID storage across instances", async () => {
    const values = new Map(), storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
    const handler = vi.fn().mockRejectedValueOnce(Error("animation failed")).mockResolvedValue(undefined);
    const { coordinator: c } = setup({ storage, onEvent: handler, maxRecentIds: 1 }); c.initialize(cell(0));
    await expect(c.handle(event(1))).rejects.toThrow("animation failed"); await c.handle(event(1)); c.close();
    const next = setup({ storage, maxRecentIds: 1 }); next.coordinator.initialize(cell(0));
    expect(await next.coordinator.handle(event(1))).toMatchObject({ duplicate: true });
    await next.coordinator.handle(event(2)); expect(JSON.parse([...values.values()][0])).toHaveLength(1); next.coordinator.close();
  });
  it("fails closed on missing/versioned correlation and preserves ordinary event compatibility", async () => {
    const { coordinator: c } = setup(); expect(() => c.initialize({ state: "present", value: 5 })).toThrow("correlated readable");
    await expect(c.handle({ ...event(1), stateEvent: { ...marker(1), version: 2 } })).rejects.toMatchObject({ code: "state_event_correlation_missing" });
    expect(validStateEvent(marker(0))).toBe(true); expect(validStateEvent(marker(0), { event: true })).toBe(false); c.close();
  });
  it("registers events before snapshot/watch, ignores obsolete reads, and stops both subscriptions on a gap", async () => {
    const callbacks = {}, reads = [], calls = [], statuses = [];
    const stateClient = { read: vi.fn(() => new Promise((resolve) => reads.push(resolve))), watch: vi.fn((_query, listener) => {
      calls.push("watch"); callbacks.state = listener; return { unsubscribe: () => calls.push("unwatch") };
    }) };
    const eventClient = { subscribe: vi.fn((handler, listener) => { calls.push("events"); callbacks.handle = handler; callbacks.event = listener; return { unsubscribe: () => calls.push("unevents") }; }) };
    const snapshots = [], impacts = [];
    const sub = watchStateEvents({ stateClient, eventClient, query: {}, selection: "value", storage: null,
      onSnapshot: (value) => snapshots.push(value), onEvent: (value) => impacts.push(value), onStatus: (status) => statuses.push(status) });
    expect(calls).toEqual(["events"]); callbacks.event.onStatus({ state: "live" }); expect(calls).toEqual(["events", "watch"]);
    const pending = callbacks.handle(event(2)); callbacks.state.onResult({ result: { status: "ready", data: { value: cell(3) } } });
    reads[0]({ status: "ready", data: { value: cell(1) } }); await pending; expect(impacts).toEqual([]); expect(snapshots.at(-1).value).toBe(97);
    callbacks.event.onStatus({ state: "reconnecting", stale: true }); callbacks.event.onStatus({ state: "live" });
    reads[1]({ status: "ready", data: { value: cell(4) } }); await vi.waitFor(() => expect(snapshots.at(-1).value).toBe(96));
    callbacks.event.onStatus({ state: "ended", code: "retention_gap" }); expect(calls.slice(-2)).toEqual(["unwatch", "unevents"]);
    expect(statuses.at(-1).code).toBe("retention_gap"); sub.unsubscribe();
  });
  it("ends both subscriptions on a mismatched owner event instead of retrying it indefinitely", async () => {
    let listener, handle, stops = 0; const statuses = [];
    const sub = watchStateEvents({ stateClient: { watch: () => ({ unsubscribe() { stops++; } }), read: async () => ({ status: "ready", data: { value: cell(0) } }) },
      eventClient: { subscribe(handler, options) { handle = handler; listener = options; return { unsubscribe() { stops++; } }; } }, selection: "value", storage: null,
      onSnapshot() {}, onEvent() {}, onStatus: (value) => statuses.push(value) });
    listener.onStatus({ state: "live" }); await Promise.resolve(); await Promise.resolve();
    const changed = event(1); changed.stateEvent.scopeToken = "ses1." + "b".repeat(22);
    await expect(handle(changed)).rejects.toMatchObject({ code: "state_event_scope_changed" });
    expect(stops).toBe(2); expect(statuses.at(-1).code).toBe("state_event_scope_changed"); sub.unsubscribe();
  });
  it("stops the event consumer if the read grant is denied", async () => {
    let listener, stop = 0;
    const sub = watchStateEvents({ stateClient: { watch: () => ({ unsubscribe() {} }), read: async () => { throw Object.assign(Error("denied"), { code: "query_access_denied" }); } },
      eventClient: { subscribe(_h, options) { listener = options; return { unsubscribe() { stop++; } }; } }, selection: "value", storage: null, onSnapshot() {}, onEvent() {} });
    listener.onStatus({ state: "live" }); await vi.waitFor(() => expect(stop).toBe(1)); sub.unsubscribe();
  });
});
