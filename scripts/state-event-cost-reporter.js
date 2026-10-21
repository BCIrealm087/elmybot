import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { PRICE_DATE, PRICE_SOURCES } from "./lib/state-event-cost-model.js";
const require = createRequire(import.meta.url);

// Vitest's reporter runs in Node, outside the workerd test isolate. Task meta
// carries only aggregate counters and SQL text; never bindings or row values.
export default class StateEventCostReporter {
  measurements = [];
  onTestCaseResult(testCase) {
    const measurement = testCase.meta().stateEventCost;
    if (measurement) this.measurements.push({ name: testCase.name, ...measurement });
  }
  onTestRunEnd() {
    const report = JSON.stringify({ schemaVersion: 2, measuredAt: new Date().toISOString(),
      sourceCommit: process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      priceDate: PRICE_DATE, priceSources: PRICE_SOURCES,
      runtime: { node: process.versions.node, vitest: require("vitest/package.json").version, workerd: require("workerd/package.json").version },
      measurements: this.measurements.sort((a, b) => a.name.localeCompare(b.name)) }, null, 2) + "\n";
    if (process.env.STATE_EVENT_COST_OUTPUT) writeFileSync(process.env.STATE_EVENT_COST_OUTPUT, report);
    else console.log(report);
  }
}
