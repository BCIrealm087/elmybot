import { logError } from "../../common.js";
import { twitchPublicUrl } from "./environment.js";
import {
	registerTwitchChannel,
	unregisterTwitchChannel
} from "./channel-registry.js";
import { TWITCH_EVENTSUB_SERVICE_NAME } from "./eventsub-service.js";
import {
	noStoreJson,
	TwitchEventSubError,
	validateChannelConfig,
	validateEventSubMessageId
} from "./eventsub-common.js";

export {
	RECOVERABLE_EVENTSUB_STATUS,
	TWITCH_CHANNEL_AUTHORIZATION_MODES
} from "./eventsub-common.js";

const LIST_QUERY_PARAMETERS = Object.freeze([
	"status",
	"type",
	"user_id",
	"subscription_id",
	"conduit_id",
	"after"
]);

export function twitchEventSubManagerObjectName(broadcasterUserId) {
	return `twitch:channel:${broadcasterUserId}`;
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

function assertEnvironmentCallback(callbackUrl, env) {
	if (callbackUrl !== twitchPublicUrl(env, "/twitch")) {
		throw new TwitchEventSubError(
			"The Twitch channel callback does not match this deployment environment.",
			{
				status: 503,
				code: "twitch_eventsub_environment_mismatch"
			}
		);
	}
}

function eventSubServiceStub(env) {
	if (!env.TWITCH_EVENTSUB_SERVICE) {
		throw new TwitchEventSubError("TWITCH_EVENTSUB_SERVICE is not configured.", {
			status: 503,
			code: "twitch_eventsub_not_configured"
		});
	}
	return env.TWITCH_EVENTSUB_SERVICE.get(
		env.TWITCH_EVENTSUB_SERVICE.idFromName(TWITCH_EVENTSUB_SERVICE_NAME)
	);
}

function eventSubCredentials(env, { needsBot = false, needsWebhookSecret = false } = {}) {
	const credentials = {
		clientId: configuredString(env.TWITCH_CLIENT_ID, "TWITCH_CLIENT_ID"),
		clientSecret: configuredString(env.TWITCH_CLIENT_SECRET, "TWITCH_CLIENT_SECRET")
	};
	if (needsBot) {
		credentials.botUserId = configuredString(env.TWITCH_BOT_USER_ID, "TWITCH_BOT_USER_ID");
	}
	if (needsWebhookSecret) {
		credentials.eventSubSecret = configuredString(
			env.TWITCH_EVENTSUB_SECRET,
			"TWITCH_EVENTSUB_SECRET"
		);
		if (
			credentials.eventSubSecret.length < 10 ||
			credentials.eventSubSecret.length > 100
		) {
			throw new TwitchEventSubError(
				"TWITCH_EVENTSUB_SECRET must be between 10 and 100 characters.",
				{ status: 503, code: "twitch_eventsub_not_configured" }
			);
		}
	}
	return credentials;
}

function eventSubServiceRequest(env, path, input) {
	return eventSubServiceStub(env).fetch(`https://twitch-eventsub-service${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input)
	});
}

async function checkedEventSubServiceJson(response, fallbackMessage) {
	let result;
	try {
		result = await response.json();
	} catch (cause) {
		throw new TwitchEventSubError("The EventSub service returned an invalid response.", {
			status: 502,
			code: "twitch_eventsub_invalid_service_response",
			cause
		});
	}
	if (!response.ok) {
		throw new TwitchEventSubError(result?.error || fallbackMessage, {
			status: response.status,
			code: result?.code || "twitch_eventsub_service_failed"
		});
	}
	return result;
}

export async function removeTwitchChatSubscriptions(channel, env) {
	const validated = validateChannelConfig(channel);
	assertEnvironmentCallback(validated.callbackUrl, env);
	return checkedEventSubServiceJson(
		await eventSubServiceRequest(env, "/subscriptions/chat/remove", {
			channel: validated,
			credentials: eventSubCredentials(env, { needsBot: true })
		}),
		"Could not remove Twitch chat subscriptions."
	);
}

export async function ensureTwitchChatSubscription(channel, env) {
	const validated = validateChannelConfig(channel);
	assertEnvironmentCallback(validated.callbackUrl, env);
	return checkedEventSubServiceJson(
		await eventSubServiceRequest(env, "/subscriptions/chat/ensure", {
			channel: validated,
			credentials: eventSubCredentials(env, {
				needsBot: true,
				needsWebhookSecret: true
			})
		}),
		"Could not reconcile the Twitch chat subscription."
	);
}

async function createChatSubscription(request, env) {
	let requestBody;
	try {
		requestBody = await request.json();
	} catch {
		throw new TwitchEventSubError("The request body must be valid JSON.");
	}

	return await createTwitchChatSubscription({
		broadcasterUserId: requestBody?.broadcasterUserId,
		callbackUrl: twitchPublicUrl(env, "/twitch")
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
	assertEnvironmentCallback(parsedCallback.href, env);
	return eventSubServiceRequest(env, "/subscriptions/chat/create", {
		channel: {
			broadcasterUserId,
			callbackUrl: parsedCallback.href
		},
		credentials: eventSubCredentials(env, {
			needsBot: true,
			needsWebhookSecret: true
		})
	});
}

async function listTwitchEventSubSubscriptions(request, env) {
	const requestUrl = new URL(request.url);
	const filters = {};
	for (const name of LIST_QUERY_PARAMETERS) {
		const value = requestUrl.searchParams.get(name);
		if (value) filters[name] = value;
	}
	return eventSubServiceRequest(env, "/subscriptions/list", {
		filters,
		credentials: eventSubCredentials(env)
	});
}

export async function getTwitchEventSubServiceStatus(env) {
	try {
		return await eventSubServiceStub(env).fetch("https://twitch-eventsub-service/status");
	} catch (error) {
		if (error instanceof TwitchEventSubError) {
			return noStoreJson({ error: error.message, code: error.code }, error.status);
		}

		logError("twitch.eventsub_service_status_failed", {
			platform: "twitch",
			correlationId: `twitch-eventsub-service:${crypto.randomUUID()}`,
			groupId: null
		}, error);
		return noStoreJson({ error: "Twitch EventSub service status failed." }, 500);
	}
}

/**
 * Protected management endpoint for the bot's EventSub subscriptions.
 */
export async function handleTwitchEventSubSubscriptions(request, env) {
	try {
		if (request.method === "GET") {
			return await listTwitchEventSubSubscriptions(request, env);
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

export async function claimTwitchEventSubMessage(
	env,
	{ broadcasterUserId, messageId }
) {
	if (
		typeof broadcasterUserId !== "string" ||
		broadcasterUserId.length === 0
	) {
		throw new TwitchEventSubError("The EventSub broadcaster ID is invalid.", {
			status: 400,
			code: "twitch_eventsub_invalid_broadcaster_id"
		});
	}
	validateEventSubMessageId(messageId);

	const response = await managerResponse(
		env,
		broadcasterUserId,
		"/events/claim",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageId })
		}
	);
	let result;
	try {
		result = await response.json();
	} catch (cause) {
		throw new TwitchEventSubError(
			"The EventSub message claim returned an invalid response.",
			{
				status: 502,
				code: "twitch_eventsub_message_claim_invalid_response",
				cause
			}
		);
	}
	if (!response.ok || typeof result.claimed !== "boolean") {
		throw new TwitchEventSubError(
			result.error || "Could not claim the EventSub message.",
			{
				status: response.ok ? 502 : response.status,
				code: result.code || "twitch_eventsub_message_claim_failed"
			}
		);
	}
	return result.claimed;
}

async function managerResponse(env, broadcasterUserId, path, init) {
	if (!env.TWITCH_EVENTSUB_MANAGER) {
		throw new TwitchEventSubError("TWITCH_EVENTSUB_MANAGER is not configured.", {
			status: 503,
			code: "twitch_eventsub_not_configured"
		});
	}
	return recoveryStub(env, broadcasterUserId).fetch(
		`https://twitch-eventsub-manager${path}`,
		init
	);
}

export async function putTwitchChannelDesiredState(env, channel) {
	const validated = validateChannelConfig(channel);
	const response = await managerResponse(env, validated.broadcasterUserId, "/configure", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(validated)
	});
	if (response.ok) {
		await registerTwitchChannel(env, {
			...validated,
			login: channel.login
		});
	}
	return response;
}

export async function deconfigureTwitchChannelDesiredState(
	env,
	channel,
	{ unregister = false } = {}
) {
	const validated = validateChannelConfig(channel);
	const response = await managerResponse(env, validated.broadcasterUserId, "/deconfigure", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(validated)
	});
	if (response.ok && unregister) {
		await unregisterTwitchChannel(env, validated.broadcasterUserId);
	}
	return response;
}

async function configureTwitchChannel(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		throw new TwitchEventSubError("The request body must be valid JSON.");
	}
	const channel = validateChannelConfig({
		broadcasterUserId: body?.broadcasterUserId,
		callbackUrl: twitchPublicUrl(env, "/twitch"),
		authorizationMode: body?.authorizationMode
	});
	return putTwitchChannelDesiredState(env, channel);
}

async function deconfigureTwitchChannel(request, env) {
	const broadcasterUserId = new URL(request.url).searchParams.get("broadcasterUserId");
	if (typeof broadcasterUserId !== "string" || broadcasterUserId.length === 0) {
		throw new TwitchEventSubError("broadcasterUserId is required.");
	}
	return deconfigureTwitchChannelDesiredState(env, {
		broadcasterUserId,
		callbackUrl: twitchPublicUrl(env, "/twitch")
	}, { unregister: true });
}

async function getTwitchChannelConfiguration(request, env) {
	const broadcasterUserId = new URL(request.url).searchParams.get("broadcasterUserId");
	if (typeof broadcasterUserId !== "string" || broadcasterUserId.length === 0) {
		throw new TwitchEventSubError("broadcasterUserId is required.");
	}
	return managerResponse(env, broadcasterUserId, "/status", { method: "GET" });
}

export async function handleTwitchChannelConfiguration(request, env) {
	try {
		if (request.method === "POST") {
			return await configureTwitchChannel(request, env);
		}
		if (request.method === "GET") {
			return await getTwitchChannelConfiguration(request, env);
		}
		if (request.method === "DELETE") {
			return await deconfigureTwitchChannel(request, env);
		}
		return new Response("Method Not Allowed", { status: 405 });
	} catch (error) {
		if (error instanceof TwitchEventSubError) {
			return noStoreJson({ error: error.message, code: error.code }, error.status);
		}
		logError("twitch.channel_configuration_failed", {
			platform: "twitch",
			correlationId: `twitch-channel-config:${crypto.randomUUID()}`,
			groupId: null
		}, error);
		return noStoreJson({ error: "Twitch channel configuration failed." }, 500);
	}
}
