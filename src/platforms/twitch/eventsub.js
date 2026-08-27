import {
	jsonResponse,
	logError
} from "../../common.js";
import { twitchPublicUrl } from "./environment.js";
import {
	registerTwitchChannel,
	unregisterTwitchChannel
} from "./channel-registry.js";
import { TWITCH_EVENTSUB_SERVICE_NAME } from "./eventsub-service.js";

const LIST_QUERY_PARAMETERS = Object.freeze([
	"status",
	"type",
	"user_id",
	"subscription_id",
	"conduit_id",
	"after"
]);
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
const EVENTSUB_MESSAGE_TTL_MS = 60 * 60 * 1000;
const MAX_EVENTSUB_MESSAGE_ID_LENGTH = 512;
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

function initializeEventSubManagerTables(state) {
	state.storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS eventsub_seen_messages (
			message_id TEXT PRIMARY KEY,
			seen_at_ms INTEGER NOT NULL,
			expires_at_ms INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS eventsub_seen_messages_expiry
			ON eventsub_seen_messages (expires_at_ms);
	`);
}

function validateEventSubMessageId(messageId) {
	if (
		typeof messageId !== "string" ||
		messageId.length === 0 ||
		messageId.length > MAX_EVENTSUB_MESSAGE_ID_LENGTH
	) {
		throw new TwitchEventSubError("The EventSub message ID is invalid.", {
			status: 400,
			code: "twitch_eventsub_invalid_message_id"
		});
	}
	return messageId;
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

async function removeTwitchChatSubscriptions(channel, env) {
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

export class TwitchEventSubManager {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		initializeEventSubManagerTables(state);
	}

	claimMessage(messageId) {
		const validated = validateEventSubMessageId(messageId);
		const nowMs = Date.now();
		return this.state.storage.transactionSync(() => {
			this.pruneSeenMessages(nowMs);
			const existing = this.state.storage.sql.exec(
				"SELECT 1 AS seen FROM eventsub_seen_messages WHERE message_id = ?",
				validated
			).toArray()[0];
			if (existing) return false;

			this.state.storage.sql.exec(
				`INSERT INTO eventsub_seen_messages
					(message_id, seen_at_ms, expires_at_ms)
				 VALUES (?, ?, ?)`,
				validated,
				nowMs,
				nowMs + EVENTSUB_MESSAGE_TTL_MS
			);
			return true;
		});
	}

	pruneSeenMessages(nowMs = Date.now()) {
		this.state.storage.sql.exec(
			"DELETE FROM eventsub_seen_messages WHERE expires_at_ms <= ?",
			nowMs
		);
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
		this.pruneSeenMessages();
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
			await registerTwitchChannel(this.env, target);
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
			if (request.method === "POST" && url.pathname === "/events/claim") {
				const input = await request.json();
				return noStoreJson({ claimed: this.claimMessage(input?.messageId) });
			}
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
