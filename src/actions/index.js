import { coreActions } from "./core.js";
import { createActionRegistry } from "./registry.js";

export const actionRegistry = createActionRegistry(coreActions);

export {
  ActionRegistryError,
  createActionRegistry,
  executeAction
} from "./registry.js";
export { CORE_ACTION_KINDS, coreActions } from "./core.js";
