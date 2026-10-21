import { incrementalBill, measurementUsage, paidBill } from "./state-event-cost-model.js";

// Aggregate object-active seconds and Worker CPU are assumptions, never local
// callback timings. Cleanup allowances cover the measured ten-operation batch.
export const SCENARIO_ASSUMPTIONS = Object.freeze({ objectSeconds: 0.05, workerCpuMs: 5, storageGbMonth: 0 });
const combinedCleanup = Object.freeze({ receiptRowsRead: 64, receiptRowsWritten: 8, receiptRequests: 0.1 });
const eventCleanup = Object.freeze({ receiptRowsRead: 32, receiptRowsWritten: 3, receiptRequests: 0.1 });
const monthlyCommands = [10_000, 100_000, 1_000_000, 10_000_000];

function sumMeasurements(a, b) {
  return {
    rowsRead: a.rowsRead + b.rowsRead, rowsWritten: a.rowsWritten + b.rowsWritten,
    requests: a.requests + b.requests, incomingMessages: a.incomingMessages + b.incomingMessages,
    alarms: Object.fromEntries(["reads", "writes", "deletes", "invocations"].map((key) => [key, a.alarms[key] + b.alarms[key]]))
  };
}

export function summarizeStateEventCosts(measurements) {
  const find = (predicate, label) => {
    const matches = measurements.filter(predicate);
    if (matches.length !== 1) throw Error(`Expected exactly one ${label} measurement; found ${matches.length}`);
    return matches[0];
  };
  const health = find((row) => row.installedHealth && !row.immediate && row.warmOnline, "alarm-driven health");
  const immediateHealth = find((row) => row.installedHealth && row.immediate && row.warmOnline, "immediate health");
  const profiles = {
    eventOnly: { measurement: health.eventOnly, cleanup: eventCleanup },
    independentStateAndEvent: { measurement: sumMeasurements(health.stateOnly, health.eventOnly), cleanup: eventCleanup }
  };
  for (const immediate of [false, true]) {
    for (const shared of [false, true]) {
      const label = `${shared ? "shared" : "local"}${immediate ? "Immediate" : "Alarm"}`;
      const row = find((item) => !item.installedHealth && !!item.immediate === immediate && item.shared === shared && item.warmOnline, label);
      profiles[label] = { measurement: row.warmOnline, cleanup: combinedCleanup };
    }
  }
  profiles.healthAlarm = { measurement: health.warmOnline, cleanup: combinedCleanup };
  profiles.healthImmediate = { measurement: immediateHealth.warmOnline, cleanup: combinedCleanup };
  const estimates = Object.fromEntries(Object.entries(profiles).map(([name, { measurement, cleanup }]) => {
    const options = { ...SCENARIO_ASSUMPTIONS, ...cleanup };
    const usage = measurementUsage(measurement, 1_000_000, options);
    return [name, {
      perCommand: measurementUsage(measurement, 1, options),
      monthly: monthlyCommands.map((commands) => ({ commands, bill: paidBill(measurementUsage(measurement, commands, options)) })),
      incrementalOneMillionWithWriteAndRequestAllowancesSpent: incrementalBill(usage, { rowsWritten: 50_000_000, doRequests: 1_000_000 })
    }];
  }));
  return {
    assumptions: { ...SCENARIO_ASSUMPTIONS, combinedCleanup, eventCleanup }, profiles: estimates,
    // Overlapping requests on one object share duration; this input is already
    // the sum of non-overlapping active intervals across all involved objects.
    durationSensitivity: [0.05, 1, 5, 900].map((objectSeconds) => ({ objectSeconds,
      bill: paidBill(measurementUsage(immediateHealth.warmOnline, 1_000_000, { ...SCENARIO_ASSUMPTIONS, ...combinedCleanup, objectSeconds })) }))
  };
}
