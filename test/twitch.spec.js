import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/index.js";
import { TWITCH_AUTH_OBJECT_NAME } from "../src/platforms/twitch/auth.js";

const encoder = new TextEncoder();
const oauthEnv = {
	...env,
	TWITCH_OAUTH_SETUP_TOKEN: "setup-token",
	TWITCH_CLIENT_ID: "client-id",
	TWITCH_CLIENT_SECRET: "client-secret",
	TWITCH_BOT_USER_ID: "bot-user-id"
};

function twitchAuthStub() {
	return env.TWITCH_AUTH.get(env.TWITCH_AUTH.idFromName(TWITCH_AUTH_OBJECT_NAME));
}

async function storeTwitchTokens(overrides = {}) {
	await runInDurableObject(twitchAuthStub(), async (_instance, state) => {
		await state.storage.put("oauthTokens", {
			accessToken: "stored-access-token",
			refreshToken: "stored-refresh-token",
			expiresAtMs: Date.now() + 4 * 60 * 60 * 1000,
			lastValidatedAtMs: Date.now(),
			clientId: "client-id",
			userId: "bot-user-id",
			login: "elmybot",
			scopes: ["user:bot", "user:read:chat", "user:write:chat"],
			...overrides
		});
	});
}

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
		await storeTwitchTokens();
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
			TWITCH_CLIENT_SECRET: "client-secret",
			TWITCH_BOT_USER_ID: "bot-user-id"
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.twitch.tv/helix/chat/messages");
		expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
			Authorization: "Bearer stored-access-token",
			"Client-Id": "client-id"
		});
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			broadcaster_id: "broadcaster-id",
			sender_id: "bot-user-id",
			message: "I'm here!!1"
		});
	});

	it("refreshes an expiring token before sending a chat message", async () => {
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
		await storeTwitchTokens({ expiresAtMs: Date.now() + 30 * 1000 });
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				expect(init.body.get("grant_type")).toBe("refresh_token");
				expect(init.body.get("refresh_token")).toBe("stored-refresh-token");
				expect(init.body.get("client_secret")).toBe("client-secret");
				return Response.json({
					access_token: "refreshed-access-token",
					refresh_token: "rotated-refresh-token",
					expires_in: 14400,
					scope: ["user:read:chat", "user:write:chat", "user:bot"]
				});
			}

			expect(input).toBe("https://api.twitch.tv/helix/chat/messages");
			expect(init.headers.Authorization).toBe("Bearer refreshed-access-token");
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, {
			...oauthEnv,
			TWITCH_EVENTSUB_SECRET: secret
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await runInDurableObject(twitchAuthStub(), async (_instance, state) => {
			const stored = await state.storage.get("oauthTokens");
			expect(stored).toMatchObject({
				accessToken: "refreshed-access-token",
				refreshToken: "rotated-refresh-token",
				clientId: "client-id"
			});
		});
	});

	it("refreshes and retries once when Twitch rejects a stored access token", async () => {
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
		await storeTwitchTokens();
		let chatRequests = 0;
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "replacement-access-token",
					refresh_token: "replacement-refresh-token",
					expires_in: 14400,
					scope: ["user:read:chat", "user:write:chat", "user:bot"]
				});
			}

			expect(input).toBe("https://api.twitch.tv/helix/chat/messages");
			chatRequests += 1;
			if (chatRequests === 1) {
				expect(init.headers.Authorization).toBe("Bearer stored-access-token");
				return new Response("Unauthorized", { status: 401 });
			}
			expect(init.headers.Authorization).toBe("Bearer replacement-access-token");
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, {
			...oauthEnv,
			TWITCH_EVENTSUB_SECRET: secret
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
			"https://api.twitch.tv/helix/chat/messages",
			"https://id.twitch.tv/oauth2/token",
			"https://api.twitch.tv/helix/chat/messages"
		]);
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

describe("Twitch OAuth", () => {
	it("protects OAuth setup with a dedicated bearer token", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/twitch/oauth/start", { method: "POST" }),
			oauthEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Unauthorized");
	});

	it("creates an authorization URL with the bot scopes and exact callback", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/twitch/oauth/start", {
				method: "POST",
				headers: { Authorization: "Bearer setup-token" }
			}),
			oauthEnv,
			createExecutionContext()
		);
		const result = await response.json();
		const authorizationUrl = new URL(result.authorizationUrl);

		expect(response.status).toBe(200);
		expect(authorizationUrl.origin + authorizationUrl.pathname)
			.toBe("https://id.twitch.tv/oauth2/authorize");
		expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
		expect(authorizationUrl.searchParams.get("redirect_uri"))
			.toBe("https://example.com/twitch/oauth/callback");
		expect(authorizationUrl.searchParams.get("scope").split(" ").sort()).toEqual([
			"user:bot",
			"user:read:chat",
			"user:write:chat"
		]);
		expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
		expect(authorizationUrl.searchParams.get("force_verify")).toBe("true");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("exchanges the callback and stores validated OAuth tokens", async () => {
		const startResponse = await worker.fetch(
			new Request("https://example.com/twitch/oauth/start", {
				method: "POST",
				headers: { Authorization: "Bearer setup-token" }
			}),
			oauthEnv,
			createExecutionContext()
		);
		const { authorizationUrl } = await startResponse.json();
		const state = new URL(authorizationUrl).searchParams.get("state");
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				expect(init.method).toBe("POST");
				expect(init.body.get("client_secret")).toBe("client-secret");
				return Response.json({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 14400,
					scope: ["user:read:chat", "user:write:chat", "user:bot"]
				});
			}

			expect(input).toBe("https://id.twitch.tv/oauth2/validate");
			expect(init.headers.Authorization).toBe("OAuth new-access-token");
			return Response.json({
				client_id: "client-id",
				login: "elmybot",
				user_id: "bot-user-id",
				scopes: ["user:read:chat", "user:write:chat", "user:bot"],
				expires_in: 14400
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			new Request(`https://example.com/twitch/oauth/callback?code=auth-code&state=${state}`),
			oauthEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("authorization stored");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await runInDurableObject(twitchAuthStub(), async (_instance, state) => {
			const stored = await state.storage.get("oauthTokens");
			expect(stored).toMatchObject({
				accessToken: "new-access-token",
				refreshToken: "new-refresh-token",
				clientId: "client-id",
				userId: "bot-user-id",
				login: "elmybot"
			});
		});

		const replay = await worker.fetch(
			new Request(`https://example.com/twitch/oauth/callback?code=auth-code&state=${state}`),
			oauthEnv,
			createExecutionContext()
		);
		expect(replay.status).toBe(400);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
