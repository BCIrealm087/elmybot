import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createExecutionContext,
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/index.js";
import { TWITCH_AUTH_OBJECT_NAME } from "../src/platforms/twitch/auth.js";
import {
	twitchEventSubManagerObjectName
} from "../src/platforms/twitch/eventsub.js";

const encoder = new TextEncoder();
const oauthEnv = {
	...env,
	TWITCH_OAUTH_SETUP_TOKEN: "setup-token",
	TWITCH_CLIENT_ID: "client-id",
	TWITCH_CLIENT_SECRET: "client-secret",
	TWITCH_BOT_USER_ID: "bot-user-id"
};
const eventSubEnv = {
	...oauthEnv,
	TWITCH_EVENTSUB_SECRET: "eventsub-secret"
};

function twitchAuthStub() {
	return env.TWITCH_AUTH.get(env.TWITCH_AUTH.idFromName(TWITCH_AUTH_OBJECT_NAME));
}

function twitchEventSubManagerStub(broadcasterUserId = "broadcaster-id") {
	const name = twitchEventSubManagerObjectName(broadcasterUserId);
	return env.TWITCH_EVENTSUB_MANAGER.get(
		env.TWITCH_EVENTSUB_MANAGER.idFromName(name)
	);
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

	it("validates a stale OAuth session before sending a chat message", async () => {
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
		await storeTwitchTokens({ lastValidatedAtMs: Date.now() - 61 * 60 * 1000 });
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/validate") {
				expect(init.headers.Authorization).toBe("OAuth stored-access-token");
				return Response.json({
					client_id: "client-id",
					login: "elmybot",
					user_id: "bot-user-id",
					scopes: ["user:read:chat", "user:write:chat", "user:bot"],
					expires_in: 10800
				});
			}

			expect(input).toBe("https://api.twitch.tv/helix/chat/messages");
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
			"https://id.twitch.tv/oauth2/validate",
			"https://api.twitch.tv/helix/chat/messages"
		]);
		await runInDurableObject(twitchAuthStub(), async (_instance, state) => {
			const stored = await state.storage.get("oauthTokens");
			expect(stored.lastValidatedAtMs).toBeGreaterThan(Date.now() - 5000);
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
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

describe("Twitch EventSub management", () => {
	it("protects subscription management with the setup bearer token", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions"),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Unauthorized");
	});

	it("creates the bot's channel.chat.message webhook subscription", async () => {
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				expect(init.method).toBe("POST");
				expect(init.signal).toBeInstanceOf(AbortSignal);
				expect(init.body.get("grant_type")).toBe("client_credentials");
				expect(init.body.get("client_id")).toBe("client-id");
				expect(init.body.get("client_secret")).toBe("client-secret");
				return Response.json({
					access_token: "app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}

			expect(input).toBe("https://api.twitch.tv/helix/eventsub/subscriptions");
			expect(init.method).toBe("POST");
			expect(init.headers).toMatchObject({
				Authorization: "Bearer app-access-token",
				"Client-Id": "client-id",
				"content-type": "application/json"
			});
			expect(JSON.parse(init.body)).toEqual({
				type: "channel.chat.message",
				version: "1",
				condition: {
					broadcaster_user_id: "broadcaster-id",
					user_id: "bot-user-id"
				},
				transport: {
					method: "webhook",
					callback: "https://example.com/twitch",
					secret: "eventsub-secret"
				}
			});
			return Response.json({
				data: [{ id: "subscription-id", status: "webhook_callback_verification_pending" }],
				total: 1,
				total_cost: 0,
				max_total_cost: 10000
			}, { status: 202 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				method: "POST",
				headers: {
					Authorization: "Bearer setup-token",
					"content-type": "application/json"
				},
				body: JSON.stringify({ broadcasterUserId: "broadcaster-id" })
			}),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			data: [{ id: "subscription-id", status: "webhook_callback_verification_pending" }]
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("lists EventSub subscriptions and preserves supported filters", async () => {
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}

			expect(input).toBe(
				"https://api.twitch.tv/helix/eventsub/subscriptions?status=enabled&after=next-page"
			);
			expect(init.method).toBe("GET");
			expect(init.headers).toMatchObject({
				Authorization: "Bearer app-access-token",
				"Client-Id": "client-id"
			});
			return Response.json({
				data: [{ id: "subscription-id", status: "enabled" }],
				total: 1,
				pagination: {}
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			new Request(
				"https://example.com/twitch/eventsub/subscriptions?status=enabled&after=next-page",
				{ headers: { Authorization: "Bearer setup-token" } }
			),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: [{ id: "subscription-id", status: "enabled" }]
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects a create request without a broadcaster ID before calling Twitch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				method: "POST",
				headers: {
					Authorization: "Bearer setup-token",
					"content-type": "application/json"
				},
				body: JSON.stringify({})
			}),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "twitch_eventsub_error"
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stores per-channel desired state and exposes its status", async () => {
		const broadcasterUserId = "configured-channel-id";
		const response = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/channels", {
				method: "POST",
				headers: {
					Authorization: "Bearer setup-token",
					"content-type": "application/json"
				},
				body: JSON.stringify({ broadcasterUserId })
			}),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			configured: true,
			channel: {
				broadcasterUserId,
				callbackUrl: "https://example.com/twitch",
				lastResult: "pending"
			}
		});

		const statusResponse = await worker.fetch(
			new Request(
				`https://example.com/twitch/eventsub/channels?broadcasterUserId=${broadcasterUserId}`,
				{ headers: { Authorization: "Bearer setup-token" } }
			),
			eventSubEnv,
			createExecutionContext()
		);
		expect(statusResponse.status).toBe(200);
		expect(await statusResponse.json()).toMatchObject({
			configured: true,
			channel: { broadcasterUserId },
			recovery: null
		});
		await runInDurableObject(
			twitchEventSubManagerStub(broadcasterUserId),
			async (_instance, state) => {
				expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
			}
		);
	});

	it("recreates a configured channel subscription when reconciliation finds none", async () => {
		const broadcasterUserId = "missing-channel-id";
		const stub = twitchEventSubManagerStub(broadcasterUserId);
		await stub.fetch("https://twitch-eventsub-manager/configure", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				broadcasterUserId,
				callbackUrl: "https://example.com/twitch"
			})
		});
		await runInDurableObject(stub, async (instance) => {
			instance.env = eventSubEnv;
		});

		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			if (init.method === "GET") {
				expect(input).toBe(
					"https://api.twitch.tv/helix/eventsub/subscriptions?type=channel.chat.message"
				);
				return Response.json({ data: [], pagination: {} });
			}

			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body).condition.broadcaster_user_id)
				.toBe(broadcasterUserId);
			return Response.json({
				data: [{
					id: "recreated-subscription-id",
					status: "webhook_callback_verification_pending"
				}]
			}, { status: 202 });
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get("channelConfig")).toMatchObject({
				broadcasterUserId,
				lastResult: "created",
				lastSubscriptionId: "recreated-subscription-id",
				consecutiveFailures: 0
			});
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});
});

describe("Twitch EventSub recovery", () => {
	it("queues and completes recovery after notification delivery failures", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: {
					id: "revoked-subscription-id",
					status: "notification_failures_exceeded",
					type: "channel.chat.message",
					version: "1",
					condition: {
						broadcaster_user_id: "broadcaster-id",
						user_id: "bot-user-id"
					},
					transport: {
						method: "webhook",
						callback: "https://example.com/twitch"
					}
				}
			}),
			secret,
			messageType: "revocation"
		});
		const ctx = createExecutionContext();
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const response = await worker.fetch(request, eventSubEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		const stub = twitchEventSubManagerStub();
		await runInDurableObject(stub, async (instance, state) => {
			instance.env = eventSubEnv;
			expect(await state.storage.get("pendingRecovery")).toMatchObject({
				broadcasterUserId: "broadcaster-id",
				reason: "notification_failures_exceeded",
				sourceSubscriptionId: "revoked-subscription-id",
				attempts: 0
			});
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});

		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			if (init.method === "GET") {
				return Response.json({ data: [], pagination: {} });
			}
			expect(input).toBe("https://api.twitch.tv/helix/eventsub/subscriptions");
			return Response.json({
				data: [{
					id: "replacement-subscription-id",
					status: "webhook_callback_verification_pending"
				}]
			}, { status: 202 });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "log").mockImplementation(() => {});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get("pendingRecovery")).toBeUndefined();
			expect(await state.storage.get("channelConfig")).toMatchObject({
				broadcasterUserId: "broadcaster-id",
				lastResult: "created",
				lastSubscriptionId: "replacement-subscription-id"
			});
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("retries EventSub recovery with an alarm after a temporary failure", async () => {
		const stub = twitchEventSubManagerStub();
		await stub.fetch("https://twitch-eventsub-manager/recover", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				broadcasterUserId: "broadcaster-id",
				callbackUrl: "https://example.com/twitch",
				reason: "notification_failures_exceeded",
				sourceSubscriptionId: "revoked-subscription-id"
			})
		});
		await runInDurableObject(stub, async (instance) => {
			instance.env = eventSubEnv;
		});
		const fetchMock = vi.fn(async (input) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			return Response.json({ message: "temporarily unavailable" }, { status: 503 });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get("pendingRecovery")).toMatchObject({
				attempts: 1
			});
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("does not recreate subscriptions that require reauthorization", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: {
					id: "revoked-subscription-id",
					status: "authorization_revoked",
					type: "channel.chat.message",
					version: "1",
					condition: {
						broadcaster_user_id: "reauthorization-broadcaster-id",
						user_id: "bot-user-id"
					}
				}
			}),
			secret,
			messageType: "revocation"
		});
		const ctx = createExecutionContext();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const response = await worker.fetch(request, eventSubEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(fetchMock).not.toHaveBeenCalled();
		await runInDurableObject(
			twitchEventSubManagerStub("reauthorization-broadcaster-id"),
			async (_instance, state) => {
				expect(await state.storage.get("pendingRecovery")).toBeUndefined();
			}
		);
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
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});

		const replay = await worker.fetch(
			new Request(`https://example.com/twitch/oauth/callback?code=auth-code&state=${state}`),
			oauthEnv,
			createExecutionContext()
		);
		expect(replay.status).toBe(400);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("validates hourly by alarm and schedules the next validation", async () => {
		await storeTwitchTokens({ lastValidatedAtMs: Date.now() - 60 * 60 * 1000 });
		const stub = twitchAuthStub();
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.setAlarm(Date.now() + 60 * 1000);
		});
		const fetchMock = vi.fn(async (input, init) => {
			expect(input).toBe("https://id.twitch.tv/oauth2/validate");
			expect(init.headers.Authorization).toBe("OAuth stored-access-token");
			return Response.json({
				client_id: "client-id",
				login: "elmybot",
				user_id: "bot-user-id",
				scopes: ["user:read:chat", "user:write:chat", "user:bot"],
				expires_in: 10800
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(fetchMock).toHaveBeenCalledOnce();
		await runInDurableObject(stub, async (_instance, state) => {
			const stored = await state.storage.get("oauthTokens");
			expect(stored.lastValidatedAtMs).toBeGreaterThan(Date.now() - 5000);
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("ends the stored session when Twitch rejects both access and refresh tokens", async () => {
		await storeTwitchTokens({ lastValidatedAtMs: Date.now() - 60 * 60 * 1000 });
		const fetchMock = vi.fn(async (input) => {
			if (input === "https://id.twitch.tv/oauth2/validate") {
				return Response.json({ status: 401, message: "invalid access token" }, { status: 401 });
			}
			expect(input).toBe("https://id.twitch.tv/oauth2/token");
			return Response.json({ status: 400, message: "Invalid refresh token" }, { status: 400 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await twitchAuthStub().fetch("https://twitch-auth/oauth/access-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientId: "client-id",
				clientSecret: "client-secret",
				botUserId: "bot-user-id"
			})
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "twitch_oauth_refresh_rejected" });
		await runInDurableObject(twitchAuthStub(), async (_instance, state) => {
			expect(await state.storage.get("oauthTokens")).toBeUndefined();
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});
