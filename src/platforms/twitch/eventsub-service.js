import {
	jsonResponse,
	logError,
	withExternalRequestTimeout
} from "../../common.js";

export const TWITCH_EVENTSUB_SERVICE_NAME = "twitch:eventsub-service";

const APP_TOKEN_KEY = "appAccessToken";
const APP_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const EVENTSUB_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const APP_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const MAX_LIST_PAGES = 100;
const LIST_FILTER_NAMES = Object.freeze([
	"status",
	"type",
	"user_id",
	"subscription_id",
	"conduit_id"
]);
const HEALTHY_SUBSCRIPTION_STATUSES = new Set([
	"enabled",
	"webhook_callback_verification_pending"
]);

class TwitchEventSubServiceError extends Error {
	constructor(message, { status = 400, code = "twitch_eventsub_service_error", cause } = {}) {
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

function requiredString(value, name) {
	if (typeof value !== "string" || value.length === 0) {
		throw new TwitchEventSubServiceError(`${name} is not configured.`, {
			status: 503,
			code: "twitch_eventsub_not_configured"
		});
	}
	return value;
}

function validateCredentials(input, { needsBot = false, needsWebhookSecret = false } = {}) {
	const credentials = {
		clientId: requiredString(input?.clientId, "TWITCH_CLIENT_ID"),
		clientSecret: requiredString(input?.clientSecret, "TWITCH_CLIENT_SECRET")
	};
	if (needsBot) {
		credentials.botUserId = requiredString(input?.botUserId, "TWITCH_BOT_USER_ID");
	}
	if (needsWebhookSecret) {
		credentials.eventSubSecret = requiredString(
			input?.eventSubSecret,
			"TWITCH_EVENTSUB_SECRET"
		);
		if (
			credentials.eventSubSecret.length < 10 ||
			credentials.eventSubSecret.length > 100
		) {
			throw new TwitchEventSubServiceError(
				"TWITCH_EVENTSUB_SECRET must be between 10 and 100 characters.",
				{ status: 503, code: "twitch_eventsub_not_configured" }
			);
		}
	}
	return credentials;
}

function validateChannel(input) {
	if (
		typeof input?.broadcasterUserId !== "string" ||
		input.broadcasterUserId.length === 0
	) {
		throw new TwitchEventSubServiceError("broadcasterUserId is required.");
	}
	let callback;
	try {
		callback = new URL(input.callbackUrl);
	} catch {
		throw new TwitchEventSubServiceError("The EventSub callback is invalid.", {
			status: 503,
			code: "twitch_eventsub_invalid_callback"
		});
	}
	if (callback.protocol !== "https:" || callback.pathname !== "/twitch") {
		throw new TwitchEventSubServiceError(
			"The EventSub callback must be HTTPS and end in /twitch.",
			{ status: 503, code: "twitch_eventsub_invalid_callback" }
		);
	}
	return {
		broadcasterUserId: input.broadcasterUserId,
		callbackUrl: callback.href
	};
}

async function requestAppAccessToken(credentials) {
	let response;
	try {
		response = await fetch(
			APP_TOKEN_URL,
			withExternalRequestTimeout({
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: credentials.clientId,
					client_secret: credentials.clientSecret,
					grant_type: "client_credentials"
				})
			})
		);
	} catch (cause) {
		throw new TwitchEventSubServiceError("Twitch app authentication was unavailable.", {
			status: 502,
			code: "twitch_eventsub_auth_network_error",
			cause
		});
	}
	if (!response.ok) {
		await response.text();
		throw new TwitchEventSubServiceError("Twitch rejected the application credentials.", {
			status: 502,
			code: "twitch_eventsub_auth_rejected"
		});
	}
	let token;
	try {
		token = await response.json();
	} catch (cause) {
		throw new TwitchEventSubServiceError("Twitch returned an invalid app-token response.", {
			status: 502,
			code: "twitch_eventsub_invalid_auth_response",
			cause
		});
	}
	if (
		typeof token.access_token !== "string" ||
		token.access_token.length === 0 ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0
	) {
		throw new TwitchEventSubServiceError("Twitch returned an invalid app-token response.", {
			status: 502,
			code: "twitch_eventsub_invalid_auth_response"
		});
	}
	const nowMs = Date.now();
	return {
		accessToken: token.access_token,
		clientId: credentials.clientId,
		obtainedAtMs: nowMs,
		expiresAtMs: nowMs + token.expires_in * 1000
	};
}

async function rawEventSubRequest({ method, url, clientId, accessToken, body }) {
	try {
		return await fetch(
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
		throw new TwitchEventSubServiceError("Twitch EventSub was unavailable.", {
			status: 502,
			code: "twitch_eventsub_network_error",
			cause
		});
	}
}

function cloneExternalResponse(response, bodyText) {
	return new Response(bodyText, {
		status: response.status,
		headers: {
			"cache-control": "no-store",
			"content-type": response.headers.get("content-type") ??
				"application/json; charset=utf-8"
		}
	});
}

function createSubscriptionBody(channel, credentials) {
	return {
		type: "channel.chat.message",
		version: "1",
		condition: {
			broadcaster_user_id: channel.broadcasterUserId,
			user_id: credentials.botUserId
		},
		transport: {
			method: "webhook",
			callback: channel.callbackUrl,
			secret: credentials.eventSubSecret
		}
	};
}

export class TwitchEventSubService {
	constructor(state) {
		this.state = state;
		this.tokenPromise = null;
		this.channelOperations = new Map();
	}

	async getAppAccessToken(credentials, rejectedToken = null) {
		for (;;) {
			const cached = await this.state.storage.get(APP_TOKEN_KEY);
			if (
				cached?.clientId === credentials.clientId &&
				cached.accessToken !== rejectedToken &&
				Number.isFinite(cached.expiresAtMs) &&
				cached.expiresAtMs - Date.now() > APP_TOKEN_REFRESH_BUFFER_MS
			) {
				return cached.accessToken;
			}
			if (this.tokenPromise) {
				await this.tokenPromise;
				continue;
			}
			this.tokenPromise = (async () => {
				const token = await requestAppAccessToken(credentials);
				await this.state.storage.put(APP_TOKEN_KEY, token);
				return token.accessToken;
			})();
			try {
				return await this.tokenPromise;
			} finally {
				this.tokenPromise = null;
			}
		}
	}

	async invalidateAppAccessToken(accessToken) {
		const cached = await this.state.storage.get(APP_TOKEN_KEY);
		if (cached?.accessToken === accessToken) {
			await this.state.storage.delete(APP_TOKEN_KEY);
		}
	}

	async eventSubRequest(credentials, request) {
		let accessToken = await this.getAppAccessToken(credentials);
		let response = await rawEventSubRequest({
			...request,
			clientId: credentials.clientId,
			accessToken
		});
		if (response.status === 401) {
			await response.text();
			await this.invalidateAppAccessToken(accessToken);
			accessToken = await this.getAppAccessToken(credentials, accessToken);
			response = await rawEventSubRequest({
				...request,
				clientId: credentials.clientId,
				accessToken
			});
		}
		return response;
	}

	async withChannelOperation(broadcasterUserId, operation) {
		const previous = this.channelOperations.get(broadcasterUserId) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(operation);
		this.channelOperations.set(broadcasterUserId, current);
		try {
			return await current;
		} finally {
			if (this.channelOperations.get(broadcasterUserId) === current) {
				this.channelOperations.delete(broadcasterUserId);
			}
		}
	}

	async listSubscriptions(credentials, filters = {}) {
		const appliedFilters = LIST_FILTER_NAMES.filter((name) =>
			typeof filters[name] === "string" && filters[name].length > 0
		);
		if (appliedFilters.length > 1) {
			throw new TwitchEventSubServiceError(
				"EventSub subscription filters are mutually exclusive."
			);
		}
		const url = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
		for (const name of [
			...LIST_FILTER_NAMES,
			"after"
		]) {
			if (typeof filters[name] === "string" && filters[name].length > 0) {
				url.searchParams.set(name, filters[name]);
			}
		}
		return this.eventSubRequest(credentials, { method: "GET", url: url.href });
	}

	async matchingChatSubscriptions(channel, credentials) {
		const subscriptions = [];
		let cursor = null;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const response = await this.listSubscriptions(credentials, {
				user_id: channel.broadcasterUserId,
				...(cursor ? { after: cursor } : {})
			});
			if (!response.ok) {
				await response.text();
				throw new TwitchEventSubServiceError(
					`Twitch rejected EventSub reconciliation with status ${response.status}.`,
					{ status: 502, code: "twitch_eventsub_reconciliation_rejected" }
				);
			}
			let result;
			try {
				result = await response.json();
			} catch (cause) {
				throw new TwitchEventSubServiceError("Twitch returned an invalid EventSub list.", {
					status: 502,
					code: "twitch_eventsub_invalid_list_response",
					cause
				});
			}
			if (!Array.isArray(result.data)) {
				throw new TwitchEventSubServiceError("Twitch returned an invalid EventSub list.", {
					status: 502,
					code: "twitch_eventsub_invalid_list_response"
				});
			}
			subscriptions.push(...result.data.filter((subscription) =>
				subscription?.type === "channel.chat.message" &&
				subscription?.condition?.broadcaster_user_id === channel.broadcasterUserId &&
				subscription?.condition?.user_id === credentials.botUserId
			));
			cursor = result.pagination?.cursor;
			if (typeof cursor !== "string" || cursor.length === 0) return subscriptions;
		}
		throw new TwitchEventSubServiceError("Twitch EventSub pagination exceeded its safety limit.", {
			status: 502,
			code: "twitch_eventsub_pagination_limit"
		});
	}

	async deleteSubscription(id, credentials) {
		const url = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
		url.searchParams.set("id", id);
		const response = await this.eventSubRequest(credentials, {
			method: "DELETE",
			url: url.href
		});
		if (response.status !== 204) {
			await response.text();
			throw new TwitchEventSubServiceError(
				`Twitch rejected stale subscription removal with status ${response.status}.`,
				{ status: 502, code: "twitch_eventsub_delete_rejected" }
			);
		}
	}

	async createChatSubscription(channel, credentials) {
		return this.eventSubRequest(credentials, {
			method: "POST",
			url: EVENTSUB_SUBSCRIPTIONS_URL,
			body: createSubscriptionBody(channel, credentials)
		});
	}

	async removeChatSubscriptions(channel, credentials) {
		return this.withChannelOperation(channel.broadcasterUserId, async () => {
			const subscriptions = await this.matchingChatSubscriptions(channel, credentials);
			let removedSubscriptions = 0;
			for (const subscription of subscriptions) {
				if (typeof subscription?.id === "string" && subscription.id.length > 0) {
					await this.deleteSubscription(subscription.id, credentials);
					removedSubscriptions += 1;
				}
			}
			return { removedSubscriptions };
		});
	}

	async ensureChatSubscription(channel, credentials) {
		return this.withChannelOperation(channel.broadcasterUserId, async () => {
			const subscriptions = await this.matchingChatSubscriptions(channel, credentials);
			const healthy = subscriptions.find((subscription) =>
				subscription?.transport?.method === "webhook" &&
				subscription?.transport?.callback === channel.callbackUrl &&
				HEALTHY_SUBSCRIPTION_STATUSES.has(subscription.status)
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
					await this.deleteSubscription(subscription.id, credentials);
				}
			}
			const response = await this.createChatSubscription(channel, credentials);
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
				throw new TwitchEventSubServiceError(
					`Twitch rejected EventSub creation with status ${response.status}.`,
					{ status: 502, code: "twitch_eventsub_create_rejected" }
				);
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
				status: result?.data?.[0]?.status ??
					"webhook_callback_verification_pending"
			};
		});
	}

	async status() {
		const token = await this.state.storage.get(APP_TOKEN_KEY);
		return {
			cached: Boolean(token),
			usable: Boolean(
				token &&
				Number.isFinite(token.expiresAtMs) &&
				token.expiresAtMs - Date.now() > APP_TOKEN_REFRESH_BUFFER_MS
			),
			clientId: token?.clientId ?? null,
			obtainedAtMs: token?.obtainedAtMs ?? null,
			expiresAtMs: token?.expiresAtMs ?? null
		};
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/status") {
				return noStoreJson(await this.status());
			}
			if (request.method !== "POST") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			const input = await request.json();
			if (url.pathname === "/subscriptions/list") {
				const credentials = validateCredentials(input?.credentials);
				const response = await this.listSubscriptions(credentials, input?.filters);
				return cloneExternalResponse(response, await response.text());
			}
			const channel = validateChannel(input?.channel);
			if (url.pathname === "/subscriptions/chat/remove") {
				const credentials = validateCredentials(input?.credentials, { needsBot: true });
				return noStoreJson(await this.removeChatSubscriptions(channel, credentials));
			}
			const credentials = validateCredentials(input?.credentials, {
				needsBot: true,
				needsWebhookSecret: true
			});
			if (url.pathname === "/subscriptions/chat/create") {
				return this.withChannelOperation(channel.broadcasterUserId, async () => {
					const response = await this.createChatSubscription(channel, credentials);
					return cloneExternalResponse(response, await response.text());
				});
			}
			if (url.pathname === "/subscriptions/chat/ensure") {
				return noStoreJson(await this.ensureChatSubscription(channel, credentials));
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchEventSubServiceError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			logError("twitch.eventsub_service_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-service:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Twitch EventSub service failed." }, 500);
		}
	}
}
