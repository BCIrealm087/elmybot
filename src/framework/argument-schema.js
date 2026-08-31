import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const SCHEMA_TYPE = "argument-schema";
const MAX_ERROR_MESSAGE_LENGTH = 300;

export class SchemaValidationError extends TypeError {
  constructor(path, message) {
    const prefix = path ? `\`${path}\` ` : "Value ";
    super(`${prefix}${message}`.slice(0, MAX_ERROR_MESSAGE_LENGTH));
    this.name = "SchemaValidationError";
    this.code = "argument_validation_failed";
    this.path = path;
  }
}

function fail(path, message) {
  throw new SchemaValidationError(path, message);
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyJsonValue(value, path, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be a finite number.");
    return value;
  }
  if (typeof value !== "object") fail(path, "must be JSON-safe.");
  if (ancestors.has(value)) fail(path, "must not contain cycles.");
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) =>
      copyJsonValue(entry, `${path}[${index}]`, nextAncestors)
    ));
  }
  if (!isPlainObject(value)) fail(path, "must be JSON-safe.");
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    copyJsonValue(entry, path ? `${path}.${key}` : key, nextAncestors)
  ])));
}

function numberConstraint(value, name, { integer = false } = {}) {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new TypeError(`Schema ${name} must be ${integer ? "a safe integer" : "finite"}.`);
  }
  return value;
}

function lengthConstraint(value, name) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Schema ${name} must be a non-negative safe integer.`);
  }
  return value;
}

function primitiveOptions(options, validateValue) {
  if (!isPlainObject(options)) throw new TypeError("Schema options must be an object.");
  const optional = options.optional === true;
  const hasDefault = Object.prototype.hasOwnProperty.call(options, "default");
  if (hasDefault && !optional) {
    throw new TypeError("A schema default requires `optional: true`.");
  }
  const defaultValue = hasDefault
    ? copyJsonValue(validateValue(options.default, "default"), "default")
    : undefined;
  return { optional, hasDefault, defaultValue };
}

function createSchema({ kind, optional = false, hasDefault = false, defaultValue, parse }) {
  const definition = {
    kind,
    optional,
    hasDefault,
    parse(value, { path = "value", missing = false } = {}) {
      if (missing || value === undefined) {
        if (hasDefault) return defaultValue;
        if (optional) return undefined;
        fail(path, "is required.");
      }
      return parse(value, path);
    }
  };
  return markFrameworkDefinition(definition, SCHEMA_TYPE);
}

function string(options = {}) {
  const allowed = new Set(["minLength", "maxLength", "trim", "optional", "default"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported string schema option: \`${key}\`.`);
  }
  const minLength = lengthConstraint(options.minLength, "minLength") ?? 0;
  const maxLength = lengthConstraint(options.maxLength, "maxLength") ?? Infinity;
  if (minLength > maxLength) throw new TypeError("Schema minLength exceeds maxLength.");
  const trim = options.trim === true;
  const validateValue = (value, path) => {
    if (typeof value !== "string") fail(path, "must be a string.");
    const normalized = trim ? value.trim() : value;
    if (normalized.length < minLength) {
      fail(path, `must contain at least ${minLength} characters.`);
    }
    if (normalized.length > maxLength) {
      fail(path, `must contain at most ${maxLength} characters.`);
    }
    return normalized;
  };
  const presence = primitiveOptions(options, validateValue);
  return createSchema({ kind: "string", ...presence, parse: validateValue });
}

function numeric(kind, options = {}, { integer = false } = {}) {
  const allowed = new Set(["min", "max", "optional", "default"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported ${kind} schema option: \`${key}\`.`);
  }
  const min = numberConstraint(options.min, "min", { integer }) ?? -Infinity;
  const max = numberConstraint(options.max, "max", { integer }) ?? Infinity;
  if (min > max) throw new TypeError("Schema min exceeds max.");
  const validateValue = (value, path) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (integer && !Number.isSafeInteger(value))
    ) {
      fail(path, integer ? "must be a safe integer." : "must be a finite number.");
    }
    if (value < min) fail(path, `must be at least ${min}.`);
    if (value > max) fail(path, `must be at most ${max}.`);
    return value;
  };
  const presence = primitiveOptions(options, validateValue);
  return createSchema({ kind, ...presence, parse: validateValue });
}

function boolean(options = {}) {
  const allowed = new Set(["optional", "default"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported boolean schema option: \`${key}\`.`);
  }
  const validateValue = (value, path) => {
    if (typeof value !== "boolean") fail(path, "must be a boolean.");
    return value;
  };
  const presence = primitiveOptions(options, validateValue);
  return createSchema({ kind: "boolean", ...presence, parse: validateValue });
}

function enumeration(values, options = {}) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new TypeError("Enum schema values must be unique, non-empty strings.");
  }
  const allowed = new Set(["optional", "default"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported enum schema option: \`${key}\`.`);
  }
  const choices = Object.freeze([...values]);
  const validateValue = (value, path) => {
    if (typeof value !== "string" || !choices.includes(value)) {
      fail(path, `must be one of: ${choices.join(", ")}.`);
    }
    return value;
  };
  const presence = primitiveOptions(options, validateValue);
  return createSchema({
    kind: "enum",
    ...presence,
    values: choices,
    parse: validateValue
  });
}

function object(fields, { allowUnknown = false } = {}) {
  if (!isPlainObject(fields)) throw new TypeError("Object schema fields must be an object.");
  if (typeof allowUnknown !== "boolean") {
    throw new TypeError("Object schema allowUnknown must be a boolean.");
  }
  for (const [name, definition] of Object.entries(fields)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new TypeError(`Invalid schema field name: \`${name}\`.`);
    }
    if (!isSchema(definition)) {
      throw new TypeError(`Schema field \`${name}\` is not a framework schema.`);
    }
  }
  const frozenFields = Object.freeze({ ...fields });
  return createSchema({
    kind: "object",
    parse(value, path) {
      if (!isPlainObject(value)) fail(path, "must be an object.");
      if (!allowUnknown) {
        const unknown = Object.keys(value).find((key) => !(key in frozenFields));
        if (unknown) fail(path ? `${path}.${unknown}` : unknown, "is not supported.");
      }
      const normalized = {};
      for (const [name, definition] of Object.entries(frozenFields)) {
        const present = Object.prototype.hasOwnProperty.call(value, name);
        const parsed = definition.parse(value[name], {
          path: path ? `${path}.${name}` : name,
          missing: !present
        });
        if (parsed !== undefined) normalized[name] = parsed;
      }
      if (allowUnknown) {
        for (const [name, entry] of Object.entries(value)) {
          if (!(name in frozenFields)) {
            normalized[name] = copyJsonValue(entry, path ? `${path}.${name}` : name);
          }
        }
      }
      return Object.freeze(normalized);
    }
  });
}

export function isSchema(value) {
  return isFrameworkDefinition(value, SCHEMA_TYPE);
}

export const schema = Object.freeze({
  string,
  integer: (options = {}) => numeric("integer", options, { integer: true }),
  number: (options = {}) => numeric("number", options),
  boolean,
  enum: enumeration,
  object
});
