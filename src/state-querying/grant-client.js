import { createPlatformGroupRef } from "../integrations/contracts.js";
import {
  grantPermissionsForExportList,
  normalizeStateQueryGrantRequest
} from "./grants.js";

const CREDENTIAL_PREFIX = "elmybot-sqg-v1";
const CREDENTIAL_PATTERN = /^elmybot-sqg-v1\.([A-Za-z0-9_-]+)\.(discord|twitch)\.([A-Za-z0-9_-]+)\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

export class StateQueryCredentialError extends Error {
  constructor(message, { code = "query_access_denied", status = 403 } = {}) {
    super(message);
    this.name = "StateQueryCredentialError";
    this.code = code;
    this.status = status;
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function textToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToText(value) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0))
    );
  } catch {
    throw new StateQueryCredentialError("The state-query credential is invalid.");
  }
}

function base64UrlToBytes(value) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw new StateQueryCredentialError("The state-query credential is invalid.");
  }
}

async function digestSecret(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function stateQueryEnvironment(env) {
  const value = env?.STATE_QUERY_DEPLOYMENT_ENVIRONMENT ??
    env?.TWITCH_DEPLOYMENT_ENVIRONMENT;
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,40}$/.test(value)) {
    throw new Error("STATE_QUERY_DEPLOYMENT_ENVIRONMENT is not configured.");
  }
  return value;
}

async function credentialSigningKey(env, usage) {
  const secret = env?.STATE_QUERY_CREDENTIAL_SIGNING_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("STATE_QUERY_CREDENTIAL_SIGNING_SECRET is not configured.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

async function signCredential(env, unsigned) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await credentialSigningKey(env, "sign"),
    new TextEncoder().encode(unsigned)
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function validCredentialSignature(env, unsigned, signature) {
  return crypto.subtle.verify(
    "HMAC",
    await credentialSigningKey(env, "verify"),
    base64UrlToBytes(signature),
    new TextEncoder().encode(unsigned)
  );
}

function group(input) {
  try {
    return createPlatformGroupRef({
      platform: input.platform,
      kind: input.platform === "discord" ? "guild" : "channel",
      id: input.groupId
    });
  } catch {
    throw new StateQueryCredentialError("The state-query credential is invalid.");
  }
}

function groupStub(env, target) {
  if (!env?.CONFIG) throw new Error("CONFIG binding is unavailable.");
  const selected = group(target);
  return env.CONFIG.get(env.CONFIG.idFromName(selected.key));
}

function issuer(actor, target) {
  if (
    typeof actor !== "object" ||
    actor === null ||
    actor.platform !== target.platform ||
    typeof actor.id !== "string" ||
    actor.id.length === 0 ||
    actor.id.length > 200
  ) {
    throw new StateQueryCredentialError("A verified target-platform issuer is required.");
  }
  return Object.freeze({ platform: actor.platform, id: actor.id });
}

async function grantRequest(env, target, operation, body) {
  const response = await groupStub(env, target).fetch(
    `https://group-config/internal/state-query/grants/${operation}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  if (!response.ok) {
    await response.text();
    throw new Error("State-query grant storage was unavailable.");
  }
  return response.json();
}

export async function issueStateQueryGrant(env, registry, input, {
  actor,
  nowMs = Date.now()
} = {}) {
  const environment = stateQueryEnvironment(env);
  const grant = normalizeStateQueryGrantRequest(registry, input, { environment, nowMs });
  const grantId = crypto.randomUUID();
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = bytesToBase64Url(secretBytes);
  const secretDigest = await digestSecret(secret);
  const issuedBy = issuer(actor, grant.target);
  await grantRequest(env, grant.target, "issue", {
    grantId,
    secretDigest,
    grant,
    actor: issuedBy
  });
  const unsigned = [
    CREDENTIAL_PREFIX,
    textToBase64Url(environment),
    grant.target.platform,
    textToBase64Url(grant.target.groupId),
    grantId,
    secret
  ].join(".");
  const credential = `${unsigned}.${await signCredential(env, unsigned)}`;
  return Object.freeze({
    credential,
    grant: Object.freeze({ id: grantId, ...grant })
  });
}

export async function parseStateQueryCredential(env, credential) {
  if (typeof credential !== "string" || credential.length > 1024) {
    throw new StateQueryCredentialError("The state-query credential is invalid.");
  }
  const match = credential.match(CREDENTIAL_PATTERN);
  if (!match) throw new StateQueryCredentialError("The state-query credential is invalid.");
  const [
    ,
    encodedEnvironment,
    platform,
    encodedGroupId,
    grantId,
    secret,
    signature
  ] = match;
  const unsigned = credential.slice(0, credential.lastIndexOf("."));
  if (!await validCredentialSignature(env, unsigned, signature)) {
    throw new StateQueryCredentialError("The state-query credential is invalid.");
  }
  const environment = base64UrlToText(encodedEnvironment);
  const groupId = base64UrlToText(encodedGroupId);
  if (environment !== stateQueryEnvironment(env)) {
    throw new StateQueryCredentialError("The state-query credential is invalid.");
  }
  const target = { platform, groupId };
  group(target);
  return Object.freeze({ credential, environment, target, grantId, secret });
}

async function credentialRequest(env, credential, operation, nowMs) {
  const parsed = await parseStateQueryCredential(env, credential);
  return {
    parsed,
    result: await grantRequest(env, parsed.target, operation, {
      grantId: parsed.grantId,
      secretDigest: await digestSecret(parsed.secret),
      environment: parsed.environment,
      target: parsed.target,
      nowMs
    })
  };
}

export async function validateStateQueryCredential(env, credential, {
  nowMs = Date.now()
} = {}) {
  const { result } = await credentialRequest(env, credential, "validate", nowMs);
  if (result.status === "active") return result.grant;
  if (result.status === "expired") {
    throw new StateQueryCredentialError("The state-query grant has expired.", {
      code: "query_grant_expired",
      status: 401
    });
  }
  if (result.status === "revoked") {
    throw new StateQueryCredentialError("The state-query grant has been revoked.", {
      code: "query_grant_revoked",
      status: 401
    });
  }
  throw new StateQueryCredentialError("The state-query credential is invalid.");
}

export async function revokeStateQueryCredential(env, credential, {
  nowMs = Date.now()
} = {}) {
  const { result } = await credentialRequest(env, credential, "revoke", nowMs);
  if (result.status === "revoked") return Object.freeze({ revoked: true });
  if (result.status === "expired") {
    throw new StateQueryCredentialError("The state-query grant has expired.", {
      code: "query_grant_expired",
      status: 401
    });
  }
  throw new StateQueryCredentialError("The state-query credential is invalid.");
}

export async function issueBroadStateQueryGrant(
  env,
  registry,
  { target, exports: exportList, expiresInSeconds },
  options = {}
) {
  return issueStateQueryGrant(env, registry, {
    target,
    permissions: grantPermissionsForExportList(registry, target.platform, exportList),
    expiresInSeconds
  }, options);
}
