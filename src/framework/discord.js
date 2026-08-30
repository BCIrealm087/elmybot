import { schema } from "./argument-schema.js";
import {
  ACTION_COMMAND_TYPE,
  NATIVE_COMMAND_TYPE,
  markCommandDefinition,
  normalizeCommandIdentity,
  requireActionKind,
  requireCapability,
  requireObjectSchema
} from "./command-common.js";
import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const DISCORD_OPTION_TYPE = "discord-option";
const AVAILABILITY = new Set(["global", "guild"]);
const OPTION_TYPES = Object.freeze({
  string: 3,
  integer: 4,
  boolean: 5,
  user: 6,
  channel: 7,
  role: 8,
  number: 10
});

function requireAvailability(value) {
  if (!AVAILABILITY.has(value)) {
    throw new TypeError("Discord command availability is invalid.");
  }
  return value;
}

function optionalInteger(value, name, { min = 0 } = {}) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`Discord option ${name} is invalid.`);
  }
  return value;
}

function optionalNumber(value, name) {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Discord option ${name} is invalid.`);
  }
  return value;
}

export function discordOption({
  arg,
  name,
  description,
  type,
  required = false,
  minLength,
  maxLength,
  min,
  max,
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported Discord option field: \`${unknownFields[0]}\`.`);
  }
  if (typeof arg !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(arg)) {
    throw new TypeError("Discord option arg is invalid.");
  }
  const identity = normalizeCommandIdentity({ name, description });
  if (!(type in OPTION_TYPES)) throw new TypeError("Discord option type is invalid.");
  if (typeof required !== "boolean") throw new TypeError("Discord option required is invalid.");
  const normalizedMinLength = optionalInteger(minLength, "minLength");
  const normalizedMaxLength = optionalInteger(maxLength, "maxLength");
  if (
    normalizedMinLength !== null &&
    normalizedMaxLength !== null &&
    normalizedMinLength > normalizedMaxLength
  ) {
    throw new TypeError("Discord option minLength exceeds maxLength.");
  }
  const normalizedMin = optionalNumber(min, "min");
  const normalizedMax = optionalNumber(max, "max");
  if (normalizedMin !== null && normalizedMax !== null && normalizedMin > normalizedMax) {
    throw new TypeError("Discord option min exceeds max.");
  }
  if ((normalizedMinLength !== null || normalizedMaxLength !== null) && type !== "string") {
    throw new TypeError("Discord length constraints require a string option.");
  }
  if ((normalizedMin !== null || normalizedMax !== null) && !["integer", "number"].includes(type)) {
    throw new TypeError("Discord numeric constraints require a numeric option.");
  }
  return markFrameworkDefinition({
    arg,
    ...identity,
    type,
    discordType: OPTION_TYPES[type],
    required,
    minLength: normalizedMinLength,
    maxLength: normalizedMaxLength,
    min: normalizedMin,
    max: normalizedMax
  }, DISCORD_OPTION_TYPE);
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) throw new TypeError("Discord command options must be an array.");
  if (options.some((option) => !isFrameworkDefinition(option, DISCORD_OPTION_TYPE))) {
    throw new TypeError("Discord command options must use discordOption().");
  }
  if (
    new Set(options.map((option) => option.name)).size !== options.length ||
    new Set(options.map((option) => option.arg)).size !== options.length
  ) {
    throw new TypeError("Discord command option names and args must be unique.");
  }
  let optionalSeen = false;
  for (const option of options) {
    if (!option.required) optionalSeen = true;
    if (optionalSeen && option.required) {
      throw new TypeError("Required Discord options must precede optional options.");
    }
  }
  return Object.freeze([...options]);
}

export function discordActionCommand({
  name,
  description,
  availability,
  deferred = false,
  actionKind,
  options = [],
  render = discordTextResult,
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported Discord action command field: \`${unknownFields[0]}\`.`);
  }
  if (typeof deferred !== "boolean") throw new TypeError("Discord deferred is invalid.");
  if (typeof render !== "function") throw new TypeError("Discord render must be a function.");
  return markCommandDefinition({
    platform: "discord",
    mode: ACTION_COMMAND_TYPE,
    ...normalizeCommandIdentity({ name, description }),
    availability: requireAvailability(availability),
    deferred,
    actionKind: requireActionKind(actionKind),
    options: normalizeOptions(options),
    render
  }, "discord", ACTION_COMMAND_TYPE);
}

export function discordNativeCommand({
  name,
  description,
  availability,
  deferred = false,
  capability = null,
  options = [],
  input = schema.object({}),
  execute,
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported Discord native command field: \`${unknownFields[0]}\`.`);
  }
  if (typeof deferred !== "boolean") throw new TypeError("Discord deferred is invalid.");
  if (typeof execute !== "function") throw new TypeError("Discord native execute must be a function.");
  return markCommandDefinition({
    platform: "discord",
    mode: NATIVE_COMMAND_TYPE,
    ...normalizeCommandIdentity({ name, description }),
    availability: requireAvailability(availability),
    deferred,
    capability: requireCapability(capability),
    options: normalizeOptions(options),
    input: requireObjectSchema(input),
    execute
  }, "discord", NATIVE_COMMAND_TYPE);
}

export function discordTextResult(result) {
  const message = result?.output?.message;
  if (typeof message !== "string" || message.length === 0 || message.length > 2_000) {
    throw new TypeError("The action did not return a valid Discord text response.");
  }
  return Object.freeze({
    content: message,
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) })
  });
}

export function discordOptionDescriptor(option) {
  if (!isFrameworkDefinition(option, DISCORD_OPTION_TYPE)) {
    throw new TypeError("Discord option descriptors require discordOption().");
  }
  const descriptor = {
    name: option.name,
    description: option.description,
    type: option.discordType,
    required: option.required
  };
  if (option.minLength !== null) descriptor.min_length = option.minLength;
  if (option.maxLength !== null) descriptor.max_length = option.maxLength;
  if (option.min !== null) descriptor.min_value = option.min;
  if (option.max !== null) descriptor.max_value = option.max;
  return Object.freeze(descriptor);
}
