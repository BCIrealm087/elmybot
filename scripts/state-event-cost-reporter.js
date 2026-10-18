import { writeFileSync } from "node:fs";
import { PRICE_DATE, PRICE_SOURCES } from "./lib/state-event-cost-model.js";

// Vitest's reporter runs in Node, outside the workerd test isolate. Task meta
// carries only aggregate counters and SQL text; never bindings or row values.
export default class StateEventCostReporter {
  measurements = [];
  onTestCaseResult(testCase) {
    const measurement = testCase.meta().stateEventCost;
    if (measurement) this.measurements.push({ name: testCase.name, ...measurement });
  }
  onTestRunEnd() {
    const report = JSON.stringify({ schemaVersion: 1, priceDate: PRICE_DATE, priceSources: PRICE_SOURCES,
      runtime: { node: process.versions.node }, measurements: this.measurements }, null, 2) + "\n";
    if (process.env.STATE_EVENT_COST_OUTPUT) writeFileSync(process.env.STATE_EVENT_COST_OUTPUT, report);
    else console.log(report);
  }
}
