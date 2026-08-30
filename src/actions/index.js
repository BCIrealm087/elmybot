import { coreActions } from "./core.js";
import { integrationActions } from "./integration.js";
import { featureRegistry } from "../features/index.js";
import { createActionRegistry } from "./registry.js";
import { executeFeatureEvent } from "./feature-triggers.js";
import { createFeatureSchedulingHandlers } from "./scheduled-actions.js";

export const actionRegistry = createActionRegistry(
  coreActions,
  integrationActions,
  featureRegistry.actions
);

export function executeInstalledFeatureEvent(event, env) {
  return executeFeatureEvent({
    featureRegistry,
    actionRegistry,
    event,
    env
  });
}

export const featureSchedulingHandlers = createFeatureSchedulingHandlers(
  featureRegistry,
  actionRegistry
);

export {
  ActionRegistryError,
  createActionRegistry,
  executeAction
} from "./registry.js";
export { CORE_ACTION_KINDS, coreActions } from "./core.js";
export {
  INTEGRATION_ACTION_CAPABILITIES,
  INTEGRATION_ACTION_KINDS,
  integrationActions
} from "./integration.js";
