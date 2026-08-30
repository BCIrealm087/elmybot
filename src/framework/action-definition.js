import { isRegisteredCapability } from "./access.js";
import { schema, isSchema } from "./argument-schema.js";
import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const ACTION_TYPE = "feature-action";
const BOUND_ACTION_TYPE = "bound-feature-action";
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const SUPPORTED_ORIGINS = new Set(["discord", "twitch"]);
const SUPPORTED_SERVICES = new Set(["config", "state", "random"]);

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

export function defineAction({
  kind,
  capability = null,
  supportedOrigins,
  input = schema.object({}),
  uses = {},
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

  return markFrameworkDefinition({
    kind,
    capability,
    supportedOrigins: Object.freeze([...supportedOrigins].sort()),
    input,
    uses: normalizeUses(uses),
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
}
