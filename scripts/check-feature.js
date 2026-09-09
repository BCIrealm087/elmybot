import { spawnSync } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isFeatureDefinition
} from "../packages/framework/index.js";
import { checkWorkspaceFeatures } from "./check-workspace-features.js";
import {
  FeatureCheckError,
  installedFeatureIssue,
  parseFeatureCheckArguments,
  workspaceDependencyIssue
} from "./feature-check-contract.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

async function readJson(file, stage) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new FeatureCheckError(
      `Could not read valid JSON from ${path.relative(process.cwd(), file)}.`,
      { stage, cause }
    );
  }
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function portableRelative(root, value) {
  return path.relative(root, value).split(path.sep).join("/");
}

function samePath(left, right) {
  const normalize = (value) => {
    const result = path.normalize(path.resolve(value));
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

async function locateFeature(root, slug) {
  const workspaceRoot = path.join(root, "packages", "features", slug);
  const localRoot = path.join(root, "src", "features", slug);
  const localSourcePath = path.join(localRoot, "feature.js");
  const workspace = await pathExists(path.join(workspaceRoot, "package.json"));
  const local = await pathExists(localSourcePath);
  const compatibilityReexport = workspace && local &&
    (await readFile(localSourcePath, "utf8"))
      .includes(`from "@elmybot/feature-${slug}"`);
  if (workspace && local && !compatibilityReexport) {
    throw new FeatureCheckError(
      `${slug} exists as both a workspace and repository-local feature.`,
      {
        next: "Choose one ownership location and remove the unintended duplicate.",
        code: "feature_check_location_ambiguous"
      }
    );
  }
  if (!workspace && !local) {
    throw new FeatureCheckError(`No feature directory named ${slug} was found.`, {
      next:
        "Use a directory under packages/features or src/features, or run " +
        `npm run feature:new -- ${slug} --workspace.`,
      code: "feature_check_not_found"
    });
  }
  return workspace
    ? Object.freeze({
      kind: "workspace",
      root: workspaceRoot,
      sourcePath: path.join(workspaceRoot, "src", "feature.js"),
      testPath: path.join(workspaceRoot, "test", "feature.spec.js")
    })
    : Object.freeze({
      kind: "local",
      root: localRoot,
      sourcePath: localSourcePath,
      testPath: path.join(root, "test", "features", `${slug}.spec.js`)
    });
}

async function linkedWorkspacePath(root, packageName) {
  const linkPath = path.join(root, "node_modules", ...packageName.split("/"));
  try {
    const resolved = await realpath(linkPath);
    return portableRelative(root, resolved);
  } catch {
    return null;
  }
}

async function checkPackageLink(root, slug, feature) {
  if (feature.kind === "local") {
    return "Repository-local feature; no workspace package link is required.";
  }
  const stage = "Package link";
  const manifest = await readJson(path.join(feature.root, "package.json"), stage);
  const rootManifest = await readJson(path.join(root, "package.json"), stage);
  const lockfile = await readJson(path.join(root, "package-lock.json"), stage);
  const packageName = manifest.name;
  const packageVersion = manifest.version;
  const workspacePath = `packages/features/${slug}`;
  if (packageName !== `@elmybot/feature-${slug}`) {
    throw new FeatureCheckError(
      `${workspacePath}/package.json has package name "${packageName}".`,
      {
        stage,
        next: `Set its name to "@elmybot/feature-${slug}".`
      }
    );
  }
  const resolvedLink = await linkedWorkspacePath(root, packageName);
  const issue = workspaceDependencyIssue({
    packageName,
    packageVersion,
    workspacePath,
    rootDependency: rootManifest.dependencies?.[packageName],
    lockWorkspaceVersion: lockfile.packages?.[workspacePath]?.version,
    lockLink: lockfile.packages?.[`node_modules/${packageName}`],
    linkedWorkspacePath:
      resolvedLink !== null && samePath(path.join(root, resolvedLink), feature.root)
        ? workspacePath
        : resolvedLink
  });
  if (issue !== null) {
    throw new FeatureCheckError(issue.message, {
      stage,
      next: issue.next,
      code: "feature_check_package_unlinked"
    });
  }
  return `${packageName}@${packageVersion} is an exact dependency and workspace link.`;
}

async function importFeature(feature) {
  if (!await pathExists(feature.sourcePath)) {
    throw new FeatureCheckError("The feature source file is missing.", {
      stage: "Feature installation",
      next: `Create ${portableRelative(process.cwd(), feature.sourcePath)}.`
    });
  }
  let module;
  try {
    module = await import(pathToFileURL(feature.sourcePath).href);
  } catch (cause) {
    throw new FeatureCheckError(`The feature module could not load: ${cause.message}`, {
      stage: "Feature installation",
      next: "Fix the feature import or package-link error shown above.",
      cause
    });
  }
  if (!isFeatureDefinition(module.default)) {
    throw new FeatureCheckError(
      "The feature module does not default-export a defineFeature() result.",
      {
        stage: "Feature installation",
        next: "Default-export the feature definition from its source file."
      }
    );
  }
  return module.default;
}

async function checkInstalledOnce(root, definition) {
  let installedFeatures;
  try {
    ({ installedFeatures } = await import(pathToFileURL(
      path.join(root, "src", "features", "index.js")
    ).href));
  } catch (cause) {
    throw new FeatureCheckError(`The installed feature catalog could not load: ${cause.message}`, {
      stage: "Feature installation",
      next: "Fix the dependency or registry error shown above.",
      cause
    });
  }
  const count = installedFeatures.filter(({ id }) => id === definition.id).length;
  const issue = installedFeatureIssue({ featureId: definition.id, count });
  if (issue !== null) {
    throw new FeatureCheckError(issue.message, {
      stage: "Feature installation",
      next: issue.next,
      code: "feature_check_installation_invalid"
    });
  }
  return `${definition.id} appears exactly once in installedFeatures.`;
}

function executable(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

function runCommand(root, {
  stage,
  command = process.execPath,
  args,
  next,
  success
}) {
  console.log(`\n→ ${stage}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ??
      (result.signal ? `Process stopped by ${result.signal}.` : "Command exited unsuccessfully.");
    throw new FeatureCheckError(detail, {
      stage,
      next,
      code: "feature_check_command_failed"
    });
  }
  console.log(`✓ ${stage} — ${success}`);
}

async function checkCatalog(root, workspacePackages) {
  const { generateFeatureDocs } = await import("./generate-feature-docs.js");
  try {
    await generateFeatureDocs({ root, check: true, workspacePackages });
  } catch (cause) {
    throw new FeatureCheckError(cause.message, {
      stage: "Feature catalog",
      next: "Run npm run feature:docs, review the generated diff, then check again.",
      code: "feature_check_catalog_stale",
      cause
    });
  }
  return "docs/feature-catalog.md matches the installed registry.";
}

function pass(stage, detail) {
  console.log(`✓ ${stage} — ${detail}`);
}

export async function checkFeature({
  root = process.cwd(),
  slug,
  mode = "fast"
}) {
  const projectRoot = path.resolve(root);
  const feature = await locateFeature(projectRoot, slug);
  console.log(`Feature check (${mode}): ${slug}\n`);
  pass("Package link", await checkPackageLink(projectRoot, slug, feature));

  let workspacePackages;
  try {
    workspacePackages = await checkWorkspaceFeatures({ root: projectRoot });
  } catch (cause) {
    throw new FeatureCheckError(cause.message, {
      stage: "Workspace packages",
      next: "Fix the named workspace metadata or dependency, then run npm install.",
      cause
    });
  }
  pass("Workspace packages", "All feature workspace metadata is consistent.");

  const definition = await importFeature(feature);
  pass(
    "Feature installation",
    await checkInstalledOnce(projectRoot, definition)
  );

  if (!await pathExists(feature.testPath)) {
    throw new FeatureCheckError("The expected feature test file is missing.", {
      stage: "Behavior tests",
      next: `Create ${portableRelative(projectRoot, feature.testPath)}.`
    });
  }
  const testTarget = mode === "ready"
    ? []
    : [portableRelative(projectRoot, feature.testPath)];
  runCommand(projectRoot, {
    stage: mode === "ready" ? "Complete behavior suite" : "Behavior tests",
    args: [
      executable(projectRoot, "node_modules/vitest/vitest.mjs"),
      "--run",
      ...testTarget
    ],
    next: mode === "ready"
      ? "Fix the failing repository test shown above."
      : "Fix the failing feature behavior test shown above.",
    success: mode === "ready"
      ? "The complete Vitest suite passed."
      : `${testTarget[0]} passed.`
  });

  const lintTargets = mode === "ready"
    ? ["."]
    : [
      portableRelative(projectRoot, feature.sourcePath),
      portableRelative(projectRoot, feature.testPath)
    ];
  runCommand(projectRoot, {
    stage: "Public API boundary",
    args: [
      executable(projectRoot, "node_modules/eslint/bin/eslint.js"),
      ...lintTargets
    ],
    next: "Fix the ESLint or feature public-import violation shown above.",
    success: mode === "ready"
      ? "Full-project ESLint and feature-boundary rules passed."
      : "The feature source and test passed ESLint and boundary rules."
  });

  if (mode === "ready") {
    runCommand(projectRoot, {
      stage: "API boundary self-check",
      args: [path.join(projectRoot, "scripts", "check-feature-api-boundary.js")],
      next: "Fix the feature API boundary rule regression shown above.",
      success: "Allowed and forbidden import cases behaved as expected."
    });
  }

  pass(
    "Feature catalog",
    await checkCatalog(projectRoot, workspacePackages)
  );
  console.log(
    mode === "ready"
      ? `\nReady: ${definition.id} passed every local contributor gate.`
      : `\nFast check complete: ${definition.id} is ready for continued iteration.`
  );
}

async function main() {
  let parsed;
  try {
    parsed = parseFeatureCheckArguments(process.argv.slice(2));
    await checkFeature(parsed);
  } catch (error) {
    const failure = error instanceof FeatureCheckError
      ? error
      : new FeatureCheckError(error instanceof Error ? error.message : "Feature check failed.");
    console.error(`\n✗ ${failure.stage} — ${failure.message}`);
    if (failure.next !== null) console.error(`  Next: ${failure.next}`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === SCRIPT_PATH) await main();
