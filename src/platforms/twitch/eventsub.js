import {
	jsonResponse,
	logError,
	withExternalRequestTimeout
} from "../../common.js";

const APP_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const EVENTSUB_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const LIST_QUERY_PARAMETERS = Object.freeze(["status", "type", "user_id", "after"]);

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

async function createChatSubscription(request, env, clientId, clientSecret) {
	let requestBody;
	try {
		requestBody = await request.json();
	} catch {
		throw new TwitchEventSubError("The request body must be valid JSON.");
	}

	const broadcasterUserId = requestBody?.broadcasterUserId;
	if (typeof broadcasterUserId !== "string" || broadcasterUserId.length === 0) {
		throw new TwitchEventSubError("broadcasterUserId is required.");
	}

	const botUserId = configuredString(env.TWITCH_BOT_USER_ID, "TWITCH_BOT_USER_ID");
	const eventSubSecret = configuredString(env.TWITCH_EVENTSUB_SECRET, "TWITCH_EVENTSUB_SECRET");
	if (eventSubSecret.length < 10 || eventSubSecret.length > 100) {
		throw new TwitchEventSubError("TWITCH_EVENTSUB_SECRET must be between 10 and 100 characters.", {
			status: 503,
			code: "twitch_eventsub_not_configured"
		});
	}

	const requestUrl = new URL(request.url);
	if (requestUrl.protocol !== "https:") {
		throw new TwitchEventSubError("The EventSub callback must use HTTPS.", {
			status: 503,
			code: "twitch_eventsub_invalid_callback"
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
				callback: `${requestUrl.origin}/twitch`,
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
		const clientId = configuredString(env.TWITCH_CLIENT_ID, "TWITCH_CLIENT_ID");
		const clientSecret = configuredString(env.TWITCH_CLIENT_SECRET, "TWITCH_CLIENT_SECRET");

		if (request.method === "GET") {
			return await listEventSubSubscriptions(request, env, clientId, clientSecret);
		}
		if (request.method === "POST") {
			return await createChatSubscription(request, env, clientId, clientSecret);
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
