import {
  declaredRequestBodyTooLarge,
  encodedTextTooLarge,
  logError
} from "../common.js";
import { featureRegistry } from "../features/index.js";
import {
  revokeStateQueryCredential,
  StateQueryCredentialError,
  validateStateQueryCredential
} from "./grant-client.js";
import {
  authorizeStateQueryBinding,
  authorizeStateQueryPlan,
  preauthorizeStateQueryInput,
  StateQueryGrantError,
  stateQueryGrantCatalog
} from "./grants.js";
import { evaluateStateQuery } from "./evaluator.js";
import { stateQueryBrowserResponse } from "./browser-pages.js";
import {
  TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME
} from "../platforms/twitch/channel-auth-common.js";
import {
  prepareStateQuery,
  STATE_QUERY_LIMITS,
  StateQueryError
} from "./query.js";
import {
  createStateQuerySseResponse,
  STATE_QUERY_SSE_LIMITS,
  StateQueryStreamError
} from "./sse.js";

const SESSION_COOKIE = "elmybot_state_query";
const JSON_CONTENT_TYPE = "application/json";
const MAX_OPERATOR_FORM_BYTES = 16 * 1024;

function hardenedHeaders(extra = {}) {
  return {
    "cache-control": "no-store, private",
    "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra
  };
}

function plain(value, status) {
  return new Response(value, {
    status,
    headers: hardenedHeaders({ "content-type": "text/plain; charset=utf-8" })
  });
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: hardenedHeaders({
      "content-type": "application/json; charset=utf-8",
      ...headers
    })
  });
}

function publicError(error) {
  if (
    error instanceof StateQueryCredentialError ||
    error instanceof StateQueryError ||
    error instanceof StateQueryGrantError ||
    error instanceof StateQueryStreamError
  ) {
    return json({
      error: {
        code: error.code,
        message: error instanceof StateQueryGrantError
          ? "The read-grant request is invalid."
          : error.message
      }
    }, error.status);
  }
  return null;
}

function cookieValue(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [candidate, ...value] = part.trim().split("=");
    if (candidate === name) return value.join("=");
  }
  return null;
}

function bearerCredential(request) {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  if (!match) throw new StateQueryCredentialError("The state-query credential is invalid.");
  return match[1];
}

function requestCredential(request, { bearerOnly = false } = {}) {
  const bearer = bearerCredential(request);
  if (bearer) return { credential: bearer, transport: "bearer" };
  if (!bearerOnly) {
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (cookie) return { credential: cookie, transport: "cookie" };
  }
  throw new StateQueryCredentialError("A state-query credential is required.");
}

function publicOrigin(env, request) {
  const configured = env?.STATE_QUERY_PUBLIC_ORIGIN ?? env?.TWITCH_PUBLIC_ORIGIN;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error("STATE_QUERY_PUBLIC_ORIGIN is not configured.");
  }
  let origin;
  try {
    origin = new URL(configured).origin;
  } catch {
    throw new Error("STATE_QUERY_PUBLIC_ORIGIN is not configured.");
  }
  if (origin !== new URL(request.url).origin) {
    throw new Error("The state-query request does not match this deployment origin.");
  }
  return origin;
}

function requireSameOrigin(request, env) {
  if (request.headers.get("origin") !== publicOrigin(env, request)) {
    throw new StateQueryCredentialError("The request origin is not allowed.");
  }
}

function sessionCookie(credential, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${credential}; Path=/state-query; HttpOnly; Secure; ` +
    `SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/state-query; HttpOnly; Secure; SameSite=Strict; ` +
    "Max-Age=0";
}

function html(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: hardenedHeaders({
      "content-type": "text/html; charset=utf-8",
      ...headers
    })
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function operatorPage({ error = null } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Elmybot state-query grant</title></head><body>
<main><h1>Create a Twitch state-query grant</h1>
<p>Sign in with the broadcaster account for the channel whose state may be read.</p>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/state-query/operator/twitch">
<label>Readable export identities<br><textarea name="exports" rows="4" cols="72" required>fun.deaths:remembered_game:v1,fun.deaths:count:v1,fun.deaths:counts:v1</textarea></label>
<p>Use comma-separated catalog identities. Lookup arguments are allowed within their declared schemas; collections include future materialized members.</p>
<label>Lifetime in hours <input name="duration_hours" type="number" min="1" max="720" value="24" required></label>
<p><button type="submit">Continue with Twitch</button></p>
</form></main></body></html>`;
}

function issuedPage(issued) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Elmybot state-query grant created</title></head><body><main>
<h1>State-query grant created</h1>
<p>This credential is shown once. Keep it secret and do not put it in a URL.</p>
<p><code>${escapeHtml(issued.credential)}</code></p>
<p>Grant ID: <code>${escapeHtml(issued.grant.id)}</code></p>
<p>Expires: <time>${escapeHtml(new Date(issued.grant.expiresAtMs).toISOString())}</time></p>
<p>A secure same-origin session cookie is active. You may now open <a href="/state-query/setup">the query setup page</a>.</p>
</main></body></html>`;
}

function twitchOAuthStub(env) {
  if (!env?.TWITCH_CHANNEL_OAUTH) {
    throw new Error("Twitch operator OAuth is not configured.");
  }
  return env.TWITCH_CHANNEL_OAUTH.get(
    env.TWITCH_CHANNEL_OAUTH.idFromName(TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME)
  );
}

async function readOperatorForm(request) {
  if (declaredRequestBodyTooLarge(request, MAX_OPERATOR_FORM_BYTES)) {
    throw new StateQueryGrantError("Operator form exceeds the size limit.", { status: 413 });
  }
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new StateQueryGrantError("Operator form encoding is invalid.", { status: 415 });
  }
  const body = new TextDecoder().decode(await request.arrayBuffer());
  if (encodedTextTooLarge(body, MAX_OPERATOR_FORM_BYTES)) {
    throw new StateQueryGrantError("Operator form exceeds the size limit.", { status: 413 });
  }
  return new URLSearchParams(body);
}

async function twitchOperatorResponse(request, env) {
  if (request.method === "GET") return html(operatorPage());
  if (request.method !== "POST") return plain("Method Not Allowed", 405);
  requireSameOrigin(request, env);
  const form = await readOperatorForm(request);
  const durationHours = Number(form.get("duration_hours"));
  if (!Number.isSafeInteger(durationHours) || durationHours < 1 || durationHours > 720) {
    return html(operatorPage({ error: "Lifetime must be between 1 and 720 hours." }), 422);
  }
  const redirectUri = `${publicOrigin(env, request)}/state-query/operator/twitch/callback`;
  const response = await twitchOAuthStub(env).fetch(
    "https://twitch-channel-oauth/state-query/oauth/start",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirectUri,
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET,
        exports: form.get("exports"),
        expiresInSeconds: durationHours * 60 * 60
      })
    }
  );
  if (!response.ok) {
    await response.text();
    return html(operatorPage({
      error: response.status >= 500
        ? "Twitch authorization is temporarily unavailable."
        : "The export list or grant settings are invalid."
    }), response.status >= 500 ? 503 : 422);
  }
  const result = await response.json();
  return new Response(null, {
    status: 303,
    headers: hardenedHeaders({ location: result.authorizationUrl })
  });
}

async function twitchOperatorCallback(request, env) {
  if (request.method !== "GET") return plain("Method Not Allowed", 405);
  const url = new URL(request.url);
  if (url.searchParams.has("error")) {
    return html(operatorPage({ error: "Twitch authorization was denied." }), 400);
  }
  const response = await twitchOAuthStub(env).fetch(
    "https://twitch-channel-oauth/state-query/oauth/callback",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        redirectUri: `${publicOrigin(env, request)}/state-query/operator/twitch/callback`,
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET
      })
    }
  );
  if (!response.ok) {
    await response.text();
    return html(operatorPage({
      error: response.status >= 500
        ? "Twitch authorization is temporarily unavailable."
        : "This Twitch authorization is invalid or expired."
    }), response.status >= 500 ? 503 : 400);
  }
  const issued = await response.json();
  const maxAge = Math.max(0, Math.floor((issued.grant.expiresAtMs - Date.now()) / 1000));
  return html(issuedPage(issued), 200, {
    "set-cookie": sessionCookie(issued.credential, maxAge)
  });
}

async function readJson(request, maxBytes = STATE_QUERY_LIMITS.maxDocumentBytes) {
  if (declaredRequestBodyTooLarge(request, maxBytes)) {
    throw new StateQueryError("exceeds the document-size limit.", {
      code: "query_limit_exceeded",
      status: 413,
      path: "query"
    });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith(JSON_CONTENT_TYPE)) {
    throw new StateQueryError("must use application/json.", {
      code: "query_document_invalid",
      status: 415,
      path: "query"
    });
  }
  const text = await request.text();
  if (encodedTextTooLarge(text, maxBytes)) {
    throw new StateQueryError("exceeds the document-size limit.", {
      code: "query_limit_exceeded",
      status: 413,
      path: "query"
    });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new StateQueryError("must be valid JSON.", {
      code: "query_document_invalid",
      status: 400,
      path: "query",
      cause
    });
  }
}

async function authorizedRequest(request, env, options = {}) {
  const selected = requestCredential(request, options);
  if (selected.transport === "cookie" && options.mutates) requireSameOrigin(request, env);
  return {
    ...selected,
    grant: await validateStateQueryCredential(env, selected.credential)
  };
}

async function catalogResponse(request, env, registry) {
  if (request.method !== "GET") return plain("Method Not Allowed", 405);
  const { grant } = await authorizedRequest(request, env);
  return json({
    protocolVersion: 1,
    target: grant.target,
    grant: {
      id: grant.id,
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
      limits: grant.limits
    },
    exports: stateQueryGrantCatalog(registry, grant)
  });
}

async function snapshotResponse(request, env, registry) {
  if (request.method !== "POST") return plain("Method Not Allowed", 405);
  const { grant } = await authorizedRequest(request, env, { mutates: false });
  const input = await readJson(request, Math.min(
    STATE_QUERY_LIMITS.maxDocumentBytes,
    grant.limits.maxDocumentBytes
  ));
  preauthorizeStateQueryInput(input, grant);
  const plan = await prepareStateQuery(registry, input);
  authorizeStateQueryPlan(plan, grant);
  const result = await evaluateStateQuery(registry, plan.query, {
    env,
    preparedPlan: plan,
    correlationId: `state-query-snapshot:${crypto.randomUUID()}`,
    authorizeBinding: (binding, argumentsValue) =>
      authorizeStateQueryBinding(grant, binding, argumentsValue),
    maxResultBytes: grant.limits.maxResultBytes
  });
  return json(result.envelope);
}

async function streamResponse(request, env) {
  if (request.method !== "POST") return plain("Method Not Allowed", 405);
  const { grant } = await authorizedRequest(request, env, { mutates: false });
  const input = await readJson(request, Math.min(
    STATE_QUERY_LIMITS.maxDocumentBytes * STATE_QUERY_SSE_LIMITS.maxQueriesPerConnection,
    grant.limits.maxDocumentBytes * STATE_QUERY_SSE_LIMITS.maxQueriesPerConnection
  ));
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !Array.isArray(input.queries)) {
    throw new StateQueryStreamError("State-query stream registration is invalid.");
  }
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId && input.subscriptionId === undefined) {
    const match = lastEventId.match(/^sq1\.[a-f0-9]{32}\.([a-f0-9]{32})\.\d+$/);
    input.subscriptionId = match?.[1] ?? "invalid-recovery-cursor";
  }
  if (input.queries.length < 1 ||
      input.queries.length > STATE_QUERY_SSE_LIMITS.maxQueriesPerConnection) {
    throw new StateQueryStreamError("State-query stream query limit exceeded.", {
      status: 413,
      code: "query_limit_exceeded"
    });
  }
  for (const entry of input.queries) preauthorizeStateQueryInput(entry?.query, grant);
  return await createStateQuerySseResponse(env, grant, input);
}

async function sessionResponse(request, env) {
  if (request.method === "DELETE") {
    requireSameOrigin(request, env);
    return new Response(null, {
      status: 204,
      headers: hardenedHeaders({ "set-cookie": clearSessionCookie() })
    });
  }
  if (request.method !== "POST") return plain("Method Not Allowed", 405);
  requireSameOrigin(request, env);
  const { credential, grant } = await authorizedRequest(request, env, { bearerOnly: true });
  const maxAge = Math.max(0, Math.floor((grant.expiresAtMs - Date.now()) / 1000));
  return new Response(null, {
    status: 204,
    headers: hardenedHeaders({ "set-cookie": sessionCookie(credential, maxAge) })
  });
}

async function revokeResponse(request, env) {
  if (request.method !== "DELETE") return plain("Method Not Allowed", 405);
  const selected = requestCredential(request);
  if (selected.transport === "cookie") requireSameOrigin(request, env);
  await revokeStateQueryCredential(env, selected.credential);
  return new Response(null, {
    status: 204,
    headers: hardenedHeaders({ "set-cookie": clearSessionCookie() })
  });
}

export async function handleStateQueryRequest(
  request,
  env,
  { registry = featureRegistry } = {}
) {
  const url = new URL(request.url);
  try {
    if (["app.js", "client.js", "query.js", "ui.js", "browser.css"].some(
      (name) => url.pathname === `/state-query/${name}`
    )) {
      return await env.BROWSER_ASSETS.fetch(request);
    }
    const browserResponse = stateQueryBrowserResponse(request);
    if (browserResponse) return browserResponse;
    if (url.pathname === "/state-query/operator/twitch") {
      return await twitchOperatorResponse(request, env);
    }
    if (url.pathname === "/state-query/operator/twitch/callback") {
      return await twitchOperatorCallback(request, env);
    }
    if (url.pathname === "/state-query/catalog") {
      return await catalogResponse(request, env, registry);
    }
    if (url.pathname === "/state-query/snapshot") {
      return await snapshotResponse(request, env, registry);
    }
    if (url.pathname === "/state-query/stream") {
      return await streamResponse(request, env);
    }
    if (url.pathname === "/state-query/session") {
      return await sessionResponse(request, env);
    }
    if (url.pathname === "/state-query/grant") {
      return await revokeResponse(request, env);
    }
    return plain("Not Found", 404);
  } catch (error) {
    const response = publicError(error);
    if (response) return response;
    const correlationId = `state-query-http:${crypto.randomUUID()}`;
    logError("state_query.http_failed", {
      platform: "shared",
      correlationId,
      method: request.method,
      route: url.pathname
    }, error);
    return json({
      error: {
        code: "query_source_unavailable",
        message: "State-query service is temporarily unavailable.",
        correlationId
      }
    }, 503);
  }
}
