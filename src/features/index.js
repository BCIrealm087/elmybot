import { createFeatureRegistry } from "../framework/index.js";

// Feature installation is explicit. Framework migrations add reviewed feature
// modules to this list while legacy command and action registries continue to
// coexist during the staged rollout.
export const installedFeatures = Object.freeze([]);
export const featureRegistry = createFeatureRegistry(installedFeatures);
