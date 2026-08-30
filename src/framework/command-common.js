import { isRegisteredCapability } from "./access.js";
import { isSchema, schema } from "./argument-schema.js";
import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const ACTION_COMMAND_TYPE = "action-command";
export const NATIVE_COMMAND_TYPE = "native-command";
export const SCHEDULED_ACTION_COMMAND_TYPE = "scheduled-action-command";
export const TWITCH_PARSER_TYPE = "twitch-parser";

export function normalizeCommandIdentity({ name, description }) {
  if (typeof name !== "string") throw new TypeError("Command name is invalid.");
  const normalizedName = name.toLowerCase();
  if (!COMMAND_NAME_PATTERN.test(normalizedName)) {
    throw new TypeError("Command name is invalid.");
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > 100
  ) {
    throw new TypeError("Command description is invalid.");
  }
  return { name: normalizedName, description };
}

export function requireActionKind(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/.test(value)
  ) {
    throw new TypeError("Command actionKind is invalid.");
  }
  return value;
}

export function requireCapability(value) {
  if (value !== null && typeof value !== "string") {
    throw new TypeError("Command capability is invalid.");
  }
  return value;
}

export function validateRegisteredCapability(value) {
  if (!isRegisteredCapability(value)) {
    throw new TypeError(`Command capability is not registered: \`${value}\`.`);
  }
}

export function requireObjectSchema(value = schema.object({})) {
  if (!isSchema(value) || value.kind !== "object") {
    throw new TypeError("Command input must be an object schema.");
  }
  return value;
}

export function markCommandDefinition(value, platform, mode) {
  return markFrameworkDefinition(value, `${platform}:${mode}`);
}

export function isCommandDefinition(value, platform, mode = null) {
  if (mode) return isFrameworkDefinition(value, `${platform}:${mode}`);
  return isFrameworkDefinition(value, `${platform}:${ACTION_COMMAND_TYPE}`) ||
    isFrameworkDefinition(value, `${platform}:${NATIVE_COMMAND_TYPE}`) ||
    isFrameworkDefinition(value, `${platform}:${SCHEDULED_ACTION_COMMAND_TYPE}`);
}

export function markTwitchParser(value) {
  return markFrameworkDefinition(value, TWITCH_PARSER_TYPE);
}

export function isTwitchParser(value) {
  return isFrameworkDefinition(value, TWITCH_PARSER_TYPE);
}
