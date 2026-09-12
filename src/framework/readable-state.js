import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const READABLE_STATE_EXPORT_TYPE = "readable-state-export";
const EXPORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SUPPORTED_PLATFORMS = Object.freeze(["discord", "twitch"]);
const EXPORT_KINDS = new Set(["value", "lookup", "collection"]);
const SCOPE_KINDS = new Set(["group_local", "effective_shareable"]);
const ABSENCE_KINDS = new Set(["absent", "unselected", "default"]);
const SCHEMA_TYPES = new Set([
  "string",
  "boolean",
  "number",
  "integer",
  "object",
  "array"
]);
const MAX_SCHEMA_DEPTH = 10;
const MAX_SCHEMA_PROPERTIES = 20;
const MAX_PARAMETERS = 10;
const MAX_COLLECTION_ITEMS = 100;

export class ReadableStateDefinitionError extends TypeError {
  constructor(message, {
    path = "Readable state export",
    code = "invalid_readable_state_export"
  } = {}) {
    super(`${path} ${message}`);
    this.name = "ReadableStateDefinitionError";
    this.path = path;
    this.code = code;
  }
}

function fail(path, message) {
  throw new ReadableStateDefinitionError(message, { path });
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, path) {
  if (!isPlainObject(value)) fail(path, "must be an object.");
  return value;
}

function onlyFields(value, allowed, path) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) fail(`${path}.${unknown}`, "is not a supported field.");
}

function text(value, path, maximum) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    fail(path, "is invalid.");
  }
  return value.trim();
}

function finiteConstraint(value, path, { integer = false, minimum } = {}) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    (minimum !== undefined && value < minimum)
  ) {
    fail(path, "is invalid.");
  }
  return value;
}

function normalizeSchema(value, path, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) fail(path, "is nested too deeply.");
  requireObject(value, path);
  const type = value.type;
  if (!SCHEMA_TYPES.has(type)) fail(`${path}.type`, "is invalid.");
  const nullable = value.nullable ?? false;
  if (typeof nullable !== "boolean") fail(`${path}.nullable`, "must be boolean.");

  if (type === "string") {
    onlyFields(value, new Set(["type", "nullable", "minLength", "maxLength"]), path);
    const minLength = finiteConstraint(value.minLength ?? 0, `${path}.minLength`, {
      integer: true,
      minimum: 0
    });
    const maxLength = finiteConstraint(value.maxLength, `${path}.maxLength`, {
      integer: true,
      minimum: 0
    });
    if (maxLength === undefined || minLength > maxLength || maxLength > 16_384) {
      fail(`${path}.maxLength`, "is invalid.");
    }
    return Object.freeze({ type, minLength, maxLength, ...(nullable ? { nullable } : {}) });
  }

  if (type === "number" || type === "integer") {
    onlyFields(value, new Set(["type", "nullable", "minimum", "maximum"]), path);
    const integer = type === "integer";
    const minimum = finiteConstraint(value.minimum, `${path}.minimum`, { integer });
    const maximum = finiteConstraint(value.maximum, `${path}.maximum`, { integer });
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      fail(path, "has a minimum greater than its maximum.");
    }
    return Object.freeze({
      type,
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(nullable ? { nullable } : {})
    });
  }

  if (type === "boolean") {
    onlyFields(value, new Set(["type", "nullable"]), path);
    return Object.freeze({ type, ...(nullable ? { nullable } : {}) });
  }

  if (type === "array") {
    onlyFields(value, new Set(["type", "nullable", "items", "maxItems"]), path);
    const maxItems = finiteConstraint(value.maxItems, `${path}.maxItems`, {
      integer: true,
      minimum: 0
    });
    if (maxItems === undefined || maxItems > MAX_COLLECTION_ITEMS) {
      fail(`${path}.maxItems`, `must be at most ${MAX_COLLECTION_ITEMS}.`);
    }
    return Object.freeze({
      type,
      items: normalizeSchema(value.items, `${path}.items`, depth + 1),
      maxItems,
      ...(nullable ? { nullable } : {})
    });
  }

  onlyFields(value, new Set([
    "type",
    "nullable",
    "properties",
    "required"
  ]), path);
  requireObject(value.properties, `${path}.properties`);
  const entries = Object.entries(value.properties);
  if (entries.length === 0 || entries.length > MAX_SCHEMA_PROPERTIES) {
    fail(`${path}.properties`, `must contain 1–${MAX_SCHEMA_PROPERTIES} fields.`);
  }
  const properties = Object.freeze(Object.fromEntries(entries.map(([name, schema]) => {
    if (!FIELD_ID_PATTERN.test(name)) fail(`${path}.properties.${name}`, "has an invalid name.");
    return [name, normalizeSchema(schema, `${path}.properties.${name}`, depth + 1)];
  })));
  if (
    !Array.isArray(value.required) ||
    value.required.some((name) => typeof name !== "string" || !(name in properties)) ||
    new Set(value.required).size !== value.required.length
  ) {
    fail(`${path}.required`, "must contain unique declared property names.");
  }
  return Object.freeze({
    type,
    properties,
    required: Object.freeze([...value.required]),
    ...(nullable ? { nullable } : {})
  });
}

function normalizePlatforms(value, path) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((platform) => !SUPPORTED_PLATFORMS.includes(platform)) ||
    new Set(value).size !== value.length
  ) {
    fail(path, "must contain unique supported platforms.");
  }
  return Object.freeze(SUPPORTED_PLATFORMS.filter((platform) => value.includes(platform)));
}

function normalizeScope(value, path) {
  requireObject(value, path);
  if (!SCOPE_KINDS.has(value.kind)) fail(`${path}.kind`, "is invalid.");
  if (value.kind === "group_local") {
    onlyFields(value, new Set(["kind"]), path);
    return Object.freeze({ kind: value.kind });
  }
  onlyFields(value, new Set(["kind", "namespace"]), path);
  if (typeof value.namespace !== "string" || !FIELD_ID_PATTERN.test(value.namespace)) {
    fail(`${path}.namespace`, "is invalid.");
  }
  return Object.freeze({ kind: value.kind, namespace: value.namespace });
}

function normalizeParameters(value, kind, path) {
  if (value === undefined) value = {};
  requireObject(value, path);
  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMETERS) {
    fail(path, `must contain at most ${MAX_PARAMETERS} parameters.`);
  }
  if ((kind === "lookup") !== (entries.length > 0)) {
    fail(path, kind === "lookup"
      ? "must contain at least one parameter for a lookup."
      : `must be empty for a ${kind} export.`);
  }
  return Object.freeze(Object.fromEntries(entries.map(([name, parameter]) => {
    const parameterPath = `${path}.${name}`;
    if (!FIELD_ID_PATTERN.test(name)) fail(parameterPath, "has an invalid name.");
    requireObject(parameter, parameterPath);
    onlyFields(parameter, new Set(["label", "schema", "normalize"]), parameterPath);
    const schema = normalizeSchema(parameter.schema, `${parameterPath}.schema`);
    if (!["string", "boolean", "number", "integer"].includes(schema.type)) {
      fail(`${parameterPath}.schema`, "must describe a scalar value.");
    }
    if (parameter.normalize !== undefined && typeof parameter.normalize !== "function") {
      fail(`${parameterPath}.normalize`, "must be a function.");
    }
    return [name, Object.freeze({
      label: text(parameter.label, `${parameterPath}.label`, 80),
      schema,
      ...(parameter.normalize ? { normalize: parameter.normalize } : {})
    })];
  })));
}

function normalizeResult(value, path) {
  requireObject(value, path);
  onlyFields(value, new Set(["schema", "absence"]), path);
  requireObject(value.absence, `${path}.absence`);
  onlyFields(value.absence, new Set(["kind"]), `${path}.absence`);
  if (!ABSENCE_KINDS.has(value.absence.kind)) {
    fail(`${path}.absence.kind`, "is invalid.");
  }
  return Object.freeze({
    schema: normalizeSchema(value.schema, `${path}.schema`),
    absence: Object.freeze({ kind: value.absence.kind })
  });
}

function normalizeAccess(value, path) {
  requireObject(value, path);
  onlyFields(value, new Set(["kind"]), path);
  if (value.kind !== "operator_grant") {
    fail(`${path}.kind`, "must be operator_grant.");
  }
  return Object.freeze({ kind: value.kind });
}

function normalizeCollection(value, kind, result, path) {
  if (kind !== "collection") {
    if (value !== undefined) fail(path, "is only supported for collection exports.");
    return null;
  }
  if (result.schema.type !== "array") {
    fail("Readable state export.result.schema", "must be an array for a collection.");
  }
  if (value === undefined) value = {};
  requireObject(value, path);
  onlyFields(value, new Set(["membership", "order", "legacyCoverage"]), path);
  const normalized = {
    membership: value.membership ?? "materialized",
    order: value.order ?? "canonical_subject",
    legacyCoverage: value.legacyCoverage ?? "explicit"
  };
  if (
    normalized.membership !== "materialized" ||
    normalized.order !== "canonical_subject" ||
    normalized.legacyCoverage !== "explicit"
  ) {
    fail(path, "contains an unsupported collection policy.");
  }
  return Object.freeze(normalized);
}

export function defineReadableStateExport(input) {
  const path = "Readable state export";
  requireObject(input, path);
  onlyFields(input, new Set([
    "id",
    "version",
    "label",
    "description",
    "kind",
    "platforms",
    "scope",
    "access",
    "parameters",
    "result",
    "collection"
  ]), path);
  if (typeof input.id !== "string" || !EXPORT_ID_PATTERN.test(input.id)) {
    fail(`${path}.id`, "is invalid.");
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 1_000_000) {
    fail(`${path}.version`, "must be a positive integer no greater than 1000000.");
  }
  if (!EXPORT_KINDS.has(input.kind)) fail(`${path}.kind`, "is invalid.");
  const result = normalizeResult(input.result, `${path}.result`);
  const definition = {
    id: input.id,
    version: input.version,
    label: text(input.label, `${path}.label`, 80),
    description: text(input.description, `${path}.description`, 200),
    kind: input.kind,
    platforms: normalizePlatforms(input.platforms, `${path}.platforms`),
    scope: normalizeScope(input.scope, `${path}.scope`),
    access: normalizeAccess(input.access, `${path}.access`),
    parameters: normalizeParameters(input.parameters, input.kind, `${path}.parameters`),
    result,
    ...(input.kind === "collection"
      ? { collection: normalizeCollection(input.collection, input.kind, result, `${path}.collection`) }
      : {})
  };
  return markFrameworkDefinition(definition, READABLE_STATE_EXPORT_TYPE);
}

export function isReadableStateExport(value) {
  return isFrameworkDefinition(value, READABLE_STATE_EXPORT_TYPE);
}

function copyJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(copyJson));
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copyJson(entry)])
    ));
  }
  return value;
}

export function validateReadableStateSchemaValue(schema, value, path = "value") {
  if (value === null) {
    if (schema.nullable === true) return null;
    fail(path, "must not be null.");
  }
  if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < schema.minLength ||
      value.length > schema.maxLength
    ) fail(path, "does not satisfy its string schema.");
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail(path, "must be boolean.");
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    ) fail(path, `does not satisfy its ${schema.type} schema.`);
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) {
      fail(path, "does not satisfy its array schema.");
    }
    return Object.freeze(value.map((entry, index) =>
      validateReadableStateSchemaValue(schema.items, entry, `${path}[${index}]`)
    ));
  }
  if (!isPlainObject(value)) fail(path, "must be an object.");
  const unknown = Object.keys(value).find((field) => !(field in schema.properties));
  if (unknown) fail(`${path}.${unknown}`, "is not declared.");
  for (const required of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      fail(`${path}.${required}`, "is required.");
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([field, entry]) => [
    field,
    validateReadableStateSchemaValue(schema.properties[field], entry, `${path}.${field}`)
  ])));
}

export function publicReadableStateExport(definition, featureId) {
  return copyJson({
    feature: featureId,
    export: definition.id,
    version: definition.version,
    label: definition.label,
    description: definition.description,
    kind: definition.kind,
    scope: definition.scope.kind,
    supportedPlatforms: definition.platforms,
    parameters: Object.fromEntries(Object.entries(definition.parameters).map(
      ([name, parameter]) => [name, {
        label: parameter.label,
        schema: parameter.schema
      }]
    )),
    resultSchema: definition.result.schema,
    absence: definition.result.absence,
    ...(definition.collection ? { collection: definition.collection } : {})
  });
}
