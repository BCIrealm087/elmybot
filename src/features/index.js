import { createFeatureRegistry } from "../framework/index.js";
import { aliveFeature } from "./alive/feature.js";
import { discordRoleAccessFeature } from "./discord-role-access/feature.js";

// Feature installation is explicit while legacy registries continue to coexist
// during the staged migration.
export const installedFeatures = Object.freeze([
  aliveFeature,
  discordRoleAccessFeature
]);
export const featureRegistry = createFeatureRegistry(installedFeatures);
