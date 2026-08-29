import { logError } from "../../common.js";
import {
	drainTwitchEventSubInbox,
	enqueueTwitchEventSubMessage,
	TWITCH_EVENTSUB_INBOX_SCHEMA_VERSION
} from "./eventsub-inbox.js";
import {
	assertTwitchRequestOrigin,
	TwitchEnvironmentError
} from "./environment.js";
import { shouldEnqueueTwitchEventSubNotification } from "./eventsub-registry.js";
import { handleTwitchManagementRoute } from "./routes.js";

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

/**
 * Entrypoint for Twitch EventSub webhook requests.
 */
export async function handleTwitchRequest(request, env, ctx, eventSubRegistry) {
	const url = new URL(request.url);
	const isHealthCheck = url.pathname === "/twitch" && request.method === "GET";
	let environmentConfiguration;
	if (!isHealthCheck) {
		try {
			environmentConfiguration = assertTwitchRequestOrigin(request, env);
		} catch (error) {
			if (error instanceof TwitchEnvironmentError) {
				return new Response(error.message, {
					status: error.status,
					headers: { "cache-control": "no-store" }
				});
			}
			throw error;
		}
	}

	const managementResponse = await handleTwitchManagementRoute(
		request,
		env,
		environmentConfiguration
	);
	if (managementResponse) return managementResponse;

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

	if (messageType === "notification" || messageType === "revocation") {
		const broadcasterUserId =
			payload.subscription?.condition?.broadcaster_user_id ??
			payload.event?.broadcaster_user_id;
		if (messageType === "notification") {
			try {
				const shouldEnqueue = await shouldEnqueueTwitchEventSubNotification(
					eventSubRegistry,
					{ payload, messageId, messageTimestamp: timestamp }
				);
				if (!shouldEnqueue) return new Response(null, { status: 204 });
			} catch (error) {
				logError("twitch.eventsub_admission_failed", {
					platform: "twitch",
					correlationId: `twitch:${messageId}`,
					groupId: broadcasterUserId ?? null,
					messageType
				}, error);
				return new Response("Service Unavailable", { status: 503 });
			}
		}
		try {
			await enqueueTwitchEventSubMessage(env, broadcasterUserId, {
				schemaVersion: TWITCH_EVENTSUB_INBOX_SCHEMA_VERSION,
				broadcasterUserId,
				messageId,
				messageType,
				messageTimestamp: timestamp,
				payload
			});
			ctx.waitUntil(
				drainTwitchEventSubInbox(env, broadcasterUserId).catch((error) =>
					logError("twitch.eventsub_inbox_drain_failed", {
						platform: "twitch",
						correlationId: `twitch:${messageId}`,
						groupId: broadcasterUserId,
						messageType
					}, error)
				)
			);
		} catch (error) {
			if (error?.code === "twitch_eventsub_subscription_unsupported") {
				console.warn(JSON.stringify({
					level: "warn",
					event: "twitch.eventsub_subscription_unsupported",
					platform: "twitch",
					correlationId: `twitch:${messageId}`,
					groupId: broadcasterUserId ?? null,
					subscriptionType: payload.subscription?.type ?? null,
					subscriptionVersion: payload.subscription?.version ?? null
				}));
				return new Response(null, { status: 204 });
			}
			logError("twitch.eventsub_inbox_enqueue_failed", {
				platform: "twitch",
				correlationId: `twitch:${messageId}`,
				groupId: broadcasterUserId ?? null,
				messageType
			}, error);
			const status = Number.isInteger(error?.status) &&
				error.status >= 400 && error.status < 500
					? error.status
					: 503;
			return new Response(
				status >= 400 && status < 500
					? "Bad Request"
					: "Service Unavailable",
				{ status }
			);
		}
	}

	return new Response(null, { status: 204 });
}
