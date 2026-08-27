import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createExecutionContext,
	env,
	runDurableObjectAlarm,
	runInDurableObject
} from "cloudflare:test";
import worker from "../src/index.js";
import {
	TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME,
	twitchChannelAuthObjectName
} from "../src/platforms/twitch/channel-auth.js";
import {
	twitchEventSubManagerObjectName
} from "../src/platforms/twitch/eventsub.js";

const channelOAuthEnv = {
	...env,
	TWITCH_OAUTH_SETUP_TOKEN: "setup-token",
	TWITCH_CLIENT_ID: "client-id",
	TWITCH_CLIENT_SECRET: "client-secret",
	TWITCH_BOT_USER_ID: "bot-user-id",
	TWITCH_EVENTSUB_SECRET: "eventsub-secret"
};

function channelOAuthCoordinatorStub() {
	return env.TWITCH_CHANNEL_OAUTH.get(
		env.TWITCH_CHANNEL_OAUTH.idFromName(TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME)
	);
}

function channelAuthStub(broadcasterUserId = "broadcaster-id") {
	return env.TWITCH_CHANNEL_AUTH.get(
		env.TWITCH_CHANNEL_AUTH.idFromName(twitchChannelAuthObjectName(broadcasterUserId))
	);
}

function eventSubManagerStub(broadcasterUserId = "broadcaster-id") {
	const name = twitchEventSubManagerObjectName(broadcasterUserId);
	return env.TWITCH_EVENTSUB_MANAGER.get(
		env.TWITCH_EVENTSUB_MANAGER.idFromName(name)
	);
}

async function startChannelOAuth() {
	const response = await worker.fetch(
		new Request("https://example.com/twitch/channels/oauth/start", {
			method: "POST",
			headers: { Authorization: "Bearer setup-token" }
		}),
		channelOAuthEnv,
		createExecutionContext()
	);
	return { response, result: await response.json() };
}

async function storeChannelAuthorization(overrides = {}) {
	const stub = channelAuthStub(overrides.userId ?? "broadcaster-id");
	await runInDurableObject(stub, async (instance, state) => {
		instance.env = channelOAuthEnv;
		await state.storage.put("channelAuthorization", {
			status: "authorized",
			accessToken: "channel-access-token",
			refreshToken: "channel-refresh-token",
			expiresAtMs: Date.now() + 4 * 60 * 60 * 1000,
			lastValidatedAtMs: Date.now(),
			authorizedAtMs: Date.now(),
			clientId: "client-id",
			userId: "broadcaster-id",
			login: "broadcaster",
			scopes: ["channel:bot"],
			callbackUrl: "https://example.com/twitch",
			provisioningPending: false,
			deconfigurationPending: false,
			...overrides
		});
		await state.storage.setAlarm(Date.now() + 1000);
	});
	return stub;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Twitch broadcaster OAuth", () => {
	it("protects channel OAuth start and requests only channel:bot", async () => {
		const unauthorized = await worker.fetch(
			new Request("https://example.com/twitch/channels/oauth/start", { method: "POST" }),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(unauthorized.status).toBe(401);

		const { response, result } = await startChannelOAuth();
		const authorizationUrl = new URL(result.authorizationUrl);
		expect(response.status).toBe(200);
		expect(authorizationUrl.origin + authorizationUrl.pathname)
			.toBe("https://id.twitch.tv/oauth2/authorize");
		expect(authorizationUrl.searchParams.get("redirect_uri"))
			.toBe("https://example.com/twitch/channels/oauth/callback");
		expect(authorizationUrl.searchParams.get("scope")).toBe("channel:bot");
		expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
		expect(authorizationUrl.searchParams.get("force_verify")).toBe("true");
		await runInDurableObject(channelOAuthCoordinatorStub(), async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("derives the broadcaster from Twitch, stores tokens, and configures the channel", async () => {
		const { result } = await startChannelOAuth();
		const state = new URL(result.authorizationUrl).searchParams.get("state");
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/token") {
				expect(init.body.get("code")).toBe("authorization-code");
				expect(init.body.get("redirect_uri"))
					.toBe("https://example.com/twitch/channels/oauth/callback");
				return Response.json({
					access_token: "broadcaster-access-token",
					refresh_token: "broadcaster-refresh-token",
					expires_in: 14400,
					scope: ["channel:bot"],
					token_type: "bearer"
				});
			}
			expect(input).toBe("https://id.twitch.tv/oauth2/validate");
			expect(init.headers.Authorization).toBe("OAuth broadcaster-access-token");
			return Response.json({
				client_id: "client-id",
				user_id: "broadcaster-id",
				login: "broadcaster",
				scopes: ["channel:bot"],
				expires_in: 14390
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const callbackUrl = new URL("https://example.com/twitch/channels/oauth/callback");
		callbackUrl.searchParams.set("code", "authorization-code");
		callbackUrl.searchParams.set("state", state);
		const response = await worker.fetch(
			new Request(callbackUrl),
			channelOAuthEnv,
			createExecutionContext()
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Twitch channel broadcaster authorized");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await runInDurableObject(channelAuthStub(), async (_instance, durableState) => {
			expect(await durableState.storage.get("channelAuthorization")).toMatchObject({
				status: "authorized",
				accessToken: "broadcaster-access-token",
				refreshToken: "broadcaster-refresh-token",
				clientId: "client-id",
				userId: "broadcaster-id",
				login: "broadcaster",
				scopes: ["channel:bot"],
				provisioningPending: false
			});
			expect(await durableState.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
		await runInDurableObject(eventSubManagerStub(), async (_instance, durableState) => {
			expect(await durableState.storage.get("channelConfig")).toMatchObject({
				broadcasterUserId: "broadcaster-id",
				callbackUrl: "https://example.com/twitch",
				authorizationMode: "broadcaster_oauth",
				enabled: true
			});
		});

		const statusResponse = await worker.fetch(
			new Request(
				"https://example.com/twitch/channels/oauth?broadcasterUserId=broadcaster-id",
				{ headers: { Authorization: "Bearer setup-token" } }
			),
			channelOAuthEnv,
			createExecutionContext()
		);
		const statusText = await statusResponse.text();
		expect(statusResponse.status).toBe(200);
		expect(JSON.parse(statusText)).toMatchObject({
			authorized: true,
			authorization: {
				status: "authorized",
				broadcasterUserId: "broadcaster-id",
				login: "broadcaster",
				scopes: ["channel:bot"]
			}
		});
		expect(statusText).not.toContain("broadcaster-access-token");
		expect(statusText).not.toContain("broadcaster-refresh-token");

		const replayResponse = await worker.fetch(
			new Request(callbackUrl),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(replayResponse.status).toBe(400);
		expect(await replayResponse.json()).toMatchObject({
			code: "twitch_channel_oauth_invalid_state"
		});
	});

	it("refreshes and validates a broadcaster authorization with its alarm", async () => {
		const stub = await storeChannelAuthorization();
		let validations = 0;
		const fetchMock = vi.fn(async (input, init) => {
			if (input === "https://id.twitch.tv/oauth2/validate") {
				validations += 1;
				if (validations === 1) return new Response("invalid", { status: 401 });
				expect(init.headers.Authorization).toBe("OAuth rotated-access-token");
				return Response.json({
					client_id: "client-id",
					user_id: "broadcaster-id",
					login: "broadcaster",
					scopes: ["channel:bot"],
					expires_in: 14400
				});
			}
			expect(input).toBe("https://id.twitch.tv/oauth2/token");
			expect(init.body.get("refresh_token")).toBe("channel-refresh-token");
			return Response.json({
				access_token: "rotated-access-token",
				refresh_token: "rotated-refresh-token",
				expires_in: 14400,
				scope: ["channel:bot"]
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.get("channelAuthorization")).toMatchObject({
				status: "authorized",
				accessToken: "rotated-access-token",
				refreshToken: "rotated-refresh-token"
			});
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("requires reauthorization and deconfigures the channel after refresh rejection", async () => {
		const stub = await storeChannelAuthorization();
		const fetchMock = vi.fn(async (input) => {
			if (input === "https://id.twitch.tv/oauth2/validate") {
				return new Response("invalid", { status: 401 });
			}
			return new Response("invalid refresh", { status: 400 });
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			const authorization = await state.storage.get("channelAuthorization");
			expect(authorization).toMatchObject({
				status: "reauthorization_required",
				userId: "broadcaster-id",
				reason: "twitch_channel_oauth_refresh_rejected",
				deconfigurationPending: false
			});
			expect(authorization.accessToken).toBeUndefined();
			expect(authorization.refreshToken).toBeUndefined();
			expect(await state.storage.getAlarm()).toBeNull();
		});
		await runInDurableObject(eventSubManagerStub(), async (_instance, state) => {
			expect(await state.storage.get("channelConfig")).toMatchObject({
				broadcasterUserId: "broadcaster-id",
				enabled: false,
				lastResult: "deconfiguration_pending"
			});
		});
	});

	it("disconnects locally, revokes the token, and deconfigures the channel", async () => {
		await storeChannelAuthorization();
		const manager = eventSubManagerStub();
		await manager.fetch("https://twitch-eventsub-manager/configure", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				broadcasterUserId: "broadcaster-id",
				callbackUrl: "https://example.com/twitch",
				authorizationMode: "broadcaster_oauth"
			})
		});
		const fetchMock = vi.fn(async (input, init) => {
			expect(input).toBe("https://id.twitch.tv/oauth2/revoke");
			expect(init.body.get("client_id")).toBe("client-id");
			expect(init.body.get("token")).toBe("channel-access-token");
			return new Response(null, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await worker.fetch(
			new Request(
				"https://example.com/twitch/channels/oauth?broadcasterUserId=broadcaster-id",
				{
					method: "DELETE",
					headers: { Authorization: "Bearer setup-token" }
				}
			),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			disconnected: true,
			authorization: {
				status: "disconnected",
				broadcasterUserId: "broadcaster-id",
				deconfigurationPending: false
			}
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		await runInDurableObject(channelAuthStub(), async (_instance, state) => {
			const authorization = await state.storage.get("channelAuthorization");
			expect(authorization.accessToken).toBeUndefined();
			expect(authorization.refreshToken).toBeUndefined();
			expect(await state.storage.getAlarm()).toBeNull();
		});
		await runInDurableObject(manager, async (_instance, state) => {
			expect(await state.storage.get("channelConfig")).toMatchObject({
				enabled: false,
				lastResult: "deconfiguration_pending"
			});
		});
	});
});
