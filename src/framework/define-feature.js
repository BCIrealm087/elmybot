import { frameworkDefinitionType } from "./definition-brand.js";
import {
  frameworkApiVersion,
  supportedFrameworkApiVersions
} from "./api-version.js";

const FEATURE_ID_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const MAX_FEATURE_ID_LENGTH = 100;
const MAX_FEATURE_DESCRIPTION_LENGTH = 200;
const SHAREABLE_NAMESPACE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_SHAREABLE_NAMESPACES = 20;
const MAX_SHAREABLE_LABEL_LENGTH = 80;
const MAX_SHAREABLE_SCHEMA_VERSION = 1_000_000;
const MAX_SHAREABLE_COMPATIBLE_VERSIONS = 20;
const MAX_SHAREABLE_ENTRIES = 100;
const MAX_SHAREABLE_VALUE_BYTES = 16 * 1024;
const SHAREABLE_SUMMARY_KINDS = new Set(["presence", "entry_count"]);
const TOP_LEVEL_FIELDS = new Set([
  "apiVersion",
  "id",
  "description",
  "actions",
  "commands",
  "routes",
  "events",
  "schedules",
  "shareableState",
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

function onlyFields(value, allowed, path) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) fail(`${path}.${unknown}`, "is not a supported field.");
}

function positiveInteger(value, path, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(path, `must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function compatibleVersions(value, schemaVersion, path) {
  if (value === undefined) return Object.freeze([schemaVersion]);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SHAREABLE_COMPATIBLE_VERSIONS
  ) {
    fail(
      path,
      `must contain between 1 and ${MAX_SHAREABLE_COMPATIBLE_VERSIONS} versions.`
    );
  }
  const normalized = value.map((version, index) =>
    positiveInteger(version, `${path}[${index}]`, schemaVersion)
  );
  if (new Set(normalized).size !== normalized.length) {
    fail(path, "must not contain duplicate versions.");
  }
  if (!normalized.includes(schemaVersion)) {
    fail(path, "must include the current schemaVersion.");
  }
  return Object.freeze(normalized.sort((left, right) => left - right));
}

function collisionSummary(value, path) {
  if (value === undefined) value = {};
  requirePlainObject(value, path);
  onlyFields(value, new Set(["kind"]), path);
  const kind = value.kind ?? "presence";
  if (!SHAREABLE_SUMMARY_KINDS.has(kind)) {
    fail(`${path}.kind`, "is invalid.");
  }
  return Object.freeze({ kind });
}

function shareableLimits(value, path) {
  if (value === undefined) value = {};
  requirePlainObject(value, path);
  onlyFields(value, new Set(["maxEntries", "maxValueBytes"]), path);
  return Object.freeze({
    maxEntries: positiveInteger(
      value.maxEntries ?? MAX_SHAREABLE_ENTRIES,
      `${path}.maxEntries`,
      MAX_SHAREABLE_ENTRIES
    ),
    maxValueBytes: positiveInteger(
      value.maxValueBytes ?? MAX_SHAREABLE_VALUE_BYTES,
      `${path}.maxValueBytes`,
      MAX_SHAREABLE_VALUE_BYTES
    )
  });
}

function shareableState(value) {
  const path = "Feature definition.shareableState";
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SHAREABLE_NAMESPACES) {
    fail(path, `must be an array of at most ${MAX_SHAREABLE_NAMESPACES} entries.`);
  }
  const ids = new Set();
  const namespaces = value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    requirePlainObject(entry, entryPath);
    onlyFields(entry, new Set([
      "id",
      "label",
      "schemaVersion",
      "compatibleVersions",
      "collisionSummary",
      "limits"
    ]), entryPath);
    if (
      typeof entry.id !== "string" ||
      !SHAREABLE_NAMESPACE_ID_PATTERN.test(entry.id)
    ) {
      fail(`${entryPath}.id`, "is invalid.");
    }
    if (ids.has(entry.id)) fail(`${entryPath}.id`, "must be unique.");
    ids.add(entry.id);
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (
      typeof entry.label !== "string" ||
      label.length === 0 ||
      label.length > MAX_SHAREABLE_LABEL_LENGTH ||
      hasControlCharacters(entry.label)
    ) {
      fail(`${entryPath}.label`, "is invalid.");
    }
    const schemaVersion = positiveInteger(
      entry.schemaVersion,
      `${entryPath}.schemaVersion`,
      MAX_SHAREABLE_SCHEMA_VERSION
    );
    return Object.freeze({
      id: entry.id,
      label,
      schemaVersion,
      compatibleVersions: compatibleVersions(
        entry.compatibleVersions,
        schemaVersion,
        `${entryPath}.compatibleVersions`
      ),
      collisionSummary: collisionSummary(
        entry.collisionSummary,
        `${entryPath}.collisionSummary`
      ),
      limits: shareableLimits(entry.limits, `${entryPath}.limits`)
    });
  });
  return Object.freeze(namespaces);
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
    shareableState: shareableState(input.shareableState),
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
