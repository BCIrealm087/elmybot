import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { summarizeStateEventCosts } from "./lib/state-event-cost-summary.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output")) throw Error("Usage: npm run measure:state-events -- [--output path.json]");
const output = resolve(root, args[1] ?? "docs/state-event-cost-measurements.json");
const temporary = `${output}.tmp-${process.pid}`;
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", "test/state-event-cost.spec.js", "test/state-event-activation.spec.js", "test/state-event-receipt-probe.spec.js",
  "test/state-event-cost-model.spec.js",
  "--reporter=default", "--reporter=./scripts/state-event-cost-reporter.js"], {
  cwd: root, stdio: "inherit", env: { ...process.env, STATE_EVENT_COST_OUTPUT: temporary }
});
try {
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const report = JSON.parse(readFileSync(temporary, "utf8"));
    report.scenarios = summarizeStateEventCosts(report.measurements);
    writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
    renameSync(temporary, output);
    console.log(`\nNative workerd measurements: ${output} (${report.measurements.length} profiles)`);
    for (const [name, profile] of Object.entries(report.scenarios.profiles)) {
      const bill = profile.monthly.find((row) => row.commands === 1_000_000).bill;
      console.log(`${name}: ${profile.perCommand.rowsWritten} modeled writes/command; 1M-command scenario $${bill.total.toFixed(2)} including the $5 plan.`);
    }
  }
} finally {
  // A failing/incomplete measurement must not replace the accepted baseline.
  rmSync(temporary, { force: true });
}
