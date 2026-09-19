import { createPlatformGroupRef } from "../integrations/contracts.js";
import { normalizeReadableStateParameter } from "./catalog.js";
import {
  canonicalStateQueryJson,
  STATE_QUERY_LIMITS,
  StateQueryError
} from "./query.js";

export const STATE_QUERY_GRANT_LIMITS = Object.freeze({
  minLifetimeSeconds: 5 * 60,
  maxLifetimeSeconds: 30 * 24 * 60 * 60,
  defaultLifetimeSeconds: 24 * 60 * 60,
  maxPermissions: 20,
  maxExactValues: 50
});

const LIMIT_NAMES = Object.freeze(Object.keys(STATE_QUERY_LIMITS));
const READ_FIELDS = new Set(["feature", "export", "version"]);

export class StateQueryGrantError extends Error {
  constructor(message, {
    code = "state_query_grant_invalid",
    status = 422,
    path = "grant"
  } = {}) {
    super(`${path} ${message}`);
    this.name = "StateQueryGrantError";
    this.code = code;
    this.status = status;
    this.path = path;
  }
}

function fail(path, message, options = {}) {
  throw new StateQueryGrantError(message, { path, ...options });
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, path) {
  if (!isPlainObject(value)) fail(path, "must be an object.");
  return value;
}

function onlyFields(value, allowed, path) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) fail(`${path}.${unknown}`, "is not supported.");
}

function normalizeTarget(value) {
  const path = "grant.target";
  requireObject(value, path);
  onlyFields(value, new Set(["platform", "groupId"]), path);
  let group;
  try {
    group = createPlatformGroupRef({
      platform: value.platform,
      kind: value.platform === "discord" ? "guild" : "channel",
      id: value.groupId
    });
  } catch {
    fail(path, "is invalid.");
  }
  return Object.freeze({ platform: group.platform, groupId: group.id });
}

export function readableStateIdentity(read) {
  return `${read.feature}:${read.export}:v${read.version}`;
}

function normalizeRead(registry, read, platform, path) {
  requireObject(read, path);
  onlyFields(read, READ_FIELDS, path);
  const identity = readableStateIdentity(read);
  const installed = registry.readableState[identity];
  if (!installed || !installed.definition.platforms.includes(platform)) {
    fail(path, "does not identify an eligible readable export.");
  }
  return {
    identity,
    installed,
    read: Object.freeze({
      feature: installed.featureId,
      export: installed.definition.id,
      version: installed.definition.version
    })
  };
}

function canonicalScalar(value) {
  return canonicalStateQueryJson(value);
}

function normalizeValuePolicy(parameter, input, path) {
  if (input === "any" || input === "none") {
    return Object.freeze({ kind: input });
  }
  requireObject(input, path);
  onlyFields(input, new Set(["exact"]), path);
  if (
    !Array.isArray(input.exact) ||
    input.exact.length === 0 ||
    input.exact.length > STATE_QUERY_GRANT_LIMITS.maxExactValues
  ) {
    fail(`${path}.exact`, "must contain 1–50 values.");
  }
  const values = new Map();
  for (const [index, candidate] of input.exact.entries()) {
    let normalized;
    try {
      normalized = normalizeReadableStateParameter(
        parameter,
        candidate,
        `${path}.exact[${index}]`
      ).value;
    } catch {
      fail(`${path}.exact[${index}]`, "is invalid for this parameter.");
    }
    values.set(canonicalScalar(normalized), normalized);
  }
  return Object.freeze({ kind: "exact", values: Object.freeze([...values.values()]) });
}

function normalizeDynamicSources(registry, input, platform, path) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > STATE_QUERY_GRANT_LIMITS.maxPermissions) {
    fail(path, "must be an array of at most 20 readable exports.");
  }
  const sources = new Map();
  for (const [index, read] of input.entries()) {
    const normalized = normalizeRead(registry, read, platform, `${path}[${index}]`);
    sources.set(normalized.identity, normalized.read);
  }
  return Object.freeze([...sources.values()]);
}

function normalizeArguments(registry, definition, input, platform, path) {
  const names = Object.keys(definition.parameters);
  if (names.length === 0) {
    if (input !== undefined && (!isPlainObject(input) || Object.keys(input).length > 0)) {
      fail(path, "is not allowed for this export.");
    }
    return Object.freeze({});
  }
  requireObject(input, path);
  const unknown = Object.keys(input).find((name) => !(name in definition.parameters));
  if (unknown) fail(`${path}.${unknown}`, "is not declared.");
  const missing = names.find((name) => !Object.prototype.hasOwnProperty.call(input, name));
  if (missing) fail(`${path}.${missing}`, "is required.");
  return Object.freeze(Object.fromEntries(names.map((name) => {
    const parameterPath = `${path}.${name}`;
    const policy = requireObject(input[name], parameterPath);
    onlyFields(policy, new Set(["values", "dynamicFrom"]), parameterPath);
    return [name, Object.freeze({
      values: normalizeValuePolicy(
        definition.parameters[name],
        policy.values,
        `${parameterPath}.values`
      ),
      dynamicFrom: normalizeDynamicSources(
        registry,
        policy.dynamicFrom,
        platform,
        `${parameterPath}.dynamicFrom`
      )
    })];
  })));
}

function normalizeCollection(definition, input, path) {
  if (definition.kind !== "collection") {
    if (input !== undefined) fail(path, "is only allowed for collection exports.");
    return null;
  }
  requireObject(input, path);
  onlyFields(input, new Set(["includeFutureMembers"]), path);
  if (input.includeFutureMembers !== true) {
    fail(
      `${path}.includeFutureMembers`,
      "must be true; frozen-membership collection grants are not supported in version 1."
    );
  }
  return Object.freeze({ includeFutureMembers: true });
}

function normalizePermissions(registry, input, platform) {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > STATE_QUERY_GRANT_LIMITS.maxPermissions
  ) {
    fail("grant.permissions", "must contain 1–20 permissions.");
  }
  const permissions = new Map();
  for (const [index, candidate] of input.entries()) {
    const path = `grant.permissions[${index}]`;
    requireObject(candidate, path);
    onlyFields(candidate, new Set(["read", "arguments", "collection"]), path);
    const normalized = normalizeRead(registry, candidate.read, platform, `${path}.read`);
    if (permissions.has(normalized.identity)) {
      fail(path, "duplicates another readable export permission.");
    }
    const definition = normalized.installed.definition;
    const permission = {
      read: normalized.read,
      arguments: normalizeArguments(
        registry,
        definition,
        candidate.arguments,
        platform,
        `${path}.arguments`
      )
    };
    const collection = normalizeCollection(
      definition,
      candidate.collection,
      `${path}.collection`
    );
    if (collection) permission.collection = collection;
    permissions.set(normalized.identity, Object.freeze(permission));
  }
  for (const [identity, permission] of permissions) {
    for (const [name, policy] of Object.entries(permission.arguments)) {
      for (const source of policy.dynamicFrom) {
        if (!permissions.has(readableStateIdentity(source))) {
          fail(
            `grant.permissions.${identity}.arguments.${name}.dynamicFrom`,
            "must reference another export allowed by this grant."
          );
        }
      }
    }
  }
  return Object.freeze([...permissions.values()]);
}

function normalizeLimits(input) {
  if (input === undefined) return STATE_QUERY_LIMITS;
  requireObject(input, "grant.limits");
  onlyFields(input, new Set(LIMIT_NAMES), "grant.limits");
  return Object.freeze(Object.fromEntries(LIMIT_NAMES.map((name) => {
    const value = input[name] ?? STATE_QUERY_LIMITS[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > STATE_QUERY_LIMITS[name]) {
      fail(`grant.limits.${name}`, `must be between 1 and ${STATE_QUERY_LIMITS[name]}.`);
    }
    return [name, value];
  })));
}

export function normalizeStateQueryGrantRequest(registry, input, {
  environment,
  nowMs = Date.now()
} = {}) {
  requireObject(input, "grant");
  onlyFields(
    input,
    new Set(["target", "permissions", "expiresInSeconds", "limits"]),
    "grant"
  );
  if (typeof environment !== "string" || !/^[a-z0-9_-]{1,40}$/.test(environment)) {
    throw new TypeError("State-query deployment environment is invalid.");
  }
  const target = normalizeTarget(input.target);
  const lifetime = input.expiresInSeconds ?? STATE_QUERY_GRANT_LIMITS.defaultLifetimeSeconds;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < STATE_QUERY_GRANT_LIMITS.minLifetimeSeconds ||
    lifetime > STATE_QUERY_GRANT_LIMITS.maxLifetimeSeconds
  ) {
    fail(
      "grant.expiresInSeconds",
      `must be between ${STATE_QUERY_GRANT_LIMITS.minLifetimeSeconds} and ` +
      `${STATE_QUERY_GRANT_LIMITS.maxLifetimeSeconds}.`
    );
  }
  return Object.freeze({
    target,
    environment,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + lifetime * 1000,
    permissions: normalizePermissions(registry, input.permissions, target.platform),
    limits: normalizeLimits(input.limits)
  });
}

function accessDenied() {
  throw new StateQueryError("is not authorized by this read grant.", {
    code: "query_access_denied",
    status: 403,
    path: "query"
  });
}

function permissionMap(grant) {
  return new Map(grant.permissions.map((permission) => [
    readableStateIdentity(permission.read),
    permission
  ]));
}

function sameTarget(left, right) {
  return left?.platform === right?.platform && left?.groupId === right?.groupId;
}

function valueAllowed(policy, value) {
  if (policy.kind === "any") return true;
  if (policy.kind === "none") return false;
  const canonical = canonicalScalar(value);
  return policy.values.some((allowed) => canonicalScalar(allowed) === canonical);
}

export function preauthorizeStateQueryInput(input, grant) {
  if (!isPlainObject(input) || !sameTarget(input.target, grant.target)) accessDenied();
  if (!isPlainObject(input.bindings)) accessDenied();
  const permissions = permissionMap(grant);
  for (const candidate of Object.values(input.bindings)) {
    if (!isPlainObject(candidate?.read)) accessDenied();
    if (!permissions.has(readableStateIdentity(candidate.read))) accessDenied();
  }
}

export function authorizeStateQueryPlan(plan, grant) {
  if (!sameTarget(plan.query.target, grant.target)) accessDenied();
  const encodedBytes = new TextEncoder().encode(canonicalStateQueryJson(plan.query)).byteLength;
  if (encodedBytes > grant.limits.maxDocumentBytes) accessDenied();
  if (Object.keys(plan.bindings).length > grant.limits.maxBindings) accessDenied();
  if (Object.keys(plan.selections).length > grant.limits.maxSelections) accessDenied();
  if (plan.maxDependencyDepth > grant.limits.maxDependencyDepth) accessDenied();
  const permissions = permissionMap(grant);
  let dynamicEdges = 0;
  let collectionBindings = 0;
  for (const binding of Object.values(plan.bindings)) {
    const permission = permissions.get(readableStateIdentity({
      feature: binding.featureId,
      export: binding.definition.id,
      version: binding.definition.version
    }));
    if (!permission) accessDenied();
    if (binding.definition.kind === "collection") {
      collectionBindings += 1;
      if (permission.collection?.includeFutureMembers !== true) accessDenied();
    }
    if (Object.keys(binding.arguments).length > grant.limits.maxArguments) accessDenied();
    for (const [name, expression] of Object.entries(binding.arguments)) {
      const policy = permission.arguments[name];
      if (!policy) accessDenied();
      if (expression.kind === "literal") {
        if (!valueAllowed(policy.values, expression.normalized.literal)) accessDenied();
        continue;
      }
      dynamicEdges += 1;
      const source = plan.bindings[expression.ref];
      const sourceIdentity = readableStateIdentity({
        feature: source.featureId,
        export: source.definition.id,
        version: source.definition.version
      });
      if (!policy.dynamicFrom.some((allowed) =>
        readableStateIdentity(allowed) === sourceIdentity
      )) accessDenied();
      if (expression.path.length > grant.limits.maxProjectionDepth) accessDenied();
    }
  }
  if (dynamicEdges > grant.limits.maxDynamicEdges) accessDenied();
  if (collectionBindings > grant.limits.maxCollectionBindings) accessDenied();
  for (const selection of Object.values(plan.selections)) {
    if (selection.path.length > grant.limits.maxProjectionDepth) accessDenied();
  }
}

export function authorizeStateQueryBinding(grant, binding, argumentsValue) {
  const permission = permissionMap(grant).get(readableStateIdentity({
    feature: binding.featureId,
    export: binding.definition.id,
    version: binding.definition.version
  }));
  if (!permission) accessDenied();
  for (const [name, value] of Object.entries(argumentsValue)) {
    if (!valueAllowed(permission.arguments[name]?.values, value)) accessDenied();
  }
}

export function stateQueryGrantCatalog(registry, grant) {
  const permissions = permissionMap(grant);
  return registry.readableCatalog.filter((entry) =>
    entry.supportedPlatforms.includes(grant.target.platform) &&
    permissions.has(readableStateIdentity(entry))
  ).map((entry) => {
    const permission = permissions.get(readableStateIdentity(entry));
    return Object.freeze({
      ...entry,
      grantScope: Object.freeze({
        arguments: permission.arguments,
        ...(permission.collection ? { collection: permission.collection } : {})
      })
    });
  });
}

export function grantPermissionsForExportList(registry, platform, input) {
  if (typeof input !== "string") fail("exports", "must be a comma-separated string.");
  const identities = [...new Set(input.split(",").map((value) => value.trim()).filter(Boolean))];
  if (identities.length === 0 || identities.length > STATE_QUERY_GRANT_LIMITS.maxPermissions) {
    fail("exports", "must contain 1–20 export identities.");
  }
  const selected = identities.map((identity, index) => {
    const installed = registry.readableState[identity];
    if (!installed || !installed.definition.platforms.includes(platform)) {
      fail(`exports[${index}]`, "does not identify an eligible readable export.");
    }
    return installed;
  });
  const allowedReads = selected.map(({ featureId, definition }) => ({
    feature: featureId,
    export: definition.id,
    version: definition.version
  }));
  return selected.map(({ featureId, definition }) => ({
    read: { feature: featureId, export: definition.id, version: definition.version },
    ...(Object.keys(definition.parameters).length > 0 ? {
      arguments: Object.fromEntries(Object.keys(definition.parameters).map((name) => [
        name,
        { values: "any", dynamicFrom: allowedReads }
      ]))
    } : {}),
    ...(definition.kind === "collection"
      ? { collection: { includeFutureMembers: true } }
      : {})
  }));
}
