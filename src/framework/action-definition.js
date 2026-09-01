import { isRegisteredCapability } from "./access.js";
import {
  schema,
  isSchema,
  objectSchemaField,
  SchemaValidationError
} from "./argument-schema.js";
import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const ACTION_TYPE = "feature-action";
const BOUND_ACTION_TYPE = "bound-feature-action";
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const SUPPORTED_ORIGINS = new Set(["discord", "twitch"]);
const SUPPORTED_SERVICES = new Set([
  "authorization",
  "config",
  "links",
  "state",
  "random"
]);
const COOLDOWN_SCOPES = new Set(["actor", "group"]);
const CONDITIONAL_ACCESS_FIELD_KINDS = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "enum"
]);
const MAX_CONDITIONAL_ACCESS_RULES = 20;
const MAX_CONDITIONAL_ACCESS_VALUES = 20;

function requireVersionedKinds(value, path) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
  const normalized = value.map((kind, index) => {
    if (
      typeof kind !== "string" ||
      kind.length > 200 ||
      !VERSIONED_KIND_PATTERN.test(kind)
    ) {
      throw new TypeError(`${path}[${index}] is invalid.`);
    }
    return kind;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${path} must not contain duplicates.`);
  }
  return Object.freeze(normalized);
}

function normalizeUses(value = {}) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Action uses must be an object.");
  }
  const allowed = new Set(["routes", "effects", "services"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported action uses field: \`${key}\`.`);
  }
  const services = value.services ?? [];
  if (!Array.isArray(services)) throw new TypeError("Action uses.services must be an array.");
  if (
    services.some((service) => !SUPPORTED_SERVICES.has(service)) ||
    new Set(services).size !== services.length
  ) {
    throw new TypeError("Action uses.services is invalid.");
  }
  return Object.freeze({
    routes: requireVersionedKinds(value.routes ?? [], "Action uses.routes"),
    effects: requireVersionedKinds(value.effects ?? [], "Action uses.effects"),
    services: Object.freeze([...services])
  });
}

function normalizeCooldown(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Action cooldown must be an object.");
  }
  const allowed = new Set(["scope", "seconds"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Unsupported action cooldown field: \`${key}\`.`);
    }
  }
  if (!COOLDOWN_SCOPES.has(value.scope)) {
    throw new TypeError("Action cooldown scope is invalid.");
  }
  if (
    !Number.isSafeInteger(value.seconds) ||
    value.seconds < 1 ||
    value.seconds > 86_400
  ) {
    throw new TypeError("Action cooldown seconds must be between 1 and 86400.");
  }
  return Object.freeze({ scope: value.scope, seconds: value.seconds });
}

function requirePlainObject(value, message) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(message);
  }
  return value;
}

function onlyFields(value, allowed, path) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`Unsupported ${path} field: \`${unknown}\`.`);
}

function normalizeConditionalAccess(value, input, uses) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_CONDITIONAL_ACCESS_RULES) {
    throw new TypeError(
      `Action conditionalAccess must be an array of at most ` +
      `${MAX_CONDITIONAL_ACCESS_RULES} rules.`
    );
  }
  if (value.length > 0 && !uses.services.includes("authorization")) {
    throw new TypeError(
      "Action conditionalAccess requires the `authorization` service."
    );
  }
  return Object.freeze(value.map((entry, index) => {
    const path = `action conditionalAccess[${index}]`;
    requirePlainObject(entry, `Action conditionalAccess[${index}] must be an object.`);
    onlyFields(entry, new Set(["capability", "when"]), path);
    if (typeof entry.capability !== "string") {
      throw new TypeError(`Action conditionalAccess[${index}] capability is invalid.`);
    }
    const when = requirePlainObject(
      entry.when,
      `Action conditionalAccess[${index}].when must be an object.`
    );
    onlyFields(when, new Set(["argument", "values"]), `${path}.when`);
    if (
      typeof when.argument !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(when.argument)
    ) {
      throw new TypeError(`Action conditionalAccess[${index}] argument is invalid.`);
    }
    const field = objectSchemaField(input, when.argument);
    if (!field || !CONDITIONAL_ACCESS_FIELD_KINDS.has(field.kind)) {
      throw new TypeError(
        `Action conditionalAccess[${index}] argument must name a primitive input field.`
      );
    }
    if (
      !Array.isArray(when.values) ||
      when.values.length === 0 ||
      when.values.length > MAX_CONDITIONAL_ACCESS_VALUES
    ) {
      throw new TypeError(
        `Action conditionalAccess[${index}] values must contain between 1 and ` +
        `${MAX_CONDITIONAL_ACCESS_VALUES} entries.`
      );
    }
    if (when.values.some((candidate) =>
      candidate === null ||
      !["string", "number", "boolean"].includes(typeof candidate)
    )) {
      throw new TypeError(
        `Action conditionalAccess[${index}] values must be primitive values.`
      );
    }
    let values;
    try {
      values = when.values.map((candidate) => field.parse(candidate, {
        path: `conditionalAccess[${index}].when.values`
      }));
    } catch (cause) {
      if (cause instanceof SchemaValidationError) {
        throw new TypeError(
          `Action conditionalAccess[${index}] contains a value rejected by its ` +
          "input field.",
          { cause }
        );
      }
      throw cause;
    }
    if (new Set(values.map((candidate) => JSON.stringify(candidate))).size !== values.length) {
      throw new TypeError(`Action conditionalAccess[${index}] values must be unique.`);
    }
    return Object.freeze({
      capability: entry.capability,
      when: Object.freeze({
        argument: when.argument,
        values: Object.freeze(values)
      })
    });
  }));
}

export function defineAction({
  kind,
  capability = null,
  conditionalAccess,
  supportedOrigins,
  input = schema.object({}),
  uses = {},
  cooldown = null,
  execute,
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported action field: \`${unknownFields[0]}\`.`);
  }
  if (
    typeof kind !== "string" ||
    kind.length > 200 ||
    !VERSIONED_KIND_PATTERN.test(kind)
  ) {
    throw new TypeError("Action kind is invalid.");
  }
  if (capability !== null && typeof capability !== "string") {
    throw new TypeError("Action capability is invalid.");
  }
  if (!Array.isArray(supportedOrigins) || supportedOrigins.length === 0) {
    throw new TypeError("Action supportedOrigins must contain a platform.");
  }
  if (
    supportedOrigins.some((origin) => !SUPPORTED_ORIGINS.has(origin)) ||
    new Set(supportedOrigins).size !== supportedOrigins.length
  ) {
    throw new TypeError("Action supportedOrigins is invalid.");
  }
  if (!isSchema(input) || input.kind !== "object") {
    throw new TypeError("Action input must be an object schema.");
  }
  if (typeof execute !== "function") throw new TypeError("Action execute must be a function.");

  const normalizedUses = normalizeUses(uses);
  return markFrameworkDefinition({
    kind,
    capability,
    conditionalAccess: normalizeConditionalAccess(
      conditionalAccess,
      input,
      normalizedUses
    ),
    supportedOrigins: Object.freeze([...supportedOrigins].sort()),
    input,
    uses: normalizedUses,
    cooldown: normalizeCooldown(cooldown),
    execute
  }, ACTION_TYPE);
}

export function isFeatureActionDefinition(value) {
  return isFrameworkDefinition(value, ACTION_TYPE);
}

export function isBoundFeatureActionDefinition(value) {
  return isFrameworkDefinition(value, BOUND_ACTION_TYPE);
}

export function bindFeatureActionDefinition(action, featureId) {
  if (!isFeatureActionDefinition(action)) {
    throw new TypeError("Feature actions must be created with defineAction().");
  }
  return markFrameworkDefinition({ ...action, featureId }, BOUND_ACTION_TYPE);
}

export function validateFeatureActionCapability(action) {
  if (!isRegisteredCapability(action.capability)) {
    throw new TypeError(`Action capability is not registered: \`${action.capability}\`.`);
  }
  const unknownConditional = action.conditionalAccess.find(
    ({ capability }) => !isRegisteredCapability(capability)
  );
  if (unknownConditional) {
    throw new TypeError(
      `Action conditional capability is not registered: ` +
      `\`${unknownConditional.capability}\`.`
    );
  }
}
