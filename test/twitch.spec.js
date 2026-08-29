import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createExecutionContext,
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/index.js";
import { TWITCH_APP_AUTH_OBJECT_NAME } from "../src/platforms/twitch/app-auth.js";
import { TWITCH_AUTH_OBJECT_NAME } from "../src/platforms/twitch/auth.js";
import { twitchChannelAuthObjectName } from "../src/platforms/twitch/channel-auth.js";
import {
	handleTwitchChannelHealth,
	TWITCH_CHANNEL_REGISTRY_NAME
} from "../src/platforms/twitch/channel-registry.js";
import {
	ensureTwitchChatSubscription,
	twitchEventSubManagerObjectName
} from "../src/platforms/twitch/eventsub.js";
import { twitchEventSubInboxStub } from "../src/platforms/twitch/eventsub-inbox.js";

const encoder = new TextEncoder();
let twitchMessageIdCounter = 0;
const oauthEnv = {
	...env,
	TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
	TWITCH_PUBLIC_ORIGIN: "https://example.com",
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

function twitchAppAuthStub() {
	return env.TWITCH_APP_AUTH.get(
		env.TWITCH_APP_AUTH.idFromName(TWITCH_APP_AUTH_OBJECT_NAME)
	);
}

function twitchEventSubManagerStub(broadcasterUserId = "broadcaster-id") {
	const name = twitchEventSubManagerObjectName(broadcasterUserId);
	return env.TWITCH_EVENTSUB_MANAGER.get(
		env.TWITCH_EVENTSUB_MANAGER.idFromName(name)
	);
}

function twitchChannelRegistryStub() {
	return env.TWITCH_CHANNEL_REGISTRY.get(
		env.TWITCH_CHANNEL_REGISTRY.idFromName(TWITCH_CHANNEL_REGISTRY_NAME)
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

async function storeTwitchAppToken(overrides = {}) {
	await runInDurableObject(twitchAppAuthStub(), async (_instance, state) => {
		await state.storage.put("appAccessToken", {
			accessToken: "stored-app-access-token",
			clientId: "client-id",
			obtainedAtMs: Date.now(),
			expiresAtMs: Date.now() + 4 * 60 * 60 * 1000,
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
	messageId,
	messageType = "notification",
	timestamp = new Date().toISOString()
}) {
	const resolvedMessageId = messageId ?? `message-id-${++twitchMessageIdCounter}`;
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
		encoder.encode(resolvedMessageId + timestamp + body)
	);

	return new Request("https://example.com/twitch", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Twitch-Eventsub-Message-Id": resolvedMessageId,
			"Twitch-Eventsub-Message-Timestamp": timestamp,
			"Twitch-Eventsub-Message-Signature": `sha256=${toHex(new Uint8Array(signature))}`,
			"Twitch-Eventsub-Message-Type": messageType
		},
		body
	});
}

function successfulTwitchChatResponse(messageId = "sent-message-id") {
	return Response.json({
		data: [{
			message_id: messageId,
			is_sent: true,
			drop_reason: null
		}]
	});
}

async function runAliveCommandWithFetch(fetchImplementation, broadcasterUserId) {
	const request = await makeSignedTwitchRequest({
		body: JSON.stringify({
			subscription: {
				type: "channel.chat.message",
				condition: { broadcaster_user_id: broadcasterUserId }
			},
			event: {
				broadcaster_user_id: broadcasterUserId,
				chatter_user_id: "chatter-id",
				message: { text: "!alive" }
			}
		})
	});
	await storeTwitchAppToken();
	const fetchMock = vi.fn(fetchImplementation);
	vi.stubGlobal("fetch", fetchMock);
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, eventSubEnv, ctx);
	await waitOnExecutionContext(ctx);
	return {
		response,
		fetchMock,
		errorLogs: errorSpy.mock.calls.map(([entry]) => JSON.parse(entry))
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await runInDurableObject(
		twitchAppAuthStub(),
		async (_instance, state) => state.storage.deleteAll()
	);
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

	it("reports the safe Twitch deployment identity to authorized operators", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/twitch/configuration", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			oauthEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			deploymentEnvironment: "test",
			publicOrigin: "https://example.com",
			clientId: "client-id",
			botUserId: "bot-user-id"
		});
	});

	it("rejects Twitch requests sent through a noncanonical origin", async () => {
		const response = await worker.fetch(
			new Request("https://other.example/twitch/oauth/start", {
				method: "POST",
				headers: { Authorization: "Bearer setup-token" }
			}),
			oauthEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(421);
		expect(await response.text()).toContain("configured Twitch public origin");
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
			{ ...oauthEnv, TWITCH_EVENTSUB_SECRET: secret },
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
			{ ...oauthEnv, TWITCH_EVENTSUB_SECRET: "eventsub-secret" },
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
					chatter_user_id: "chatter-id",
					message: { text: "!alive" }
				}
			}),
			secret
		});
		await storeTwitchAppToken();
		const fetchMock = vi.fn(async (_input, init) => {
			expect(init.signal).toBeInstanceOf(AbortSignal);
			return successfulTwitchChatResponse();
		});
		vi.stubGlobal("fetch", fetchMock);
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, {
			...env,
			TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
			TWITCH_PUBLIC_ORIGIN: "https://example.com",
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
			Authorization: "Bearer stored-app-access-token",
			"Client-Id": "client-id"
		});
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			broadcaster_id: "broadcaster-id",
			sender_id: "bot-user-id",
			message: "I'm here!!1"
		});
	});

	it("acknowledges a duplicate notification without running its command twice", async () => {
		const broadcasterUserId = "duplicate-command-broadcaster";
		const body = JSON.stringify({
			subscription: {
				type: "channel.chat.message",
				condition: { broadcaster_user_id: broadcasterUserId }
			},
			event: {
				broadcaster_user_id: broadcasterUserId,
				chatter_user_id: "chatter-id",
				message: { text: "!alive" }
			}
		});
		const requestOptions = {
			body,
			messageId: "duplicate-notification-id",
			timestamp: new Date().toISOString()
		};
		await storeTwitchAppToken();
		const fetchMock = vi.fn(async () => successfulTwitchChatResponse());
		vi.stubGlobal("fetch", fetchMock);

		const firstContext = createExecutionContext();
		const firstResponse = await worker.fetch(
			await makeSignedTwitchRequest(requestOptions),
			eventSubEnv,
			firstContext
		);
		await waitOnExecutionContext(firstContext);

		const secondContext = createExecutionContext();
		const secondResponse = await worker.fetch(
			await makeSignedTwitchRequest(requestOptions),
			eventSubEnv,
			secondContext
		);
		await waitOnExecutionContext(secondContext);

		expect(firstResponse.status).toBe(204);
		expect(secondResponse.status).toBe(204);
		expect(fetchMock).toHaveBeenCalledOnce();
		await runInDurableObject(
			twitchEventSubInboxStub(env, broadcasterUserId),
			async (_instance, state) => {
				const rows = state.storage.sql.exec(
					"SELECT message_id, status FROM eventsub_inbox"
				).toArray();
				expect(rows).toEqual([{
					message_id: "duplicate-notification-id",
					status: "completed"
				}]);
			}
		);
	});

	it("replaces an expiring app token before sending a chat message", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: { type: "channel.chat.message" },
				event: {
					broadcaster_user_id: "broadcaster-id",
					chatter_user_id: "chatter-id",
					message: { text: "!alive" }
				}
			}),
			secret
		});
		await storeTwitchAppToken({ expiresAtMs: Date.now() + 30 * 1000 });
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				expect(init.body.get("grant_type")).toBe("client_credentials");
				expect(init.body.get("client_id")).toBe("client-id");
				expect(init.body.get("client_secret")).toBe("client-secret");
				return Response.json({
					access_token: "refreshed-app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}

			expect(input).toBe("https://api.twitch.tv/helix/chat/messages");
			expect(init.headers.Authorization).toBe("Bearer refreshed-app-access-token");
			return successfulTwitchChatResponse();
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
		await runInDurableObject(twitchAppAuthStub(), async (_instance, state) => {
			const stored = await state.storage.get("oauthTokens");
			const appToken = await state.storage.get("appAccessToken");
			expect(stored).toBeUndefined();
			expect(appToken).toMatchObject({
				accessToken: "refreshed-app-access-token",
				clientId: "client-id"
			});
		});
	});

	it("refreshes and retries once when Twitch rejects a stored app token", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: { type: "channel.chat.message" },
				event: {
					broadcaster_user_id: "broadcaster-id",
					chatter_user_id: "chatter-id",
					message: { text: "!alive" }
				}
			}),
			secret
		});
		await storeTwitchAppToken();
		let chatRequests = 0;
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "replacement-app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}

			expect(input).toBe("https://api.twitch.tv/helix/chat/messages");
			chatRequests += 1;
			if (chatRequests === 1) {
				expect(init.headers.Authorization).toBe("Bearer stored-app-access-token");
				return new Response("Unauthorized", { status: 401 });
			}
			expect(init.headers.Authorization).toBe("Bearer replacement-app-access-token");
			return successfulTwitchChatResponse();
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

	it("sends with the app token without coupling delivery to bot-token validation", async () => {
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: { type: "channel.chat.message" },
				event: {
					broadcaster_user_id: "broadcaster-id",
					chatter_user_id: "chatter-id",
					message: { text: "!alive" }
				}
			}),
			secret
		});
		await storeTwitchTokens({ lastValidatedAtMs: Date.now() - 61 * 60 * 1000 });
		await storeTwitchAppToken();
		const fetchMock = vi.fn(async (input, init) => {
			expect(input).toBe("https://api.twitch.tv/helix/chat/messages");
			expect(init.headers.Authorization).toBe("Bearer stored-app-access-token");
			return successfulTwitchChatResponse();
		});
		vi.stubGlobal("fetch", fetchMock);
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, {
			...oauthEnv,
			TWITCH_EVENTSUB_SECRET: secret
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(204);
		expect(fetchMock).toHaveBeenCalledOnce();
		await runInDurableObject(twitchAuthStub(), async (_instance, state) => {
			const stored = await state.storage.get("oauthTokens");
			expect(stored.lastValidatedAtMs).toBeLessThan(Date.now() - 60 * 60 * 1000);
		});
	});

	it("reports a Twitch-declared chat drop with its bounded reason", async () => {
		const oversizedMessage = "x".repeat(600);
		const result = await runAliveCommandWithFetch(
			async () => Response.json({
				data: [{
					message_id: "",
					is_sent: false,
					drop_reason: {
						code: "automod_held",
						message: oversizedMessage
					}
				}]
			}),
			"dropped-message-broadcaster"
		);

		expect(result.response.status).toBe(204);
		expect(result.errorLogs).toHaveLength(1);
		expect(result.errorLogs[0]).toMatchObject({
			event: "twitch.command_failed",
			groupId: "dropped-message-broadcaster",
			error: {
				name: "TwitchChatDeliveryError",
				code: "twitch_chat_message_dropped",
				classification: "dropped",
				retryable: false,
				metadata: {
					dropReason: {
						code: "automod_held",
						message: "x".repeat(500)
					}
				}
			}
		});
	});

	it.each([
		{
			status: 400,
			classification: "invalid_request",
			code: "twitch_chat_invalid_request",
			retryable: false
		},
		{
			status: 403,
			classification: "authorization",
			code: "twitch_chat_authorization_failed",
			retryable: false
		},
		{
			status: 429,
			classification: "rate_limit",
			code: "twitch_chat_rate_limited",
			retryable: true
		},
		{
			status: 503,
			classification: "service",
			code: "twitch_chat_service_unavailable",
			retryable: true
		}
	])(
		"classifies Twitch chat HTTP $status failures",
		async ({ status, classification, code, retryable }) => {
			const result = await runAliveCommandWithFetch(
				async () => new Response(null, { status }),
				`http-${status}-broadcaster`
			);

			expect(result.response.status).toBe(204);
			expect(result.errorLogs).toHaveLength(1);
				expect(result.errorLogs[0].error).toMatchObject({
					name: "TwitchChatDeliveryError",
					code,
					classification,
					status,
					retryable
				});
		}
	);

	it("classifies a repeated 401 after token refresh as authentication failure", async () => {
		let chatRequests = 0;
		const result = await runAliveCommandWithFetch(async (input) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "replacement-app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			chatRequests += 1;
			return new Response("Unauthorized", { status: 401 });
		}, "authentication-failure-broadcaster");

		expect(result.response.status).toBe(204);
		expect(chatRequests).toBe(2);
		expect(result.errorLogs).toHaveLength(1);
		expect(result.errorLogs[0].error).toMatchObject({
			name: "TwitchChatDeliveryError",
			code: "twitch_chat_authentication_failed",
			classification: "authentication",
			status: 401,
			retryable: false
		});
	});

	it("classifies a malformed successful Twitch chat response", async () => {
		const result = await runAliveCommandWithFetch(
			async () => Response.json({ data: [] }),
			"invalid-chat-response-broadcaster"
		);

		expect(result.response.status).toBe(204);
		expect(result.errorLogs).toHaveLength(1);
		expect(result.errorLogs[0].error).toMatchObject({
			name: "TwitchChatDeliveryError",
			code: "twitch_chat_invalid_response",
			classification: "invalid_response",
			retryable: true
		});
	});

	it("classifies Twitch chat network failures as transient", async () => {
		const result = await runAliveCommandWithFetch(
			async () => {
				throw new TypeError("network unavailable");
			},
			"network-failure-broadcaster"
		);

		expect(result.response.status).toBe(204);
		expect(result.errorLogs).toHaveLength(1);
		expect(result.errorLogs[0].error).toMatchObject({
			name: "TwitchChatDeliveryError",
			code: "twitch_chat_network_error",
			classification: "network",
			retryable: true,
			cause: {
				name: "TypeError",
				message: "network unavailable"
			}
		});
	});

	it("acknowledges irrelevant chat messages without durable admission", async () => {
		const secret = "eventsub-secret";
		const broadcasterUserId = "filtered-chat-broadcaster";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		for (const messageText of ["hello", "!unknown"]) {
			const request = await makeSignedTwitchRequest({
				body: JSON.stringify({
					subscription: {
						type: "channel.chat.message",
						condition: { broadcaster_user_id: broadcasterUserId }
					},
					event: {
						broadcaster_user_id: broadcasterUserId,
						message: { text: messageText }
					}
				}),
				secret
			});
			const response = await worker.fetch(
				request,
				{ ...oauthEnv, TWITCH_EVENTSUB_SECRET: secret },
				createExecutionContext()
			);
			expect(response.status).toBe(204);
		}

		expect(fetchMock).not.toHaveBeenCalled();
		await runInDurableObject(
			twitchEventSubInboxStub(env, broadcasterUserId),
			async (_instance, state) => {
				const rows = state.storage.sql.exec(
					"SELECT COUNT(*) AS count FROM eventsub_inbox"
				).toArray();
				expect(rows[0].count).toBe(0);
				expect(await state.storage.getAlarm()).toBeNull();
			}
		);
	});
});

describe("Twitch EventSub management", () => {
	it("refuses to reconcile subscriptions for another environment's callback", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(ensureTwitchChatSubscription({
			broadcasterUserId: "broadcaster-id",
			callbackUrl: "https://production.example/twitch"
		}, eventSubEnv)).rejects.toMatchObject({
			code: "twitch_eventsub_environment_mismatch",
			status: 503
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("protects subscription management and app-auth status with the setup bearer token", async () => {
		const [response, appAuthResponse, compatibilityStatusResponse] = await Promise.all([
			worker.fetch(
				new Request("https://example.com/twitch/eventsub/subscriptions"),
				eventSubEnv,
				createExecutionContext()
			),
			worker.fetch(
				new Request("https://example.com/twitch/app-auth"),
				eventSubEnv,
				createExecutionContext()
			),
			worker.fetch(
				new Request("https://example.com/twitch/eventsub/service"),
				eventSubEnv,
				createExecutionContext()
			)
		]);

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Unauthorized");
		expect(appAuthResponse.status).toBe(401);
		expect(await appAuthResponse.text()).toBe("Unauthorized");
		expect(compatibilityStatusResponse.status).toBe(401);
		expect(await compatibilityStatusResponse.text()).toBe("Unauthorized");
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

	it("rejects EventSub kinds that are not installed in this deployment", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const response = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				method: "POST",
				headers: {
					Authorization: "Bearer setup-token",
					"content-type": "application/json"
				},
				body: JSON.stringify({
					broadcasterUserId: "broadcaster-id",
					kind: "twitch.stream.offline.v1"
				})
			}),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "twitch_eventsub_definition_unsupported"
		});
		expect(fetchMock).not.toHaveBeenCalled();
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

	it("shares one cached app token across concurrent EventSub requests", async () => {
		let tokenRequests = 0;
		let listRequests = 0;
		const fetchMock = vi.fn(async (input) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				tokenRequests += 1;
				return Response.json({
					access_token: "shared-app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			listRequests += 1;
			return Response.json({ data: [], pagination: {} });
		});
		vi.stubGlobal("fetch", fetchMock);

		const requests = [0, 1].map(() => worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			eventSubEnv,
			createExecutionContext()
		));
		const responses = await Promise.all(requests);

		expect(responses.map(({ status }) => status)).toEqual([200, 200]);
		expect(tokenRequests).toBe(1);
		expect(listRequests).toBe(2);

		const statusResponse = await worker.fetch(
			new Request("https://example.com/twitch/app-auth", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			eventSubEnv,
			createExecutionContext()
		);
		const statusText = await statusResponse.text();
		expect(statusResponse.status).toBe(200);
		expect(JSON.parse(statusText)).toMatchObject({
			cached: true,
			usable: true,
			clientId: "client-id"
		});
		expect(statusText).not.toContain("shared-app-access-token");
	});

	it("shares one cached app token between chat delivery and EventSub", async () => {
		let tokenRequests = 0;
		let chatRequests = 0;
		let eventSubRequests = 0;
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				tokenRequests += 1;
				return Response.json({
					access_token: "shared-cross-service-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			if (input === "https://api.twitch.tv/helix/chat/messages") {
				chatRequests += 1;
				expect(init.headers.Authorization).toBe("Bearer shared-cross-service-token");
				return successfulTwitchChatResponse();
			}
			eventSubRequests += 1;
			expect(input).toBe("https://api.twitch.tv/helix/eventsub/subscriptions");
			expect(init.headers.Authorization).toBe("Bearer shared-cross-service-token");
			return Response.json({ data: [], pagination: {} });
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatRequest = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: { type: "channel.chat.message" },
				event: {
					broadcaster_user_id: "shared-token-broadcaster",
					chatter_user_id: "chatter-id",
					message: { text: "!alive" }
				}
			})
		});
		const chatContext = createExecutionContext();
		const chatResponse = await worker.fetch(chatRequest, eventSubEnv, chatContext);
		await waitOnExecutionContext(chatContext);
		const eventSubResponse = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			eventSubEnv,
			createExecutionContext()
		);

		expect(chatResponse.status).toBe(204);
		expect(eventSubResponse.status).toBe(200);
		expect(tokenRequests).toBe(1);
		expect(chatRequests).toBe(1);
		expect(eventSubRequests).toBe(1);
	});

	it("refreshes the cached app token and retries once after a Twitch 401", async () => {
		let tokenRequests = 0;
		let listRequests = 0;
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				tokenRequests += 1;
				return Response.json({
					access_token: `app-access-token-${tokenRequests}`,
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			listRequests += 1;
			if (listRequests === 1) {
				expect(init.headers.Authorization).toBe("Bearer app-access-token-1");
				return new Response("invalid", { status: 401 });
			}
			expect(init.headers.Authorization).toBe("Bearer app-access-token-2");
			return Response.json({ data: [], pagination: {} });
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(tokenRequests).toBe(2);
		expect(listRequests).toBe(2);
	});

	it("replaces an app token before using it near expiry", async () => {
		await runInDurableObject(
			twitchAppAuthStub(),
			async (_instance, state) => state.storage.put("appAccessToken", {
				accessToken: "expiring-app-access-token",
				clientId: "client-id",
				obtainedAtMs: Date.now() - 1000,
				expiresAtMs: Date.now() + 30_000
			})
		);
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "fresh-app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			expect(init.headers.Authorization).toBe("Bearer fresh-app-access-token");
			return Response.json({ data: [], pagination: {} });
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("serializes EventSub mutations for the same broadcaster", async () => {
		let releaseFirstCreate;
		let markFirstCreateStarted;
		const firstCreateStarted = new Promise((resolve) => {
			markFirstCreateStarted = resolve;
		});
		const firstCreateRelease = new Promise((resolve) => {
			releaseFirstCreate = resolve;
		});
		let activeCreates = 0;
		let maximumActiveCreates = 0;
		let createRequests = 0;
		const fetchMock = vi.fn(async (input) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				return Response.json({
					access_token: "app-access-token",
					expires_in: 3600,
					token_type: "bearer"
				});
			}
			createRequests += 1;
			activeCreates += 1;
			maximumActiveCreates = Math.max(maximumActiveCreates, activeCreates);
			if (createRequests === 1) {
				markFirstCreateStarted();
				await firstCreateRelease;
			}
			activeCreates -= 1;
			return Response.json({
				data: [{ id: `subscription-${createRequests}` }]
			}, { status: 202 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const createRequest = () => worker.fetch(
			new Request("https://example.com/twitch/eventsub/subscriptions", {
				method: "POST",
				headers: {
					Authorization: "Bearer setup-token",
					"content-type": "application/json"
				},
				body: JSON.stringify({ broadcasterUserId: "serialized-channel-id" })
			}),
			eventSubEnv,
			createExecutionContext()
		);
		const firstResponse = createRequest();
		await firstCreateStarted;
		const secondResponse = createRequest();
		releaseFirstCreate();
		const responses = await Promise.all([firstResponse, secondResponse]);

		expect(responses.map(({ status }) => status)).toEqual([202, 202]);
		expect(createRequests).toBe(2);
		expect(maximumActiveCreates).toBe(1);
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
				authorizationMode: "moderator",
				enabled: true,
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
			channel: {
				broadcasterUserId,
				authorizationMode: "moderator",
				enabled: true
			},
			recovery: null
		});
		await runInDurableObject(
			twitchEventSubManagerStub(broadcasterUserId),
			async (_instance, state) => {
				expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
			}
		);
	});

	it("registers configured channels and aggregates their health", async () => {
		const broadcasterUserId = "aggregate-health-channel-id";
		const configureResponse = await worker.fetch(
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
		expect(configureResponse.status).toBe(202);

		await runInDurableObject(
			twitchEventSubManagerStub(broadcasterUserId),
			async (_instance, state) => {
				const channel = await state.storage.get("channelConfig");
				await state.storage.put("channelConfig", {
					...channel,
					lastResult: "existing",
					lastSubscriptionStatus: "enabled",
					lastReconciledAtMs: Date.now()
				});
			}
		);

		const response = await worker.fetch(
			new Request("https://example.com/twitch/channels/health?limit=20", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			eventSubEnv,
			createExecutionContext()
		);
		const result = await response.json();
		const channel = result.channels.find(
			(entry) => entry.broadcasterUserId === broadcasterUserId
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(result.total).toBeGreaterThanOrEqual(1);
		expect(result.summary.healthy).toBeGreaterThanOrEqual(1);
		expect(channel).toMatchObject({
			broadcasterUserId,
			authorizationMode: "moderator",
			health: "healthy",
			authorization: { required: false, status: "not_required" },
			eventSub: {
				configured: true,
				channel: {
					lastResult: "existing",
					lastSubscriptionStatus: "enabled"
				}
			}
		});
	});

	it("protects channel health and rejects unbounded pages", async () => {
		const unauthorized = await worker.fetch(
			new Request("https://example.com/twitch/channels/health"),
			eventSubEnv,
			createExecutionContext()
		);
		expect(unauthorized.status).toBe(401);

		const response = await worker.fetch(
			new Request("https://example.com/twitch/channels/health?limit=21", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			eventSubEnv,
			createExecutionContext()
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "twitch_channel_registry_error"
		});
	});

	it("bounds channel health fan-out concurrency", async () => {
		let activeComponentRequests = 0;
		let maxActiveComponentRequests = 0;
		let componentRequests = 0;
		const componentFetch = async (url) => {
			componentRequests += 1;
			activeComponentRequests += 1;
			maxActiveComponentRequests = Math.max(
				maxActiveComponentRequests,
				activeComponentRequests
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
			activeComponentRequests -= 1;
			return url.endsWith("channel-auth/status")
				? Response.json({ authorized: true })
				: Response.json({ configured: true, channel: { lastResult: "existing" } });
		};
		const channels = Array.from({ length: 10 }, (_, index) => ({
			broadcasterUserId: `bounded-health-${index}`,
			authorizationMode: "broadcaster_oauth",
			login: `bounded-health-${index}`
		}));
		const namespace = (fetch) => ({
			idFromName: (name) => name,
			get: () => ({ fetch })
		});
		const response = await handleTwitchChannelHealth(
			new Request("https://example.com/twitch/channels/health?limit=20"),
			{
				TWITCH_CHANNEL_REGISTRY: namespace(async () => Response.json({
					total: channels.length,
					channels,
					nextCursor: null
				})),
				TWITCH_EVENTSUB_MANAGER: namespace(componentFetch),
				TWITCH_CHANNEL_AUTH: namespace(componentFetch)
			}
		);

		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.count).toBe(channels.length);
		expect(result.channels.map((channel) => channel.broadcasterUserId)).toEqual(
			channels.map((channel) => channel.broadcasterUserId)
		);
		expect(componentRequests).toBe(20);
		expect(maxActiveComponentRequests).toBe(8);
	});

	it("paginates the central channel registry with opaque membership metadata", async () => {
		const stub = twitchChannelRegistryStub();
		for (const broadcasterUserId of [
			"zz-registry-a",
			"zz-registry-b",
			"zz-registry-c"
		]) {
			const response = await stub.fetch("https://twitch-channel-registry/channels", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					broadcasterUserId,
					authorizationMode: "broadcaster_oauth",
					login: broadcasterUserId
				})
			});
			expect(response.status).toBe(201);
		}

		const response = await stub.fetch(
			"https://twitch-channel-registry/channels?cursor=zz-registry-0&limit=2"
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			channels: [
				{ broadcasterUserId: "zz-registry-a", login: "zz-registry-a" },
				{ broadcasterUserId: "zz-registry-b", login: "zz-registry-b" }
			],
			nextCursor: "zz-registry-b"
		});
	});

	it("reports legacy channel state with the moderator authorization mode", async () => {
		const broadcasterUserId = "legacy-channel-id";
		await runInDurableObject(
			twitchEventSubManagerStub(broadcasterUserId),
			async (_instance, state) => {
				await state.storage.put("channelConfig", {
					broadcasterUserId,
					callbackUrl: "https://example.com/twitch",
					configuredAtMs: Date.now(),
					lastResult: "existing",
					consecutiveFailures: 0
				});
			}
		);

		const response = await worker.fetch(
			new Request(
				`https://example.com/twitch/eventsub/channels?broadcasterUserId=${broadcasterUserId}`,
				{ headers: { Authorization: "Bearer setup-token" } }
			),
			eventSubEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			configured: true,
			channel: {
				authorizationMode: "moderator",
				enabled: true
			}
		});
	});

	it("deconfigures a channel, removes its subscription, and blocks late recovery", async () => {
		const broadcasterUserId = "deconfigured-channel-id";
		const stub = twitchEventSubManagerStub(broadcasterUserId);
		await stub.fetch("https://twitch-eventsub-manager/configure", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				broadcasterUserId,
				callbackUrl: "https://example.com/twitch",
				authorizationMode: "broadcaster_oauth"
			})
		});

		const response = await worker.fetch(
			new Request(
				`https://example.com/twitch/eventsub/channels?broadcasterUserId=${broadcasterUserId}`,
				{
					method: "DELETE",
					headers: { Authorization: "Bearer setup-token" }
				}
			),
			eventSubEnv,
			createExecutionContext()
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			configured: false,
			channel: {
				broadcasterUserId,
				authorizationMode: "broadcaster_oauth",
				enabled: false,
				lastResult: "deconfiguration_pending"
			}
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
				return Response.json({
					data: [{
						id: "subscription-to-remove",
						type: "channel.chat.message",
						status: "enabled",
						condition: {
							broadcaster_user_id: broadcasterUserId,
							user_id: "bot-user-id"
						},
						transport: {
							method: "webhook",
							callback: "https://example.com/twitch"
						}
					}],
					pagination: {}
				});
			}
			expect(init.method).toBe("DELETE");
			expect(input).toBe(
				"https://api.twitch.tv/helix/eventsub/subscriptions?id=subscription-to-remove"
			);
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		let status = await (await stub.fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(status).toMatchObject({
			configured: false,
			channel: {
				broadcasterUserId,
				authorizationMode: "broadcaster_oauth",
				enabled: false,
				lastResult: "deconfigured",
				removedSubscriptions: 1
			},
			alarmAtMs: null
		});

		const recoveryResponse = await stub.fetch("https://twitch-eventsub-manager/recover", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				broadcasterUserId,
				callbackUrl: "https://example.com/twitch",
				reason: "notification_failures_exceeded",
				sourceSubscriptionId: "late-revocation-id"
			})
		});
		expect(recoveryResponse.status).toBe(202);
		expect(await recoveryResponse.json()).toEqual({ queued: false });
		status = await (await stub.fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(status).toMatchObject({
			recovery: null,
			alarmAtMs: null
		});
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
					"https://api.twitch.tv/helix/eventsub/subscriptions?user_id=missing-channel-id"
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
		const status = await (await stub.fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(status).toMatchObject({
			configured: true,
			channel: {
				broadcasterUserId,
				lastResult: "created",
				lastSubscriptionId: "recreated-subscription-id",
				lastSubscriptions: [
					{
						kind: "twitch.chat.message.v1",
						result: "created",
						subscriptionId: "recreated-subscription-id"
					},
					{
						kind: "twitch.stream.online.v1",
						result: "created",
						subscriptionId: "recreated-subscription-id"
					}
				],
				consecutiveFailures: 0
			}
		});
		expect(status.alarmAtMs).toBeGreaterThan(Date.now());
		const registryResponse = await twitchChannelRegistryStub().fetch(
			"https://twitch-channel-registry/channels?cursor=missing-channel-h&limit=20"
		);
		const registryPage = await registryResponse.json();
		expect(registryPage.channels).toContainEqual(expect.objectContaining({
			broadcasterUserId,
			authorizationMode: "moderator"
		}));
	});
});

describe("Twitch EventSub recovery", () => {
	it("queues and completes recovery after notification delivery failures", async () => {
		const secret = "eventsub-secret";
		const body = JSON.stringify({
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
			});
		const requestOptions = {
			body,
			secret,
			messageId: "duplicate-revocation-id",
			messageType: "revocation"
		};
		const ctx = createExecutionContext();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const response = await worker.fetch(
			await makeSignedTwitchRequest(requestOptions),
			eventSubEnv,
			ctx
		);
		await waitOnExecutionContext(ctx);
		const duplicateContext = createExecutionContext();
		const duplicateResponse = await worker.fetch(
			await makeSignedTwitchRequest(requestOptions),
			eventSubEnv,
			duplicateContext
		);
		await waitOnExecutionContext(duplicateContext);

		expect(response.status).toBe(204);
		expect(duplicateResponse.status).toBe(204);
		expect(warnSpy).toHaveBeenCalledOnce();
		const stub = twitchEventSubManagerStub();
		await runInDurableObject(stub, async (instance) => {
			instance.env = eventSubEnv;
		});
		let status = await (await stub.fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(status).toMatchObject({
			recovery: {
				reason: "notification_failures_exceeded",
				attempts: 0
			}
		});
		expect(status.alarmAtMs).toBeGreaterThan(Date.now());

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
		status = await (await stub.fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(status).toMatchObject({
			recovery: null,
			channel: {
				broadcasterUserId: "broadcaster-id",
				lastResult: "created",
				lastSubscriptionId: "replacement-subscription-id"
			}
		});
		expect(status.alarmAtMs).toBeGreaterThan(Date.now());
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
		const status = await (await stub.fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(status).toMatchObject({
			recovery: {
				attempts: 1
			}
		});
		expect(status.alarmAtMs).toBeGreaterThan(Date.now());
	});

	it("does not recreate subscriptions that require reauthorization", async () => {
		const broadcasterUserId = "reauthorization-broadcaster-id";
		const channelAuthStub = env.TWITCH_CHANNEL_AUTH.get(
			env.TWITCH_CHANNEL_AUTH.idFromName(twitchChannelAuthObjectName(broadcasterUserId))
		);
		await runInDurableObject(channelAuthStub, async (instance, state) => {
			instance.env = eventSubEnv;
			await state.storage.put("channelAuthorization", {
				status: "authorized",
				accessToken: "channel-access-token",
				refreshToken: "channel-refresh-token",
				expiresAtMs: Date.now() + 4 * 60 * 60 * 1000,
				lastValidatedAtMs: Date.now(),
				authorizedAtMs: Date.now(),
				clientId: "client-id",
				userId: broadcasterUserId,
				login: "reauthorization-broadcaster",
				scopes: ["channel:bot"],
				callbackUrl: "https://example.com/twitch",
				provisioningPending: false,
				deconfigurationPending: false
			});
		});
		const secret = "eventsub-secret";
		const request = await makeSignedTwitchRequest({
			body: JSON.stringify({
				subscription: {
					id: "revoked-subscription-id",
					status: "authorization_revoked",
					type: "channel.chat.message",
					version: "1",
					condition: {
						broadcaster_user_id: broadcasterUserId,
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
		const authorizationStatus = await (await channelAuthStub.fetch(
			"https://twitch-channel-auth/status"
		)).json();
		expect(authorizationStatus).toMatchObject({
			authorized: false,
			authorization: {
				status: "reauthorization_required",
				broadcasterUserId,
				reason: "eventsub_authorization_revoked"
			}
		});
		await runInDurableObject(channelAuthStub, async (_instance, state) => {
			const authorization = await state.storage.get("channelAuthorization");
			expect(authorization.accessToken).toBeUndefined();
			expect(authorization.refreshToken).toBeUndefined();
		});
		const eventSubStatus = await (await twitchEventSubManagerStub(
			broadcasterUserId
		).fetch("https://twitch-eventsub-manager/status")).json();
		expect(eventSubStatus).toMatchObject({
			recovery: null,
			configured: false,
			channel: {
				broadcasterUserId,
				enabled: false,
				lastResult: "deconfiguration_pending"
			}
		});
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
