import { logError, withExternalRequestTimeout } from "../../common.js";
import { commands } from "./commands.js";
import { TWITCH_AUTH_OBJECT_NAME } from "./auth.js";

const encoder = new TextEncoder();
const EVENTSUB_SIGNATURE_PREFIX = "sha256=";
const EVENTSUB_SIGNATURE_BYTES = 32;
const EVENTSUB_MAX_AGE_MS = 10 * 60 * 1000;

let cachedSecret = null;
let cachedSecretKeyPromise = null;

function twitchAuthStub(env) {
	const id = env.TWITCH_AUTH.idFromName(TWITCH_AUTH_OBJECT_NAME);
	return env.TWITCH_AUTH.get(id);
}

function oauthSetupAuthorized(request, env) {
	return typeof env.TWITCH_OAUTH_SETUP_TOKEN === "string" &&
		env.TWITCH_OAUTH_SETUP_TOKEN.length > 0 &&
		request.headers.get("authorization") === `Bearer ${env.TWITCH_OAUTH_SETUP_TOKEN}`;
}

async function startTwitchOAuth(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN) {
		return new Response("Twitch OAuth setup is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}

	const url = new URL(request.url);
	return twitchAuthStub(env).fetch("https://twitch-auth/oauth/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			redirectUri: `${url.origin}/twitch/oauth/callback`,
			clientId: env.TWITCH_CLIENT_ID,
			clientSecret: env.TWITCH_CLIENT_SECRET,
			botUserId: env.TWITCH_BOT_USER_ID
		})
	});
}

async function finishTwitchOAuth(request, env) {
	const url = new URL(request.url);
	if (url.searchParams.has("error")) {
		return new Response("Twitch authorization was denied.", {
			status: 400,
			headers: { "cache-control": "no-store" }
		});
	}

	const response = await twitchAuthStub(env).fetch("https://twitch-auth/oauth/callback", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			code: url.searchParams.get("code"),
			state: url.searchParams.get("state"),
			redirectUri: `${url.origin}${url.pathname}`,
			clientId: env.TWITCH_CLIENT_ID,
			clientSecret: env.TWITCH_CLIENT_SECRET,
			botUserId: env.TWITCH_BOT_USER_ID
		})
	});
	if (!response.ok) return response;

	return new Response("Twitch bot authorization stored. You can close this tab.", {
		headers: {
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
			"referrer-policy": "no-referrer"
		}
	});
}

function hexToU8(hex) {
	if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
		return null;
	}

	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

async function verifyTwitchRequest({ secret, messageId, timestamp, signature, bodyText }) {
	if (typeof secret !== "string" || secret.length === 0) return false;
	if (!signature?.startsWith(EVENTSUB_SIGNATURE_PREFIX)) return false;

	const providedSignature = hexToU8(signature.slice(EVENTSUB_SIGNATURE_PREFIX.length));
	if (!providedSignature || providedSignature.length !== EVENTSUB_SIGNATURE_BYTES) return false;

	const timestampMs = Date.parse(timestamp);
	if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > EVENTSUB_MAX_AGE_MS) {
		return false;
	}

	try {
		if (secret !== cachedSecret) {
			cachedSecret = secret;
			cachedSecretKeyPromise = crypto.subtle.importKey(
				"raw",
				encoder.encode(secret),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["verify"]
			);
		}

		const key = await cachedSecretKeyPromise;
		const message = encoder.encode(messageId + timestamp + bodyText);
		return await crypto.subtle.verify("HMAC", key, providedSignature, message);
	} catch {
		return false;
	}
}

function commandFromMessage(messageText) {
	const match = messageText.trim().match(/^!([^\s]+)(?:\s|$)/);
	if (!match) return null;
	return commands[match[1].toLowerCase()] ?? null;
}

async function getTwitchAccessToken(env, rejectedAccessToken) {
	const response = await twitchAuthStub(env).fetch("https://twitch-auth/oauth/access-token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			clientId: env.TWITCH_CLIENT_ID,
			clientSecret: env.TWITCH_CLIENT_SECRET,
			botUserId: env.TWITCH_BOT_USER_ID,
			rejectedAccessToken
		})
	});
	const result = await response.json();
	if (!response.ok || typeof result.accessToken !== "string") {
		const error = new Error(result.error || "Could not obtain a Twitch access token.");
		error.status = response.status;
		error.code = result.code;
		throw error;
	}
	return result.accessToken;
}

function postTwitchChatMessage(env, event, message, accessToken) {
	return fetch(
		"https://api.twitch.tv/helix/chat/messages",
		withExternalRequestTimeout({
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Client-Id": env.TWITCH_CLIENT_ID,
				"content-type": "application/json"
			},
			body: JSON.stringify({
				broadcaster_id: event.broadcaster_user_id,
				sender_id: env.TWITCH_BOT_USER_ID,
				message
			})
		})
	);
}

async function sendTwitchChatMessage(env, event, message) {
	if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || !env.TWITCH_BOT_USER_ID) {
		throw new Error("Twitch chat credentials are not configured.");
	}
	if (!event?.broadcaster_user_id) {
		throw new Error("Twitch chat event is missing its broadcaster ID.");
	}

	let accessToken = await getTwitchAccessToken(env);
	let response = await postTwitchChatMessage(env, event, message, accessToken);
	if (response.status === 401) {
		await response.text();
		accessToken = await getTwitchAccessToken(env, accessToken);
		response = await postTwitchChatMessage(env, event, message, accessToken);
	}

	if (!response.ok) {
		await response.text();
		const error = new Error("Twitch rejected the chat message.");
		error.status = response.status;
		throw error;
	}
}

function handleChatNotification(payload, env, ctx, messageId) {
	if (payload.subscription?.type !== "channel.chat.message") return;

	const messageText = payload.event?.message?.text;
	if (typeof messageText !== "string") return;

	const command = commandFromMessage(messageText);
	if (!command) return;

	const reply = command.exec(payload.event, env);
	if (typeof reply !== "string" || reply.length === 0) return;

	ctx.waitUntil(
		sendTwitchChatMessage(env, payload.event, reply).catch((error) =>
			logError("twitch.command_failed", {
				platform: "twitch",
				correlationId: `twitch:${messageId}`,
				groupId: payload.event.broadcaster_user_id,
				command: messageText.trim().split(/\s+/, 1)[0]
			}, error)
		)
	);
}

/**
 * Entrypoint for Twitch EventSub webhook requests.
 */
export async function handleTwitchRequest(request, env, ctx) {
	const url = new URL(request.url);
	if (url.pathname === "/twitch/oauth/start") {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		return startTwitchOAuth(request, env);
	}
	if (url.pathname === "/twitch/oauth/callback") {
		if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
		return finishTwitchOAuth(request, env);
	}
	if (url.pathname !== "/twitch") return new Response("Not found", { status: 404 });

	if (request.method === "GET") return new Response("OK");
	if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

	const messageId = request.headers.get("Twitch-Eventsub-Message-Id");
	const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp");
	const signature = request.headers.get("Twitch-Eventsub-Message-Signature");
	const messageType = request.headers.get("Twitch-Eventsub-Message-Type");
	if (!messageId || !timestamp || !signature || !messageType) {
		return new Response("Bad Request", { status: 400 });
	}

	const bodyText = await request.text();
	const verified = await verifyTwitchRequest({
		secret: env.TWITCH_EVENTSUB_SECRET,
		messageId,
		timestamp,
		signature,
		bodyText
	});
	if (!verified) return new Response("Invalid signature", { status: 401 });

	let payload;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	if (messageType === "webhook_callback_verification") {
		if (typeof payload.challenge !== "string") {
			return new Response("Bad Request", { status: 400 });
		}
		return new Response(payload.challenge, {
			headers: { "content-type": "text/plain; charset=utf-8" }
		});
	}

	if (messageType === "notification") {
		handleChatNotification(payload, env, ctx, messageId);
	}

	return new Response(null, { status: 204 });
}
