import { createPlatformGroupRef } from "../integrations/contracts.js";
import {
  normalizeReadableStateParameter,
  ReadableStateReferenceError
} from "./catalog.js";

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FEATURE_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const PLATFORMS = new Set(["discord", "twitch"]);

export const STATE_QUERY_LIMITS = Object.freeze({
  maxDocumentBytes: 16 * 1024,
  maxBindings: 20,
  maxSelections: 20,
  maxArguments: 10,
  maxDynamicEdges: 40,
  maxDependencyDepth: 8,
  maxProjectionDepth: 10,
  maxCollectionBindings: 3,
  maxResultBytes: 64 * 1024
});

export class StateQueryError extends Error {
  constructor(message, {
    code = "query_document_invalid",
    status = 422,
    path = "query",
    cause
  } = {}) {
    super(`${path} ${message}`, { cause });
    this.name = "StateQueryError";
    this.code = code;
    this.status = status;
    this.path = path;
  }
}

function fail(path, message, code = "query_document_invalid", status = 422, cause) {
  throw new StateQueryError(message, { path, code, status, cause });
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, path, code = "query_document_invalid") {
  if (!isPlainObject(value)) fail(path, "must be an object.", code);
  return value;
}

function onlyFields(value, allowed, path, code = "query_document_invalid") {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) fail(`${path}.${unknown}`, "is not supported.", code);
}

function identifier(value, path, code = "query_document_invalid") {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail(path, "is invalid.", code);
  }
  return value;
}

function freezeJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, freezeJson(entry)])
    ));
  }
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalValue(value[key])
    ]));
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  fail("query", "contains a value that cannot be canonicalized.");
}

export function canonicalStateQueryJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export async function stateQueryDigest(value) {
  const bytes = new TextEncoder().encode(canonicalStateQueryJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function normalizeTarget(value) {
  const path = "query.target";
  requireObject(value, path, "query_target_invalid");
  onlyFields(value, new Set(["platform", "groupId"]), path, "query_target_invalid");
  if (!PLATFORMS.has(value.platform)) {
    fail(`${path}.platform`, "is unsupported.", "query_target_invalid");
  }
  let group;
  try {
    group = createPlatformGroupRef({
      platform: value.platform,
      kind: value.platform === "discord" ? "guild" : "channel",
      id: value.groupId
    });
  } catch (cause) {
    fail(`${path}.groupId`, "is invalid.", "query_target_invalid", 422, cause);
  }
  return Object.freeze({
    platform: group.platform,
    groupId: group.id
  });
}

function installedExport(registry, read, path, platform) {
  requireObject(read, path, "query_export_not_found");
  onlyFields(
    read,
    new Set(["feature", "export", "version"]),
    path,
    "query_document_invalid"
  );
  if (typeof read.feature !== "string" || !FEATURE_ID_PATTERN.test(read.feature)) {
    fail(`${path}.feature`, "is invalid.", "query_export_not_found", 404);
  }
  identifier(read.export, `${path}.export`, "query_export_not_found");
  if (!Number.isSafeInteger(read.version) || read.version < 1) {
    fail(`${path}.version`, "is invalid.", "query_export_version_unsupported");
  }
  const identity = `${read.feature}:${read.export}:v${read.version}`;
  const installed = registry?.readableState?.[identity];
  if (!installed) {
    const otherVersion = Object.values(registry?.readableState ?? {}).some((entry) =>
      entry.featureId === read.feature && entry.definition.id === read.export
    );
    fail(
      path,
      otherVersion
        ? "pins an unsupported readable export version."
        : "does not identify an installed readable export.",
      otherVersion ? "query_export_version_unsupported" : "query_export_not_found",
      otherVersion ? 422 : 404
    );
  }
  if (!installed.definition.platforms.includes(platform)) {
    fail(path, "is not available for the target platform.", "query_export_not_found", 404);
  }
  return installed;
}

function projectionSchema(schema, path, errorPath) {
  if (!Array.isArray(path) || path.length > STATE_QUERY_LIMITS.maxProjectionDepth) {
    fail(errorPath, "has an invalid projection path.", "query_reference_invalid");
  }
  let current = schema;
  for (let index = 0; index < path.length; index += 1) {
    const field = path[index];
    if (
      typeof field !== "string" ||
      current.type !== "object" ||
      !Object.prototype.hasOwnProperty.call(current.properties, field)
    ) {
      fail(errorPath, "does not identify a declared result field.", "query_reference_invalid");
    }
    current = current.properties[field];
  }
  return current;
}

function schemaAssignable(source, target) {
  if (source.nullable === true && target.nullable !== true) return false;
  if (source.type !== target.type) {
    if (!(source.type === "integer" && target.type === "number")) return false;
  }
  if (target.type === "string") {
    if (source.minLength < target.minLength) return false;
    if (source.maxLength > target.maxLength) return false;
  }
  if (["number", "integer"].includes(target.type)) {
    if (target.minimum !== undefined && (
      source.minimum === undefined || source.minimum < target.minimum
    )) return false;
    if (target.maximum !== undefined && (
      source.maximum === undefined || source.maximum > target.maximum
    )) return false;
  }
  return true;
}

function literalExpression(expression, parameter, path) {
  const literal = expression.literal;
  if (
    literal !== null &&
    typeof literal !== "string" &&
    typeof literal !== "boolean" &&
    !(typeof literal === "number" && Number.isSafeInteger(literal))
  ) {
    fail(
      `${path}.literal`,
      "must be a string, boolean, safe integer, or null.",
      "query_argument_invalid"
    );
  }
  let normalized;
  try {
    normalized = normalizeReadableStateParameter(parameter, literal, `${path}.literal`);
  } catch (cause) {
    if (cause instanceof ReadableStateReferenceError) {
      fail(path, "does not satisfy its declared parameter.", "query_argument_invalid", 422, cause);
    }
    throw cause;
  }
  return {
    normalized: Object.freeze({ literal: normalized.value }),
    subject: normalized.subject
  };
}

function argumentExpression(expression, parameter, path) {
  requireObject(expression, path, "query_argument_invalid");
  const hasLiteral = Object.prototype.hasOwnProperty.call(expression, "literal");
  const hasReference = Object.prototype.hasOwnProperty.call(expression, "ref");
  if (hasLiteral === hasReference) {
    fail(path, "must contain exactly one literal or reference.", "query_argument_invalid");
  }
  if (hasLiteral) {
    onlyFields(expression, new Set(["literal"]), path, "query_argument_invalid");
    return { kind: "literal", ...literalExpression(expression, parameter, path) };
  }
  onlyFields(expression, new Set(["ref", "path"]), path, "query_argument_invalid");
  if (expression.path !== undefined && !Array.isArray(expression.path)) {
    fail(`${path}.path`, "must be an array.", "query_reference_invalid");
  }
  return {
    kind: "reference",
    ref: identifier(expression.ref, `${path}.ref`, "query_reference_invalid"),
    path: Object.freeze([...(expression.path ?? [])])
  };
}

function bindingDefinition(registry, alias, input, platform) {
  const path = `query.bindings.${alias}`;
  requireObject(input, path);
  onlyFields(input, new Set(["read", "arguments"]), path);
  const installed = installedExport(registry, input.read, `${path}.read`, platform);
  const definition = installed.definition;
  const parameterNames = Object.keys(definition.parameters);
  const hasArguments = Object.prototype.hasOwnProperty.call(input, "arguments");
  if ((parameterNames.length > 0) !== hasArguments) {
    fail(
      `${path}.arguments`,
      parameterNames.length > 0 ? "is required." : "is not allowed for this export.",
      "query_argument_invalid"
    );
  }
  const argumentInput = input.arguments ?? {};
  requireObject(argumentInput, `${path}.arguments`, "query_argument_invalid");
  if (Object.keys(argumentInput).length > STATE_QUERY_LIMITS.maxArguments) {
    fail(`${path}.arguments`, "exceeds the argument limit.", "query_limit_exceeded", 413);
  }
  const unknown = Object.keys(argumentInput).find((name) => !(name in definition.parameters));
  if (unknown) {
    fail(`${path}.arguments.${unknown}`, "is not declared.", "query_argument_invalid");
  }
  const missing = parameterNames.find((name) =>
    !Object.prototype.hasOwnProperty.call(argumentInput, name)
  );
  if (missing) fail(`${path}.arguments.${missing}`, "is required.", "query_argument_invalid");
  const argumentsPlan = Object.freeze(Object.fromEntries(parameterNames.map((name) => [
    name,
    Object.freeze(argumentExpression(
      argumentInput[name],
      definition.parameters[name],
      `${path}.arguments.${name}`
    ))
  ])));
  return Object.freeze({
    alias,
    featureId: installed.featureId,
    definition,
    arguments: argumentsPlan
  });
}

function validateBindingReferences(bindings) {
  let edges = 0;
  for (const binding of Object.values(bindings)) {
    for (const [name, expression] of Object.entries(binding.arguments)) {
      if (expression.kind !== "reference") continue;
      edges += 1;
      if (edges > STATE_QUERY_LIMITS.maxDynamicEdges) {
        fail("query.bindings", "exceeds the dynamic dependency limit.", "query_limit_exceeded", 413);
      }
      const source = bindings[expression.ref];
      if (!source) {
        fail(
          `query.bindings.${binding.alias}.arguments.${name}.ref`,
          "does not identify a binding.",
          "query_reference_invalid"
        );
      }
      const sourceSchema = projectionSchema(
        source.definition.result.schema,
        expression.path,
        `query.bindings.${binding.alias}.arguments.${name}.path`
      );
      if (!schemaAssignable(sourceSchema, binding.definition.parameters[name].schema)) {
        fail(
          `query.bindings.${binding.alias}.arguments.${name}`,
          "is not type-compatible with the destination parameter.",
          "query_type_mismatch"
        );
      }
    }
  }
}

function evaluationOrder(bindings) {
  const visiting = new Set();
  const visited = new Set();
  const depths = new Map();
  const order = [];
  const visit = (alias) => {
    if (visiting.has(alias)) fail("query.bindings", "contains a dependency cycle.", "query_cycle");
    if (visited.has(alias)) return depths.get(alias);
    visiting.add(alias);
    let depth = 1;
    for (const expression of Object.values(bindings[alias].arguments)) {
      if (expression.kind !== "reference") continue;
      depth = Math.max(depth, visit(expression.ref) + 1);
    }
    if (depth > STATE_QUERY_LIMITS.maxDependencyDepth) {
      fail("query.bindings", "exceeds the dependency-depth limit.", "query_limit_exceeded", 413);
    }
    visiting.delete(alias);
    visited.add(alias);
    depths.set(alias, depth);
    order.push(alias);
    return depth;
  };
  for (const alias of Object.keys(bindings)) visit(alias);
  return Object.freeze({
    order: Object.freeze(order),
    maxDepth: Math.max(...depths.values())
  });
}

function selectionDefinition(bindings, alias, input) {
  const path = `query.select.${alias}`;
  requireObject(input, path, "query_reference_invalid");
  onlyFields(input, new Set(["ref", "path"]), path, "query_reference_invalid");
  const ref = identifier(input.ref, `${path}.ref`, "query_reference_invalid");
  const source = bindings[ref];
  if (!source) fail(`${path}.ref`, "does not identify a binding.", "query_reference_invalid");
  if (input.path !== undefined && !Array.isArray(input.path)) {
    fail(`${path}.path`, "must be an array.", "query_reference_invalid");
  }
  const projection = Object.freeze([...(input.path ?? [])]);
  projectionSchema(source.definition.result.schema, projection, `${path}.path`);
  return Object.freeze({ ref, path: projection });
}

function normalizedExpression(expression) {
  return expression.kind === "literal"
    ? Object.freeze({ literal: expression.normalized.literal })
    : Object.freeze({ ref: expression.ref, path: expression.path });
}

export async function prepareStateQuery(registry, input) {
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch (cause) {
    fail("query", "must be JSON-serializable.", "query_document_invalid", 422, cause);
  }
  if (typeof serialized !== "string") {
    fail("query", "must be a JSON object.");
  }
  if (new TextEncoder().encode(serialized).byteLength > STATE_QUERY_LIMITS.maxDocumentBytes) {
    fail("query", "exceeds the document-size limit.", "query_limit_exceeded", 413);
  }
  requireObject(input, "query");
  onlyFields(input, new Set(["version", "target", "bindings", "select"]), "query");
  if (input.version !== 1) {
    fail("query.version", "is unsupported.", "query_version_unsupported");
  }
  const target = normalizeTarget(input.target);
  requireObject(input.bindings, "query.bindings");
  const bindingEntries = Object.entries(input.bindings);
  if (
    bindingEntries.length === 0 ||
    bindingEntries.length > STATE_QUERY_LIMITS.maxBindings
  ) {
    fail("query.bindings", "must contain 1–20 bindings.", "query_limit_exceeded", 413);
  }
  const bindings = Object.freeze(Object.fromEntries(bindingEntries.map(([alias, value]) => {
    identifier(alias, `query.bindings.${alias}`);
    return [alias, bindingDefinition(registry, alias, value, target.platform)];
  })));
  if (
    Object.values(bindings).filter(({ definition }) => definition.kind === "collection").length >
    STATE_QUERY_LIMITS.maxCollectionBindings
  ) {
    fail("query.bindings", "exceeds the collection-binding limit.", "query_limit_exceeded", 413);
  }
  validateBindingReferences(bindings);
  const evaluation = evaluationOrder(bindings);

  requireObject(input.select, "query.select");
  const selectionEntries = Object.entries(input.select);
  if (
    selectionEntries.length === 0 ||
    selectionEntries.length > STATE_QUERY_LIMITS.maxSelections
  ) {
    fail("query.select", "must contain 1–20 selections.", "query_limit_exceeded", 413);
  }
  const selections = Object.freeze(Object.fromEntries(selectionEntries.map(([alias, value]) => {
    identifier(alias, `query.select.${alias}`);
    return [alias, selectionDefinition(bindings, alias, value)];
  })));
  const normalizedQuery = freezeJson({
    version: 1,
    target,
    bindings: Object.fromEntries(Object.entries(bindings).map(([alias, binding]) => [
      alias,
      {
        read: {
          feature: binding.featureId,
          export: binding.definition.id,
          version: binding.definition.version
        },
        ...(Object.keys(binding.arguments).length > 0
          ? {
              arguments: Object.fromEntries(Object.entries(binding.arguments).map(
                ([name, expression]) => [name, normalizedExpression(expression)]
              ))
            }
          : {})
      }
    ])),
    select: Object.fromEntries(Object.entries(selections).map(([alias, selection]) => [
      alias,
      { ref: selection.ref, path: selection.path }
    ]))
  });
  return Object.freeze({
    query: normalizedQuery,
    digest: await stateQueryDigest(normalizedQuery),
    bindings,
    selections,
    order: evaluation.order,
    maxDependencyDepth: evaluation.maxDepth
  });
}

export function projectStateQueryValue(value, path) {
  let current = value;
  for (const field of path) current = current[field];
  return current;
}
