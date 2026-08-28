import { coreActions } from "./core.js";
import { integrationActions } from "./integration.js";
import { createActionRegistry } from "./registry.js";

export const actionRegistry = createActionRegistry(coreActions, integrationActions);

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
