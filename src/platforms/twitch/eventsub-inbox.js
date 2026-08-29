import { logError } from "../../common.js";
import { alarmDrainTimeRemaining } from "../../alarm-drain.js";
import { twitchPublicUrl } from "./environment.js";
import {
	noStoreJson,
	validateEventSubMessageId
} from "./eventsub-common.js";
import {
	eventSubDefinitionForSubscription,
	requireTwitchEventSubDefinition
} from "./eventsub-registry.js";

export const TWITCH_EVENTSUB_INBOX_SCHEMA_VERSION = 1;

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_DELIVERY_ATTEMPTS = 5;
const DRAIN_BATCH_SIZE = 20;
const ATTEMPT_LEASE_MS = 60 * 1000;
const COMPLETED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = Object.freeze([
	30 * 1000,
	2 * 60 * 1000,
	10 * 60 * 1000,
	30 * 60 * 1000
]);
const INBOX_STATES = Object.freeze([
	"pending",
	"attempting",
	"retry_wait",
	"completed",
	"dead_letter"
]);

export class TwitchEventSubInboxError extends Error {
	constructor(message, {
		status = 400,
		code = "twitch_eventsub_inbox_error",
		cause
	} = {}) {
		super(message, { cause });
		this.name = "TwitchEventSubInboxError";
		this.status = status;
		this.code = code;
	}
}

export function twitchEventSubInboxObjectName(broadcasterUserId) {
	return `twitch:eventsub-inbox:${broadcasterUserId}`;
}

export function twitchEventSubInboxStub(env, broadcasterUserId) {
	if (!env.TWITCH_EVENTSUB_INBOX) {
		throw new TwitchEventSubInboxError(
			"TWITCH_EVENTSUB_INBOX is not configured.",
			{ status: 503, code: "twitch_eventsub_inbox_not_configured" }
		);
	}
	if (typeof broadcasterUserId !== "string" || broadcasterUserId.length === 0) {
		throw new TwitchEventSubInboxError(
			"The EventSub broadcaster ID is invalid.",
			{ code: "twitch_eventsub_inbox_invalid_broadcaster" }
		);
	}
	return env.TWITCH_EVENTSUB_INBOX.get(
		env.TWITCH_EVENTSUB_INBOX.idFromName(
			twitchEventSubInboxObjectName(broadcasterUserId)
		)
	);
}

function twitchRuntimeEnvironment(env) {
	return Object.fromEntries([
		"TWITCH_DEPLOYMENT_ENVIRONMENT",
		"TWITCH_PUBLIC_ORIGIN",
		"TWITCH_CLIENT_ID",
		"TWITCH_CLIENT_SECRET",
		"TWITCH_BOT_USER_ID",
		"TWITCH_EVENTSUB_SECRET"
	].flatMap((name) =>
		typeof env[name] === "string" ? [[name, env[name]]] : []
	));
}

async function checkedInboxJson(response, fallbackMessage) {
	let result;
	try {
		result = await response.json();
	} catch (cause) {
		throw new TwitchEventSubInboxError(
			"The EventSub inbox returned an invalid response.",
			{
				status: 502,
				code: "twitch_eventsub_inbox_invalid_response",
				cause
			}
		);
	}
	if (!response.ok) {
		throw new TwitchEventSubInboxError(result?.error || fallbackMessage, {
			status: response.status,
			code: result?.code || "twitch_eventsub_inbox_failed"
		});
	}
	return result;
}

export async function enqueueTwitchEventSubMessage(env, broadcasterUserId, input) {
	return checkedInboxJson(
		await twitchEventSubInboxStub(env, broadcasterUserId).fetch(
			"https://twitch-eventsub-inbox/messages",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...input,
					broadcasterUserId,
					runtimeEnvironment: twitchRuntimeEnvironment(env)
				})
			}
		),
		"Could not persist the EventSub message."
	);
}

export async function drainTwitchEventSubInbox(env, broadcasterUserId) {
	const runtimeEnvironment = twitchRuntimeEnvironment(env);
	return checkedInboxJson(
		await twitchEventSubInboxStub(env, broadcasterUserId).fetch(
			"https://twitch-eventsub-inbox/drain",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ runtimeEnvironment })
			}
		),
		"Could not drain the EventSub inbox."
	);
}

function initializeInboxTables(state) {
	state.storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS eventsub_inbox (
			message_id TEXT PRIMARY KEY,
			fingerprint TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_timestamp TEXT NOT NULL,
			subscription_kind TEXT NOT NULL,
			broadcaster_user_id TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			status TEXT NOT NULL,
			attempts INTEGER NOT NULL,
			received_at_ms INTEGER NOT NULL,
			next_attempt_at_ms INTEGER,
			last_attempt_at_ms INTEGER,
			completed_at_ms INTEGER,
			expires_at_ms INTEGER NOT NULL,
			last_error TEXT
		);
		CREATE INDEX IF NOT EXISTS eventsub_inbox_due
			ON eventsub_inbox (status, next_attempt_at_ms);
		CREATE INDEX IF NOT EXISTS eventsub_inbox_expiry
			ON eventsub_inbox (expires_at_ms);
	`);
}

function safeErrorMessage(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 1000);
}

function extractBroadcasterUserId(payload) {
	return payload?.subscription?.condition?.broadcaster_user_id ??
		payload?.event?.broadcaster_user_id;
}

function validateMessage(input, broadcasterUserId, registry) {
	if (input?.schemaVersion !== TWITCH_EVENTSUB_INBOX_SCHEMA_VERSION) {
		throw new TwitchEventSubInboxError(
			"The EventSub inbox schema version is unsupported.",
			{ status: 422, code: "twitch_eventsub_inbox_schema_unsupported" }
		);
	}
	const messageId = validateEventSubMessageId(input.messageId);
	if (!["notification", "revocation"].includes(input.messageType)) {
		throw new TwitchEventSubInboxError("The EventSub message type is invalid.");
	}
	const timestampMs = Date.parse(input.messageTimestamp);
	if (!Number.isFinite(timestampMs)) {
		throw new TwitchEventSubInboxError("The EventSub message timestamp is invalid.");
	}
	if (
		typeof input.payload !== "object" ||
		input.payload === null ||
		Array.isArray(input.payload)
	) {
		throw new TwitchEventSubInboxError("The EventSub payload is invalid.");
	}
	const payloadJson = JSON.stringify(input.payload);
	if (new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) {
		throw new TwitchEventSubInboxError("The EventSub payload is too large.", {
			status: 413,
			code: "twitch_eventsub_inbox_payload_too_large"
		});
	}
	if (
		typeof broadcasterUserId !== "string" ||
		broadcasterUserId.length === 0 ||
		extractBroadcasterUserId(input.payload) !== broadcasterUserId
	) {
		throw new TwitchEventSubInboxError(
			"The EventSub payload broadcaster does not match the inbox.",
			{ code: "twitch_eventsub_inbox_broadcaster_mismatch" }
		);
	}
	const subscription = input.payload.subscription;
	const version = subscription?.version ?? "1";
	const definition = eventSubDefinitionForSubscription(
		registry,
		subscription?.type,
		version
	);
	if (!definition) {
		throw new TwitchEventSubInboxError(
			"The EventSub subscription is not registered.",
			{ status: 422, code: "twitch_eventsub_subscription_unsupported" }
		);
	}

	return {
		messageId,
		messageType: input.messageType,
		messageTimestamp: new Date(timestampMs).toISOString(),
		subscriptionKind: definition.kind,
		payload: input.payload,
		payloadJson
	};
}

async function sha256(value) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(bytes))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function rowToMessage(row) {
	return {
		messageId: row.message_id,
		messageType: row.message_type,
		messageTimestamp: row.message_timestamp,
		subscriptionKind: row.subscription_kind,
		broadcasterUserId: row.broadcaster_user_id,
		payload: JSON.parse(row.payload_json),
		status: row.status,
		attempts: row.attempts
	};
}

export class TwitchEventSubInboxBackend {
	constructor(state, env, registry) {
		this.state = state;
		this.env = env;
		this.registry = registry;
		initializeInboxTables(state);
	}

	prune(nowMs = Date.now()) {
		this.state.storage.sql.exec(
			"DELETE FROM eventsub_inbox WHERE expires_at_ms <= ?",
			nowMs
		);
	}

	async enqueue(input) {
		this.runtimeEnvironment = twitchRuntimeEnvironment(
			input?.runtimeEnvironment ?? {}
		);
		const broadcasterUserId = input?.broadcasterUserId;
		const message = validateMessage(input, broadcasterUserId, this.registry);
		const fingerprint = await sha256(JSON.stringify({
			messageType: message.messageType,
			subscriptionKind: message.subscriptionKind,
			payload: message.payload
		}));
		const nowMs = Date.now();
		// Arm recovery before inserting. A harmless empty alarm is preferable to
		// a persisted message with no wake-up after an interrupted request.
		await this.state.storage.setAlarm(nowMs + 1000);
		const result = this.state.storage.transactionSync(() => {
			this.prune(nowMs);
			const existing = this.state.storage.sql.exec(
				"SELECT fingerprint, status FROM eventsub_inbox WHERE message_id = ?",
				message.messageId
			).toArray()[0];
			if (existing) {
				if (existing.fingerprint !== fingerprint) {
					throw new TwitchEventSubInboxError(
						"The EventSub message ID was reused with different content.",
						{ status: 409, code: "twitch_eventsub_inbox_message_conflict" }
					);
				}
				return { accepted: false, duplicate: true, status: existing.status };
			}

			this.state.storage.sql.exec(
				`INSERT INTO eventsub_inbox (
					message_id, fingerprint, message_type, message_timestamp,
					subscription_kind, broadcaster_user_id, payload_json, status,
					attempts, received_at_ms, next_attempt_at_ms, expires_at_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
				message.messageId,
				fingerprint,
				message.messageType,
				message.messageTimestamp,
				message.subscriptionKind,
				broadcasterUserId,
				message.payloadJson,
				nowMs,
				nowMs,
				nowMs + COMPLETED_RETENTION_MS
			);
			return { accepted: true, duplicate: false, status: "pending" };
		});
		if (result.duplicate && ["completed", "dead_letter"].includes(result.status)) {
			await this.scheduleNextAlarm();
		}
		return result;
	}

	recoverExpiredAttempts(nowMs = Date.now()) {
		this.state.storage.sql.exec(
			`UPDATE eventsub_inbox
			 SET status = 'retry_wait', next_attempt_at_ms = ?,
			     last_error = 'Processing lease expired.'
			 WHERE status = 'attempting' AND last_attempt_at_ms <= ?`,
			nowMs,
			nowMs - ATTEMPT_LEASE_MS
		);
	}

	claimNext(nowMs = Date.now()) {
		return this.state.storage.transactionSync(() => {
			const row = this.state.storage.sql.exec(
				`SELECT * FROM eventsub_inbox
				 WHERE status IN ('pending', 'retry_wait')
				   AND next_attempt_at_ms <= ?
				 ORDER BY received_at_ms, message_id
				 LIMIT 1`,
				nowMs
			).toArray()[0];
			if (!row) return null;
			this.state.storage.sql.exec(
				`UPDATE eventsub_inbox
				 SET status = 'attempting', attempts = attempts + 1,
				     last_attempt_at_ms = ?, next_attempt_at_ms = NULL
				 WHERE message_id = ?`,
				nowMs,
				row.message_id
			);
			return rowToMessage({ ...row, status: "attempting", attempts: row.attempts + 1 });
		});
	}

	complete(messageId, nowMs = Date.now()) {
		this.state.storage.sql.exec(
			`UPDATE eventsub_inbox
			 SET status = 'completed', completed_at_ms = ?,
			     next_attempt_at_ms = NULL, last_error = NULL,
			     expires_at_ms = ?
			 WHERE message_id = ?`,
			nowMs,
			nowMs + COMPLETED_RETENTION_MS,
			messageId
		);
	}

	fail(message, error, nowMs = Date.now()) {
		const terminal = error?.retryable === false ||
			message.attempts >= MAX_DELIVERY_ATTEMPTS;
		const retryDelayMs = RETRY_DELAYS_MS[
			Math.min(message.attempts - 1, RETRY_DELAYS_MS.length - 1)
		];
		this.state.storage.sql.exec(
			`UPDATE eventsub_inbox
			 SET status = ?, next_attempt_at_ms = ?, last_error = ?,
			     expires_at_ms = ?
			 WHERE message_id = ?`,
			terminal ? "dead_letter" : "retry_wait",
			terminal ? null : nowMs + retryDelayMs,
			safeErrorMessage(error),
			nowMs + COMPLETED_RETENTION_MS,
			message.messageId
		);
		return { terminal, retryDelayMs: terminal ? null : retryDelayMs };
	}

	async scheduleNextAlarm() {
		const next = this.state.storage.sql.exec(
			`SELECT MIN(
				CASE WHEN status = 'attempting'
					THEN last_attempt_at_ms + ?
					ELSE next_attempt_at_ms
				END
			) AS next_attempt_at_ms
			 FROM eventsub_inbox
			 WHERE status IN ('pending', 'retry_wait', 'attempting')`,
			ATTEMPT_LEASE_MS
		).toArray()[0]?.next_attempt_at_ms;
		if (Number.isInteger(next)) {
			await this.state.storage.setAlarm(Math.max(next, Date.now()));
		} else {
			await this.state.storage.deleteAlarm();
		}
	}

	async process(message, runtimeEnvironment = {}) {
		const definition = requireTwitchEventSubDefinition(
			this.registry,
			message.subscriptionKind
		);
		const processingEnvironment = Object.freeze({
			...this.env,
			...runtimeEnvironment
		});
		const context = Object.freeze({
			payload: message.payload,
			env: processingEnvironment,
			messageId: message.messageId,
			messageTimestamp: message.messageTimestamp,
			callbackUrl: twitchPublicUrl(processingEnvironment, "/twitch")
		});
		if (message.messageType === "notification") {
			await definition.handleNotification(context);
		} else if (definition.handleRevocation) {
			await definition.handleRevocation(context);
		}
	}

	async drain(runtimeEnvironment = this.runtimeEnvironment ?? {}) {
		const startedAtMs = Date.now();
		runtimeEnvironment = twitchRuntimeEnvironment(runtimeEnvironment);
		this.recoverExpiredAttempts();
		let processed = 0;
		for (; processed < DRAIN_BATCH_SIZE; processed++) {
			if (!alarmDrainTimeRemaining(startedAtMs, processed)) break;
			const message = this.claimNext();
			if (!message) break;
			await this.state.storage.setAlarm(Date.now() + ATTEMPT_LEASE_MS);
			try {
				await this.process(message, runtimeEnvironment);
				this.complete(message.messageId);
			} catch (error) {
				const failure = this.fail(message, error);
				if (!error?.eventSubLogged) {
					logError("twitch.eventsub_inbox_processing_failed", {
						platform: "twitch",
						correlationId: `twitch:${message.messageId}`,
						groupId: message.broadcasterUserId,
						subscriptionKind: message.subscriptionKind,
						attempts: message.attempts,
						terminal: failure.terminal,
						nextRetryInMs: failure.retryDelayMs
					}, error);
				}
			}
		}
		this.prune();
		await this.scheduleNextAlarm();
		return { processed };
	}

	async alarm() {
		await this.drain();
	}

	messageStatus(messageId) {
		const row = this.state.storage.sql.exec(
			`SELECT message_id, message_type, subscription_kind, status, attempts,
			        received_at_ms, next_attempt_at_ms, last_attempt_at_ms,
			        completed_at_ms, last_error
			 FROM eventsub_inbox WHERE message_id = ?`,
			validateEventSubMessageId(messageId)
		).toArray()[0];
		return row ?? null;
	}

	deadLetters() {
		return this.state.storage.sql.exec(
			`SELECT message_id, message_type, subscription_kind, attempts,
			        received_at_ms, last_attempt_at_ms, last_error
			 FROM eventsub_inbox WHERE status = 'dead_letter'
			 ORDER BY last_attempt_at_ms DESC LIMIT 50`
		).toArray();
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/messages") {
				const result = await this.enqueue(await request.json());
				return noStoreJson(result, result.accepted ? 202 : 200);
			}
			if (request.method === "POST" && url.pathname === "/drain") {
				let input = {};
				try {
					input = await request.json();
				} catch {
					// Alarms and older internal callers may not provide a body.
				}
				return noStoreJson(await this.drain(input?.runtimeEnvironment));
			}
			if (request.method === "GET" && url.pathname === "/messages") {
				const message = this.messageStatus(url.searchParams.get("messageId"));
				return noStoreJson({ message }, message ? 200 : 404);
			}
			if (request.method === "GET" && url.pathname === "/dead-letters") {
				return noStoreJson({ messages: this.deadLetters() });
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (
				error instanceof TwitchEventSubInboxError ||
				error?.code === "twitch_eventsub_registry_error" ||
				error?.code?.startsWith("twitch_eventsub_")
			) {
				return noStoreJson({
					error: error.message,
					code: error.code
				}, error.status ?? 400);
			}
			logError("twitch.eventsub_inbox_failed", {
				platform: "twitch",
				correlationId: `twitch-eventsub-inbox:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "The EventSub inbox failed." }, 500);
		}
	}
}

export { INBOX_STATES as TWITCH_EVENTSUB_INBOX_STATES };
