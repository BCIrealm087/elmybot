import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { measurementUsage, paidBill } from "./lib/state-event-cost-model.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output")) throw Error("Usage: npm run measure:state-events -- [--output path.json]");
const output = resolve(root, args[1] ?? "docs/state-event-cost-measurements.json");
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", "test/state-event-cost.spec.js", "--reporter=default", "--reporter=./scripts/state-event-cost-reporter.js"], {
  cwd: root, stdio: "inherit", env: { ...process.env, STATE_EVENT_COST_OUTPUT: output }
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const report = JSON.parse(readFileSync(output, "utf8"));
const profiles = report.measurements.filter((item) => item.warmOnline);
console.log(`\nNative workerd measurements: ${output}`);
for (const item of profiles) {
  const usage = measurementUsage(item.warmOnline, 1_000_000, { receiptRowsRead: 64, receiptRowsWritten: 8, receiptRequests: 0.1 });
  console.log(`${item.installedHealth ? "Installed health" : item.shared ? "Shared" : "Local"} warmed cycle: ${item.warmOnline.rowsWritten} SQL writes; ${usage.rowsWritten / 1e6} modeled writes/command including alarm and receipt-cleanup allowances. 1M-command scenario $${paidBill(usage).total.toFixed(2)} including the $5 plan.`);
}
