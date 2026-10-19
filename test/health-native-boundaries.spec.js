import { afterEach, describe, expect, it } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import { nativeHealthFixture, cleanupNativeHealthFixtures } from "./helpers/installed-health-native-fixture.js";

afterEach(cleanupNativeHealthFixtures);
describe("installed health with raw native request boundaries", () => {
  it.each([false, true])("accepts, publishes and ACKs paced operations without per-hop injection (linked=%s)", async (linked) => {
    const f = await nativeHealthFixture({ linked });
    expect(f.route.key === f.otherRoute.key).toBe(linked);
    expect((await f.read()).value).toBe(100);
    const socket = await f.openSocket(), frames = [];
    socket.addEventListener("message", ({ data }) => {
      const frame = JSON.parse(data);
      if (frame.type === "event") {
        frames.push({ ...frame, receivedAtMs: Date.now() });
        socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: frame.cursor }));
      }
    });
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
    const controlsBefore = f.controlCalls;
    let first;
    for (let index = 0; index < 4; index++) {
      if (index) await new Promise((resolve) => setTimeout(resolve, 1200));
      const input = f.invocation(linked && index % 2 ? f.twitch : f.discord); first ??= input;
      expect((await f.command(input)).output.message).toBe("Health saved and impact queued.");
      await expect.poll(() => frames.length, { timeout: 4500 }).toBe(index + 1);
      expect(frames[index].payload.after).toBe(99 - index);
    }
    expect(f.controlCalls).toBe(controlsBefore);
    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(frames.map((frame) => frame.eventId)).size).toBe(4);
    expect(new Set(frames.map((frame) => frame.stateEvent.operationId)).size).toBe(4);
    // Eviction is an explicit lifecycle boundary, after the unmodified path.
    await evictDurableObject(f.ownerStub);
    expect((await f.read()).value).toBe(96);
    expect((await f.command(first)).output.message).toBe("Health saved and impact queued.");
    expect((await f.read()).value).toBe(96);
    expect((await f.read()).stateEvent.operationSequence).toBe(4);
    await expect.poll(() => f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
  }, 30_000);
});
