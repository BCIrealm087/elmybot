import { SchemaValidationError, schema } from "./argument-schema.js";
import {
  ACTION_COMMAND_TYPE,
  NATIVE_COMMAND_TYPE,
  isTwitchParser,
  markCommandDefinition,
  markTwitchParser,
  normalizeCommandIdentity,
  requireActionKind,
  requireCapability,
  requireObjectSchema
} from "./command-common.js";

function parseToken(value, type, path) {
  if (type === "string") return value;
  if (type === "integer") {
    if (!/^[+-]?\d+$/.test(value)) throw new SchemaValidationError(path, "must be an integer.");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new SchemaValidationError(path, "must be a safe integer.");
    return parsed;
  }
  if (type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new SchemaValidationError(path, "must be a finite number.");
    return parsed;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new SchemaValidationError(path, "must be `true` or `false`.");
  }
  throw new TypeError(`Unsupported Twitch token type: \`${type}\`.`);
}

function tokenizeArgs(argsText) {
  const tokens = [];
  let token = "";
  let tokenStarted = false;
  let quoted = false;
  let escaped = false;

  for (const character of argsText.trim()) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === "\"") {
      quoted = !quoted;
      tokenStarted = true;
    } else if (/\s/.test(character) && !quoted) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quoted) {
    throw new SchemaValidationError("arguments", "contains an unterminated quote.");
  }
  if (escaped) token += "\\";
  if (tokenStarted) tokens.push(token);
  return tokens;
}

export function twitchNoArgs() {
  return markTwitchParser({
    kind: "none",
    parse(argsText) {
      if (argsText.trim().length > 0) {
        throw new SchemaValidationError("arguments", "does not accept a value.");
      }
      return Object.freeze({});
    }
  });
}

export function twitchRestText({ arg, minLength = 0, maxLength = 500, ...unknown }) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported Twitch rest-text field: \`${unknownFields[0]}\`.`);
  }
  if (typeof arg !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(arg)) {
    throw new TypeError("Twitch rest-text arg is invalid.");
  }
  if (
    !Number.isSafeInteger(minLength) ||
    !Number.isSafeInteger(maxLength) ||
    minLength < 0 ||
    maxLength < minLength
  ) {
    throw new TypeError("Twitch rest-text length constraints are invalid.");
  }
  return markTwitchParser({
    kind: "rest-text",
    parse(argsText) {
      const value = argsText.trim();
      if (value.length < minLength) {
        throw new SchemaValidationError(arg, `must contain at least ${minLength} characters.`);
      }
      if (value.length > maxLength) {
        throw new SchemaValidationError(arg, `must contain at most ${maxLength} characters.`);
      }
      return Object.freeze({ [arg]: value });
    }
  });
}

export function twitchTokens(fields) {
  if (!Array.isArray(fields)) throw new TypeError("Twitch token fields must be an array.");
  const normalized = fields.map((field, index) => {
    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      throw new TypeError(`Twitch token field ${index} is invalid.`);
    }
    const allowed = new Set(["arg", "type", "optional", "default"]);
    for (const key of Object.keys(field)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported Twitch token field: \`${key}\`.`);
    }
    if (typeof field.arg !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(field.arg)) {
      throw new TypeError(`Twitch token field ${index} arg is invalid.`);
    }
    if (!["string", "integer", "number", "boolean"].includes(field.type)) {
      throw new TypeError(`Twitch token field ${index} type is invalid.`);
    }
    const optional = field.optional === true;
    const hasDefault = Object.prototype.hasOwnProperty.call(field, "default");
    if (hasDefault && !optional) {
      throw new TypeError("A Twitch token default requires `optional: true`.");
    }
    const defaultValue = hasDefault
      ? parseToken(String(field.default), field.type, field.arg)
      : undefined;
    return Object.freeze({
      arg: field.arg,
      type: field.type,
      optional,
      hasDefault,
      defaultValue
    });
  });
  if (new Set(normalized.map((field) => field.arg)).size !== normalized.length) {
    throw new TypeError("Twitch token args must be unique.");
  }
  let optionalSeen = false;
  for (const field of normalized) {
    if (field.optional) optionalSeen = true;
    if (optionalSeen && !field.optional) {
      throw new TypeError("Required Twitch tokens must precede optional tokens.");
    }
  }
  const definitions = Object.freeze(normalized);
  return markTwitchParser({
    kind: "tokens",
    parse(argsText) {
      const tokens = tokenizeArgs(argsText);
      if (tokens.length > definitions.length) {
        throw new SchemaValidationError("arguments", "contains too many values.");
      }
      const args = {};
      for (const [index, field] of definitions.entries()) {
        if (index < tokens.length) {
          args[field.arg] = parseToken(tokens[index], field.type, field.arg);
        } else if (field.hasDefault) {
          args[field.arg] = field.defaultValue;
        } else if (!field.optional) {
          throw new SchemaValidationError(field.arg, "is required.");
        }
      }
      return Object.freeze(args);
    }
  });
}

export function twitchActionCommand({
  name,
  description,
  actionKind,
  parse = twitchNoArgs(),
  render = twitchTextResult,
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported Twitch action command field: \`${unknownFields[0]}\`.`);
  }
  if (!isTwitchParser(parse)) throw new TypeError("Twitch parse must use a framework parser.");
  if (typeof render !== "function") throw new TypeError("Twitch render must be a function.");
  return markCommandDefinition({
    platform: "twitch",
    mode: ACTION_COMMAND_TYPE,
    ...normalizeCommandIdentity({ name, description }),
    actionKind: requireActionKind(actionKind),
    parse,
    render
  }, "twitch", ACTION_COMMAND_TYPE);
}

export function twitchNativeCommand({
  name,
  description,
  capability = null,
  parse = twitchNoArgs(),
  input = schema.object({}),
  execute,
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported Twitch native command field: \`${unknownFields[0]}\`.`);
  }
  if (!isTwitchParser(parse)) throw new TypeError("Twitch parse must use a framework parser.");
  if (typeof execute !== "function") throw new TypeError("Twitch native execute must be a function.");
  return markCommandDefinition({
    platform: "twitch",
    mode: NATIVE_COMMAND_TYPE,
    ...normalizeCommandIdentity({ name, description }),
    capability: requireCapability(capability),
    parse,
    input: requireObjectSchema(input),
    execute
  }, "twitch", NATIVE_COMMAND_TYPE);
}

export function twitchTextResult(result) {
  const message = result?.output?.message;
  if (typeof message !== "string" || message.length === 0 || message.length > 500) {
    throw new TypeError("The action did not return a valid Twitch text response.");
  }
  return message;
}
