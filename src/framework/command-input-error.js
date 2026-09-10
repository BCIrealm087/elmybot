import { SchemaValidationError } from "./argument-schema.js";

// Presentation only: retain the original validation error for diagnostics.
export function formatCommandInputError(error, command) {
  const validation = error instanceof SchemaValidationError ? error
    : ["action_arguments_invalid", "discord_feature_scheduling_error"].includes(error?.code) &&
        error.cause instanceof SchemaValidationError
      ? error.cause : null;
  if (!validation) return null;

  const commandName = `${command.platform === "discord" ? "/" : "!"}${command.name}`;
  const field = validation.path?.replace(/^(?:scheduled )?arguments(?:\.|$)/, "").split(".")[0];
  const option = command.options?.find(({ arg }) => arg === field);
  const label = option?.name ?? (field && /^[a-z][a-z0-9_]{0,63}$/.test(field)
    ? (command.platform === "discord" ? "input" : field.replaceAll("_", " "))
    : "arguments");
  let explanation = `${label} ${validation.reason}`;
  if (command.platform === "twitch" && validation.path === "arguments") {
    if (validation.reason === "contains an unterminated quote.") {
      explanation = "Close the double quote around multi-word text.";
    } else if (validation.reason === "contains too many values.") {
      explanation = "Too many arguments. Put multi-word values in double quotes.";
    } else if (validation.reason === "does not accept a value.") {
      explanation = "This command does not take arguments.";
    }
  }
  const usage = command.usage ?? (command.parse?.kind === "none" ? commandName : null);
  const example = usage ? ` Example: ${usage}` : "";
  const prefix = `${commandName}: `;
  const remaining = 500 - prefix.length - example.length;
  const detail = explanation.length > remaining
    ? `${explanation.slice(0, remaining - 1)}…` : explanation;
  return `${prefix}${detail}${example}`;
}
