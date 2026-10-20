// Pricing assumptions are explicit inputs, separate from the native workerd
// counters. This is a reproducible scenario calculator, not invoice telemetry.
export const PRICE_DATE = "2026-10-20";
export const PRICE_SOURCES = Object.freeze([
  "https://developers.cloudflare.com/durable-objects/platform/pricing/",
  "https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/",
  "https://developers.cloudflare.com/workers/platform/pricing/"
]);
const dimensions = Object.freeze({
  doRequests: { included: 1_000_000, unit: 1_000_000, rate: 0.15, roundUp: true },
  doGbSeconds: { included: 400_000, unit: 1_000_000, rate: 12.50, roundUp: true },
  rowsRead: { included: 25_000_000_000, unit: 1_000_000, rate: 0.001, roundUp: true },
  rowsWritten: { included: 50_000_000, unit: 1_000_000, rate: 1, roundUp: true },
  storageGbMonth: { included: 5, unit: 1, rate: 0.20, roundUp: true },
  workerRequests: { included: 10_000_000, unit: 1_000_000, rate: 0.30, roundUp: false },
  workerCpuMs: { included: 30_000_000, unit: 1_000_000, rate: 0.02, roundUp: false }
});
function quantity(value) {
  if (!Number.isFinite(value) || value < 0) throw TypeError("Usage must be finite and nonnegative.");
  return value;
}
export function paidBill(usage = {}) {
  const costs = { subscription: 5 };
  for (const [name, { included, unit, rate, roundUp }] of Object.entries(dimensions)) {
    const overage = Math.max(0, quantity(usage[name] ?? 0) - included) / unit;
    costs[name] = (roundUp ? Math.max(0, Math.ceil(overage - 1e-12)) : overage) * rate;
  }
  return { ...costs, total: Math.round(Object.values(costs).reduce((sum, value) => sum + value, 0) * 100) / 100 };
}
export function addUsage(...items) {
  return Object.fromEntries(Object.keys(dimensions).map((key) => [key, items.reduce((sum, item) => sum + quantity(item[key] ?? 0), 0)]));
}
export function incrementalBill(added, existing = {}) {
  return Math.round((paidBill(addUsage(existing, added)).total - paidBill(existing).total) * 100) / 100;
}
export function measurementUsage(measurement, commands, { objectSeconds = 0.05, workerCpuMs = 5, storageGbMonth = 0,
  receiptRowsRead = 0, receiptRowsWritten = 0, receiptRequests = 0 } = {}) {
  for (const value of [commands, objectSeconds, workerCpuMs, storageGbMonth, receiptRowsRead, receiptRowsWritten, receiptRequests]) quantity(value);
  return {
    rowsRead: commands * (measurement.rowsRead + measurement.alarms.reads + receiptRowsRead),
    // Alarm API calls are not included in SQL cursor counters. Charge one row
    // per set/delete conservatively; a no-op/delete may meter differently.
    rowsWritten: commands * (measurement.rowsWritten + measurement.alarms.writes + measurement.alarms.deletes + receiptRowsWritten),
    doRequests: commands * (measurement.requests + measurement.alarms.invocations + measurement.incomingMessages / 20 + receiptRequests),
    doGbSeconds: commands * objectSeconds * 0.128,
    workerRequests: commands, workerCpuMs: commands * workerCpuMs, storageGbMonth
  };
}
