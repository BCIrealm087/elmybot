// Internal protocol: deliberately absent from the stable feature API.
import { createCommandInvocation } from "../integrations/contracts.js";

export const STATE_EVENT_LIMITS = Object.freeze({
  sourceLifetimeMs: 2 * 60 * 60 * 1000,
  receiptRetentionMs: 2 * 60 * 60 * 1000,
  maxRequestBytes: 16 * 1024,
  maxResultBytes: 4 * 1024,
  maxRecordBytes: 8 * 1024,
  maxRows: 100_000,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxPendingRows: 100,
  maxPendingBytes: 512 * 1024,
  pruneBatch: 20,
  maxAttempts: 8
});

export class StateEventRecoveryError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = "StateEventRecoveryError";
    this.code = code;
    this.status = status;
  }
}
export function recoveryError(code, status) {
  return new StateEventRecoveryError(`state_event_${code}`, status);
}

export function canonicalJson(value, limit = STATE_EVENT_LIMITS.maxRequestBytes) {
  const seen = new Set();
  function copy(item, depth) {
    if (depth > 20) throw recoveryError("invalid_request", 422);
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || seen.has(item)) throw recoveryError("invalid_request", 422);
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw recoveryError("invalid_request", 422);
    }
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    const expected = Array.isArray(item) ? [...item.keys()].map(String).concat("length") : keys;
    if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
      throw recoveryError("invalid_request", 422);
    }
    const result = Array.isArray(item) ? [] : Object.create(null);
    for (const key of keys.filter((key) => key !== "length" || !Array.isArray(item)).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw recoveryError("invalid_request", 422);
      result[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(item);
    return result;
  }
  const json = JSON.stringify(copy(value, 0));
  if (jsonBytes(json) > limit) throw recoveryError("too_large", 422);
  return json;
}
export function jsonBytes(json) {
  return new TextEncoder().encode(json).byteLength;
}
async function digest(tuple, prefix) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(tuple))));
  return prefix + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export async function fingerprint(value) {
  return digest(["elmybot.state-event-fingerprint.v1", canonicalJson(value)], "sef1.");
}

// declaration contains the versioned operation/namespace/payload declarations,
// never live configuration. Selected configuration belongs in the prepared request.
export async function createStateEventIdentity({ environment, featureId, invocation, declaration }) {
  const command = createCommandInvocation(invocation);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(environment ?? "") ||
      !/^[a-z][a-z0-9._-]{0,127}$/.test(featureId ?? "") ||
      !Number.isSafeInteger(command.sourceCreatedAtMs)) {
    throw recoveryError("invalid_source", 422);
  }
  const tuple = [environment, featureId, command.kind, command.origin.group.key, command.sourceEventId];
  const [operationId, sourceKey, callerFingerprint] = await Promise.all([
    digest(["elmybot.state-event-operation.v1", ...tuple], "seo1."),
    digest(["elmybot.state-event-source.v1", environment, featureId, command.origin.group.key, command.sourceEventId], "sesrc1."),
    fingerprint({ action: command.kind, args: command.args, actor: command.origin.actor,
      sourceCreatedAtMs: command.sourceCreatedAtMs, declaration })
  ]);
  return Object.freeze({ operationId, sourceKey, callerFingerprint, environment, featureId,
    actionKind: command.kind, originGroupKey: command.origin.group.key,
    sourceEventId: command.sourceEventId, sourceCreatedAtMs: command.sourceCreatedAtMs });
}

export function validateIdentity(identity) {
  if (!/^seo1\.[\w-]{43}$/.test(identity?.operationId ?? "") ||
      !/^sesrc1\.[\w-]{43}$/.test(identity?.sourceKey ?? "") ||
      !/^sef1\.[\w-]{43}$/.test(identity?.callerFingerprint ?? "") ||
      !Number.isSafeInteger(identity?.sourceCreatedAtMs) || identity.sourceCreatedAtMs < 0 ||
      typeof identity.originGroupKey !== "string" || typeof identity.featureId !== "string" ||
      typeof identity.actionKind !== "string") throw recoveryError("invalid_source", 422);
  canonicalJson(identity, 2048);
}
export function assertFresh(identity, nowMs) {
  if (identity.sourceCreatedAtMs > nowMs || nowMs >= identity.sourceCreatedAtMs + STATE_EVENT_LIMITS.sourceLifetimeMs) {
    throw recoveryError("source_expired", 410);
  }
}
export function validateRoute(route) {
  if (!["group_local", "effective_shareable"].includes(route?.kind) ||
      typeof route.key !== "string" || !route.key.length || route.key.length > 512 ||
      !Number.isSafeInteger(route.bindingRevision) || route.bindingRevision < 0 ||
      !/^des1\.[\w-]{43}$/.test(route.streamRouteId ?? "")) throw recoveryError("invalid_route", 422);
  if (route.kind === "effective_shareable" && (!route.realm || typeof route.namespace?.namespaceId !== "string" ||
      typeof route.namespace?.featureId !== "string")) throw recoveryError("invalid_route", 422);
  canonicalJson(route, 2048);
}
export function validateAttempt(attempt) {
  validateIdentity(attempt?.identity);
  validateRoute(attempt?.route);
  if (attempt.route.kind === "group_local" && attempt.route.key !== attempt.identity.originGroupKey ||
      attempt.route.kind === "effective_shareable" && attempt.route.namespace.featureId !== attempt.identity.featureId) {
    throw recoveryError("wrong_owner", 422);
  }
  if (!Number.isSafeInteger(attempt.epoch) || attempt.epoch < 1 || attempt.epoch > STATE_EVENT_LIMITS.maxAttempts ||
      !/^[\w-]{36}$/.test(attempt.token ?? "") || !/^sef1\.[\w-]{43}$/.test(attempt.preparedFingerprint ?? "")) {
    throw recoveryError("invalid_attempt", 422);
  }
}
export function sameIdentity(a, b) {
  return a.operationId === b.operationId && a.callerFingerprint === b.callerFingerprint && a.sourceKey === b.sourceKey;
}
export function sameAttempt(a, b) {
  return sameIdentity(a.identity, b.identity) && a.preparedFingerprint === b.preparedFingerprint &&
    a.epoch === b.epoch && a.token === b.token && canonicalJson(a.route) === canonicalJson(b.route);
}
export function newAttempt(identity, preparedFingerprint, route, epoch = 1) {
  validateRoute(route);
  const attempt = JSON.parse(canonicalJson({ identity, preparedFingerprint, route, epoch, token: crypto.randomUUID() }));
  validateAttempt(attempt);
  return attempt;
}
