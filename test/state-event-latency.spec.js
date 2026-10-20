import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupDeliveryFixtures, deliveryFixture } from "./helpers/state-event-delivery-fixture.js";

afterEach(async () => { await cleanupDeliveryFixtures(); vi.restoreAllMocks(); });

describe("state-event scheduling at ordinary command spacing", () => {
  // Real clocks, native SQL, alarms, RPC, WebSocket registration and ACKs. Do
  // not force due dates, expire leases, or call alarm/drain from the test. This
  // catches application scheduling regressions, not Cloudflare placement jitter.
  it.each([{ shared: false, spacing: 5000 }, { shared: false, spacing: 15000 }, { shared: true, spacing: 5000 }, { shared: true, spacing: 15000 }])(
    "publishes and ACKs three commands without a lease-length stall (%j)", async ({ shared, spacing }) => {
      const f = await deliveryFixture({ shared });
      f.testEnv.STATE_EVENT_DIAGNOSTICS = "true";
      const logs = [];
      vi.spyOn(console, "log").mockImplementation((value) => {
        try { const record = JSON.parse(value); if (record.event === "state_event.trace") logs.push(record); } catch { /* unrelated logs */ }
      });
      const grant = f.grant();
      expect((await f.streamCall("grants/issue", grant)).status).toBe(201);
      const socket = await f.openSocket(grant.grantId), frames = [];
      socket.addEventListener("message", ({ data }) => {
        const event = JSON.parse(data);
        if (event.type === "event") {
          frames.push({ ...event, receivedAtMs: Date.now() });
          socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: event.cursor }));
        }
      });
      socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
      const accepted = [];
      for (let index = 0; index < 3; index++) {
        if (index) {
          const remaining = accepted[index - 1].receipt.committedAtMs + spacing - Date.now();
          if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        const next = await f.commit(); accepted.push(next);
        await expect.poll(() => frames.length, { timeout: 4500 }).toBe(index + 1);
        expect(frames[index].eventId).toBe(next.receipt.eventId);
        expect(Date.parse(frames[index].acceptedAt) - next.receipt.committedAtMs).toBeLessThan(4000);
        expect(frames[index].receivedAtMs - next.receipt.committedAtMs).toBeLessThan(4500);
      }
      await expect.poll(() => logs.filter((row) => row.stage === "socket.ack").length).toBe(3);
      // ACK cleanup can use the one-second coalesced wake after publication.
      // Vitest's default one-second poll races that valid future deadline.
      await expect.poll(() => f.rows(f.ownerStub, "state_event_outbox"), { timeout: 4500 }).toEqual([]);
      expect(frames.map((row) => row.sequence)).toEqual([1, 2, 3]);
      for (const next of accepted) {
        expect(logs.some((row) => row.stage === "commit" && row.operationId === next.operationId)).toBe(true);
        expect(logs.some((row) => row.stage === "relay.claim" && row.operationId === next.operationId)).toBe(true);
        expect(logs.some((row) => row.stage === "destination.append" && row.operationId === next.operationId)).toBe(true);
      }
      expect(logs.some((row) => row.stage === "alarm.start" && Number.isSafeInteger(row.scheduledAtMs))).toBe(true);
      expect(logs.some((row) => row.reason === "uncertain")).toBe(false);
    }, 55_000);
});
