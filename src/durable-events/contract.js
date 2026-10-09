export const DURABLE_EVENT_LIMITS = Object.freeze({
  maxPayloadBytes: 4_096,
  maxRetainedEvents: 1_000,
  maxRetainedBytes: 1_048_576,
  retentionMs: 30 * 60 * 1_000,
  maxIngressPerSecond: 10,
  receiptRetentionMs: 2 * 60 * 60 * 1_000,
  maxReceiptRows: 100_000,
  maxReceiptMetadataBytes: 16 * 1_048_576,
  maxPendingRows: 100,
  maxPendingBytes: 512 * 1_024
});

export const DURABLE_EVENT_CODES = Object.freeze({
  consumerUnavailable: "durable_event_consumer_unavailable",
  streamFull: "durable_event_stream_full",
  gapRequiresReset: "durable_event_gap_requires_reset",
  transition: "durable_event_stream_transition",
  payloadInvalid: "durable_event_payload_invalid",
  sourceConflict: "durable_event_source_conflict",
  serviceUnavailable: "durable_event_service_unavailable"
});

const SAFE_MESSAGES = Object.freeze({
  [DURABLE_EVENT_CODES.consumerUnavailable]:
    "No durable event consumer is connected.",
  [DURABLE_EVENT_CODES.streamFull]:
    "The durable event stream is temporarily full.",
  [DURABLE_EVENT_CODES.gapRequiresReset]:
    "The durable event stream requires an operator reset.",
  [DURABLE_EVENT_CODES.transition]:
    "The durable event stream is transitioning.",
  [DURABLE_EVENT_CODES.payloadInvalid]:
    "The durable event payload is invalid.",
  [DURABLE_EVENT_CODES.sourceConflict]:
    "This command source was already used with different event data.",
  [DURABLE_EVENT_CODES.serviceUnavailable]:
    "The durable event service is temporarily unavailable."
});

export class DurableEventError extends Error {
  constructor(code, { status = 500, cause } = {}) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES[DURABLE_EVENT_CODES.serviceUnavailable], {
      cause
    });
    this.name = "DurableEventError";
    this.code = code;
    this.status = status;
  }
}

export function durableEventError(code, options) {
  return new DurableEventError(code, options);
}

function invalidPayload() {
  throw durableEventError(DURABLE_EVENT_CODES.payloadInvalid, { status: 422 });
}

function canonicalPayloadValue(value, schema, depth = 0) {
  if (depth > 10) invalidPayload();
  if (value === null) {
    if (schema.nullable === true) return null;
    invalidPayload();
  }
  if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < schema.minLength ||
      value.length > schema.maxLength
    ) invalidPayload();
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") invalidPayload();
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isSafeInteger(value)) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    ) invalidPayload();
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) invalidPayload();
    return value.map((entry) => canonicalPayloadValue(
      entry,
      schema.items,
      depth + 1
    ));
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) invalidPayload();
  const keys = Object.keys(value);
  if (keys.some((key) => !Object.hasOwn(schema.properties, key))) invalidPayload();
  if (schema.required.some((key) => !Object.hasOwn(value, key))) invalidPayload();
  return Object.fromEntries(Object.keys(schema.properties).sort().flatMap((key) =>
    Object.hasOwn(value, key)
      ? [[key, canonicalPayloadValue(value[key], schema.properties[key], depth + 1)]]
      : []
  ));
}

export function serializeDurableEventPayload(value, schema) {
  const serialized = JSON.stringify(canonicalPayloadValue(value, schema));
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > DURABLE_EVENT_LIMITS.maxPayloadBytes) invalidPayload();
  return Object.freeze({ serialized, bytes });
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Base64Url(value) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ));
  return bytesToBase64Url(digest);
}

export async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function durableEventId({
  featureId,
  streamId,
  version,
  originGroupKey,
  sourceEventId
}) {
  return "dev1." + await sha256Base64Url(JSON.stringify([
    "elmybot.durable-event.v1",
    featureId,
    streamId,
    version,
    originGroupKey,
    sourceEventId
  ]));
}

export async function durableEventRouteId({
  deploymentEnvironment,
  scopeKind,
  realmIdentity,
  featureId,
  streamId,
  version
}) {
  return "des1." + await sha256Base64Url(JSON.stringify([
    "elmybot.durable-event-stream.v1",
    deploymentEnvironment,
    scopeKind,
    realmIdentity,
    featureId,
    streamId,
    version
  ]));
}
