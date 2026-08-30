import path from "node:path";
import { featureApiBoundaryRule } from "./eslint/feature-api-boundary.js";

function reportsFor(specifier) {
  const reports = [];
  const visitors = featureApiBoundaryRule.create({
    filename: path.resolve("src/features/example/feature.js"),
    report: (report) => reports.push(report)
  });
  visitors.ImportDeclaration({ source: { value: specifier } });
  return reports;
}

for (const allowed of [
  "../../framework/index.js",
  "../another-feature/feature.js",
  "some-reviewed-package"
]) {
  if (reportsFor(allowed).length !== 0) {
    throw new Error(`Feature API boundary rejected allowed import: ${allowed}`);
  }
}

for (const forbidden of [
  "../../framework/feature-storage.js",
  "../../group-configuration.js",
  "../../integrations/coordinator.js",
  "../../platforms/twitch/channel-auth.js"
]) {
  if (reportsFor(forbidden).length !== 1) {
    throw new Error(`Feature API boundary accepted internal import: ${forbidden}`);
  }
}

const dynamicReports = [];
const dynamicVisitors = featureApiBoundaryRule.create({
  filename: path.resolve("src/features/example/feature.js"),
  report: (report) => dynamicReports.push(report)
});
dynamicVisitors.ImportExpression({ source: { type: "Identifier", name: "moduleName" } });
if (dynamicReports.length !== 1 || dynamicReports[0].messageId !== "dynamicImport") {
  throw new Error("Feature API boundary accepted a computed dynamic import.");
}
