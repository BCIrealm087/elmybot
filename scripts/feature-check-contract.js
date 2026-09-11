const FEATURE_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/;

export class FeatureCheckError extends Error {
  constructor(message, {
    stage = "Feature selection",
    next = null,
    code = "feature_check_error"
  } = {}) {
    super(message);
    this.name = "FeatureCheckError";
    this.stage = stage;
    this.next = next;
    this.code = code;
  }
}

export function parseFeatureCheckArguments(argv) {
  let slug = null;
  let mode = "fast";
  let selectedMode = null;
  for (const argument of argv) {
    if (argument === "--fast" || argument === "--ready") {
      const nextMode = argument.slice(2);
      if (selectedMode !== null && selectedMode !== nextMode) {
        throw new FeatureCheckError("Choose either --fast or --ready, not both.", {
          code: "feature_check_mode_ambiguous"
        });
      }
      mode = nextMode;
      selectedMode = nextMode;
    } else if (argument.startsWith("--")) {
      throw new FeatureCheckError(`Unknown option: ${argument}.`, {
        code: "feature_check_option_unknown"
      });
    } else if (slug === null) {
      slug = argument;
    } else {
      throw new FeatureCheckError(`Unexpected argument: ${argument}.`, {
        code: "feature_check_argument_unexpected"
      });
    }
  }
  if (slug === null) {
    throw new FeatureCheckError(
      "Name the feature directory to check, for example `fun-hype`.",
      { code: "feature_check_slug_missing" }
    );
  }
  if (!FEATURE_SLUG_PATTERN.test(slug)) {
    throw new FeatureCheckError(
      "Feature name must use lowercase letters, digits, and single dashes.",
      { code: "feature_check_slug_invalid" }
    );
  }
  return Object.freeze({ slug, mode });
}

export function workspaceDependencyIssue({
  packageName,
  packageVersion,
  workspacePath,
  rootDependency,
  lockWorkspaceVersion,
  lockLink,
  linkedWorkspacePath
}) {
  if (rootDependency === undefined) {
    return Object.freeze({
      message: `${packageName} is not an exact root dependency.`,
      next: `Add "${packageName}": "${packageVersion}" to root dependencies, then run npm install.`
    });
  }
  if (rootDependency !== packageVersion) {
    return Object.freeze({
      message:
        `${packageName} root dependency is "${rootDependency}", expected ` +
        `"${packageVersion}".`,
      next:
        `Set "${packageName}" to "${packageVersion}" in root dependencies, ` +
        "then run npm install."
    });
  }
  if (
    lockWorkspaceVersion !== packageVersion ||
    lockLink?.link !== true ||
    lockLink?.resolved !== workspacePath
  ) {
    return Object.freeze({
      message: `package-lock.json does not contain the current ${packageName} workspace link.`,
      next: "Run npm install to update the lockfile and workspace links."
    });
  }
  if (linkedWorkspacePath === null) {
    return Object.freeze({
      message: `${packageName} is not linked in node_modules.`,
      next: "Run npm install to create the workspace link."
    });
  }
  if (linkedWorkspacePath !== workspacePath) {
    return Object.freeze({
      message: `${packageName} resolves outside its workspace directory.`,
      next: "Run npm install to rebuild the workspace link."
    });
  }
  return null;
}

export function installedFeatureIssue({ featureId, count }) {
  if (count === 1) return null;
  if (count === 0) {
    return Object.freeze({
      message: `${featureId} is not present in installedFeatures.`,
      next:
        "Import the feature in src/features/index.js and add it once to installedFeatures."
    });
  }
  return Object.freeze({
    message: `${featureId} appears ${count} times in installedFeatures.`,
    next: "Keep exactly one installedFeatures entry for this feature."
  });
}
