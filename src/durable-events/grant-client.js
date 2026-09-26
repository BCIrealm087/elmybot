import {
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  shareableStateRealmObjectName
} from "../shareable-state/index.js";
import {
  integrationRegistryStub,
  resolveEffectiveShareableStateRealm
} from "../integrations/registry-client.js";
import { durableEventRouteId } from "./contract.js";
import {
  DURABLE_EVENT_GRANT_LIMITS,
  normalizeDurableEventGrantRequest
} from "./grants.js";
import {
  DURABLE_EVENT_GRANT_PATH,
  durableEventInternalHeaders
} from "./stream.js";

const CREDENTIAL_PREFIX = "elmybot-deg-v1";
const CREDENTIAL_PATTERN = /^elmybot-deg-v1\.([a-z0-9_-]{1,40})\.(discord|twitch)\.(\d{1,30})\.([A-Za-z0-9_-]{43})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

export class DurableEventCredentialError extends Error {
  constructor(message, { code = "durable_event_access_denied", status = 403 } = {}) {
    super(message);
    this.name = "DurableEventCredentialError";
    this.code = code;
    this.status = status;
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw new DurableEventCredentialError("The durable-event credential is invalid.");
  }
}

async function digestSecret(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function durableEventEnvironment(env) {
  const value = env?.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT;
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,40}$/.test(value)) {
    throw new Error("DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT is not configured.");
  }
  return value;
}

export function requireDurableEventStreamsEnabled(env) {
  if (env?.DURABLE_EVENT_STREAMS_ENABLED !== "true") {
    throw new DurableEventCredentialError("Durable event streams are unavailable.", {
      code: "durable_event_service_unavailable",
      status: 503
    });
  }
}

async function signingKey(env, usage) {
  const secret = env?.DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET is not configured.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

async function sign(env, unsigned) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env, "sign"),
    new TextEncoder().encode(unsigned)
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function validSignature(env, unsigned, signature) {
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(env, "verify"),
    base64UrlToBytes(signature),
    new TextEncoder().encode(unsigned)
  );
}

function issuer(actor, target) {
  if (
    typeof actor !== "object" || actor === null ||
    actor.platform !== target.platform ||
    typeof actor.id !== "string" || actor.id.length === 0 || actor.id.length > 200
  ) {
    throw new DurableEventCredentialError("A verified target-platform issuer is required.");
  }
  return { platform: actor.platform, id: actor.id };
}

function otherPlatform(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

async function resolvedRoute(env, normalized) {
  let realmIdentity;
  let bindingRevision = 0;
  let binding = null;
  if (normalized.definition.scope.kind === "group_local") {
    realmIdentity = normalized.target.key;
  } else {
    const targetPlatform = otherPlatform(normalized.target.platform);
    const result = await resolveEffectiveShareableStateRealm(env, {
      sourceGroup: normalized.target,
      targetPlatform,
      correlationId: `durable-event-grant:${crypto.randomUUID()}`
    });
    const realm = result.defaultLink === null
      ? createStandaloneRealmIdentity(
          result.standaloneRealm.ownerGroup,
          { generation: result.standaloneRealm.generation }
        )
      : createIntegrationRealmIdentity(
          result.defaultLink.integration,
          { generation: result.defaultLink.integration.shareableStateGeneration ?? 1 }
        );
    realmIdentity = shareableStateRealmObjectName(realm);
    bindingRevision = result.bindingRevision;
    binding = {
      sourceGroup: normalized.target,
      targetPlatform,
      revision: bindingRevision,
      sourceKey: realmIdentity
    };
  }
  const descriptor = {
    deploymentEnvironment: normalized.environment,
    scopeKind: normalized.definition.scope.kind,
    realmIdentity,
    featureId: normalized.stream.feature,
    streamId: normalized.stream.stream,
    version: normalized.stream.version
  };
  return {
    routeId: await durableEventRouteId(descriptor),
    bindingRevision,
    ...(binding ? { binding } : {}),
    descriptor
  };
}

function streamStub(env, routeId) {
  if (!env?.DURABLE_EVENT_STREAM) throw new Error("DURABLE_EVENT_STREAM is unavailable.");
  return env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(routeId));
}

async function checked(response) {
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw new DurableEventCredentialError("The durable-event service is unavailable.", {
      code: "durable_event_service_unavailable",
      status: 503,
      cause
    });
  }
  if (!response.ok) {
    throw new DurableEventCredentialError(result?.error ?? "Durable-event access failed.", {
      code: result?.code ?? "durable_event_service_unavailable",
      status: response.status
    });
  }
  return result;
}

async function grantRequest(env, routeId, operation, body) {
  return checked(await streamStub(env, routeId).fetch(
    `https://durable-event-stream${DURABLE_EVENT_GRANT_PATH}/${operation}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...durableEventInternalHeaders },
      body: JSON.stringify(body)
    }
  ));
}

export async function issueDurableEventGrant(env, registry, input, {
  actor,
  nowMs = Date.now()
} = {}) {
  requireDurableEventStreamsEnabled(env);
  const normalized = normalizeDurableEventGrantRequest(registry, input, {
    environment: durableEventEnvironment(env),
    nowMs
  });
  const route = await resolvedRoute(env, normalized);
  const grantId = crypto.randomUUID();
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = bytesToBase64Url(secretBytes);
  const issue = {
    grantId,
    secretDigest: await digestSecret(secret),
    grant: {
      target: { platform: normalized.target.platform, groupId: normalized.target.id },
      stream: normalized.stream,
      environment: normalized.environment,
      issuedAtMs: normalized.issuedAtMs,
      expiresAtMs: normalized.expiresAtMs,
      route
    },
    actor: issuer(actor, normalized.target),
    resetBacklog: normalized.resetBacklog
  };
  if (route.binding) {
    await checked(await integrationRegistryStub(env).fetch(
      "https://integration-registry/durable-events/grants/issue",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceGroup: normalized.target,
          targetPlatform: route.binding.targetPlatform,
          expectedRevision: route.binding.revision,
          expectedSourceKey: route.binding.sourceKey,
          routeId: route.routeId,
          expiresAtMs: normalized.expiresAtMs,
          environment: normalized.environment,
          issue
        })
      }
    ));
  } else {
    await grantRequest(env, route.routeId, "issue", issue);
  }
  const routeField = route.routeId.slice("des1.".length);
  const unsigned = [
    CREDENTIAL_PREFIX,
    normalized.environment,
    normalized.target.platform,
    normalized.target.id,
    routeField,
    grantId,
    secret
  ].join(".");
  return Object.freeze({
    credential: `${unsigned}.${await sign(env, unsigned)}`,
    grant: Object.freeze({
      id: grantId,
      target: Object.freeze({
        platform: normalized.target.platform,
        groupId: normalized.target.id
      }),
      stream: normalized.stream,
      environment: normalized.environment,
      issuedAtMs: normalized.issuedAtMs,
      expiresAtMs: normalized.expiresAtMs
    })
  });
}

export async function parseDurableEventCredential(env, credential) {
  requireDurableEventStreamsEnabled(env);
  if (typeof credential !== "string" || credential.length > 1024) {
    throw new DurableEventCredentialError("The durable-event credential is invalid.");
  }
  const match = credential.match(CREDENTIAL_PATTERN);
  if (!match) throw new DurableEventCredentialError("The durable-event credential is invalid.");
  const [, environment, platform, groupId, routeField, grantId, secret, signature] = match;
  const unsigned = credential.slice(0, credential.lastIndexOf("."));
  if (!await validSignature(env, unsigned, signature) ||
      environment !== durableEventEnvironment(env)) {
    throw new DurableEventCredentialError("The durable-event credential is invalid.");
  }
  return Object.freeze({
    environment,
    target: Object.freeze({ platform, groupId }),
    routeId: `des1.${routeField}`,
    grantId,
    secret
  });
}

async function credentialRequest(env, credential, operation, nowMs) {
  const parsed = await parseDurableEventCredential(env, credential);
  return {
    parsed,
    result: await grantRequest(env, parsed.routeId, operation, {
      grantId: parsed.grantId,
      secretDigest: await digestSecret(parsed.secret),
      environment: parsed.environment,
      target: parsed.target,
      routeId: parsed.routeId,
      nowMs
    })
  };
}

function statusError(status) {
  if (status === "expired") {
    return new DurableEventCredentialError("The durable-event grant has expired.", {
      code: "durable_event_grant_expired",
      status: 401
    });
  }
  if (status === "revoked" || status === "replaced") {
    return new DurableEventCredentialError("The durable-event grant is no longer active.", {
      code: "durable_event_grant_revoked",
      status: 401
    });
  }
  return new DurableEventCredentialError("The durable-event credential is invalid.");
}

export async function validateDurableEventCredential(env, credential, {
  nowMs = Date.now()
} = {}) {
  const { result } = await credentialRequest(env, credential, "validate", nowMs);
  if (result.status === "active") return result.grant;
  throw statusError(result.status);
}

export async function validateDurableEventGrantReference(env, {
  routeId,
  grantId,
  target,
  nowMs = Date.now()
}) {
  requireDurableEventStreamsEnabled(env);
  const result = await grantRequest(env, routeId, "reference", {
    routeId,
    grantId,
    environment: durableEventEnvironment(env),
    target,
    nowMs
  });
  if (result.status === "active") return result.grant;
  throw statusError(result.status);
}

export async function revokeDurableEventCredential(env, credential, {
  nowMs = Date.now()
} = {}) {
  const { result } = await credentialRequest(env, credential, "revoke", nowMs);
  if (result.status === "revoked") return Object.freeze({ revoked: true });
  throw statusError(result.status);
}

export { DURABLE_EVENT_GRANT_LIMITS };
