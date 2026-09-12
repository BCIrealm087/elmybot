import { validateReadableStateSchemaValue } from "../framework/readable-state.js";

const GROUP_ID_PATTERN = /^[^\s:]{1,200}$/;
const PLATFORMS = new Set(["discord", "twitch"]);

export class ReadableStateReferenceError extends TypeError {
  constructor(message, {
    path = "Readable state reference",
    code = "readable_state_reference_invalid",
    cause
  } = {}) {
    super(`${path} ${message}`, { cause });
    this.name = "ReadableStateReferenceError";
    this.path = path;
    this.code = code;
  }
}

function fail(path, message, options = {}) {
  throw new ReadableStateReferenceError(message, { path, ...options });
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
  if (unknown) fail(`${path}.${unknown}`, "is not supported.");
}

function normalizedSubject(value, path) {
  if (!isPlainObject(value)) return { value, subject: null };
  onlyFields(value, new Set(["value", "label"]), path);
  if (!("value" in value) || typeof value.label !== "string") {
    fail(path, "must contain value and label.");
  }
  const label = value.label.trim();
  if (
    typeof value.value !== "string" ||
    label.length === 0 ||
    label.length > 80 ||
    Array.from(value.label).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    fail(path, "contains invalid subject metadata.");
  }
  return {
    value: value.value,
    subject: Object.freeze({ identity: value.value, label })
  };
}

export function normalizeReadableStateArguments(definition, input = {}) {
  const path = "Readable state reference.arguments";
  requireObject(input, path);
  const expected = Object.keys(definition.parameters);
  const unknown = Object.keys(input).find((name) => !(name in definition.parameters));
  if (unknown) fail(`${path}.${unknown}`, "is not declared.");
  const missing = expected.find((name) => !Object.prototype.hasOwnProperty.call(input, name));
  if (missing) fail(`${path}.${missing}`, "is required.");

  const values = {};
  const subjects = {};
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    const normalized = normalizeReadableStateParameter(
      parameter,
      input[name],
      `${path}.${name}`
    );
    values[name] = normalized.value;
    if (normalized.subject) subjects[name] = normalized.subject;
  }

  return Object.freeze({
    values: Object.freeze(values),
    subjects: Object.freeze(subjects)
  });
}

export function normalizeReadableStateParameter(parameter, input, path = "value") {
  let value;
  try {
    value = validateReadableStateSchemaValue(parameter.schema, input, path);
  } catch (cause) {
    fail(path, "does not satisfy its declared schema.", { cause });
  }
  let normalized = { value, subject: null };
  if (parameter.normalize) {
    try {
      normalized = normalizedSubject(
        parameter.normalize(value),
        `${path}.normalized`
      );
    } catch (cause) {
      if (cause instanceof ReadableStateReferenceError) throw cause;
      fail(path, "could not be normalized.", { cause });
    }
  }
  try {
    value = validateReadableStateSchemaValue(
      parameter.schema,
      normalized.value,
      `${path}.normalized`
    );
  } catch (cause) {
    fail(path, "normalizer returned an invalid value.", { cause });
  }
  if (parameter.normalize) {
    let repeated;
    try {
      repeated = normalizedSubject(
        parameter.normalize(value),
        `${path}.renormalized`
      );
      validateReadableStateSchemaValue(
        parameter.schema,
        repeated.value,
        `${path}.renormalized`
      );
    } catch (cause) {
      if (cause instanceof ReadableStateReferenceError) throw cause;
      fail(path, "could not be normalized idempotently.", { cause });
    }
    if (!Object.is(repeated.value, value)) {
      fail(path, "normalizer must be idempotent.");
    }
  }
  return Object.freeze({ value, subject: normalized.subject });
}

export function createReadableStateReference(registry, input) {
  const path = "Readable state reference";
  requireObject(input, path);
  onlyFields(input, new Set(["target", "read", "arguments"]), path);
  requireObject(input.target, `${path}.target`);
  onlyFields(input.target, new Set(["platform", "groupId"]), `${path}.target`);
  if (!PLATFORMS.has(input.target.platform)) {
    fail(`${path}.target.platform`, "is unsupported.");
  }
  if (typeof input.target.groupId !== "string" || !GROUP_ID_PATTERN.test(input.target.groupId)) {
    fail(`${path}.target.groupId`, "is invalid.");
  }
  requireObject(input.read, `${path}.read`);
  onlyFields(input.read, new Set(["feature", "export", "version"]), `${path}.read`);
  const identity = `${input.read.feature}:${input.read.export}:v${input.read.version}`;
  const registered = registry?.readableState?.[identity];
  if (!registered) {
    fail(`${path}.read`, "does not identify an installed readable export.", {
      code: "readable_state_export_not_found"
    });
  }
  if (!registered.definition.platforms.includes(input.target.platform)) {
    fail(`${path}.target.platform`, "is not supported by this export.", {
      code: "readable_state_platform_unsupported"
    });
  }
  const normalized = normalizeReadableStateArguments(
    registered.definition,
    input.arguments ?? {}
  );

  return Object.freeze({
    target: Object.freeze({
      platform: input.target.platform,
      groupId: input.target.groupId
    }),
    read: Object.freeze({
      feature: registered.featureId,
      export: registered.definition.id,
      version: registered.definition.version
    }),
    arguments: normalized.values
  });
}
