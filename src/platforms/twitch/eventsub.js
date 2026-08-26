import {
	jsonResponse,
	logError,
	withExternalRequestTimeout
} from "../../common.js";

const APP_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const EVENTSUB_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const LIST_QUERY_PARAMETERS = Object.freeze(["status", "type", "user_id", "after"]);
export const RECOVERABLE_EVENTSUB_STATUS = "notification_failures_exceeded";
const RECOVERY_KEY = "pendingRecovery";
const RECOVERY_INITIAL_DELAY_MS = 1000;
const RECOVERY_RETRY_DELAYS_MS = Object.freeze([
	60 * 1000,
	5 * 60 * 1000,
	15 * 60 * 1000,
	60 * 60 * 1000
]);

export function twitchEventSubManagerObjectName(broadcasterUserId) {
	return `twitch:channel:${broadcasterUserId}`;
}

class TwitchEventSubError extends Error {
	constructor(message, { status = 400, code = "twitch_eventsub_error", cause } = {}) {
		super(message, { cause });
		this.status = status;
		this.code = code;
	}
}

function noStoreJson(value, status = 200) {
	const response = jsonResponse(value, status);
	response.headers.set("cache-control", "no-store");
	return response;
}

function configuredString(value, name) {
	if (typeof value !== "string" || value.length === 0) {
		throw new TwitchEventSubError(`${name} is not configured.`, {
			status: 503,
			code: "twitch_eventsub_not_configured"
		});
	}
	return value;
}

async function getTwitchAppAccessToken(clientId, clientSecret) {
	let response;
	try {
		response = await fetch(
			APP_TOKEN_URL,
			withExternalRequestTimeout({
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: "client_credentials"
				})
			})
		);
	} catch (cause) {
		throw new TwitchEventSubError("Twitch app authentication was unavailable.", {
			status: 502,
			code: "twitch_eventsub_auth_network_error",
			cause
		});
	}

	if (!response.ok) {
		await response.text();
		throw new TwitchEventSubError("Twitch rejected the application credentials.", {
			status: 502,
			code: "twitch_eventsub_auth_rejected"
		});
	}

	let token;
	try {
		token = await response.json();
	} catch (cause) {
		throw new TwitchEventSubError("Twitch returned an invalid app-token response.", {
			status: 502,
			code: "twitch_eventsub_invalid_auth_response",
			cause
		});
	}
	if (typeof token.access_token !== "string" || token.access_token.length === 0) {
		throw new TwitchEventSubError("Twitch returned an invalid app-token response.", {
			status: 502,
			code: "twitch_eventsub_invalid_auth_response"
		});
	}
	return token.access_token;
}

async function twitchEventSubRequest({ method, url, clientId, accessToken, body }) {
	let response;
	try {
		response = await fetch(
			url,
			withExternalRequestTimeout({
				method,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Client-Id": clientId,
					...(body ? { "content-type": "application/json" } : {})
				},
				...(body ? { body: JSON.stringify(body) } : {})
			})
		);
	} catch (cause) {
		throw new TwitchEventSubError("Twitch EventSub was unavailable.", {
			status: 502,
			code: "twitch_eventsub_network_error",
			cause
		});
	}

	const responseBody = await response.text();
	return new Response(responseBody, {
		status: response.status,
		headers: {
			"cache-control": "no-store",
			"content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8"
		}
	});
}

async function listEventSubSubscriptions(request, env, clientId, clientSecret) {
	const requestUrl = new URL(request.url);
	const twitchUrl = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
	for (const name of LIST_QUERY_PARAMETERS) {
		const value = requestUrl.searchParams.get(name);
		if (value) twitchUrl.searchParams.set(name, value);
	}

	const accessToken = await getTwitchAppAccessToken(clientId, clientSecret);
	return twitchEventSubRequest({
		method: "GET",
		url: twitchUrl.href,
		clientId,
		accessToken
	});
}

async function createChatSubscription(request, env) {
	let requestBody;
	try {
		requestBody = await request.json();
	} catch {
		throw new TwitchEventSubError("The request body must be valid JSON.");
	}

	const requestUrl = new URL(request.url);
	return createTwitchChatSubscription({
		broadcasterUserId: requestBody?.broadcasterUserId,
		callbackUrl: `${requestUrl.origin}/twitch`
	}, env);
}

export async function createTwitchChatSubscription({
	broadcasterUserId,
	callbackUrl
}, env) {
	if (typeof broadcasterUserId !== "string" || broadcasterUserId.length === 0) {
		throw new TwitchEventSubError("broadcasterUserId is required.");
	}

	let parsedCallback;
	try {
		parsedCallback = new URL(callbackUrl);
	} catch {
		throw new TwitchEventSubError("The EventSub callback is invalid.", {
			status: 503,
			code: "twitch_eventsub_invalid_callback"
		});
	}
	if (parsedCallback.protocol !== "https:" || parsedCallback.pathname !== "/twitch") {
		throw new TwitchEventSubError("The EventSub callback must be HTTPS and end in /twitch.", {
			status: 503,
			code: "twitch_eventsub_invalid_callback"
		});
	}

	const clientId = configuredString(env.TWITCH_CLIENT_ID, "TWITCH_CLIENT_ID");
	const clientSecret = configuredString(env.TWITCH_CLIENT_SECRET, "TWITCH_CLIENT_SECRET");
	const botUserId = configuredString(env.TWITCH_BOT_USER_ID, "TWITCH_BOT_USER_ID");
	const eventSubSecret = configuredString(env.TWITCH_EVENTSUB_SECRET, "TWITCH_EVENTSUB_SECRET");
	if (eventSubSecret.length < 10 || eventSubSecret.length > 100) {
		throw new TwitchEventSubError("TWITCH_EVENTSUB_SECRET must be between 10 and 100 characters.", {
			status: 503,
			code: "twitch_eventsub_not_configured"
		});
	}

	const accessToken = await getTwitchAppAccessToken(clientId, clientSecret);
	return twitchEventSubRequest({
		method: "POST",
		url: EVENTSUB_SUBSCRIPTIONS_URL,
		clientId,
		accessToken,
		body: {
			type: "channel.chat.message",
			version: "1",
			condition: {
				broadcaster_user_id: broadcasterUserId,
				user_id: botUserId
			},
			transport: {
				method: "webhook",
				callback: parsedCallback.href,
				secret: eventSubSecret
			}
		}
	});
}

/**
 * Protected management endpoint for the bot's EventSub subscriptions.
 */
export async function handleTwitchEventSubSubscriptions(request, env) {
	try {
		if (request.method === "GET") {
			const clientId = configuredString(env.TWITCH_CLIENT_ID, "TWITCH_CLIENT_ID");
			const clientSecret = configuredString(env.TWITCH_CLIENT_SECRET, "TWITCH_CLIENT_SECRET");
			return await listEventSubSubscriptions(request, env, clientId, clientSecret);
		}
		if (request.method === "POST") {
			return await createChatSubscription(request, env);
		}
		return new Response("Method Not Allowed", { status: 405 });
	} catch (error) {
		if (error instanceof TwitchEventSubError) {
			return noStoreJson({ error: error.message, code: error.code }, error.status);
		}

		logError("twitch.eventsub_management_failed", {
			platform: "twitch",
			correlationId: `twitch-eventsub:${crypto.randomUUID()}`,
			groupId: null
		}, error);
		return noStoreJson({ error: "Twitch EventSub management failed." }, 500);
	}
}

function recoveryStub(env, broadcasterUserId) {
	const name = twitchEventSubManagerObjectName(broadcasterUserId);
	return env.TWITCH_EVENTSUB_MANAGER.get(
		env.TWITCH_EVENTSUB_MANAGER.idFromName(name)
	);
}

export async function queueTwitchEventSubRecovery(env, recovery) {
	if (!env.TWITCH_EVENTSUB_MANAGER) {
		throw new TwitchEventSubError("TWITCH_EVENTSUB_MANAGER is not configured.", {
			status: 503,
			code: "twitch_eventsub_not_configured"
		});
	}

	const response = await recoveryStub(env, recovery.broadcasterUserId).fetch(
		"https://twitch-eventsub-manager/recover",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(recovery)
		}
	);
	if (!response.ok) {
		const result = await response.json();
		throw new TwitchEventSubError(result.error || "Could not queue EventSub recovery.", {
			status: response.status,
			code: result.code || "twitch_eventsub_recovery_queue_failed"
		});
	}
}

function validateRecovery(recovery) {
	if (
		typeof recovery?.broadcasterUserId !== "string" ||
		recovery.broadcasterUserId.length === 0 ||
		typeof recovery.callbackUrl !== "string" ||
		recovery.callbackUrl.length === 0 ||
		recovery.reason !== RECOVERABLE_EVENTSUB_STATUS
	) {
		throw new TwitchEventSubError("The EventSub recovery request is invalid.");
	}

	let callback;
	try {
		callback = new URL(recovery.callbackUrl);
	} catch {
		throw new TwitchEventSubError("The EventSub recovery callback is invalid.");
	}
	if (callback.protocol !== "https:" || callback.pathname !== "/twitch") {
		throw new TwitchEventSubError("The EventSub recovery callback is invalid.");
	}

	return {
		broadcasterUserId: recovery.broadcasterUserId,
		callbackUrl: callback.href,
		reason: recovery.reason,
		sourceSubscriptionId:
			typeof recovery.sourceSubscriptionId === "string"
				? recovery.sourceSubscriptionId
				: null,
		attempts: 0,
		queuedAtMs: Date.now()
	};
}

export class TwitchEventSubManager {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async queueRecovery(recovery) {
		const validated = validateRecovery(recovery);
		const existing = await this.state.storage.get(RECOVERY_KEY);
		if (
			existing?.sourceSubscriptionId &&
			existing.sourceSubscriptionId === validated.sourceSubscriptionId
		) {
			return;
		}

		await this.state.storage.put(RECOVERY_KEY, validated);
		await this.state.storage.setAlarm(Date.now() + RECOVERY_INITIAL_DELAY_MS);
	}

	async alarm() {
		const recovery = await this.state.storage.get(RECOVERY_KEY);
		if (!recovery) return;

		try {
			const response = await createTwitchChatSubscription({
				broadcasterUserId: recovery.broadcasterUserId,
				callbackUrl: recovery.callbackUrl
			}, this.env);

			if (response.status !== 202 && response.status !== 409) {
				await response.text();
				const error = new Error(
					`Twitch rejected EventSub recovery with status ${response.status}.`
				);
				error.status = response.status;
				throw error;
			}

			await this.state.storage.delete(RECOVERY_KEY);
			await this.state.storage.deleteAlarm();
			console.log(JSON.stringify({
				level: "info",
				event: "twitch.eventsub_recovered",
				platform: "twitch",
				groupId: recovery.broadcasterUserId,
				sourceSubscriptionId: recovery.sourceSubscriptionId,
				result: response.status === 409 ? "already_exists" : "created"
			}));
		} catch (error) {
			const attempts = (recovery.attempts ?? 0) + 1;
			const delayMs = RECOVERY_RETRY_DELAYS_MS[
				Math.min(attempts - 1, RECOVERY_RETRY_DELAYS_MS.length - 1)
			];
			await this.state.storage.put(RECOVERY_KEY, {
				...recovery,
				attempts,
				lastAttemptAtMs: Date.now()
			});
			await this.state.storage.setAlarm(Date.now() + delayMs);
			logError("twitch.eventsub_recovery_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-recovery:${crypto.randomUUID()}`,
				groupId: recovery.broadcasterUserId,
				sourceSubscriptionId: recovery.sourceSubscriptionId,
				attempts,
				nextRetryInMs: delayMs
			}, error);
		}
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/recover") {
				await this.queueRecovery(await request.json());
				return noStoreJson({ queued: true }, 202);
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchEventSubError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			logError("twitch.eventsub_recovery_queue_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-recovery-queue:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Could not queue EventSub recovery." }, 500);
		}
	}
}
