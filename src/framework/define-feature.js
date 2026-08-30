import { frameworkDefinitionType } from "./definition-brand.js";
import {
  frameworkApiVersion,
  supportedFrameworkApiVersions
} from "./api-version.js";

const FEATURE_ID_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const MAX_FEATURE_ID_LENGTH = 100;
const MAX_FEATURE_DESCRIPTION_LENGTH = 200;
const TOP_LEVEL_FIELDS = new Set([
  "apiVersion",
  "id",
  "description",
  "actions",
  "commands",
  "routes",
  "events",
  "schedules",
  "effectAdapters"
]);
const SUPPORTED_PLATFORMS = Object.freeze(["discord", "twitch"]);
const featureDefinitions = new WeakSet();

export class FeatureDefinitionError extends TypeError {
  constructor(message, {
    path = "Feature definition",
    code = "invalid_feature_definition",
    details = null
  } = {}) {
    super(`${path} ${message}`);
    this.name = "FeatureDefinitionError";
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function fail(path, message) {
  throw new FeatureDefinitionError(message, { path });
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, path) {
  if (!isPlainObject(value)) fail(path, "must be an object.");
  return value;
}

function cloneAndFreeze(value, path, ancestors = new Set()) {
  if (frameworkDefinitionType(value) !== null) return value;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "function"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite numbers.");
    return value;
  }
  if (typeof value !== "object") {
    fail(path, "contains an unsupported value.");
  }
  if (ancestors.has(value)) fail(path, "must not contain cycles.");

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) =>
      cloneAndFreeze(entry, `${path}[${index}]`, nextAncestors)
    ));
  }
  requirePlainObject(value, path);
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      cloneAndFreeze(entry, `${path}.${key}`, nextAncestors)
    ])
  ));
}

function definitionArray(value, path) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) fail(path, "must be an array.");
  return cloneAndFreeze(value, path);
}

function platformCollections(value, path) {
  if (value === undefined) value = {};
  requirePlainObject(value, path);
  for (const platform of Object.keys(value)) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      fail(`${path}.${platform}`, "targets an unsupported platform.");
    }
  }
  return Object.freeze(Object.fromEntries(SUPPORTED_PLATFORMS.map((platform) => [
    platform,
    definitionArray(value[platform], `${path}.${platform}`)
  ])));
}

export function defineFeature(input) {
  requirePlainObject(input, "Feature definition");
  for (const field of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(field)) {
      fail(`Feature definition.${field}`, "is not a supported field.");
    }
  }
  if (input.apiVersion !== frameworkApiVersion) {
    throw new FeatureDefinitionError(
      `must equal ${frameworkApiVersion}.`,
      {
        path: "Feature definition.apiVersion",
        code: "unsupported_framework_api_version",
        details: Object.freeze({
          received: input.apiVersion ?? null,
          supported: supportedFrameworkApiVersions
        })
      }
    );
  }
  if (
    typeof input.id !== "string" ||
    input.id.length > MAX_FEATURE_ID_LENGTH ||
    !FEATURE_ID_PATTERN.test(input.id)
  ) {
    fail("Feature definition.id", "is invalid.");
  }
  if (
    typeof input.description !== "string" ||
    input.description.trim().length === 0 ||
    input.description.length > MAX_FEATURE_DESCRIPTION_LENGTH
  ) {
    fail("Feature definition.description", "is invalid.");
  }

  const feature = Object.freeze({
    apiVersion: frameworkApiVersion,
    id: input.id,
    description: input.description,
    actions: definitionArray(input.actions, "Feature definition.actions"),
    commands: platformCollections(input.commands, "Feature definition.commands"),
    routes: definitionArray(input.routes, "Feature definition.routes"),
    events: definitionArray(input.events, "Feature definition.events"),
    schedules: definitionArray(input.schedules, "Feature definition.schedules"),
    effectAdapters: platformCollections(
      input.effectAdapters,
      "Feature definition.effectAdapters"
    )
  });
  featureDefinitions.add(feature);
  return feature;
}

export function isFeatureDefinition(value) {
  return featureDefinitions.has(value);
}
