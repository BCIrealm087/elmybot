import { StateEventRecoveryError } from "./identity.js";

// Translate only the known unavailable outcome. Unknown acceptance must retain
// its error path: it may already have committed and must not invite a new command.
export function formatStateEventCommandError(error) {
  if (!(error instanceof StateEventRecoveryError) || error.code !== "state_event_service_unavailable") return null;
  return "This command is currently unavailable. Ask the bot operator to check whether it is enabled.";
}
