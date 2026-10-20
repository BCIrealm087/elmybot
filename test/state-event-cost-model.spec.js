import { describe, expect, it } from "vitest";
import { incrementalBill, measurementUsage, paidBill } from "../scripts/lib/state-event-cost-model.js";
import { summarizeStateEventCosts } from "../scripts/lib/state-event-cost-summary.js";

const measurement = (rowsWritten, requests, writes, invocations) => ({ rowsRead: 100, rowsWritten, requests, incomingMessages: 1,
  alarms: { reads: 1, writes, deletes: 1, invocations } });
function measuredProfiles() {
  return [
    { installedHealth: true, shared: true, warmOnline: measurement(118, 14, 16, 3),
      eventOnly: measurement(23, 5, 3, 0), stateOnly: { ...measurement(4, 1, 0, 0), incomingMessages: 0, alarms: { reads: 0, writes: 0, deletes: 0, invocations: 0 } } },
    { installedHealth: true, shared: true, immediate: true, warmOnline: measurement(118, 14, 13, 1) },
    ...[false, true].flatMap((shared) => [false, true].map((immediate) => ({ shared, immediate,
      warmOnline: measurement(shared ? 118 : 105, shared ? 14 : 8, immediate ? 13 : 16, immediate ? 1 : 3) }))),
    // Append-only profiles must never be mistaken for a complete online cycle.
    { shared: true, immediate: true, warm: measurement(90, 10, 4, 0) }
  ];
}

describe("state/event pricing scenarios", () => {
  it("applies monthly allowances once and rounds Durable Object overage units", () => {
    expect(paidBill({ doRequests: 1_000_001, doGbSeconds: 400_001, rowsWritten: 50_000_001 }))
      .toMatchObject({ doRequests: 0.15, doGbSeconds: 12.5, rowsWritten: 1, total: 18.65 });
  });
  it("computes marginal cost from existing account usage rather than giving every feature a fresh allowance", () => {
    expect(incrementalBill({ rowsWritten: 2_000_000 }, { rowsWritten: 49_000_000 })).toBe(1);
    expect(incrementalBill({ rowsWritten: 2_000_000 }, { rowsWritten: 50_000_000 })).toBe(2);
    expect(incrementalBill({ doRequests: 1 }, { doRequests: 1_000_001 })).toBe(0);
  });
  it("counts RPCs, alarms and 20:1 incoming messages separately, with explicit timing assumptions", () => {
    const usage = measurementUsage({ rowsRead: 100, rowsWritten: 117, requests: 19, incomingMessages: 1,
      alarms: { reads: 12, writes: 12, deletes: 1, invocations: 3 } }, 1_000_000, { objectSeconds: 0.05 });
    expect(usage).toMatchObject({ rowsRead: 112_000_000, rowsWritten: 130_000_000, doRequests: 22_050_000,
      doGbSeconds: 6400, workerCpuMs: 5_000_000 });
    expect(paidBill(usage).total).toBe(88.3);
    const withCleanup = measurementUsage({ rowsRead: 3922, rowsWritten: 117, requests: 19, incomingMessages: 1,
      alarms: { reads: 12, writes: 12, deletes: 1, invocations: 3 } }, 1_000_000,
    { receiptRowsRead: 64, receiptRowsWritten: 8, receiptRequests: 0.1 });
    expect(withCleanup.rowsWritten).toBe(138_000_000);
    expect(paidBill(withCleanup).total).toBe(96.3);
  });
  it("rejects invalid usage rather than producing a misleading negative estimate", () => {
    expect(() => paidBill({ rowsWritten: -1 })).toThrow();
    expect(() => paidBill({ doGbSeconds: Infinity })).toThrow();
    expect(() => measurementUsage({ alarms: {} }, -1)).toThrow();
  });
  it("prices complete immediate cycles separately from fallback, append-only and independent references", () => {
    const result = summarizeStateEventCosts(measuredProfiles());
    expect(result.profiles.healthImmediate.perCommand).toMatchObject({ rowsWritten: 140, doRequests: 15.15, doGbSeconds: 0.0064 });
    expect(result.profiles.healthAlarm.perCommand.rowsWritten).toBe(143);
    expect(result.profiles.healthAlarm.perCommand.doRequests).toBeCloseTo(17.15);
    expect(result.profiles.healthImmediate.monthly.find((row) => row.commands === 1_000_000).bill.total).toBe(97.25);
    expect(result.profiles.independentStateAndEvent.perCommand.rowsWritten - result.profiles.eventOnly.perCommand.rowsWritten).toBe(4);
    expect(result.profiles.healthImmediate.incrementalOneMillionWithWriteAndRequestAllowancesSpent).toBe(142.4);
    expect(result.durationSensitivity.map(({ bill }) => bill.doGbSeconds)).toEqual([0, 0, 12.5, 1437.5]);
  });
  it("rejects incomplete or ambiguous profile sets instead of publishing a partial baseline", () => {
    expect(() => summarizeStateEventCosts(measuredProfiles().filter((row) => !row.immediate))).toThrow("immediate health");
    const rows = measuredProfiles();
    expect(() => summarizeStateEventCosts([...rows, rows[1]])).toThrow("found 2");
  });
});
