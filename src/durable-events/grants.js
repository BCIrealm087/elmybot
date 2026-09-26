import { createPlatformGroupRef } from "../integrations/contracts.js";

export const DURABLE_EVENT_GRANT_LIMITS = Object.freeze({
  minLifetimeSeconds: 5 * 60,
  maxLifetimeSeconds: 30 * 24 * 60 * 60,
  defaultLifetimeSeconds: 24 * 60 * 60
});

export class DurableEventGrantError extends Error {
  constructor(message, {
    code = "durable_event_grant_invalid",
    status = 422
  } = {}) {
    super(message);
    this.name = "DurableEventGrantError";
    this.code = code;
    this.status = status;
  }
}

function fail(message, options) {
  throw new DurableEventGrantError(message, options);
}

function target(value) {
  try {
    const group = createPlatformGroupRef({
      platform: value?.platform,
      kind: value?.platform === "discord" ? "guild" : "channel",
      id: value?.groupId
    });
    if (!/^\d{1,30}$/.test(group.id)) fail("The event-grant target is invalid.");
    return group;
  } catch (cause) {
    if (cause instanceof DurableEventGrantError) throw cause;
    fail("The event-grant target is invalid.");
  }
}

export function durableEventStreamIdentity(stream) {
  return `${stream.feature}:${stream.stream}:v${stream.version}`;
}

export function normalizeDurableEventGrantRequest(registry, input, {
  environment,
  nowMs = Date.now()
} = {}) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("The event-grant request is invalid.");
  }
  const unknown = Object.keys(input).find((field) => ![
    "target",
    "stream",
    "expiresInSeconds",
    "resetBacklog"
  ].includes(field));
  if (unknown) fail("The event-grant request is invalid.");
  if (typeof environment !== "string" || !/^[a-z0-9_-]{1,40}$/.test(environment)) {
    throw new TypeError("Durable-event deployment environment is invalid.");
  }
  const selectedTarget = target(input.target);
  if (typeof input.stream !== "string" || input.stream.length > 200) {
    fail("The event stream identity is invalid.");
  }
  const installed = registry?.eventStreams?.[input.stream];
  if (!installed || !installed.definition.platforms.includes(selectedTarget.platform)) {
    fail("The event stream is not eligible for this target.");
  }
  const lifetime = input.expiresInSeconds ??
    DURABLE_EVENT_GRANT_LIMITS.defaultLifetimeSeconds;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < DURABLE_EVENT_GRANT_LIMITS.minLifetimeSeconds ||
    lifetime > DURABLE_EVENT_GRANT_LIMITS.maxLifetimeSeconds
  ) {
    fail("The event-grant lifetime is invalid.");
  }
  if (input.resetBacklog !== undefined && typeof input.resetBacklog !== "boolean") {
    fail("The event-grant reset choice is invalid.");
  }
  return Object.freeze({
    target: selectedTarget,
    stream: Object.freeze({
      feature: installed.featureId,
      stream: installed.definition.id,
      version: installed.definition.version
    }),
    definition: installed.definition,
    environment,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + lifetime * 1000,
    resetBacklog: input.resetBacklog === true
  });
}

export function durableEventGrantCatalog(registry, grant) {
  const identity = durableEventStreamIdentity(grant.stream);
  const entry = registry.eventCatalog.find((candidate) =>
    durableEventStreamIdentity(candidate) === identity &&
    candidate.platforms.includes(grant.target.platform)
  );
  if (!entry) {
    throw new DurableEventGrantError("The granted event stream is unavailable.", {
      code: "durable_event_access_denied",
      status: 403
    });
  }
  return Object.freeze([entry]);
}
