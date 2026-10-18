import { describe, expect, it } from "vitest";
import { incrementalBill, measurementUsage, paidBill } from "../scripts/lib/state-event-cost-model.js";

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
});
