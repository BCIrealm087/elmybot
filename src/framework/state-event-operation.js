import { isSchema, objectSchemaField } from "./argument-schema.js";
import { isFrameworkDefinition, markFrameworkDefinition } from "./definition-brand.js";
import { serializeDurableEventPayload } from "../durable-events/contract.js";

const TYPE = "state-event-operation";
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD = /^[a-z][A-Za-z0-9_-]{0,63}$/;
const RESULTS = new Set(["before", "after", "changed", "appliedAmount"]);
const MUTATIONS = new Set(["set", "delete", "increment", "bounded_counter"]);
const COUNTER_OPERATIONS = new Set(["set", "increment", "decrement", "reset"]);

export class StateEventOperationDefinitionError extends TypeError {
  constructor(message, { path = "State event operation" } = {}) {
    super(`${path} ${message}`);
    this.name = "StateEventOperationDefinitionError";
    this.code = "invalid_state_event_operation";
    this.path = path;
  }
}

function fail(path, message) {
  throw new StateEventOperationDefinitionError(message, { path });
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" ||
        !Object.getOwnPropertyDescriptor(value, key).enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    fail(path, "must be a plain data object.");
  }
  return value;
}

function fields(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "is unsupported.");
  }
}

function identifier(value, path) {
  if (typeof value !== "string" || !ID.test(value)) fail(path, "is invalid.");
  return value;
}

// Copy only JSON data; callbacks, accessors, prototypes, cycles and non-finite
// numbers cannot enter a persisted mutation/projection description.
function json(value, path, ancestors = new Set(), depth = 0) {
  if (depth > 20) fail(path, "is nested too deeply.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || ancestors.has(value)) {
    fail(path, "must contain acyclic JSON data only.");
  }
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length ||
        Reflect.ownKeys(value).length !== value.length + 1) fail(path, "must be a dense array.");
    return Object.freeze(Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(path, "contains an accessor.");
      return json(descriptor.value, `${path}[${index}]`, next, depth + 1);
    }));
  }
  object(value, path);
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => [
    key, json(value[key], `${path}.${key}`, next, depth + 1)
  ])));
}

function sized(value, path, maximum = 16_384) {
  const result = json(value, path);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maximum) {
    fail(path, `exceeds ${maximum} serialized bytes.`);
  }
  return result;
}

export function normalizeStateEventScope(value, path = "State event scope") {
  fields(value, ["kind", "namespace"], path);
  if (value.kind === "group_local") {
    if (Object.hasOwn(value, "namespace")) fail(path, "cannot name a local namespace.");
    return Object.freeze({ kind: value.kind });
  }
  if (value.kind !== "effective_shareable") fail(`${path}.kind`, "is invalid.");
  return Object.freeze({
    kind: value.kind,
    namespace: identifier(value.namespace, `${path}.namespace`)
  });
}

function expression(value, input, path, resultAllowed = false) {
  fields(value, ["literal", "input", "config", "result"], path);
  const keys = Object.keys(value);
  if (keys.length !== 1) fail(path, "must contain exactly one selector.");
  const kind = keys[0];
  if (kind === "literal") return Object.freeze({ literal: sized(value.literal, path) });
  if (kind === "input") {
    identifier(value.input, path);
    if (!isSchema(objectSchemaField(input, value.input))) fail(path, "names an undeclared input field.");
  } else if (kind === "config") {
    identifier(value.config, path);
  } else if (!resultAllowed || !RESULTS.has(value.result)) {
    fail(path, "has an invalid result selector.");
  }
  return Object.freeze({ [kind]: value[kind] });
}

function integer(value, path, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(path, "is invalid.");
  return value;
}

function mutation(value, input, path) {
  object(value, path);
  if (!MUTATIONS.has(value.kind)) fail(`${path}.kind`, "is unsupported.");
  const counter = value.kind === "bounded_counter";
  const allowed = counter
    ? ["kind", "name", "subject", "subjectLabel", "min", "max", "initial", "operation"]
    : ["kind", "key"];
  const operation = counter ? value.operation : value.kind;
  if (counter && !COUNTER_OPERATIONS.has(operation)) fail(`${path}.operation`, "is unsupported.");
  if (operation === "set") allowed.push("value");
  if (["increment", "decrement"].includes(operation)) allowed.push("amount");
  fields(value, allowed, path);
  const result = { kind: value.kind };
  if (counter) {
    result.name = identifier(value.name, `${path}.name`);
    result.subject = expression(value.subject, input, `${path}.subject`);
    if (value.subjectLabel !== undefined) {
      if (typeof value.subjectLabel !== "string" || !value.subjectLabel.trim() ||
          value.subjectLabel.length > 80 || Array.from(value.subjectLabel).some((character) =>
            character.codePointAt(0) <= 31 || character.codePointAt(0) === 127)) {
        fail(`${path}.subjectLabel`, "is invalid.");
      }
      result.subjectLabel = value.subjectLabel.trim();
    }
    result.min = integer(value.min ?? 0, `${path}.min`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    result.max = integer(value.max ?? Number.MAX_SAFE_INTEGER, `${path}.max`, result.min, Number.MAX_SAFE_INTEGER);
    result.initial = integer(value.initial ?? result.min, `${path}.initial`, result.min, result.max);
    result.operation = operation;
  } else {
    result.key = expression(value.key, input, `${path}.key`);
  }
  if (operation === "set") result.value = expression(value.value, input, `${path}.value`);
  if (["increment", "decrement"].includes(operation)) {
    result.amount = expression(value.amount ?? { literal: 1 }, input, `${path}.amount`);
  }
  if (counter && Object.hasOwn(result.subject, "literal")) {
    const subject = result.subject.literal;
    if (typeof subject !== "string" || !subject.length || subject.length > 300) fail(`${path}.subject`, "must contain 1–300 characters.");
  }
  if (!counter && Object.hasOwn(result.key, "literal")) identifier(result.key.literal, `${path}.key`);
  if (result.amount && Object.hasOwn(result.amount, "literal")) {
    integer(result.amount.literal, `${path}.amount`, counter ? 1 : -1_000_000, 1_000_000);
  }
  if (counter && result.value && Object.hasOwn(result.value, "literal")) {
    integer(result.value.literal, `${path}.value`, result.min, result.max);
  }
  return Object.freeze(result);
}

export function defineStateEventOperation(value) {
  const path = "State event operation";
  fields(value, ["id", "input", "scope", "stream", "mutation", "event"], path);
  if (!isSchema(value.input) || value.input.kind !== "object") fail(`${path}.input`, "must be an object schema.");
  fields(value.stream, ["id", "version"], `${path}.stream`);
  object(value.event, `${path}.event`);
  const entries = Object.entries(value.event);
  if (!entries.length || entries.length > 20) fail(`${path}.event`, "must contain 1–20 projected fields.");
  const definition = {
    id: identifier(value.id, `${path}.id`),
    input: value.input,
    scope: normalizeStateEventScope(value.scope),
    stream: Object.freeze({
      id: identifier(value.stream.id, `${path}.stream.id`),
      version: integer(value.stream.version, `${path}.stream.version`, 1, 1_000_000)
    }),
    mutation: mutation(value.mutation, value.input, `${path}.mutation`),
    event: Object.freeze(Object.fromEntries(entries.map(([key, entry]) => {
      if (!FIELD.test(key)) fail(`${path}.event.${key}`, "has an invalid field name.");
      return [key, expression(entry, value.input, `${path}.event.${key}`, true)];
    })))
  };
  // Bound the static description too; a schema object contains framework-owned
  // parser functions and is deliberately not serialized as part of the request.
  sized({ ...definition, input: null }, path);
  return markFrameworkDefinition(definition, TYPE);
}

export function isStateEventOperation(value) {
  return isFrameworkDefinition(value, TYPE);
}

export function stateEventConfigKeys(definition) {
  return [...new Set([
    ...Object.values(definition.mutation), ...Object.values(definition.event)
  ].filter((entry) => entry && typeof entry === "object" && Object.hasOwn(entry, "config"))
    .map((entry) => entry.config))].sort();
}

export function prepareStateEventOperation(definition, input, config = {}) {
  if (!isStateEventOperation(definition)) fail("State event operation", "is not a definition.");
  const data = sized(input, "operation arguments");
  const args = sized(definition.input.parse(data, { path: "operation arguments" }), "operation arguments");
  object(config, "operation configuration");
  function resolve(selector) {
    const kind = Object.keys(selector)[0];
    if (kind === "result") return selector;
    const values = kind === "input" ? args : config;
    if (kind !== "literal" && !Object.hasOwn(values, selector[kind])) {
      fail(`operation ${kind}`, "is missing a selected value.");
    }
    return { literal: sized(kind === "literal" ? selector.literal : values[selector[kind]], "operation value") };
  }
  const descriptor = Object.fromEntries(Object.entries(definition.mutation).map(([key, entry]) => [
    key, entry && typeof entry === "object" ? resolve(entry).literal : entry
  ]));
  if (descriptor.kind === "bounded_counter") {
    if (typeof descriptor.subject !== "string" || !descriptor.subject.length || descriptor.subject.length > 300) {
      fail("operation subject", "must contain 1–300 characters.");
    }
  } else identifier(descriptor.key, "operation key");
  const operation = descriptor.operation ?? descriptor.kind;
  if (["increment", "decrement"].includes(operation)) {
    integer(descriptor.amount, "operation amount", descriptor.kind === "increment" ? -1_000_000 : 1, 1_000_000);
  }
  if (descriptor.kind === "bounded_counter" && operation === "set") {
    integer(descriptor.value, "operation value", descriptor.min, descriptor.max);
  }
  return sized({
    operation: definition.id,
    scope: definition.scope,
    stream: definition.stream,
    input: args,
    mutation: descriptor,
    event: Object.fromEntries(Object.entries(definition.event).map(([key, selector]) => [key, resolve(selector)]))
  }, "prepared state event request");
}

// Contributor-only calculation preview. No receipt, state write, outbox, grant,
// sequence, atomicity or successful production acceptance is simulated here.
export function previewStateEventOperation(definition, stream, input, { before, config = {} } = {}) {
  const request = prepareStateEventOperation(definition, input, config);
  return json({ preview: true, accepted: false, ...calculatePreparedStateEvent(request, stream, before) }, "operation preview");
}

export function calculatePreparedStateEvent(request, stream, before) {
  const m = request.mutation;
  const present = before !== undefined;
  const previous = present ? sized(before, "previous value") : null;
  let prior = previous;
  let after;
  let changed;
  if (m.kind === "bounded_counter" || m.kind === "increment") {
    prior = present ? previous : (m.kind === "increment" ? 0 : m.initial);
    integer(prior, "previous counter", m.min ?? -Number.MAX_SAFE_INTEGER, m.max ?? Number.MAX_SAFE_INTEGER);
    if (m.kind === "increment") after = integer(prior + m.amount, "increment result", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    else if (m.operation === "set") after = m.value;
    else if (m.operation === "reset") after = m.initial;
    else {
      const candidate = BigInt(prior) + (m.operation === "increment" ? 1n : -1n) * BigInt(m.amount);
      after = Number(candidate < BigInt(m.min) ? BigInt(m.min) : candidate > BigInt(m.max) ? BigInt(m.max) : candidate);
    }
    changed = prior !== after;
  } else {
    after = m.kind === "delete" ? null : m.value;
    changed = m.kind === "delete" ? present : !present || JSON.stringify(previous) !== JSON.stringify(after);
  }
  const difference = typeof after === "number" && typeof prior === "number" ? Math.abs(after - prior) : null;
  const result = sized({ before: prior, after, changed, appliedAmount: Number.isSafeInteger(difference) ? difference : null }, "result summary", 4_096);
  const projected = Object.fromEntries(Object.entries(request.event).map(([key, selector]) => [
    key, Object.hasOwn(selector, "result") ? result[selector.result] : selector.literal
  ]));
  const payload = JSON.parse(serializeDurableEventPayload(projected, stream.payload.schema).serialized);
  return json({ request, result, payload }, "operation calculation");
}

// Revalidate a saved request against the installed declaration without consulting
// live configuration. Repeated selectors of one config key must agree.
export function validatePreparedStateEventOperation(definition, request) {
  const saved = sized(request, "prepared state event request");
  const config = Object.create(null);
  for (const [entries, values, projected] of [
    [definition.mutation, saved.mutation, false], [definition.event, saved.event, true]
  ]) {
    for (const [key, selector] of Object.entries(entries)) {
      if (!selector || typeof selector !== "object" || !Object.hasOwn(selector, "config")) continue;
      const value = projected ? values?.[key]?.literal : values?.[key];
      if (Object.hasOwn(config, selector.config) && JSON.stringify(config[selector.config]) !== JSON.stringify(value)) {
        fail("prepared configuration", "contains inconsistent selected values.");
      }
      config[selector.config] = value;
    }
  }
  const expected = prepareStateEventOperation(definition, saved.input, config);
  if (JSON.stringify(sized(expected, "request")) !== JSON.stringify(saved)) fail("prepared request", "does not match its declaration.");
  return expected;
}
