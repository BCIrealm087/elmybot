import { jsonResponse, logError } from "../../common.js";

export const TWITCH_CHANNEL_REGISTRY_NAME = "twitch:channel-registry";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 25;
const AUTHORIZATION_MODES = new Set(["moderator", "broadcaster_oauth"]);

function channelAuthObjectName(broadcasterUserId) {
	return `twitch:channel-auth:${broadcasterUserId}`;
}

function eventSubManagerObjectName(broadcasterUserId) {
	return `twitch:channel:${broadcasterUserId}`;
}

class TwitchChannelRegistryError extends Error {
	constructor(message, { status = 400, code = "twitch_channel_registry_error" } = {}) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function noStoreJson(value, status = 200) {
	const response = jsonResponse(value, status);
	response.headers.set("cache-control", "no-store");
	return response;
}

function initializeRegistryTables(state) {
	state.storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS twitch_channels (
			broadcaster_user_id TEXT PRIMARY KEY,
			authorization_mode TEXT NOT NULL,
			login TEXT,
			registered_at_ms INTEGER NOT NULL,
			updated_at_ms INTEGER NOT NULL
		);
	`);
}

function validateBroadcasterUserId(value) {
	if (typeof value !== "string" || !/^[0-9A-Za-z_-]{1,128}$/.test(value)) {
		throw new TwitchChannelRegistryError("The Twitch broadcaster user ID is invalid.");
	}
	return value;
}

function validateRegistryEntry(input) {
	const broadcasterUserId = validateBroadcasterUserId(input?.broadcasterUserId);
	const authorizationMode = input?.authorizationMode ?? "moderator";
	if (!AUTHORIZATION_MODES.has(authorizationMode)) {
		throw new TwitchChannelRegistryError("The Twitch authorization mode is invalid.");
	}
	const login = typeof input?.login === "string" && input.login.length > 0
		? input.login.slice(0, 128)
		: null;
	return { broadcasterUserId, authorizationMode, login };
}

function registryStub(env) {
	if (!env.TWITCH_CHANNEL_REGISTRY) {
		throw new TwitchChannelRegistryError("TWITCH_CHANNEL_REGISTRY is not configured.", {
			status: 503,
			code: "twitch_channel_registry_not_configured"
		});
	}
	return env.TWITCH_CHANNEL_REGISTRY.get(
		env.TWITCH_CHANNEL_REGISTRY.idFromName(TWITCH_CHANNEL_REGISTRY_NAME)
	);
}

async function checkedRegistryResponse(response) {
	let result;
	try {
		result = await response.json();
	} catch {
		result = null;
	}
	if (!response.ok) {
		throw new TwitchChannelRegistryError(
			result?.error || "Twitch channel registry request failed.",
			{ status: response.status, code: result?.code }
		);
	}
	return result;
}

export async function registerTwitchChannel(env, channel) {
	const entry = validateRegistryEntry(channel);
	return checkedRegistryResponse(await registryStub(env).fetch(
		"https://twitch-channel-registry/channels",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(entry)
		}
	));
}

export async function unregisterTwitchChannel(env, broadcasterUserId) {
	const validated = validateBroadcasterUserId(broadcasterUserId);
	return checkedRegistryResponse(await registryStub(env).fetch(
		`https://twitch-channel-registry/channels?broadcasterUserId=${encodeURIComponent(validated)}`,
		{ method: "DELETE" }
	));
}

async function parseSafeJson(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function fetchComponent(stub, url) {
	try {
		const response = await stub.fetch(url);
		const result = await parseSafeJson(response);
		if (!response.ok) return { available: false, statusCode: response.status };
		return { available: true, result };
	} catch (error) {
		logError("twitch.channel_health_component_failed", {
			platform: "twitch",
			correlationId: `twitch-channel-health:${crypto.randomUUID()}`,
			groupId: null
		}, error);
		return { available: false, statusCode: null };
	}
}

function classifyHealth(entry, authorization, eventSub) {
	if (!eventSub.available) return "unknown";
	if (entry.authorizationMode === "broadcaster_oauth") {
		if (!authorization.available) return "unknown";
		if (!authorization.result?.authorized) {
			return authorization.result?.authorization?.status === "reauthorization_required"
				? "reauthorization_required"
				: "inactive";
		}
	}
	const status = eventSub.result;
	if (!status?.configured) return "inactive";
	if (status.recovery || status.channel?.lastResult === "error") return "degraded";
	if (["pending", "deconfiguration_pending"].includes(status.channel?.lastResult)) {
		return "pending";
	}
	if (
		status.channel?.lastSubscriptionStatus &&
		!["enabled", "webhook_callback_verification_pending"].includes(
			status.channel.lastSubscriptionStatus
		)
	) {
		return "degraded";
	}
	return "healthy";
}

async function channelHealth(env, entry) {
	const manager = env.TWITCH_EVENTSUB_MANAGER.get(
		env.TWITCH_EVENTSUB_MANAGER.idFromName(
			eventSubManagerObjectName(entry.broadcasterUserId)
		)
	);
	const eventSubPromise = fetchComponent(
		manager,
		"https://twitch-eventsub-manager/status"
	);
	const authorizationPromise = entry.authorizationMode === "broadcaster_oauth"
		? fetchComponent(
			env.TWITCH_CHANNEL_AUTH.get(
				env.TWITCH_CHANNEL_AUTH.idFromName(
					channelAuthObjectName(entry.broadcasterUserId)
				)
			),
			"https://twitch-channel-auth/status"
		)
		: Promise.resolve({
			available: true,
			result: { required: false, status: "not_required" }
		});
	const [eventSub, authorization] = await Promise.all([
		eventSubPromise,
		authorizationPromise
	]);
	return {
		...entry,
		health: classifyHealth(entry, authorization, eventSub),
		authorization: authorization.available
			? authorization.result
			: { available: false, statusCode: authorization.statusCode },
		eventSub: eventSub.available
			? eventSub.result
			: { available: false, statusCode: eventSub.statusCode }
	};
}

export async function handleTwitchChannelHealth(request, env) {
	try {
		if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
		if (!env.TWITCH_EVENTSUB_MANAGER || !env.TWITCH_CHANNEL_AUTH) {
			throw new TwitchChannelRegistryError("Twitch channel health is not configured.", {
				status: 503,
				code: "twitch_channel_health_not_configured"
			});
		}
		const url = new URL(request.url);
		const registryUrl = new URL("https://twitch-channel-registry/channels");
		for (const name of ["limit", "cursor"]) {
			const value = url.searchParams.get(name);
			if (value) registryUrl.searchParams.set(name, value);
		}
		const page = await checkedRegistryResponse(
			await registryStub(env).fetch(registryUrl)
		);
		const channels = await Promise.all(
			page.channels.map((entry) => channelHealth(env, entry))
		);
		const summary = {};
		for (const channel of channels) {
			summary[channel.health] = (summary[channel.health] ?? 0) + 1;
		}
		return noStoreJson({
			generatedAtMs: Date.now(),
			total: page.total,
			count: channels.length,
			nextCursor: page.nextCursor,
			summary,
			channels
		});
	} catch (error) {
		if (error instanceof TwitchChannelRegistryError) {
			return noStoreJson({ error: error.message, code: error.code }, error.status);
		}
		logError("twitch.channel_health_failed", {
			platform: "twitch",
			correlationId: `twitch-channel-health:${crypto.randomUUID()}`,
			groupId: null
		}, error);
		return noStoreJson({ error: "Twitch channel health failed." }, 500);
	}
}

export class TwitchChannelRegistry {
	constructor(state) {
		this.state = state;
		initializeRegistryTables(state);
	}

	upsert(input) {
		const entry = validateRegistryEntry(input);
		const nowMs = Date.now();
		this.state.storage.sql.exec(
			`INSERT INTO twitch_channels
				(broadcaster_user_id, authorization_mode, login, registered_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(broadcaster_user_id) DO UPDATE SET
				authorization_mode = excluded.authorization_mode,
				login = COALESCE(excluded.login, twitch_channels.login),
				updated_at_ms = excluded.updated_at_ms`,
			entry.broadcasterUserId,
			entry.authorizationMode,
			entry.login,
			nowMs,
			nowMs
		);
		return this.get(entry.broadcasterUserId);
	}

	get(broadcasterUserId) {
		const row = this.state.storage.sql.exec(
			`SELECT broadcaster_user_id, authorization_mode, login,
				registered_at_ms, updated_at_ms
			 FROM twitch_channels WHERE broadcaster_user_id = ?`,
			validateBroadcasterUserId(broadcasterUserId)
		).toArray()[0];
		return row ? {
			broadcasterUserId: row.broadcaster_user_id,
			authorizationMode: row.authorization_mode,
			login: row.login,
			registeredAtMs: row.registered_at_ms,
			updatedAtMs: row.updated_at_ms
		} : null;
	}

	list(url) {
		const rawLimit = url.searchParams.get("limit");
		const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
			throw new TwitchChannelRegistryError(`limit must be between 1 and ${MAX_PAGE_SIZE}.`);
		}
		const cursor = url.searchParams.get("cursor");
		if (cursor !== null) validateBroadcasterUserId(cursor);
		const rows = this.state.storage.sql.exec(
			`SELECT broadcaster_user_id, authorization_mode, login,
				registered_at_ms, updated_at_ms
			 FROM twitch_channels
			 WHERE broadcaster_user_id > ?
			 ORDER BY broadcaster_user_id ASC
			 LIMIT ?`,
			cursor ?? "",
			limit + 1
		).toArray();
		const hasMore = rows.length > limit;
		const pageRows = rows.slice(0, limit);
		const total = this.state.storage.sql.exec(
			"SELECT COUNT(*) AS total FROM twitch_channels"
		).toArray()[0].total;
		return {
			total,
			channels: pageRows.map((row) => ({
				broadcasterUserId: row.broadcaster_user_id,
				authorizationMode: row.authorization_mode,
				login: row.login,
				registeredAtMs: row.registered_at_ms,
				updatedAtMs: row.updated_at_ms
			})),
			nextCursor: hasMore
				? pageRows[pageRows.length - 1].broadcaster_user_id
				: null
		};
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (url.pathname !== "/channels") return new Response("Not found", { status: 404 });
			if (request.method === "POST") {
				return noStoreJson({ channel: this.upsert(await request.json()) }, 201);
			}
			if (request.method === "GET") return noStoreJson(this.list(url));
			if (request.method === "DELETE") {
				const broadcasterUserId = validateBroadcasterUserId(
					url.searchParams.get("broadcasterUserId")
				);
				const existing = this.get(broadcasterUserId);
				this.state.storage.sql.exec(
					"DELETE FROM twitch_channels WHERE broadcaster_user_id = ?",
					broadcasterUserId
				);
				return noStoreJson({ removed: Boolean(existing), broadcasterUserId });
			}
			return new Response("Method Not Allowed", { status: 405 });
		} catch (error) {
			if (error instanceof TwitchChannelRegistryError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			return noStoreJson({ error: "Twitch channel registry failed." }, 500);
		}
	}
}
