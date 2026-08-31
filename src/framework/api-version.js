export const frameworkApiVersion = 1;

// Kept as a compatibility alias for code written before the public API was
// stabilized. New feature modules should use `frameworkApiVersion`.
/** @deprecated Use frameworkApiVersion. */
export const FEATURE_FRAMEWORK_API_VERSION = frameworkApiVersion;

export const supportedFrameworkApiVersions = Object.freeze([
  frameworkApiVersion
]);
