import { logError, withExternalRequestTimeout } from "../../common.js";
import { commands } from "./commands.js";
import { TWITCH_AUTH_OBJECT_NAME } from "./auth.js";
import {
	claimTwitchEventSubMessage,
	getTwitchEventSubServiceStatus,
	handleTwitchChannelConfiguration,
	handleTwitchEventSubSubscriptions,
	queueTwitchEventSubRecovery,
	RECOVERABLE_EVENTSUB_STATUS
} from "./eventsub.js";
import {
	markTwitchChannelAuthorizationRevoked,
	twitchChannelAuthObjectName,
	twitchChannelOAuthCoordinatorStub
} from "./channel-auth.js";
import {
	renderTwitchConnectPage,
	renderTwitchOnboardingError,
	renderTwitchOnboardingSuccess
} from "./onboarding.js";
import {
	assertTwitchRequestOrigin,
	TwitchEnvironmentError,
	twitchPublicUrl
} from "./environment.js";
import { handleTwitchChannelHealth } from "./channel-registry.js";

const encoder = new TextEncoder();
const EVENTSUB_SIGNATURE_PREFIX = "sha256=";
const EVENTSUB_SIGNATURE_BYTES = 32;
const EVENTSUB_MAX_AGE_MS = 10 * 60 * 1000;
const TWITCH_CHAT_METADATA_STRING_MAX_LENGTH = 500;

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

	return twitchAuthStub(env).fetch("https://twitch-auth/oauth/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			redirectUri: twitchPublicUrl(env, "/twitch/oauth/callback"),
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
			redirectUri: twitchPublicUrl(env, "/twitch/oauth/callback"),
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

function requestTwitchChannelOAuthStart(env, invitationToken) {
	return twitchChannelOAuthCoordinatorStub(env).fetch(
		"https://twitch-channel-oauth/oauth/start",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				redirectUri: twitchPublicUrl(env, "/twitch/channels/oauth/callback"),
				callbackUrl: twitchPublicUrl(env, "/twitch"),
				clientId: env.TWITCH_CLIENT_ID,
				clientSecret: env.TWITCH_CLIENT_SECRET,
				...(invitationToken === undefined ? {} : { invitationToken })
			})
		}
	);
}

async function startTwitchChannelOAuth(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN || !env.TWITCH_CHANNEL_OAUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}
	return requestTwitchChannelOAuthStart(env);
}

async function createTwitchChannelInvitation(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN || !env.TWITCH_CHANNEL_OAUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}
	return twitchChannelOAuthCoordinatorStub(env).fetch(
		"https://twitch-channel-oauth/invitations/create",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				connectUrl: twitchPublicUrl(env, "/twitch/channels/connect")
			})
		}
	);
}

async function beginInvitedTwitchChannelOAuth(request, env) {
	if (!env.TWITCH_CHANNEL_OAUTH) {
		return renderTwitchOnboardingError(
			"Channel onboarding is temporarily unavailable.",
			503
		);
	}
	let invitationToken;
	try {
		invitationToken = (await request.formData()).get("invite");
	} catch {
		return renderTwitchOnboardingError("This invitation is invalid or expired.");
	}
	const response = await requestTwitchChannelOAuthStart(env, invitationToken);
	if (!response.ok) {
		await response.text();
		return renderTwitchOnboardingError(
			response.status >= 500
				? "Channel onboarding is temporarily unavailable. Please try again later."
				: "This invitation is invalid, expired, or has already been used.",
			response.status >= 500 ? 503 : 400
		);
	}
	const result = await response.json();
	return new Response(null, {
		status: 303,
		headers: {
			"cache-control": "no-store",
			location: result.authorizationUrl,
			"referrer-policy": "no-referrer"
		}
	});
}

async function finishTwitchChannelOAuth(request, env) {
	if (!env.TWITCH_CHANNEL_OAUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	const url = new URL(request.url);
	if (url.searchParams.has("error")) {
		return renderTwitchOnboardingError("Twitch channel authorization was denied.");
	}
	const response = await twitchChannelOAuthCoordinatorStub(env).fetch(
		"https://twitch-channel-oauth/oauth/callback",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: url.searchParams.get("code"),
				state: url.searchParams.get("state"),
				redirectUri: twitchPublicUrl(env, "/twitch/channels/oauth/callback"),
				clientId: env.TWITCH_CLIENT_ID,
				clientSecret: env.TWITCH_CLIENT_SECRET
			})
		}
	);
	if (!response.ok) {
		await response.text();
		return renderTwitchOnboardingError(
			response.status >= 500
				? "Twitch authorization is temporarily unavailable. Please try again later."
				: "This authorization link is invalid or expired.",
			response.status >= 500 ? 503 : 400
		);
	}
	const result = await response.json();
	const channel = result.authorization?.login || result.authorization?.broadcasterUserId;
	return renderTwitchOnboardingSuccess(channel);
}

function twitchChannelAuthStub(env, broadcasterUserId) {
	return env.TWITCH_CHANNEL_AUTH.get(
		env.TWITCH_CHANNEL_AUTH.idFromName(twitchChannelAuthObjectName(broadcasterUserId))
	);
}

async function handleTwitchChannelAuthorization(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN || !env.TWITCH_CHANNEL_AUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}
	const broadcasterUserId = new URL(request.url).searchParams.get("broadcasterUserId");
	if (!broadcasterUserId) {
		return new Response("broadcasterUserId is required.", { status: 400 });
	}
	if (request.method === "GET") {
		return twitchChannelAuthStub(env, broadcasterUserId).fetch(
			"https://twitch-channel-auth/status"
		);
	}
	if (request.method === "DELETE") {
		return twitchChannelAuthStub(env, broadcasterUserId).fetch(
			"https://twitch-channel-auth/authorization",
			{ method: "DELETE" }
		);
	}
	return new Response("Method Not Allowed", { status: 405 });
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

class TwitchChatDeliveryError extends Error {
	constructor(message, {
		classification,
		code,
		status,
		retryable = false,
		metadata = {},
		cause
	}) {
		super(message, { cause });
		this.name = "TwitchChatDeliveryError";
		this.classification = classification;
		this.code = code;
		this.retryable = retryable;
		if (status !== undefined) this.status = status;
		if (Object.keys(metadata).length > 0) this.metadata = metadata;
	}
}

function boundedTwitchChatMetadataString(value) {
	return typeof value === "string"
		? value.slice(0, TWITCH_CHAT_METADATA_STRING_MAX_LENGTH)
		: null;
}

function twitchChatHttpError(status) {
	if (status === 401) {
		return new TwitchChatDeliveryError(
			"Twitch rejected the refreshed chat authorization.",
			{
				classification: "authentication",
				code: "twitch_chat_authentication_failed",
				status
			}
		);
	}
	if (status === 403) {
		return new TwitchChatDeliveryError(
			"The bot is not permitted to send to this Twitch channel.",
			{
				classification: "authorization",
				code: "twitch_chat_authorization_failed",
				status
			}
		);
	}
	if (status === 429) {
		return new TwitchChatDeliveryError("Twitch chat rate limit exceeded.", {
			classification: "rate_limit",
			code: "twitch_chat_rate_limited",
			status,
			retryable: true
		});
	}
	if (status >= 500) {
		return new TwitchChatDeliveryError("Twitch chat is temporarily unavailable.", {
			classification: "service",
			code: "twitch_chat_service_unavailable",
			status,
			retryable: true
		});
	}
	if (status === 400 || status === 422) {
		return new TwitchChatDeliveryError("Twitch rejected the chat request.", {
			classification: "invalid_request",
			code: "twitch_chat_invalid_request",
			status
		});
	}
	return new TwitchChatDeliveryError("Twitch rejected the chat request.", {
		classification: "http",
		code: "twitch_chat_http_error",
		status
	});
}

async function postTwitchChatMessage(env, event, message, accessToken) {
	try {
		return await fetch(
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
	} catch (cause) {
		throw new TwitchChatDeliveryError("Twitch chat request failed.", {
			classification: "network",
			code: "twitch_chat_network_error",
			retryable: true,
			cause
		});
	}
}

async function validateTwitchChatResponse(response) {
	if (!response.ok) {
		await response.text();
		throw twitchChatHttpError(response.status);
	}

	let result;
	try {
		result = await response.json();
	} catch (cause) {
		throw new TwitchChatDeliveryError(
			"Twitch returned an invalid chat response.",
			{
				classification: "invalid_response",
				code: "twitch_chat_invalid_response",
				retryable: true,
				cause
			}
		);
	}

	const sent = result?.data?.[0];
	if (sent?.is_sent === false) {
		throw new TwitchChatDeliveryError("Twitch dropped the chat message.", {
			classification: "dropped",
			code: "twitch_chat_message_dropped",
			metadata: {
				dropReason: {
					code: boundedTwitchChatMetadataString(sent.drop_reason?.code),
					message: boundedTwitchChatMetadataString(sent.drop_reason?.message)
				}
			}
		});
	}
	if (
		sent?.is_sent !== true ||
		typeof sent.message_id !== "string" ||
		sent.message_id.length === 0
	) {
		throw new TwitchChatDeliveryError(
			"Twitch returned an invalid chat response.",
			{
				classification: "invalid_response",
				code: "twitch_chat_invalid_response",
				retryable: true
			}
		);
	}
	return sent.message_id;
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

	return validateTwitchChatResponse(response);
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

function handleEventSubRevocation(payload, env, ctx, messageId, callbackUrl) {
	const subscription = payload.subscription;
	const status = subscription?.status;
	const broadcasterUserId = subscription?.condition?.broadcaster_user_id;

	console.warn(JSON.stringify({
		level: "warn",
		event: "twitch.eventsub_revoked",
		platform: "twitch",
		correlationId: `twitch:${messageId}`,
		groupId: broadcasterUserId ?? null,
		subscriptionId: subscription?.id ?? null,
		subscriptionType: subscription?.type ?? null,
		status: status ?? null,
		recoverable: status === RECOVERABLE_EVENTSUB_STATUS
	}));

	if (
		subscription?.type === "channel.chat.message" &&
		status === "authorization_revoked" &&
		typeof broadcasterUserId === "string" &&
		broadcasterUserId.length > 0
	) {
		ctx.waitUntil(
			markTwitchChannelAuthorizationRevoked(env, broadcasterUserId).catch((error) =>
				logError("twitch.channel_oauth_revocation_failed", {
					platform: "twitch",
					correlationId: `twitch:${messageId}`,
					groupId: broadcasterUserId,
					subscriptionId: subscription.id ?? null
				}, error)
			)
		);
	}

	if (
		subscription?.type !== "channel.chat.message" ||
		status !== RECOVERABLE_EVENTSUB_STATUS ||
		typeof broadcasterUserId !== "string" ||
		broadcasterUserId.length === 0
	) {
		return;
	}

	ctx.waitUntil(
		queueTwitchEventSubRecovery(env, {
			broadcasterUserId,
			callbackUrl,
			reason: status,
			sourceSubscriptionId: subscription.id
		}).catch((error) =>
			logError("twitch.eventsub_recovery_queue_failed", {
				platform: "twitch",
				correlationId: `twitch:${messageId}`,
				groupId: broadcasterUserId,
				subscriptionId: subscription.id
			}, error)
		)
	);
}

/**
 * Entrypoint for Twitch EventSub webhook requests.
 */
export async function handleTwitchRequest(request, env, ctx) {
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
	if (url.pathname === "/twitch/configuration") {
		if (!env.TWITCH_OAUTH_SETUP_TOKEN) {
			return new Response("Twitch setup is not configured.", { status: 503 });
		}
		if (!oauthSetupAuthorized(request, env)) {
			return new Response("Unauthorized", { status: 401 });
		}
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return Response.json(environmentConfiguration, {
			headers: { "cache-control": "no-store" }
		});
	}
	if (url.pathname === "/twitch/channels/invitations") {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		return createTwitchChannelInvitation(request, env);
	}
	if (url.pathname === "/twitch/channels/connect") {
		if (request.method === "GET") return renderTwitchConnectPage();
		if (request.method === "POST") return beginInvitedTwitchChannelOAuth(request, env);
		return new Response("Method Not Allowed", { status: 405 });
	}
	if (url.pathname === "/twitch/channels/oauth/start") {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		return startTwitchChannelOAuth(request, env);
	}
	if (url.pathname === "/twitch/channels/oauth/callback") {
		if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
		return finishTwitchChannelOAuth(request, env);
	}
	if (url.pathname === "/twitch/channels/oauth") {
		return handleTwitchChannelAuthorization(request, env);
	}
	if (url.pathname === "/twitch/channels/health") {
		if (!env.TWITCH_OAUTH_SETUP_TOKEN) {
			return new Response("Twitch setup is not configured.", { status: 503 });
		}
		if (!oauthSetupAuthorized(request, env)) {
			return new Response("Unauthorized", { status: 401 });
		}
		return handleTwitchChannelHealth(request, env);
	}
	if (
		url.pathname === "/twitch/eventsub/subscriptions" ||
		url.pathname === "/twitch/eventsub/channels" ||
		url.pathname === "/twitch/eventsub/service"
	) {
		if (!env.TWITCH_OAUTH_SETUP_TOKEN) {
			return new Response("Twitch setup is not configured.", { status: 503 });
		}
		if (!oauthSetupAuthorized(request, env)) {
			return new Response("Unauthorized", { status: 401 });
		}
		if (url.pathname === "/twitch/eventsub/channels") {
			return handleTwitchChannelConfiguration(request, env);
		}
		if (url.pathname === "/twitch/eventsub/service") {
			if (request.method !== "GET") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			return getTwitchEventSubServiceStatus(env);
		}
		return handleTwitchEventSubSubscriptions(request, env);
	}
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

	if (messageType === "notification" || messageType === "revocation") {
		const broadcasterUserId =
			payload.subscription?.condition?.broadcaster_user_id ??
			payload.event?.broadcaster_user_id;
		try {
			const claimed = await claimTwitchEventSubMessage(env, {
				broadcasterUserId,
				messageId
			});
			if (!claimed) return new Response(null, { status: 204 });
		} catch (error) {
			logError("twitch.eventsub_message_claim_failed", {
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
				status === 400 ? "Bad Request" : "Service Unavailable",
				{ status }
			);
		}
	}

	if (messageType === "revocation") {
		handleEventSubRevocation(
			payload,
			env,
			ctx,
			messageId,
			twitchPublicUrl(env, "/twitch")
		);
	} else if (messageType === "notification") {
		handleChatNotification(payload, env, ctx, messageId);
	}

	return new Response(null, { status: 204 });
}
