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
const CHANNEL_CONFIG_KEY = "channelConfig";
export const TWITCH_CHANNEL_AUTHORIZATION_MODES = Object.freeze([
	"moderator",
	"broadcaster_oauth"
]);
const RECOVERY_INITIAL_DELAY_MS = 1000;
const RECONCILIATION_INITIAL_DELAY_MS = 60 * 1000;
const RECONCILIATION_INTERVAL_MS = 55 * 60 * 1000;
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

function validateChannelConfig(channel) {
	if (
		typeof channel?.broadcasterUserId !== "string" ||
		channel.broadcasterUserId.length === 0 ||
		typeof channel.callbackUrl !== "string" ||
		channel.callbackUrl.length === 0
	) {
		throw new TwitchEventSubError("The Twitch channel configuration is invalid.");
	}

	let callback;
	try {
		callback = new URL(channel.callbackUrl);
	} catch {
		throw new TwitchEventSubError("The Twitch channel callback is invalid.");
	}
	if (callback.protocol !== "https:" || callback.pathname !== "/twitch") {
		throw new TwitchEventSubError("The Twitch channel callback is invalid.");
	}
	const authorizationMode = channel.authorizationMode ?? "moderator";
	if (!TWITCH_CHANNEL_AUTHORIZATION_MODES.includes(authorizationMode)) {
		throw new TwitchEventSubError("The Twitch channel authorization mode is invalid.");
	}

	return {
		broadcasterUserId: channel.broadcasterUserId,
		callbackUrl: callback.href,
		authorizationMode
	};
}

async function matchingTwitchChatSubscriptions(channel, env) {
	const clientId = configuredString(env.TWITCH_CLIENT_ID, "TWITCH_CLIENT_ID");
	const clientSecret = configuredString(env.TWITCH_CLIENT_SECRET, "TWITCH_CLIENT_SECRET");
	const botUserId = configuredString(env.TWITCH_BOT_USER_ID, "TWITCH_BOT_USER_ID");
	const accessToken = await getTwitchAppAccessToken(clientId, clientSecret);
	const subscriptions = [];
	let cursor = null;

	for (let page = 0; page < 100; page++) {
		const url = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
		url.searchParams.set("type", "channel.chat.message");
		if (cursor) url.searchParams.set("after", cursor);

		const response = await twitchEventSubRequest({
			method: "GET",
			url: url.href,
			clientId,
			accessToken
		});
		if (!response.ok) {
			await response.text();
			throw new TwitchEventSubError(
				`Twitch rejected EventSub reconciliation with status ${response.status}.`,
				{
					status: 502,
					code: "twitch_eventsub_reconciliation_rejected"
				}
			);
		}

		let result;
		try {
			result = await response.json();
		} catch (cause) {
			throw new TwitchEventSubError("Twitch returned an invalid EventSub list.", {
				status: 502,
				code: "twitch_eventsub_invalid_list_response",
				cause
			});
		}
		if (!Array.isArray(result.data)) {
			throw new TwitchEventSubError("Twitch returned an invalid EventSub list.", {
				status: 502,
				code: "twitch_eventsub_invalid_list_response"
			});
		}

		subscriptions.push(...result.data.filter((subscription) =>
			subscription?.condition?.broadcaster_user_id === channel.broadcasterUserId &&
			subscription?.condition?.user_id === botUserId
		));
		cursor = result.pagination?.cursor;
		if (typeof cursor !== "string" || cursor.length === 0) break;
	}

	return { subscriptions, clientId, accessToken };
}

async function deleteTwitchEventSubSubscription(id, clientId, accessToken) {
	const url = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
	url.searchParams.set("id", id);
	const response = await twitchEventSubRequest({
		method: "DELETE",
		url: url.href,
		clientId,
		accessToken
	});
	if (response.status !== 204) {
		await response.text();
		throw new TwitchEventSubError(
			`Twitch rejected stale subscription removal with status ${response.status}.`,
			{
				status: 502,
				code: "twitch_eventsub_delete_rejected"
			}
		);
	}
}

async function removeTwitchChatSubscriptions(channel, env) {
	const validated = validateChannelConfig(channel);
	const {
		subscriptions,
		clientId,
		accessToken
	} = await matchingTwitchChatSubscriptions(validated, env);

	let removedSubscriptions = 0;
	for (const subscription of subscriptions) {
		if (typeof subscription?.id === "string" && subscription.id.length > 0) {
			await deleteTwitchEventSubSubscription(
				subscription.id,
				clientId,
				accessToken
			);
			removedSubscriptions += 1;
		}
	}

	return { removedSubscriptions };
}

export async function ensureTwitchChatSubscription(channel, env) {
	const validated = validateChannelConfig(channel);
	const {
		subscriptions,
		clientId,
		accessToken
	} = await matchingTwitchChatSubscriptions(validated, env);
	const healthy = subscriptions.find((subscription) =>
		subscription?.transport?.method === "webhook" &&
		subscription?.transport?.callback === validated.callbackUrl &&
		["enabled", "webhook_callback_verification_pending"].includes(subscription.status)
	);
	if (healthy) {
		return {
			result: "existing",
			subscriptionId: healthy.id ?? null,
			status: healthy.status
		};
	}

	for (const subscription of subscriptions) {
		if (typeof subscription?.id === "string" && subscription.id.length > 0) {
			await deleteTwitchEventSubSubscription(
				subscription.id,
				clientId,
				accessToken
			);
		}
	}

	const response = await createTwitchChatSubscription(validated, env);
	if (response.status === 409) {
		await response.text();
		return {
			result: "already_exists",
			subscriptionId: null,
			status: "unknown"
		};
	}
	if (response.status !== 202) {
		await response.text();
		const error = new TwitchEventSubError(
			`Twitch rejected EventSub creation with status ${response.status}.`,
			{
				status: 502,
				code: "twitch_eventsub_create_rejected"
			}
		);
		error.twitchStatus = response.status;
		throw error;
	}

	let result;
	try {
		result = await response.json();
	} catch {
		result = null;
	}
	return {
		result: "created",
		subscriptionId: result?.data?.[0]?.id ?? null,
		status: result?.data?.[0]?.status ?? "webhook_callback_verification_pending"
	};
}

async function createChatSubscription(request, env) {
	let requestBody;
	try {
		requestBody = await request.json();
	} catch {
		throw new TwitchEventSubError("The request body must be valid JSON.");
	}

	const requestUrl = new URL(request.url);
	return await createTwitchChatSubscription({
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
	const channel = validateChannelConfig(recovery);
	if (recovery.reason !== RECOVERABLE_EVENTSUB_STATUS) {
		throw new TwitchEventSubError("The EventSub recovery request is invalid.");
	}

	return {
		...channel,
		reason: recovery.reason,
		sourceSubscriptionId:
			typeof recovery.sourceSubscriptionId === "string"
				? recovery.sourceSubscriptionId
				: null,
		attempts: 0,
		queuedAtMs: Date.now()
	};
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

async function configureTwitchChannel(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		throw new TwitchEventSubError("The request body must be valid JSON.");
	}
	const requestUrl = new URL(request.url);
	const channel = validateChannelConfig({
		broadcasterUserId: body?.broadcasterUserId,
		callbackUrl: `${requestUrl.origin}/twitch`,
		authorizationMode: body?.authorizationMode
	});
	return managerResponse(env, channel.broadcasterUserId, "/configure", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(channel)
	});
}

async function deconfigureTwitchChannel(request, env) {
	const requestUrl = new URL(request.url);
	const broadcasterUserId = requestUrl.searchParams.get("broadcasterUserId");
	if (typeof broadcasterUserId !== "string" || broadcasterUserId.length === 0) {
		throw new TwitchEventSubError("broadcasterUserId is required.");
	}
	return managerResponse(env, broadcasterUserId, "/deconfigure", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			broadcasterUserId,
			callbackUrl: `${requestUrl.origin}/twitch`
		})
	});
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

export class TwitchEventSubManager {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async configureChannel(channel) {
		const validated = validateChannelConfig(channel);
		const existing = await this.state.storage.get(CHANNEL_CONFIG_KEY);
		const configured = {
			...existing,
			...validated,
			enabled: true,
			configuredAtMs:
				existing?.enabled === false || !existing?.configuredAtMs
					? Date.now()
					: existing.configuredAtMs,
			lastResult: existing?.enabled === false
				? "pending"
				: existing?.lastResult ?? "pending",
			consecutiveFailures: existing?.enabled === false
				? 0
				: existing?.consecutiveFailures ?? 0
		};
		delete configured.deconfiguredAtMs;
		delete configured.removedSubscriptions;
		await this.state.storage.put(CHANNEL_CONFIG_KEY, configured);
		await this.state.storage.setAlarm(Date.now() + RECONCILIATION_INITIAL_DELAY_MS);
		return configured;
	}

	async deconfigureChannel(channel) {
		const validated = validateChannelConfig(channel);
		const existing = await this.state.storage.get(CHANNEL_CONFIG_KEY);
		const deconfigured = {
			...existing,
			...validated,
			authorizationMode:
				existing?.authorizationMode ?? validated.authorizationMode,
			enabled: false,
			configuredAtMs: existing?.configuredAtMs ?? null,
			deconfiguredAtMs: Date.now(),
			lastResult: "deconfiguration_pending",
			consecutiveFailures: 0
		};
		await this.state.storage.put(CHANNEL_CONFIG_KEY, deconfigured);
		await this.state.storage.delete(RECOVERY_KEY);
		await this.state.storage.setAlarm(Date.now() + RECOVERY_INITIAL_DELAY_MS);
		return deconfigured;
	}

	async queueRecovery(recovery) {
		const validated = validateRecovery(recovery);
		const [existingRecovery, existingConfig] = await Promise.all([
			this.state.storage.get(RECOVERY_KEY),
			this.state.storage.get(CHANNEL_CONFIG_KEY)
		]);
		if (existingConfig?.enabled === false) return false;
		await this.state.storage.put(CHANNEL_CONFIG_KEY, {
			...existingConfig,
			broadcasterUserId: validated.broadcasterUserId,
			callbackUrl: validated.callbackUrl,
			authorizationMode:
				existingConfig?.authorizationMode ?? validated.authorizationMode,
			enabled: true,
			configuredAtMs: existingConfig?.configuredAtMs ?? Date.now(),
			lastResult: existingConfig?.lastResult ?? "recovery_queued",
			consecutiveFailures: existingConfig?.consecutiveFailures ?? 0
		});
		if (
			existingRecovery?.sourceSubscriptionId &&
			existingRecovery.sourceSubscriptionId === validated.sourceSubscriptionId
		) {
			return true;
		}

		await this.state.storage.put(RECOVERY_KEY, validated);
		await this.state.storage.setAlarm(Date.now() + RECOVERY_INITIAL_DELAY_MS);
		return true;
	}

	async alarm() {
		const [recovery, channel] = await Promise.all([
			this.state.storage.get(RECOVERY_KEY),
			this.state.storage.get(CHANNEL_CONFIG_KEY)
		]);
		const target = channel ?? recovery;
		if (!target) return;

		try {
			if (channel?.enabled === false) {
				const result = await removeTwitchChatSubscriptions(channel, this.env);
				const nowMs = Date.now();
				await this.state.storage.put(CHANNEL_CONFIG_KEY, {
					...channel,
					authorizationMode: channel.authorizationMode ?? "moderator",
					lastReconciledAtMs: nowMs,
					lastResult: "deconfigured",
					removedSubscriptions: result.removedSubscriptions,
					consecutiveFailures: 0
				});
				await this.state.storage.delete(RECOVERY_KEY);
				await this.state.storage.deleteAlarm();
				return;
			}

			const result = await ensureTwitchChatSubscription(target, this.env);
			const nowMs = Date.now();
			await this.state.storage.put(CHANNEL_CONFIG_KEY, {
				...target,
				authorizationMode: target.authorizationMode ?? "moderator",
				enabled: true,
				lastReconciledAtMs: nowMs,
				lastResult: result.result,
				lastSubscriptionId: result.subscriptionId,
				lastSubscriptionStatus: result.status,
				consecutiveFailures: 0
			});
			if (recovery) {
				await this.state.storage.delete(RECOVERY_KEY);
				console.log(JSON.stringify({
					level: "info",
					event: "twitch.eventsub_recovered",
					platform: "twitch",
					groupId: target.broadcasterUserId,
					sourceSubscriptionId: recovery.sourceSubscriptionId,
					result: result.result
				}));
			}
			await this.state.storage.setAlarm(nowMs + RECONCILIATION_INTERVAL_MS);
		} catch (error) {
			const attempts = recovery
				? (recovery.attempts ?? 0) + 1
				: (channel?.consecutiveFailures ?? 0) + 1;
			const delayMs = RECOVERY_RETRY_DELAYS_MS[
				Math.min(attempts - 1, RECOVERY_RETRY_DELAYS_MS.length - 1)
			];
			if (recovery) {
				await this.state.storage.put(RECOVERY_KEY, {
					...recovery,
					attempts,
					lastAttemptAtMs: Date.now()
				});
			}
			if (channel) {
				await this.state.storage.put(CHANNEL_CONFIG_KEY, {
					...channel,
					lastReconciledAtMs: Date.now(),
					lastResult: "error",
					consecutiveFailures: attempts
				});
			}
			await this.state.storage.setAlarm(Date.now() + delayMs);
			logError("twitch.eventsub_reconciliation_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-reconciliation:${crypto.randomUUID()}`,
				groupId: target.broadcasterUserId,
				sourceSubscriptionId: recovery?.sourceSubscriptionId ?? null,
				attempts,
				nextRetryInMs: delayMs
			}, error);
		}
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/recover") {
				const queued = await this.queueRecovery(await request.json());
				return noStoreJson({ queued }, 202);
			}
			if (request.method === "POST" && url.pathname === "/configure") {
				return noStoreJson({
					configured: true,
					channel: await this.configureChannel(await request.json())
				}, 202);
			}
			if (request.method === "POST" && url.pathname === "/deconfigure") {
				return noStoreJson({
					configured: false,
					channel: await this.deconfigureChannel(await request.json())
				}, 202);
			}
			if (request.method === "GET" && url.pathname === "/status") {
				const [channel, recovery, alarmAtMs] = await Promise.all([
					this.state.storage.get(CHANNEL_CONFIG_KEY),
					this.state.storage.get(RECOVERY_KEY),
					this.state.storage.getAlarm()
				]);
				return noStoreJson({
					configured: Boolean(channel && channel.enabled !== false),
					channel: channel
						? {
							...channel,
							authorizationMode: channel.authorizationMode ?? "moderator",
							enabled: channel.enabled !== false
						}
						: null,
					recovery: recovery
						? {
							reason: recovery.reason,
							attempts: recovery.attempts,
							queuedAtMs: recovery.queuedAtMs
						}
						: null,
					alarmAtMs
				});
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchEventSubError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			logError("twitch.eventsub_manager_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-manager:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Twitch EventSub management failed." }, 500);
		}
	}
}
