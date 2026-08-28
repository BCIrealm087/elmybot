import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { TWITCH_APP_AUTH_OBJECT_NAME } from "../src/platforms/twitch/app-auth.js";
import {
	drainTwitchEventSubInbox,
	enqueueTwitchEventSubMessage,
	twitchEventSubInboxStub,
	TWITCH_EVENTSUB_INBOX_SCHEMA_VERSION
} from "../src/platforms/twitch/eventsub-inbox.js";

const eventSubEnv = {
	...env,
	TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
	TWITCH_PUBLIC_ORIGIN: "https://example.com",
	TWITCH_CLIENT_ID: "client-id",
	TWITCH_CLIENT_SECRET: "client-secret",
	TWITCH_BOT_USER_ID: "bot-user-id",
	TWITCH_EVENTSUB_SECRET: "eventsub-secret"
};

let sequence = 0;

function appAuthStub() {
	return env.TWITCH_APP_AUTH.get(
		env.TWITCH_APP_AUTH.idFromName(TWITCH_APP_AUTH_OBJECT_NAME)
	);
}

async function storeAppToken() {
	await runInDurableObject(appAuthStub(), async (_instance, state) => {
		await state.storage.put("appAccessToken", {
			accessToken: "stored-app-access-token",
			clientId: "client-id",
			obtainedAtMs: Date.now(),
			expiresAtMs: Date.now() + 4 * 60 * 60 * 1000
		});
	});
}

function inboxMessage(broadcasterUserId, messageId, text = "hello") {
	return {
		schemaVersion: TWITCH_EVENTSUB_INBOX_SCHEMA_VERSION,
		messageId,
		messageType: "notification",
		messageTimestamp: new Date().toISOString(),
		payload: {
			subscription: {
				type: "channel.chat.message",
				version: "1",
				condition: { broadcaster_user_id: broadcasterUserId }
			},
			event: {
				broadcaster_user_id: broadcasterUserId,
				chatter_user_id: "chatter-id",
				message: { text }
			}
		}
	};
}

async function inboxRow(broadcasterUserId, messageId) {
	return runInDurableObject(
		twitchEventSubInboxStub(env, broadcasterUserId),
		async (_instance, state) => state.storage.sql.exec(
			`SELECT message_id, status, attempts, next_attempt_at_ms,
			        completed_at_ms, last_error
			 FROM eventsub_inbox WHERE message_id = ?`,
			messageId
		).toArray()[0]
	);
}

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await runInDurableObject(appAuthStub(), async (_instance, state) => {
		await state.storage.deleteAll();
	});
});

describe("Twitch EventSub durable inbox", () => {
	it("persists a verified notification before processing it", async () => {
		const broadcasterUserId = `inbox-persist-${++sequence}`;
		const messageId = `message-${sequence}`;
		const accepted = await enqueueTwitchEventSubMessage(
			eventSubEnv,
			broadcasterUserId,
			inboxMessage(broadcasterUserId, messageId)
		);

		expect(accepted).toEqual({
			accepted: true,
			duplicate: false,
			status: "pending"
		});
		expect(await inboxRow(broadcasterUserId, messageId)).toMatchObject({
			message_id: messageId,
			status: "pending",
			attempts: 0
		});

		expect(await drainTwitchEventSubInbox(eventSubEnv, broadcasterUserId))
			.toEqual({ processed: 1 });
		expect(await inboxRow(broadcasterUserId, messageId)).toMatchObject({
			status: "completed",
			attempts: 1
		});
	});

	it("deduplicates an identical message and rejects conflicting reuse", async () => {
		const broadcasterUserId = `inbox-dedup-${++sequence}`;
		const messageId = `message-${sequence}`;
		const original = inboxMessage(broadcasterUserId, messageId);
		await enqueueTwitchEventSubMessage(eventSubEnv, broadcasterUserId, original);

		expect(await enqueueTwitchEventSubMessage(
			eventSubEnv,
			broadcasterUserId,
			{ ...original, messageTimestamp: new Date(Date.now() + 1).toISOString() }
		)).toEqual({ accepted: false, duplicate: true, status: "pending" });
		await expect(enqueueTwitchEventSubMessage(
			eventSubEnv,
			broadcasterUserId,
			inboxMessage(broadcasterUserId, messageId, "different")
		)).rejects.toMatchObject({
			status: 409,
			code: "twitch_eventsub_inbox_message_conflict"
		});
	});

	it("keeps retryable handler failures in the durable retry queue", async () => {
		const broadcasterUserId = `inbox-retry-${++sequence}`;
		const messageId = `message-${sequence}`;
		await storeAppToken();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
		vi.spyOn(console, "error").mockImplementation(() => {});
		await enqueueTwitchEventSubMessage(
			eventSubEnv,
			broadcasterUserId,
			inboxMessage(broadcasterUserId, messageId, "!alive")
		);

		await drainTwitchEventSubInbox(eventSubEnv, broadcasterUserId);
		const row = await inboxRow(broadcasterUserId, messageId);
		expect(row).toMatchObject({
			status: "retry_wait",
			attempts: 1
		});
		expect(row.next_attempt_at_ms).toBeGreaterThan(Date.now());
		expect(row.last_error).toContain("temporarily unavailable");
	});

	it("dead-letters terminal handler failures without retrying", async () => {
		const broadcasterUserId = `inbox-terminal-${++sequence}`;
		const messageId = `message-${sequence}`;
		await storeAppToken();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));
		vi.spyOn(console, "error").mockImplementation(() => {});
		await enqueueTwitchEventSubMessage(
			eventSubEnv,
			broadcasterUserId,
			inboxMessage(broadcasterUserId, messageId, "!alive")
		);

		await drainTwitchEventSubInbox(eventSubEnv, broadcasterUserId);
		expect(await inboxRow(broadcasterUserId, messageId)).toMatchObject({
			status: "dead_letter",
			attempts: 1,
			next_attempt_at_ms: null
		});
	});

	it("recovers a message left attempting after its processing lease expires", async () => {
		const broadcasterUserId = `inbox-lease-${++sequence}`;
		const messageId = `message-${sequence}`;
		await enqueueTwitchEventSubMessage(
			eventSubEnv,
			broadcasterUserId,
			inboxMessage(broadcasterUserId, messageId)
		);
		await runInDurableObject(
			twitchEventSubInboxStub(env, broadcasterUserId),
			async (_instance, state) => state.storage.sql.exec(
				`UPDATE eventsub_inbox
				 SET status = 'attempting', attempts = 1,
				     next_attempt_at_ms = NULL, last_attempt_at_ms = ?
				 WHERE message_id = ?`,
				Date.now() - 61 * 1000,
				messageId
			)
		);

		await drainTwitchEventSubInbox(eventSubEnv, broadcasterUserId);
		expect(await inboxRow(broadcasterUserId, messageId)).toMatchObject({
			status: "completed",
			attempts: 2
		});
	});
});
