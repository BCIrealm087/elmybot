import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createExecutionContext,
	env,
	waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/index.js";

const encoder = new TextEncoder();

function toHex(bytes) {
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function makeSignedTwitchRequest({
	body,
	secret = "eventsub-secret",
	messageId = "message-id",
	messageType = "notification",
	timestamp = new Date().toISOString()
}) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(messageId + timestamp + body)
	);

	return new Request("https://example.com/twitch", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Twitch-Eventsub-Message-Id": messageId,
			"Twitch-Eventsub-Message-Timestamp": timestamp,
			"Twitch-Eventsub-Message-Signature": `sha256=${toHex(new Uint8Array(signature))}`,
			"Twitch-Eventsub-Message-Type": messageType
		},
		body
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Twitch EventSub worker", () => {
	it("returns OK for the Twitch health check", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/twitch", { method: "GET" }),
			env,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
	});

	it("returns a signed EventSub verification challenge", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({ challenge: "challenge-token" }),
			secret,
			messageType: "webhook_callback_verification"
		});

		const response = await worker.fetch(
			request,
			{ ...env, TWITCH_EVENTSUB_SECRET: secret },
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("challenge-token");
	});

	it("rejects an invalid EventSub signature", async () => {
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({ subscription: {}, event: {} }),
			secret: "wrong-secret"
		});

		const response = await worker.fetch(
			request,
			{ ...env, TWITCH_EVENTSUB_SECRET: "eventsub-secret" },
			createExecutionContext()
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Invalid signature");
	});

	it("routes !alive and sends its reply to Twitch chat", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: { type: "channel.chat.message" },
				event: {
					broadcaster_user_id: "broadcaster-id",
					message: { text: "!alive" }
				}
			}),
			secret
		});
		const fetchMock = vi.fn(async (_input, init) => {
			expect(init.signal).toBeInstanceOf(AbortSignal);
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, {
			...env,
			TWITCH_EVENTSUB_SECRET: secret,
			TWITCH_CLIENT_ID: "client-id",
			TWITCH_ACCESS_TOKEN: "access-token",
			TWITCH_BOT_USER_ID: "bot-user-id"
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.twitch.tv/helix/chat/messages");
		expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
			Authorization: "Bearer access-token",
			"Client-Id": "client-id"
		});
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			broadcaster_id: "broadcaster-id",
			sender_id: "bot-user-id",
			message: "I'm here!!1"
		});
	});

	it("acknowledges non-command chat messages without sending a reply", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: { type: "channel.chat.message" },
				event: {
					broadcaster_user_id: "broadcaster-id",
					message: { text: "hello" }
				}
			}),
			secret
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			request,
			{ ...env, TWITCH_EVENTSUB_SECRET: secret },
			createExecutionContext()
		);

		expect(response.status).toBe(204);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
