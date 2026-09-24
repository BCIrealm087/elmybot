import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const DURABLE_EVENT_STREAM_TYPE = "durable-event-stream";
const STREAM_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const RESULT_FIELD_PATTERN = /^[a-z][A-Za-z0-9_-]{0,63}$/;
const SUPPORTED_PLATFORMS = Object.freeze(["discord", "twitch"]);
const SCOPE_KINDS = new Set(["group_local", "effective_shareable"]);
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
const MAX_ARRAY_ITEMS = 100;

export const DURABLE_EVENT_DELIVERY = Object.freeze({
  kind: "bounded_at_least_once",
  consumers: 1,
  retentionSeconds: 1_800,
  maxRetainedEvents: 1_000,
  maxRetainedBytes: 1_048_576
});

export class DurableEventStreamDefinitionError extends TypeError {
  constructor(message, {
    path = "Durable event stream",
    code = "invalid_durable_event_stream"
  } = {}) {
    super(`${path} ${message}`);
    this.name = "DurableEventStreamDefinitionError";
    this.path = path;
    this.code = code;
  }
}

function fail(path, message) {
  throw new DurableEventStreamDefinitionError(message, { path });
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
    return Object.freeze({
      type,
      minLength,
      maxLength,
      ...(nullable ? { nullable } : {})
    });
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
    if (maxItems === undefined || maxItems > MAX_ARRAY_ITEMS) {
      fail(`${path}.maxItems`, `must be at most ${MAX_ARRAY_ITEMS}.`);
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
    if (!RESULT_FIELD_PATTERN.test(name)) {
      fail(`${path}.properties.${name}`, "has an invalid name.");
    }
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
  return Object.freeze(SUPPORTED_PLATFORMS.filter((platform) =>
    value.includes(platform)
  ));
}

function normalizeScope(value, path) {
  requireObject(value, path);
  onlyFields(value, new Set(["kind"]), path);
  if (!SCOPE_KINDS.has(value.kind)) fail(`${path}.kind`, "is invalid.");
  return Object.freeze({ kind: value.kind });
}

function normalizeAccess(value, path) {
  requireObject(value, path);
  onlyFields(value, new Set(["kind"]), path);
  if (value.kind !== "operator_grant") {
    fail(`${path}.kind`, "must be operator_grant.");
  }
  return Object.freeze({ kind: value.kind });
}

function normalizePayload(value, path) {
  requireObject(value, path);
  onlyFields(value, new Set(["schema"]), path);
  return Object.freeze({
    schema: normalizeSchema(value.schema, `${path}.schema`)
  });
}

export function defineDurableEventStream(input) {
  const path = "Durable event stream";
  requireObject(input, path);
  onlyFields(input, new Set([
    "id",
    "version",
    "label",
    "description",
    "platforms",
    "scope",
    "access",
    "payload"
  ]), path);
  if (typeof input.id !== "string" || !STREAM_ID_PATTERN.test(input.id)) {
    fail(`${path}.id`, "is invalid.");
  }
  if (
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    input.version > 1_000_000
  ) {
    fail(`${path}.version`, "must be a positive integer no greater than 1000000.");
  }
  return markFrameworkDefinition({
    id: input.id,
    version: input.version,
    label: text(input.label, `${path}.label`, 80),
    description: text(input.description, `${path}.description`, 200),
    platforms: normalizePlatforms(input.platforms, `${path}.platforms`),
    scope: normalizeScope(input.scope, `${path}.scope`),
    access: normalizeAccess(input.access, `${path}.access`),
    payload: normalizePayload(input.payload, `${path}.payload`)
  }, DURABLE_EVENT_STREAM_TYPE);
}

export function isDurableEventStream(value) {
  return isFrameworkDefinition(value, DURABLE_EVENT_STREAM_TYPE);
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

export function publicDurableEventStream(definition, featureId) {
  return copyJson({
    feature: featureId,
    stream: definition.id,
    version: definition.version,
    label: definition.label,
    description: definition.description,
    platforms: definition.platforms,
    scope: definition.scope,
    access: definition.access,
    payload: definition.payload,
    delivery: DURABLE_EVENT_DELIVERY
  });
}
