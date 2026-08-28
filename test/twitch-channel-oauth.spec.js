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
	TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
	TWITCH_PUBLIC_ORIGIN: "https://example.com",
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

async function invitationStorageKey(token) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	return `channelInvitation:${hash}`;
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
	it("creates a hashed, expiring, single-use invitation behind setup authorization", async () => {
		const unauthorized = await worker.fetch(
			new Request("https://example.com/twitch/channels/invitations", { method: "POST" }),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(unauthorized.status).toBe(401);

		const response = await worker.fetch(
			new Request("https://example.com/twitch/channels/invitations", {
				method: "POST",
				headers: { Authorization: "Bearer setup-token" }
			}),
			channelOAuthEnv,
			createExecutionContext()
		);
		const result = await response.json();
		const invitationUrl = new URL(result.invitationUrl);
		const invitationToken = invitationUrl.hash.slice("#invite=".length);

		expect(response.status).toBe(201);
		expect(invitationUrl.origin + invitationUrl.pathname)
			.toBe("https://example.com/twitch/channels/connect");
		expect(invitationUrl.search).toBe("");
		expect(invitationToken).toMatch(/^[0-9a-f]{64}$/);
		expect(result.expiresAtMs).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
		expect(result.expiresAtMs).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
		await runInDurableObject(channelOAuthCoordinatorStub(), async (_instance, state) => {
			const invitations = await state.storage.list({ prefix: "channelInvitation:" });
			expect(invitations.size).toBe(1);
			expect([...invitations.keys()][0]).not.toContain(invitationToken);
			expect(JSON.stringify([...invitations.values()])).not.toContain(invitationToken);
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("serves a hardened public connection page", async () => {
		const response = await worker.fetch(
			new Request("https://example.com/twitch/channels/connect"),
			channelOAuthEnv,
			createExecutionContext()
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(html).toContain("Connect your channel");
		expect(html).toContain("Continue with Twitch");
		expect(html).toContain('action="/twitch/channels/connect"');
	});

	it("consumes an invitation once and redirects the broadcaster to Twitch", async () => {
		const invitationResponse = await worker.fetch(
			new Request("https://example.com/twitch/channels/invitations", {
				method: "POST",
				headers: { Authorization: "Bearer setup-token" }
			}),
			channelOAuthEnv,
			createExecutionContext()
		);
		const invitation = await invitationResponse.json();
		const invitationToken = new URL(invitation.invitationUrl).hash.slice("#invite=".length);
		const invitationKey = await invitationStorageKey(invitationToken);
		const makeConnectRequest = () => new Request(
			"https://example.com/twitch/channels/connect",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ invite: invitationToken })
			}
		);

		const response = await worker.fetch(
			makeConnectRequest(),
			channelOAuthEnv,
			createExecutionContext()
		);
		const authorizationUrl = new URL(response.headers.get("location"));
		expect(response.status).toBe(303);
		expect(authorizationUrl.origin + authorizationUrl.pathname)
			.toBe("https://id.twitch.tv/oauth2/authorize");
		expect(authorizationUrl.searchParams.get("scope")).toBe("channel:bot");
		expect(authorizationUrl.searchParams.get("state")).toBeTruthy();

		const replay = await worker.fetch(
			makeConnectRequest(),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(replay.status).toBe(400);
		expect(await replay.text()).toContain("invalid, expired, or has already been used");
		await runInDurableObject(channelOAuthCoordinatorStub(), async (_instance, state) => {
			expect(await state.storage.get(invitationKey)).toBeUndefined();
			expect((await state.storage.list({ prefix: "channelOAuthState:" })).size).toBe(1);
		});
	});

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
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("Elmybot is ready");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await runInDurableObject(channelAuthStub(), async (_instance, durableState) => {
			const authorization = await durableState.storage.get("channelAuthorization");
			expect(authorization.refreshToken).toBe("broadcaster-refresh-token");
			expect(await durableState.storage.getAlarm()).toBeGreaterThan(Date.now());
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
		const eventSubStatus = await (await eventSubManagerStub().fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(eventSubStatus).toMatchObject({
			configured: true,
			channel: {
				broadcasterUserId: "broadcaster-id",
				callbackUrl: "https://example.com/twitch",
				authorizationMode: "broadcaster_oauth",
				enabled: true
			}
		});

		const healthResponse = await worker.fetch(
			new Request("https://example.com/twitch/channels/health?limit=25", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			channelOAuthEnv,
			createExecutionContext()
		);
		const health = await healthResponse.json();
		expect(healthResponse.status).toBe(200);
		expect(health.channels.find(
			(channel) => channel.broadcasterUserId === "broadcaster-id"
		)).toMatchObject({
			login: "broadcaster",
			authorizationMode: "broadcaster_oauth",
			health: "pending",
			authorization: { authorized: true },
			eventSub: { configured: true }
		});

		const replayResponse = await worker.fetch(
			new Request(callbackUrl),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(replayResponse.status).toBe(400);
		expect(await replayResponse.text()).toContain("invalid or expired");
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
		const status = await (await stub.fetch(
			"https://twitch-channel-auth/status"
		)).json();
		expect(status).toMatchObject({
			authorized: true,
			authorization: { status: "authorized", broadcasterUserId: "broadcaster-id" }
		});
		await runInDurableObject(stub, async (_instance, state) => {
			const authorization = await state.storage.get("channelAuthorization");
			expect(authorization.refreshToken).toBe("rotated-refresh-token");
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
	});

	it("requires reauthorization and deconfigures the channel after refresh rejection", async () => {
		const broadcasterUserId = "reauthorization-channel-id";
		const stub = await storeChannelAuthorization({ userId: broadcasterUserId });
		const configurationResponse = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/channels", {
				method: "POST",
				headers: {
					Authorization: "Bearer setup-token",
					"content-type": "application/json"
				},
				body: JSON.stringify({
					broadcasterUserId,
					authorizationMode: "broadcaster_oauth"
				})
			}),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(configurationResponse.status).toBe(202);
		const fetchMock = vi.fn(async (input) => {
			if (input === "https://id.twitch.tv/oauth2/validate") {
				return new Response("invalid", { status: 401 });
			}
			return new Response("invalid refresh", { status: 400 });
		});
		vi.stubGlobal("fetch", fetchMock);

		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const authorizationStatus = await (await stub.fetch(
			"https://twitch-channel-auth/status"
		)).json();
		expect(authorizationStatus).toMatchObject({
			authorized: false,
			authorization: {
				status: "reauthorization_required",
				broadcasterUserId,
				reason: "twitch_channel_oauth_refresh_rejected"
			}
		});
		await runInDurableObject(stub, async (_instance, state) => {
			const authorization = await state.storage.get("channelAuthorization");
			expect(authorization.accessToken).toBeUndefined();
			expect(authorization.refreshToken).toBeUndefined();
			expect(await state.storage.getAlarm()).toBeNull();
		});
		const eventSubStatus = await (await eventSubManagerStub(broadcasterUserId).fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(eventSubStatus).toMatchObject({
			configured: false,
			channel: {
				broadcasterUserId,
				enabled: false,
				lastResult: "deconfiguration_pending"
			}
		});
		const healthResponse = await worker.fetch(
			new Request("https://example.com/twitch/channels/health?limit=25", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			channelOAuthEnv,
			createExecutionContext()
		);
		const health = await healthResponse.json();
		expect(health.channels.find(
			(channel) => channel.broadcasterUserId === broadcasterUserId
		)).toMatchObject({
			health: "reauthorization_required",
			authorization: {
				authorized: false,
				authorization: { status: "reauthorization_required" }
			},
			eventSub: { configured: false }
		});
	});

	it("disconnects locally, revokes the token, and deconfigures the channel", async () => {
		await storeChannelAuthorization();
		const manager = eventSubManagerStub();
		const configurationResponse = await worker.fetch(
			new Request("https://example.com/twitch/eventsub/channels", {
			method: "POST",
			headers: {
				Authorization: "Bearer setup-token",
				"content-type": "application/json"
			},
				body: JSON.stringify({
					broadcasterUserId: "broadcaster-id",
					authorizationMode: "broadcaster_oauth"
				})
			}),
			channelOAuthEnv,
			createExecutionContext()
		);
		expect(configurationResponse.status).toBe(202);
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
		const eventSubStatus = await (await manager.fetch(
			"https://twitch-eventsub-manager/status"
		)).json();
		expect(eventSubStatus).toMatchObject({
			configured: false,
			channel: {
				enabled: false,
				lastResult: "deconfiguration_pending"
			}
		});
		const healthResponse = await worker.fetch(
			new Request("https://example.com/twitch/channels/health?limit=25", {
				headers: { Authorization: "Bearer setup-token" }
			}),
			channelOAuthEnv,
			createExecutionContext()
		);
		const health = await healthResponse.json();
		expect(health.channels.some(
			(channel) => channel.broadcasterUserId === "broadcaster-id"
		)).toBe(false);
	});
});
