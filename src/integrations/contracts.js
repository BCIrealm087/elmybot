export const INTEGRATION_CONTRACT_SCHEMA_VERSION = 1;

const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const RESOURCE_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const CAPABILITY_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const OPAQUE_ID_PATTERN = /^[^\s:]+$/;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_KIND_LENGTH = 200;
const MAX_EVENT_ID_LENGTH = 300;
const MAX_CORRELATION_ID_LENGTH = 300;
const MAX_IDEMPOTENCY_KEY_LENGTH = 500;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_ACTOR_CLAIMS = 64;

export class IntegrationContractError extends TypeError {
  constructor(path, message) {
    super(`${path} ${message}`);
    this.name = "IntegrationContractError";
    this.code = "invalid_integration_contract";
    this.path = path;
  }
}

function fail(path, message) {
  throw new IntegrationContractError(path, message);
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

function requireString(value, path, {
  maxLength = MAX_IDENTIFIER_LENGTH,
  pattern = null
} = {}) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    (pattern && !pattern.test(value))
  ) {
    fail(path, "is invalid.");
  }
  return value;
}

function requirePlatform(value, path) {
  return requireString(value, path, {
    maxLength: 32,
    pattern: PLATFORM_PATTERN
  });
}

function requireVersionedKind(value, path) {
  return requireString(value, path, {
    maxLength: MAX_KIND_LENGTH,
    pattern: VERSIONED_KIND_PATTERN
  });
}

function copyJsonValue(value, path, depth = 0) {
  if (depth > MAX_JSON_DEPTH) fail(path, "is nested too deeply.");

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain only finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) =>
      copyJsonValue(entry, `${path}[${index}]`, depth + 1)
    ));
  }
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        copyJsonValue(entry, `${path}.${key}`, depth + 1)
      ])
    ));
  }

  fail(path, "must contain only JSON values.");
}

function copyJsonObject(value, path) {
  requirePlainObject(value, path);
  const copy = copyJsonValue(value, path);
  const size = new TextEncoder().encode(JSON.stringify(copy)).byteLength;
  if (size > MAX_JSON_BYTES) fail(path, "is too large.");
  return copy;
}

function normalizePlatformGroupRef(value, path) {
  requirePlainObject(value, path);
  const platform = requirePlatform(value.platform, `${path}.platform`);
  const kind = requireString(value.kind, `${path}.kind`, {
    maxLength: 64,
    pattern: RESOURCE_KIND_PATTERN
  });
  const id = requireString(value.id, `${path}.id`, {
    pattern: OPAQUE_ID_PATTERN
  });

  return Object.freeze({
    platform,
    kind,
    id,
    key: `${platform}:${kind}:${id}`
  });
}

function normalizePlatformActorRef(value, path) {
  requirePlainObject(value, path);
  const platform = requirePlatform(value.platform, `${path}.platform`);
  const id = requireString(value.id, `${path}.id`, {
    pattern: OPAQUE_ID_PATTERN
  });
  const claims = value.claims ?? [];

  if (!Array.isArray(claims) || claims.length > MAX_ACTOR_CLAIMS) {
    fail(`${path}.claims`, "is invalid.");
  }

  const normalizedClaims = claims.map((claim, index) => {
    const normalized = requireString(claim, `${path}.claims[${index}]`, {
      maxLength: MAX_KIND_LENGTH,
      pattern: CAPABILITY_PATTERN
    });
    if (!normalized.startsWith(`${platform}.`)) {
      fail(`${path}.claims[${index}]`, "must be namespaced to the actor platform.");
    }
    return normalized;
  });

  if (new Set(normalizedClaims).size !== normalizedClaims.length) {
    fail(`${path}.claims`, "must not contain duplicates.");
  }

  return Object.freeze({
    platform,
    id,
    claims: Object.freeze([...normalizedClaims].sort())
  });
}

function normalizeIntegrationRef(value, path) {
  requirePlainObject(value, path);
  const id = requireString(value.id, `${path}.id`, {
    pattern: OPAQUE_ID_PATTERN
  });
  return Object.freeze({ id, key: `integration:${id}` });
}

function normalizeOrigin(value, path, { actorRequired }) {
  requirePlainObject(value, path);
  const group = normalizePlatformGroupRef(value.group, `${path}.group`);
  const actor = value.actor === null || value.actor === undefined
    ? null
    : normalizePlatformActorRef(value.actor, `${path}.actor`);

  if (actorRequired && actor === null) fail(`${path}.actor`, "is required.");
  if (actor && actor.platform !== group.platform) {
    fail(`${path}.actor.platform`, "must match the origin group platform.");
  }

  return Object.freeze({ group, actor });
}

function requireSourceEventId(value, path, platform) {
  const sourceEventId = requireString(value, path, {
    maxLength: MAX_EVENT_ID_LENGTH
  });
  if (!sourceEventId.startsWith(`${platform}:`)) {
    fail(path, "must be namespaced to the source platform.");
  }
  return sourceEventId;
}

function requireCorrelationId(value, path) {
  return requireString(value, path, {
    maxLength: MAX_CORRELATION_ID_LENGTH
  });
}

export function createPlatformGroupRef(value) {
  return normalizePlatformGroupRef(value, "Platform group");
}

export function createPlatformActorRef(value) {
  return normalizePlatformActorRef(value, "Platform actor");
}

export function createIntegrationRef(value) {
  return normalizeIntegrationRef(value, "Integration");
}

export function createActionDefinition({
  kind,
  capability = null,
  supportedOrigins,
  execute
}) {
  const normalizedKind = requireVersionedKind(kind, "Action kind");
  const normalizedCapability = capability === null
    ? null
    : requireString(capability, "Action capability", {
      maxLength: MAX_KIND_LENGTH,
      pattern: CAPABILITY_PATTERN
    });
  if (!Array.isArray(supportedOrigins) || supportedOrigins.length === 0) {
    fail("Action supported origins", "must contain at least one platform.");
  }
  const origins = supportedOrigins.map((platform, index) =>
    requirePlatform(platform, `Action supported origins[${index}]`)
  );
  if (new Set(origins).size !== origins.length) {
    fail("Action supported origins", "must not contain duplicates.");
  }
  if (typeof execute !== "function") fail("Action execute", "must be a function.");

  return Object.freeze({
    kind: normalizedKind,
    capability: normalizedCapability,
    supportedOrigins: Object.freeze([...origins].sort()),
    execute
  });
}

export function createCommandInvocation({
  kind,
  origin,
  args = {},
  sourceEventId,
  correlationId = sourceEventId
}) {
  const normalizedOrigin = normalizeOrigin(origin, "Command origin", {
    actorRequired: true
  });
  const normalizedSourceEventId = requireSourceEventId(
    sourceEventId,
    "Command source event ID",
    normalizedOrigin.group.platform
  );

  return Object.freeze({
    schemaVersion: INTEGRATION_CONTRACT_SCHEMA_VERSION,
    kind: requireVersionedKind(kind, "Command kind"),
    origin: normalizedOrigin,
    args: copyJsonObject(args, "Command arguments"),
    sourceEventId: normalizedSourceEventId,
    correlationId: requireCorrelationId(correlationId, "Command correlation ID")
  });
}

export function createDomainEvent({
  kind,
  source,
  occurredAt,
  payload = {},
  sourceEventId,
  correlationId = sourceEventId
}) {
  const normalizedSource = normalizeOrigin(source, "Event source", {
    actorRequired: false
  });
  const normalizedSourceEventId = requireSourceEventId(
    sourceEventId,
    "Event source event ID",
    normalizedSource.group.platform
  );
  const occurredAtMs = typeof occurredAt === "string" &&
    ISO_TIMESTAMP_PATTERN.test(occurredAt)
    ? Date.parse(occurredAt)
    : NaN;
  if (!Number.isFinite(occurredAtMs)) fail("Event occurrence time", "is invalid.");

  return Object.freeze({
    schemaVersion: INTEGRATION_CONTRACT_SCHEMA_VERSION,
    kind: requireVersionedKind(kind, "Event kind"),
    source: normalizedSource,
    occurredAt: new Date(occurredAtMs).toISOString(),
    payload: copyJsonObject(payload, "Event payload"),
    sourceEventId: normalizedSourceEventId,
    correlationId: requireCorrelationId(correlationId, "Event correlation ID")
  });
}

export function createEffect({
  kind,
  target,
  payload = {},
  integration = null,
  idempotencyKey,
  correlationId,
  causationId
}) {
  requirePlainObject(target, "Effect target");
  const group = normalizePlatformGroupRef(target.group, "Effect target group");
  const destination = copyJsonObject(
    target.destination ?? {},
    "Effect target destination"
  );
  const normalizedIntegration = integration === null
    ? null
    : normalizeIntegrationRef(integration, "Effect integration");

  return Object.freeze({
    schemaVersion: INTEGRATION_CONTRACT_SCHEMA_VERSION,
    kind: requireVersionedKind(kind, "Effect kind"),
    target: Object.freeze({ group, destination }),
    payload: copyJsonObject(payload, "Effect payload"),
    integration: normalizedIntegration,
    idempotencyKey: requireString(idempotencyKey, "Effect idempotency key", {
      maxLength: MAX_IDEMPOTENCY_KEY_LENGTH
    }),
    correlationId: requireCorrelationId(correlationId, "Effect correlation ID"),
    causationId: requireString(causationId, "Effect causation ID", {
      maxLength: MAX_EVENT_ID_LENGTH
    })
  });
}
