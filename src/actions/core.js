import { ALIVE_ACTION_KIND } from "../features/alive/feature.js";

export const CORE_ACTION_KINDS = Object.freeze({
  ALIVE: ALIVE_ACTION_KIND
});

// Kept as an empty compatibility export while the action itself is installed
// through the contributor-facing feature catalog.
export const coreActions = Object.freeze({});
