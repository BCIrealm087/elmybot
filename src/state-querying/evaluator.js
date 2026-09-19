import { validateReadableStateSchemaValue } from "../framework/readable-state.js";
import { FeatureServiceRuntimeError } from "../framework/service-runtime.js";
import {
  normalizeReadableStateParameter,
  ReadableStateReferenceError
} from "./catalog.js";
import {
  canonicalStateQueryJson,
  prepareStateQuery,
  projectStateQueryValue,
  STATE_QUERY_LIMITS,
  StateQueryError,
  stateQueryDigest
} from "./query.js";
import { createStateQuerySourceRuntime } from "./source-runtime.js";

const READY_REASON = new Set([
  "initial",
  "value_changed",
  "dependency_changed",
  "source_changed",
  "resynchronized",
  "transition_completed"
]);

function fail(message, {
  code = "query_source_unavailable",
  status = 503,
  path = "query"
} = {}) {
  throw new StateQueryError(message, { code, status, path });
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function normalizedCell(definition, cell, alias) {
  const path = `query.bindings.${alias}.result`;
  if (!isPlainObject(cell)) fail("resolver returned an invalid result cell.", { path });
  const allowed = cell.state === "present" ? new Set(["state", "value"]) : new Set(["state"]);
  const unknown = Object.keys(cell).find((field) => !allowed.has(field));
  if (unknown) fail("resolver returned an invalid result cell.", { path: `${path}.${unknown}` });
  if (cell.state === "present") {
    if (!Object.prototype.hasOwnProperty.call(cell, "value")) {
      fail("resolver omitted its present value.", { path });
    }
    if (
      definition.kind === "collection" &&
      Array.isArray(cell.value) &&
      cell.value.length > definition.result.schema.maxItems
    ) {
      fail("collection exceeds its declared complete bound.", {
        code: "query_collection_too_large",
        status: 409,
        path
      });
    }
    let value;
    try {
      value = validateReadableStateSchemaValue(definition.result.schema, cell.value, path);
    } catch {
      fail("resolver returned a value outside its declared schema.", { path });
    }
    return Object.freeze({ state: "present", value });
  }
  if (!["absent", "unselected"].includes(cell.state)) {
    fail("resolver returned an unsupported result-cell state.", { path });
  }
  if (cell.state !== definition.result.absence.kind) {
    fail("resolver returned a state that conflicts with its absence policy.", { path });
  }
  return Object.freeze({ state: cell.state });
}

function blockedCell(expression, sourceCell) {
  return Object.freeze({
    state: "blocked",
    reason: sourceCell.state === "blocked" ? "dependency_blocked" : sourceCell.state,
    binding: expression.ref
  });
}

function normalizedDynamicArgument(parameter, value, path) {
  try {
    return normalizeReadableStateParameter(parameter, value, path).value;
  } catch (cause) {
    if (cause instanceof ReadableStateReferenceError) {
      throw new StateQueryError(
        "dynamic value does not satisfy the destination parameter.",
        { code: "query_type_mismatch", path, cause }
      );
    }
    throw cause;
  }
}

function dependencyKey(dependency) {
  return canonicalStateQueryJson(dependency);
}

async function sourceRevision(source) {
  const revision = await source.revision();
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("State-query source returned an invalid revision.");
  }
  return revision;
}

async function sourceLifecycleStillCurrent(source) {
  if (typeof source.lifecycle !== "function") return true;
  const current = await source.lifecycle();
  if (
    !Number.isSafeInteger(current?.revision) ||
    current.revision < 0 ||
    !new Set(["ready", "transitioning", "unavailable"]).has(current?.status) ||
    (current.sourceKey !== null && current.sourceKey !== undefined &&
      typeof current.sourceKey !== "string")
  ) {
    throw new TypeError("State-query source returned invalid lifecycle authority.");
  }
  if (current.status === "transitioning") {
    throw new FeatureServiceRuntimeError(
      "The selected shareable state is transitioning.",
      { code: "shareable_state_transition", status: 409 }
    );
  }
  if (current.status === "unavailable") {
    throw new FeatureServiceRuntimeError(
      "The selected shareable state is unavailable.",
      { code: "shareable_state_resolution_invalid", status: 503 }
    );
  }
  return current.revision === source.lifecycleRevision &&
    current.sourceKey === source.physicalSourceKey;
}

function controlledReadContext(source, binding, dependencies, collectionReads) {
  const record = (dependency) => {
    const normalized = freezeJson({
      source: source.bindingKey,
      feature: binding.featureId,
      scope: binding.definition.scope.kind,
      ...dependency
    });
    dependencies.set(dependencyKey(normalized), normalized);
  };
  return Object.freeze({
    state: Object.freeze({
      async get(key) {
        const result = freezeJson(await source.get(key));
        record({ kind: "value", key });
        return result;
      },
      async boundedCounter(name, subject, options = {}) {
        const value = await source.boundedCounter(name, subject, options);
        record({ kind: "bounded_counter", name, subject });
        return value;
      },
      async boundedCounterSubjects(name) {
        const result = freezeJson(await source.boundedCounterSubjects(name));
        record({ kind: "collection", name });
        collectionReads.push(result.coverage);
        return result;
      }
    })
  });
}

async function evaluateAttempt(plan, sourceRuntime, authorizeBinding, maxResultBytes) {
  const cells = Object.create(null);
  const sourceStates = new Map();
  const readCache = new Map();
  const dependencies = new Map();

  for (const alias of plan.order) {
    const binding = plan.bindings[alias];
    const argumentsValue = {};
    let blocked = null;
    for (const [name, expression] of Object.entries(binding.arguments)) {
      if (expression.kind === "literal") {
        argumentsValue[name] = expression.normalized.literal;
        continue;
      }
      const sourceCell = cells[expression.ref];
      if (sourceCell.state !== "present") {
        blocked = blockedCell(expression, sourceCell);
        break;
      }
      const projected = projectStateQueryValue(sourceCell.value, expression.path);
      argumentsValue[name] = normalizedDynamicArgument(
        binding.definition.parameters[name],
        projected,
        `query.bindings.${alias}.arguments.${name}`
      );
    }
    if (blocked) {
      cells[alias] = blocked;
      continue;
    }

    if (authorizeBinding) await authorizeBinding(binding, freezeJson(argumentsValue));

    const source = await sourceRuntime.open(binding.featureId, binding.definition);
    let sourceState = sourceStates.get(source.bindingKey);
    if (!sourceState) {
      sourceState = {
        source,
        startRevision: await sourceRevision(source)
      };
      sourceStates.set(source.bindingKey, sourceState);
    }
    const cacheKey = canonicalStateQueryJson({
      source: source.bindingKey,
      feature: binding.featureId,
      export: binding.definition.id,
      version: binding.definition.version,
      arguments: argumentsValue
    });
    if (readCache.has(cacheKey)) {
      cells[alias] = readCache.get(cacheKey);
      continue;
    }
    const collectionReads = [];
    const context = controlledReadContext(
      source,
      binding,
      dependencies,
      collectionReads
    );
    const resolved = await binding.definition.resolve(
      context,
      freezeJson(argumentsValue)
    );
    if (binding.definition.kind === "collection") {
      if (collectionReads.length === 0) {
        fail("collection resolver did not read declared collection membership.", {
          path: `query.bindings.${alias}.result`
        });
      }
      if (collectionReads.some((coverage) => coverage?.complete !== true)) {
        fail("collection contains unidentified historical subjects.", {
          code: "query_collection_incomplete",
          status: 409,
          path: `query.bindings.${alias}.result`
        });
      }
    }
    const cell = normalizedCell(binding.definition, resolved, alias);
    cells[alias] = cell;
    readCache.set(cacheKey, cell);
  }

  let stable = true;
  for (const sourceState of sourceStates.values()) {
    sourceState.endRevision = await sourceRevision(sourceState.source);
    if (
      sourceState.endRevision !== sourceState.startRevision ||
      !await sourceLifecycleStillCurrent(sourceState.source)
    ) {
      stable = false;
    }
  }
  if (!stable) return { stable: false };

  const data = freezeJson(Object.fromEntries(Object.entries(plan.selections).map(
    ([alias, selection]) => {
      const sourceCell = cells[selection.ref];
      return [alias, sourceCell.state === "present"
        ? Object.freeze({
            state: "present",
            value: freezeJson(projectStateQueryValue(sourceCell.value, selection.path))
          })
        : sourceCell];
    }
  )));
  if (
    new TextEncoder().encode(JSON.stringify(data)).byteLength >
    maxResultBytes
  ) {
    fail("ready result exceeds the encoded-size limit.", {
      code: "query_result_too_large",
      status: 413,
      path: "query.select"
    });
  }
  const sourceBindings = [...sourceStates.values()].map((state) => ({
    binding: state.source.bindingKey,
    revision: state.startRevision
  })).sort((left, right) => left.binding.localeCompare(right.binding));
  const sourceWatches = [...sourceStates.values()].flatMap((state) =>
    state.source.watch ? [{
      binding: state.source.bindingKey,
      ...state.source.watch,
      expectedRevision: state.startRevision
    }] : []
  );
  const bindingWatches = [...new Map([...sourceStates.values()].flatMap((state) =>
    state.source.bindingWatch ? [[canonicalStateQueryJson(state.source.bindingWatch), {
      ...state.source.bindingWatch,
      expectedRevision: state.source.lifecycleRevision
    }]] : []
  )).values()];
  return {
    stable: true,
    data,
    sourceBindings,
    sourceWatches: freezeJson(sourceWatches),
    bindingWatches: freezeJson(bindingWatches),
    dependencies: Object.freeze([...dependencies.values()])
  };
}

async function readyEvaluation(plan, attempt, reason, now) {
  const bindingRevision = await stateQueryDigest({
    target: plan.query.target,
    sources: attempt.sourceBindings.map(({ binding }) => binding)
  });
  const resultRevision = await stateQueryDigest({
    queryDigest: plan.digest,
    bindingRevision,
    status: "ready",
    data: attempt.data
  });
  return Object.freeze({
    envelope: Object.freeze({
      protocolVersion: 1,
      queryDigest: plan.digest,
      status: "ready",
      reason,
      bindingRevision,
      resultRevision,
      observedAt: now().toISOString(),
      data: attempt.data
    }),
    observation: Object.freeze({
      query: plan.query,
      sources: freezeJson(attempt.sourceBindings),
      sourceWatches: attempt.sourceWatches,
      bindingWatches: attempt.bindingWatches,
      dependencies: attempt.dependencies
    })
  });
}

async function unavailableEvaluation(plan, code, status, reason, now) {
  const bindingRevision = await stateQueryDigest({
    target: plan.query.target,
    status,
    code
  });
  const resultRevision = await stateQueryDigest({
    queryDigest: plan.digest,
    bindingRevision,
    status,
    code
  });
  return Object.freeze({
    envelope: Object.freeze({
      protocolVersion: 1,
      queryDigest: plan.digest,
      status,
      reason,
      bindingRevision,
      resultRevision,
      observedAt: now().toISOString(),
      error: Object.freeze({ code })
    }),
    observation: null
  });
}

export async function evaluateStateQuery(registry, input, {
  env,
  preparedPlan = null,
  sourceRuntime = null,
  sourceRuntimeFactory = null,
  correlationId,
  maxAttempts = 3,
  reason = "initial",
  now = () => new Date(),
  authorizeBinding = null,
  maxResultBytes = STATE_QUERY_LIMITS.maxResultBytes
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new TypeError("State-query maxAttempts must be an integer between 1 and 5.");
  }
  if (!READY_REASON.has(reason)) {
    throw new TypeError("State-query evaluation reason is invalid.");
  }
  if (
    !Number.isSafeInteger(maxResultBytes) ||
    maxResultBytes < 1 ||
    maxResultBytes > STATE_QUERY_LIMITS.maxResultBytes
  ) {
    throw new TypeError("State-query maxResultBytes is invalid.");
  }
  const plan = preparedPlan ?? await prepareStateQuery(registry, input);
  for (let attemptNumber = 0; attemptNumber < maxAttempts; attemptNumber += 1) {
    const runtime = sourceRuntimeFactory
      ? await sourceRuntimeFactory({ attempt: attemptNumber + 1, plan })
      : sourceRuntime ?? createStateQuerySourceRuntime(env, {
          target: plan.query.target,
          correlationId
        });
    try {
      const attempt = await evaluateAttempt(
        plan,
        runtime,
        authorizeBinding,
        maxResultBytes
      );
      if (attempt.stable) return await readyEvaluation(plan, attempt, reason, now);
    } catch (error) {
      if (error instanceof StateQueryError) throw error;
      if (
        error instanceof FeatureServiceRuntimeError &&
        error.code === "shareable_state_transition"
      ) {
        return await unavailableEvaluation(
          plan,
          "query_transitioning",
          "transitioning",
          "transition_started",
          now
        );
      }
      if (
        error instanceof FeatureServiceRuntimeError &&
        error.code === "shareable_state_resolution_invalid"
      ) {
        return await unavailableEvaluation(
          plan,
          "query_source_unavailable",
          "unavailable",
          reason,
          now
        );
      }
      return await unavailableEvaluation(
        plan,
        "query_source_unavailable",
        "unavailable",
        reason,
        now
      );
    }
  }
  return await unavailableEvaluation(
    plan,
    "query_evaluation_unstable",
    "unavailable",
    reason,
    now
  );
}
