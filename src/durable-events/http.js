import {
  declaredRequestBodyTooLarge,
  encodedTextTooLarge,
  logError
} from "../common.js";
import { featureRegistry } from "../features/index.js";
import {
  DurableEventCredentialError,
  revokeDurableEventCredential,
  validateDurableEventCredential
} from "./grant-client.js";
import {
  durableEventGrantCatalog,
  DurableEventGrantError
} from "./grants.js";
import { DURABLE_EVENT_CODES, DurableEventError } from "./contract.js";
import {
  TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME
} from "../platforms/twitch/channel-auth-common.js";

const SESSION_COOKIE = "elmybot_durable_event";
const MAX_OPERATOR_FORM_BYTES = 8 * 1024;

function hardenedHeaders(extra = {}) {
  return {
    "cache-control": "no-store, private",
    "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra
  };
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

function plain(value, status) {
  return new Response(value, {
    status,
    headers: hardenedHeaders({ "content-type": "text/plain; charset=utf-8" })
  });
}

function html(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: hardenedHeaders({ "content-type": "text/html; charset=utf-8", ...headers })
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

function publicError(error) {
  if (
    error instanceof DurableEventCredentialError ||
    error instanceof DurableEventGrantError ||
    error instanceof DurableEventError
  ) {
    return json({
      error: {
        code: error.code,
        message: error instanceof DurableEventGrantError
          ? "The event-grant request is invalid."
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
  if (!match) throw new DurableEventCredentialError("The durable-event credential is invalid.");
  return match[1];
}

function requestCredential(request, { bearerOnly = false } = {}) {
  const bearer = bearerCredential(request);
  if (bearer) return { credential: bearer, transport: "bearer" };
  if (!bearerOnly) {
    const cookie = cookieValue(request, SESSION_COOKIE);
    if (cookie) return { credential: cookie, transport: "cookie" };
  }
  throw new DurableEventCredentialError("A durable-event credential is required.");
}

function publicOrigin(env, request) {
  const configured = env?.DURABLE_EVENT_PUBLIC_ORIGIN;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error("DURABLE_EVENT_PUBLIC_ORIGIN is not configured.");
  }
  let origin;
  try {
    origin = new URL(configured).origin;
  } catch {
    throw new Error("DURABLE_EVENT_PUBLIC_ORIGIN is not configured.");
  }
  if (origin !== new URL(request.url).origin) {
    throw new Error("The durable-event request does not match this deployment origin.");
  }
  return origin;
}

function requireSameOrigin(request, env) {
  if (request.headers.get("origin") !== publicOrigin(env, request)) {
    throw new DurableEventCredentialError("The request origin is not allowed.");
  }
}

function sessionCookie(credential, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${credential}; Path=/event-stream; HttpOnly; Secure; ` +
    `SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/event-stream; HttpOnly; Secure; SameSite=Strict; ` +
    "Max-Age=0";
}

async function authorizedRequest(request, env, options = {}) {
  const selected = requestCredential(request, options);
  if (selected.transport === "cookie" && options.mutates) requireSameOrigin(request, env);
  return {
    ...selected,
    grant: await validateDurableEventCredential(env, selected.credential)
  };
}

function operatorPage(registry, { error = null } = {}) {
  const streams = registry.eventCatalog
    .filter((entry) => entry.platforms.includes("twitch"))
    .map((entry) => `${entry.feature}:${entry.stream}:v${entry.version}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Elmybot event-stream grant</title></head><body><main>
<h1>Create a Twitch event-stream grant</h1>
<p>Sign in with the broadcaster account for the channel that will own the consumer.</p>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/event-stream/operator/twitch">
<label>Event stream <select name="stream" required>${streams.map((identity) =>
    `<option value="${escapeHtml(identity)}">${escapeHtml(identity)}</option>`
  ).join("")}</select></label>
<label>Lifetime in hours <input name="duration_hours" type="number" min="1" max="720" value="24" required></label>
<label><input name="reset_backlog" type="checkbox" value="true"> Acknowledge loss and reset a retention gap</label>
<p><button type="submit"${streams.length === 0 ? " disabled" : ""}>Continue with Twitch</button></p>
</form></main></body></html>`;
}

function issuedPage(issued) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Elmybot event-stream grant created</title></head><body><main>
<h1>Event-stream grant created</h1>
<p>This credential is shown once. Keep it secret and do not put it in a URL.</p>
<p><code>${escapeHtml(issued.credential)}</code></p>
<p>Expires: <time>${escapeHtml(new Date(issued.grant.expiresAtMs).toISOString())}</time></p>
</main></body></html>`;
}

function twitchOAuthStub(env) {
  if (!env?.TWITCH_CHANNEL_OAUTH) throw new Error("Twitch operator OAuth is unavailable.");
  return env.TWITCH_CHANNEL_OAUTH.get(
    env.TWITCH_CHANNEL_OAUTH.idFromName(TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME)
  );
}

async function readOperatorForm(request) {
  if (declaredRequestBodyTooLarge(request, MAX_OPERATOR_FORM_BYTES)) {
    throw new DurableEventGrantError("The operator form is too large.", { status: 413 });
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase()
    .startsWith("application/x-www-form-urlencoded")) {
    throw new DurableEventGrantError("The operator form encoding is invalid.", { status: 415 });
  }
  const body = new TextDecoder().decode(await request.arrayBuffer());
  if (encodedTextTooLarge(body, MAX_OPERATOR_FORM_BYTES)) {
    throw new DurableEventGrantError("The operator form is too large.", { status: 413 });
  }
  return new URLSearchParams(body);
}

async function twitchOperatorResponse(request, env, registry) {
  if (request.method === "GET") return html(operatorPage(registry));
  if (request.method !== "POST") return plain("Method Not Allowed", 405);
  requireSameOrigin(request, env);
  const form = await readOperatorForm(request);
  const durationHours = Number(form.get("duration_hours"));
  if (!Number.isSafeInteger(durationHours) || durationHours < 1 || durationHours > 720) {
    return html(operatorPage(registry, { error: "Lifetime must be between 1 and 720 hours." }), 422);
  }
  const response = await twitchOAuthStub(env).fetch(
    "https://twitch-channel-oauth/durable-event/oauth/start",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirectUri: `${publicOrigin(env, request)}/event-stream/operator/twitch/callback`,
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET,
        stream: form.get("stream"),
        resetBacklog: form.get("reset_backlog") === "true",
        expiresInSeconds: durationHours * 60 * 60
      })
    }
  );
  if (!response.ok) {
    await response.text();
    return html(operatorPage(registry, { error: "The stream or grant settings are invalid." }),
      response.status >= 500 ? 503 : 422);
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
  if (url.searchParams.has("error")) return html("Twitch authorization was denied.", 400);
  const response = await twitchOAuthStub(env).fetch(
    "https://twitch-channel-oauth/durable-event/oauth/callback",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        redirectUri: `${publicOrigin(env, request)}/event-stream/operator/twitch/callback`,
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET
      })
    }
  );
  if (!response.ok) {
    await response.text();
    return html("This Twitch authorization is invalid or expired.",
      response.status >= 500 ? 503 : 400);
  }
  const issued = await response.json();
  const maxAge = Math.max(0, Math.floor((issued.grant.expiresAtMs - Date.now()) / 1000));
  return html(issuedPage(issued), 200, {
    "set-cookie": sessionCookie(issued.credential, maxAge)
  });
}

async function catalogResponse(request, env, registry) {
  if (request.method !== "GET") return plain("Method Not Allowed", 405);
  const { grant } = await authorizedRequest(request, env);
  return json({
    protocolVersion: 1,
    target: grant.target,
    grant: { id: grant.id, expiresAt: new Date(grant.expiresAtMs).toISOString() },
    streams: durableEventGrantCatalog(registry, grant)
  });
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
  await revokeDurableEventCredential(env, selected.credential);
  return new Response(null, {
    status: 204,
    headers: hardenedHeaders({ "set-cookie": clearSessionCookie() })
  });
}

export async function handleDurableEventRequest(
  request,
  env,
  { registry = featureRegistry } = {}
) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/event-stream/operator/twitch") {
      return await twitchOperatorResponse(request, env, registry);
    }
    if (url.pathname === "/event-stream/operator/twitch/callback") {
      return await twitchOperatorCallback(request, env);
    }
    if (url.pathname === "/event-stream/catalog") {
      return await catalogResponse(request, env, registry);
    }
    if (url.pathname === "/event-stream/session") {
      return await sessionResponse(request, env);
    }
    if (url.pathname === "/event-stream/grant") {
      return await revokeResponse(request, env);
    }
    return plain("Not Found", 404);
  } catch (error) {
    const response = publicError(error);
    if (response) return response;
    const correlationId = `durable-event-http:${crypto.randomUUID()}`;
    logError("durable_event.http_failed", {
      platform: "shared",
      correlationId,
      method: request.method,
      route: url.pathname
    }, error);
    return json({
      error: {
        code: DURABLE_EVENT_CODES.serviceUnavailable,
        message: "Durable-event service is temporarily unavailable.",
        correlationId
      }
    }, 503);
  }
}
