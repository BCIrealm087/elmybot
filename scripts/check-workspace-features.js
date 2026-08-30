import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  frameworkApiVersion,
  isFeatureDefinition
} from "../packages/framework/index.js";

const root = process.cwd();
const workspaceRoot = path.join(root, "packages", "features");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

export async function checkWorkspaceFeatures() {
  const rootManifest = await readJson(path.join(root, "package.json"));
  const frameworkManifest = await readJson(
    path.join(root, "packages", "framework", "package.json")
  );
  requireEqual(frameworkManifest.name, "@elmybot/framework", "Framework package name is invalid.");
  requireEqual(frameworkManifest.private, true, "Framework workspace must remain private.");
  requireEqual(
    frameworkManifest.version,
    `${frameworkApiVersion}.0.0`,
    "Framework package major must match frameworkApiVersion."
  );
  requireEqual(
    rootManifest.dependencies?.[frameworkManifest.name],
    frameworkManifest.version,
    "The Worker must install the framework workspace explicitly."
  );

  const directories = (await readdir(workspaceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) throw new Error("No workspace feature packages are installed.");

  const summaries = [];
  for (const directory of directories) {
    const packageRoot = path.join(workspaceRoot, directory);
    const manifest = await readJson(path.join(packageRoot, "package.json"));
    const expectedName = `@elmybot/feature-${directory}`;
    requireEqual(manifest.name, expectedName, `Workspace ${directory} has an invalid package name.`);
    requireEqual(manifest.private, true, `${expectedName} must remain private in the first stage.`);
    requireEqual(manifest.type, "module", `${expectedName} must be an ES module package.`);
    requireEqual(manifest.exports?.["."], "./src/feature.js", `${expectedName} has an invalid export.`);
    requireEqual(
      manifest.peerDependencies?.[frameworkManifest.name],
      `^${frameworkManifest.version}`,
      `${expectedName} must declare the compatible framework peer dependency.`
    );
    requireEqual(manifest.elmybot?.kind, "feature", `${expectedName} has invalid Elmybot metadata.`);
    requireEqual(
      manifest.elmybot?.frameworkApiVersion,
      frameworkApiVersion,
      `${expectedName} metadata targets an unsupported framework API.`
    );

    const entryUrl = pathToFileURL(path.join(packageRoot, "src", "feature.js")).href;
    const module = await import(entryUrl);
    if (!isFeatureDefinition(module.default)) {
      throw new Error(`${expectedName} must default-export a defineFeature() result.`);
    }
    requireEqual(
      module.default.id,
      manifest.elmybot?.featureId,
      `${expectedName} metadata does not match its feature ID.`
    );
    requireEqual(
      module.default.apiVersion,
      frameworkApiVersion,
      `${expectedName} exports an incompatible feature.`
    );

    const installedVersion = rootManifest.dependencies?.[expectedName] ?? null;
    if (installedVersion !== null && installedVersion !== manifest.version) {
      throw new Error(`${expectedName} root dependency must match its workspace version.`);
    }
    summaries.push(Object.freeze({
      packageName: expectedName,
      featureId: module.default.id,
      installed: installedVersion !== null
    }));
  }
  return Object.freeze(summaries);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await checkWorkspaceFeatures();
}
