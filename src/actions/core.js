import {
  createActionDefinition,
  createActionResult
} from "../integrations/contracts.js";

export const CORE_ACTION_KINDS = Object.freeze({
  ALIVE: "core.health.check.v1"
});

export const coreActions = Object.freeze({
  [CORE_ACTION_KINDS.ALIVE]: createActionDefinition({
    kind: CORE_ACTION_KINDS.ALIVE,
    capability: null,
    supportedOrigins: ["discord", "twitch"],
    execute: () => createActionResult({
      output: { message: "I'm here!!1" }
    })
  })
});
