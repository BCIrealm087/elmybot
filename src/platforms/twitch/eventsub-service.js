import {
	jsonResponse,
	logError,
	withExternalRequestTimeout
} from "../../common.js";
import {
	getTwitchAppAccessToken,
	handleTwitchAppAuthStatus
} from "./app-auth.js";
import {
	requireTwitchEventSubDefinition,
	TwitchEventSubRegistryError
} from "./eventsub-registry.js";

export const TWITCH_EVENTSUB_SERVICE_NAME = "twitch:eventsub-service";

const EVENTSUB_SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const MAX_LIST_PAGES = 5;
const MAX_RECONCILIATION_MUTATIONS = 10;
const RECONCILIATION_TIME_BUDGET_MS = 5_000;
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

function createReconciliationBudget() {
	return {
		startedAtMs: Date.now(),
		operations: 0,
		mutations: 0
	};
}

async function startReconciliationOperation(budget) {
	if (!budget) return;
	if (
		budget.operations > 0 &&
		Date.now() - budget.startedAtMs >= RECONCILIATION_TIME_BUDGET_MS
	) {
		throw new TwitchEventSubServiceError(
			"Twitch EventSub reconciliation exceeded its time budget.",
			{ status: 502, code: "twitch_eventsub_reconciliation_time_budget" }
		);
	}
	budget.operations += 1;
}

async function claimReconciliationMutation(budget) {
	if (budget.mutations >= MAX_RECONCILIATION_MUTATIONS) {
		throw new TwitchEventSubServiceError(
			"Twitch EventSub reconciliation exceeded its mutation limit.",
			{ status: 502, code: "twitch_eventsub_reconciliation_mutation_limit" }
		);
	}
	budget.mutations += 1;
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

function selectedDefinitions(registry, kinds) {
	if (!Array.isArray(kinds) || kinds.length === 0) {
		throw new TwitchEventSubServiceError(
			"At least one EventSub definition kind is required."
		);
	}
	try {
		return kinds.map((kind) => requireTwitchEventSubDefinition(registry, kind));
	} catch (cause) {
		if (cause instanceof TwitchEventSubRegistryError) {
			throw new TwitchEventSubServiceError(cause.message, {
				status: 422,
				code: "twitch_eventsub_definition_unsupported",
				cause
			});
		}
		throw cause;
	}
}

function definitionCondition(definition, channel, credentials) {
	const condition = definition.condition({ channel, credentials });
	if (
		typeof condition !== "object" ||
		condition === null ||
		Array.isArray(condition) ||
		condition.broadcaster_user_id !== channel.broadcasterUserId
	) {
		throw new TwitchEventSubServiceError(
			`EventSub definition \`${definition.kind}\` returned an invalid condition.`,
			{ status: 500, code: "twitch_eventsub_definition_invalid" }
		);
	}
	if (
		definition.needsBotUserId &&
		condition.user_id !== credentials.botUserId
	) {
		throw new TwitchEventSubServiceError(
			`EventSub definition \`${definition.kind}\` did not bind the bot user.`,
			{ status: 500, code: "twitch_eventsub_definition_invalid" }
		);
	}
	return condition;
}

function sameCondition(left, right) {
	const leftKeys = Object.keys(left ?? {}).sort();
	const rightKeys = Object.keys(right ?? {}).sort();
	return leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) =>
			key === rightKeys[index] && left[key] === right[key]
		);
}

function createSubscriptionBody(definition, channel, credentials) {
	return {
		type: definition.type,
		version: definition.version,
		condition: definitionCondition(definition, channel, credentials),
		transport: {
			method: "webhook",
			callback: channel.callbackUrl,
			secret: credentials.eventSubSecret
		}
	};
}

export class TwitchEventSubServiceBackend {
	constructor(_state, env, registry) {
		this.env = env;
		this.registry = registry;
		this.channelOperations = new Map();
	}

	async appAccessToken(credentials, rejectedAccessToken = null) {
		try {
			return await getTwitchAppAccessToken({
				...this.env,
				TWITCH_CLIENT_ID: credentials.clientId,
				TWITCH_CLIENT_SECRET: credentials.clientSecret
			}, rejectedAccessToken);
		} catch (cause) {
			throw new TwitchEventSubServiceError(cause.message, {
				status: cause.status ?? 502,
				code: cause.code ?? "twitch_eventsub_auth_failed",
				cause
			});
		}
	}

	async eventSubRequest(credentials, request, budget = null) {
		await startReconciliationOperation(budget);
		let accessToken = await this.appAccessToken(credentials);
		let response = await rawEventSubRequest({
			...request,
			clientId: credentials.clientId,
			accessToken
		});
		if (response.status === 401) {
			await response.text();
			accessToken = await this.appAccessToken(credentials, accessToken);
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

	async listSubscriptions(credentials, filters = {}, budget = null) {
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
		return this.eventSubRequest(
			credentials,
			{ method: "GET", url: url.href },
			budget
		);
	}

	async matchingSubscriptions(channel, credentials, definitions, budget) {
		const subscriptions = [];
		let cursor = null;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const response = await this.listSubscriptions(credentials, {
				user_id: channel.broadcasterUserId,
				...(cursor ? { after: cursor } : {})
			}, budget);
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
				subscription?.condition?.broadcaster_user_id === channel.broadcasterUserId &&
				definitions.some((definition) =>
					subscription?.type === definition.type &&
					(subscription?.version ?? "1") === definition.version
				)
			));
			cursor = result.pagination?.cursor;
			if (typeof cursor !== "string" || cursor.length === 0) return subscriptions;
		}
		throw new TwitchEventSubServiceError("Twitch EventSub pagination exceeded its safety limit.", {
			status: 502,
			code: "twitch_eventsub_pagination_limit"
		});
	}

	async deleteSubscription(id, credentials, budget) {
		await claimReconciliationMutation(budget);
		const url = new URL(EVENTSUB_SUBSCRIPTIONS_URL);
		url.searchParams.set("id", id);
		const response = await this.eventSubRequest(credentials, {
			method: "DELETE",
			url: url.href
		}, budget);
		if (response.status !== 204) {
			await response.text();
			throw new TwitchEventSubServiceError(
				`Twitch rejected stale subscription removal with status ${response.status}.`,
				{ status: 502, code: "twitch_eventsub_delete_rejected" }
			);
		}
	}

	async createSubscription(definition, channel, credentials, budget = null) {
		if (budget) await claimReconciliationMutation(budget);
		return this.eventSubRequest(credentials, {
			method: "POST",
			url: EVENTSUB_SUBSCRIPTIONS_URL,
			body: createSubscriptionBody(definition, channel, credentials)
		}, budget);
	}

	async removeSubscriptions(channel, credentials, definitions) {
		return this.withChannelOperation(channel.broadcasterUserId, async () => {
			const budget = createReconciliationBudget();
			const subscriptions = await this.matchingSubscriptions(
				channel,
				credentials,
				definitions,
				budget
			);
			let removedSubscriptions = 0;
			for (const subscription of subscriptions) {
				if (typeof subscription?.id === "string" && subscription.id.length > 0) {
					await this.deleteSubscription(subscription.id, credentials, budget);
					removedSubscriptions += 1;
				}
			}
			return { removedSubscriptions };
		});
	}

	async ensureSubscriptions(channel, credentials, definitions) {
		return this.withChannelOperation(channel.broadcasterUserId, async () => {
			const budget = createReconciliationBudget();
			const subscriptions = await this.matchingSubscriptions(
				channel,
				credentials,
				definitions,
				budget
			);
			const reconciled = [];
			for (const definition of definitions) {
				const expectedCondition = definitionCondition(
					definition,
					channel,
					credentials
				);
				const matching = subscriptions.filter((subscription) =>
					subscription.type === definition.type &&
					(subscription.version ?? "1") === definition.version
				);
				const healthy = matching.find((subscription) =>
					subscription?.transport?.method === "webhook" &&
					subscription?.transport?.callback === channel.callbackUrl &&
					sameCondition(subscription.condition, expectedCondition) &&
					HEALTHY_SUBSCRIPTION_STATUSES.has(subscription.status)
				);
				for (const subscription of matching) {
					if (
						subscription !== healthy &&
						typeof subscription?.id === "string" &&
						subscription.id.length > 0
					) {
						await this.deleteSubscription(
							subscription.id,
							credentials,
							budget
						);
					}
				}
				if (healthy) {
					reconciled.push({
						kind: definition.kind,
						result: "existing",
						subscriptionId: healthy.id ?? null,
						status: healthy.status
					});
					continue;
				}

				const response = await this.createSubscription(
					definition,
					channel,
					credentials,
					budget
				);
				if (response.status === 409) {
					await response.text();
					reconciled.push({
						kind: definition.kind,
						result: "already_exists",
						subscriptionId: null,
						status: "unknown"
					});
					continue;
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
				reconciled.push({
					kind: definition.kind,
					result: "created",
					subscriptionId: result?.data?.[0]?.id ?? null,
					status: result?.data?.[0]?.status ??
						"webhook_callback_verification_pending"
				});
			}
			const first = reconciled[0];
			const results = new Set(reconciled.map((entry) => entry.result));
			return {
				result: results.size === 1 ? first.result : "reconciled",
				subscriptionId: first.subscriptionId,
				status: first.status,
				subscriptions: reconciled
			};
		});
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/status") {
				return handleTwitchAppAuthStatus(this.env);
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
			const definitions = selectedDefinitions(this.registry, input?.kinds);
			const needsBot = definitions.some((definition) => definition.needsBotUserId);
			if (url.pathname === "/subscriptions/remove") {
				const credentials = validateCredentials(input?.credentials, { needsBot });
				return noStoreJson(await this.removeSubscriptions(
					channel,
					credentials,
					definitions
				));
			}
			const credentials = validateCredentials(input?.credentials, {
				needsBot,
				needsWebhookSecret: true
			});
			if (url.pathname === "/subscriptions/create") {
				if (definitions.length !== 1) {
					throw new TwitchEventSubServiceError(
						"Creating a subscription requires exactly one definition kind."
					);
				}
				return this.withChannelOperation(channel.broadcasterUserId, async () => {
					const response = await this.createSubscription(
						definitions[0],
						channel,
						credentials
					);
					return cloneExternalResponse(response, await response.text());
				});
			}
			if (url.pathname === "/subscriptions/ensure") {
				return noStoreJson(await this.ensureSubscriptions(
					channel,
					credentials,
					definitions
				));
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
