import { describe, expect, it, vi } from "vitest";
import { createHealthEffectQueue, MAX_PENDING_HEALTH_EFFECTS } from "../public/health-widget/effects.js";
import { createStateEventCoordinator } from "../public/event-stream/state-event.js";

const marker = (sequence) => ({ version: 1, scopeToken: "ses1." + "a".repeat(22), operationSequence: sequence, stateRevision: sequence });
const event = (sequence) => ({ eventId: "dev1." + String(sequence).padStart(43, "a"), stateEvent: { ...marker(sequence), operationId: "seo1." + String(sequence).padStart(43, "b") },
  payload: { operation: "damage", requestedAmount: 1, appliedAmount: 1, before: 100, after: 99, changed: true } });
const snapshot = (sequence, value = 100) => ({ state: "present", value, stateEvent: marker(sequence) });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness(options = {}) {
  const animations = [], traces = [];
  let hidden = false;
  const animate = vi.fn((effect) => {
    let resolve, reject; const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
    const animation = { finished, cancel: vi.fn() }; animations.push({ effect, animation, resolve, reject }); return animation;
  });
  const queue = createHealthEffectQueue({ animate, isHidden: () => hidden, onDiagnostic: (trace) => traces.push(trace), ...options });
  return { queue, animations, traces, animate, hide(value = true) { hidden = value; queue.visibilityChanged(); } };
}

describe("health widget cosmetic acceptance queue", () => {
  it("accepts correlated events without waiting for an animation that never resolves", async () => {
    const { queue, animations } = harness(), drawn = [];
    const coordinator = createStateEventCoordinator({ storage: null, onSnapshot: (cell) => drawn.push(cell.value), onEvent: queue.accept });
    coordinator.initialize(snapshot(0));
    expect(await coordinator.handle(event(1))).toEqual({ duplicate: false, historical: false });
    expect(animations).toHaveLength(1); expect(queue.runningCount).toBe(1);
    coordinator.update(snapshot(2, 70));
    expect(await coordinator.handle(event(2))).toEqual({ duplicate: false, historical: false });
    expect(queue.pendingCount).toBe(1); expect(drawn).toEqual([100, 70]);
    coordinator.close(); queue.close();
  });

  it("keeps only eight pending descriptors and drops the oldest pending effect under a burst", async () => {
    const { queue, animations, traces } = harness();
    for (let index = 1; index <= 1000; index++) {
      expect(queue.accept(event(index))).toBeUndefined();
      expect(queue.pendingCount).toBeLessThanOrEqual(MAX_PENDING_HEALTH_EFFECTS); expect(queue.runningCount).toBe(1);
    }
    expect(animations).toHaveLength(1); expect(queue.pendingCount).toBe(8);
    expect(traces.filter((t) => t.stage === "animation.drop")).toHaveLength(991);
    for (let index = 0; index < 9; index++) { animations[index].resolve(); await flush(); }
    expect(animations.map((a) => a.effect.eventId)).toEqual([1, ...Array.from({ length: 8 }, (_, i) => 993 + i)].map((n) => event(n).eventId));
    expect(animations.every((a) => Object.keys(a.effect).sort().join(",") === "eventId,operation,operationId")).toBe(true);
    expect(queue.pendingCount).toBe(0); expect(queue.runningCount).toBe(0); queue.close();
  });

  it("cancels running/pending work on hiding, ACKs hidden impacts by acceptance, and resumes only new effects", async () => {
    const { queue, animations, hide } = harness(); queue.accept(event(1)); queue.accept(event(2));
    hide(); expect(animations[0].animation.cancel).toHaveBeenCalledOnce();
    for (let index = 3; index <= 50; index++) queue.accept(event(index));
    expect(queue.pendingCount).toBe(0); expect(queue.runningCount).toBe(0); expect(animations).toHaveLength(1);
    hide(false); await flush(); expect(animations).toHaveLength(1);
    queue.accept(event(51)); expect(animations).toHaveLength(2);
    // A delayed finish from the cancelled animation cannot clear the new one.
    animations[0].resolve(); await flush(); expect(queue.runningCount).toBe(1);
    animations[1].resolve(); await flush(); expect(queue.runningCount).toBe(0); queue.close();
  });

  it.each(["reconnecting", "credentials", "ended", "obsolete"])("clears obsolete work on %s and fences late rejection", async (reason) => {
    const { queue, animations } = harness(); queue.accept(event(1)); queue.accept(event(2));
    queue.clear(reason); queue.accept(event(3)); queue.accept(event(4));
    animations[0].reject(Error("old animation cancellation")); await flush();
    expect(animations).toHaveLength(2); expect(queue.runningCount).toBe(1); expect(queue.pendingCount).toBe(1);
    animations[1].resolve(); await flush(); expect(animations.at(-1).effect.eventId).toBe(event(4).eventId); queue.close();
  });

  it.each([false, true])("rejects malformed impacts before acceptance or overflow eviction (hidden=%s)", async (hidden) => {
    const { queue, hide, animations, traces } = harness();
    queue.accept(event(1)); for (let n = 2; n <= 9; n++) queue.accept(event(n));
    if (hidden) hide();
    const pending = queue.pendingCount;
    for (const payload of [null, {}, { ...event(1).payload, before: -1 }, { ...event(1).payload, after: 101 },
      { ...event(1).payload, operation: "reset" }, { ...event(1).payload, requestedAmount: 0 }, { ...event(1).payload, appliedAmount: 0.5 }, { ...event(1).payload, changed: "false" }]) {
      expect(() => queue.accept({ ...event(10), payload })).toThrow("Invalid v2 health impact");
    }
    expect(queue.pendingCount).toBe(pending); expect(traces.filter((t) => t.stage === "animation.drop")).toHaveLength(0);
    expect(animations).toHaveLength(1); queue.close();
  });

  it("does not enqueue duplicate, replayed or mismatched-scope events and never derives displayed health from effects", async () => {
    const { queue, animations } = harness(), drawn = [];
    const coordinator = createStateEventCoordinator({ storage: null, onSnapshot: (cell) => drawn.push(cell.value), onEvent: queue.accept });
    coordinator.initialize(snapshot(3, 75));
    expect(await coordinator.handle(event(1))).toMatchObject({ historical: true });
    await coordinator.handle(event(4)); expect(await coordinator.handle(event(4))).toMatchObject({ duplicate: true });
    const wrong = event(5); wrong.stateEvent.scopeToken = "ses1." + "b".repeat(22);
    await expect(coordinator.handle(wrong)).rejects.toMatchObject({ code: "state_event_scope_changed" });
    expect(animations).toHaveLength(1); expect(queue.pendingCount).toBe(0); expect(drawn).toEqual([75]);
    coordinator.close(); queue.close();
  });

  it("keeps invalid live events retryable through the unchanged coordinator", async () => {
    const { queue } = harness();
    const coordinator = createStateEventCoordinator({ storage: null, onSnapshot: () => {}, onEvent: queue.accept });
    coordinator.initialize(snapshot(0));
    await expect(coordinator.handle({ ...event(1), payload: {} })).rejects.toThrow("Invalid v2 health impact");
    expect(await coordinator.handle(event(1))).toMatchObject({ duplicate: false }); coordinator.close(); queue.close();
  });

  it("accepts clamped no-ops as cosmetic impacts", () => {
    const { queue, animations } = harness();
    queue.accept({ ...event(1), payload: { operation: "heal", requestedAmount: 10, appliedAmount: 0, before: 100, after: 100, changed: false } });
    expect(animations[0].effect.operation).toBe("heal"); queue.close();
  });

  it("does not let animation or diagnostics failures reject valid event acceptance", async () => {
    const { queue, animations } = harness({ onDiagnostic: () => { throw Error("logger unavailable"); } });
    queue.accept(event(1)); queue.accept(event(2)); animations[0].reject(Error("effect failed")); await flush();
    expect(animations[0].animation.cancel).toHaveBeenCalledOnce(); expect(animations).toHaveLength(2); queue.close();
    const broken = harness({ animate: () => { throw Error("animation unavailable"); } });
    expect(() => broken.queue.accept(event(3))).not.toThrow(); expect(broken.queue.runningCount).toBe(0); broken.queue.close();
  });

  it("cancels and forgets everything on teardown, ignoring late completion", async () => {
    const { queue, animations } = harness(); queue.accept(event(1)); queue.accept(event(2)); queue.close();
    expect(animations[0].animation.cancel).toHaveBeenCalledOnce(); expect(queue.pendingCount).toBe(0); expect(queue.runningCount).toBe(0);
    animations[0].resolve(); await flush(); expect(animations).toHaveLength(1); expect(() => queue.accept(event(3))).toThrow("closed");
  });
});
