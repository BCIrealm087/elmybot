import { logError, withExternalRequestTimeout } from "../../common.js";
import { commands } from "./commands.js";

const encoder = new TextEncoder();
const EVENTSUB_SIGNATURE_PREFIX = "sha256=";
const EVENTSUB_SIGNATURE_BYTES = 32;
const EVENTSUB_MAX_AGE_MS = 10 * 60 * 1000;

let cachedSecret = null;
let cachedSecretKeyPromise = null;

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

async function sendTwitchChatMessage(env, event, message) {
	if (!env.TWITCH_CLIENT_ID || !env.TWITCH_ACCESS_TOKEN || !env.TWITCH_BOT_USER_ID) {
		throw new Error("Twitch chat credentials are not configured.");
	}
	if (!event?.broadcaster_user_id) {
		throw new Error("Twitch chat event is missing its broadcaster ID.");
	}

	const response = await fetch(
		"https://api.twitch.tv/helix/chat/messages",
		withExternalRequestTimeout({
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.TWITCH_ACCESS_TOKEN}`,
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
