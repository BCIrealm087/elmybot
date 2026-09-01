import { TWITCH_AUTH_OBJECT_NAME } from "./auth.js";
import { handleTwitchAppAuthStatus } from "./app-auth.js";
import {
	getTwitchEventSubServiceStatus,
	handleTwitchChannelConfiguration,
	handleTwitchEventSubSubscriptions
} from "./eventsub.js";
import {
	twitchChannelAuthObjectName,
	twitchChannelOAuthCoordinatorStub
} from "./channel-auth.js";
import {
	renderTwitchConnectPage,
	renderTwitchIntegrationConnectPage,
	renderTwitchIntegrationSuccess,
	renderTwitchOAuthTransition,
	renderTwitchOnboardingError,
	renderTwitchOnboardingSuccess
} from "./onboarding.js";
import { twitchPublicUrl } from "./environment.js";
import { handleTwitchChannelHealth } from "./channel-registry.js";

function twitchAuthStub(env) {
	const id = env.TWITCH_AUTH.idFromName(TWITCH_AUTH_OBJECT_NAME);
	return env.TWITCH_AUTH.get(id);
}

function oauthSetupAuthorized(request, env) {
	return typeof env.TWITCH_OAUTH_SETUP_TOKEN === "string" &&
		env.TWITCH_OAUTH_SETUP_TOKEN.length > 0 &&
		request.headers.get("authorization") === `Bearer ${env.TWITCH_OAUTH_SETUP_TOKEN}`;
}

async function startTwitchOAuth(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN) {
		return new Response("Twitch OAuth setup is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}

	return twitchAuthStub(env).fetch("https://twitch-auth/oauth/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			redirectUri: twitchPublicUrl(env, "/twitch/oauth/callback"),
			clientId: env.TWITCH_CLIENT_ID,
			clientSecret: env.TWITCH_CLIENT_SECRET,
			botUserId: env.TWITCH_BOT_USER_ID
		})
	});
}

async function finishTwitchOAuth(request, env) {
	const url = new URL(request.url);
	if (url.searchParams.has("error")) {
		return new Response("Twitch authorization was denied.", {
			status: 400,
			headers: { "cache-control": "no-store" }
		});
	}

	const response = await twitchAuthStub(env).fetch("https://twitch-auth/oauth/callback", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			code: url.searchParams.get("code"),
			state: url.searchParams.get("state"),
			redirectUri: twitchPublicUrl(env, "/twitch/oauth/callback"),
			clientId: env.TWITCH_CLIENT_ID,
			clientSecret: env.TWITCH_CLIENT_SECRET,
			botUserId: env.TWITCH_BOT_USER_ID
		})
	});
	if (!response.ok) return response;

	return new Response("Twitch bot authorization stored. You can close this tab.", {
		headers: {
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
			"referrer-policy": "no-referrer"
		}
	});
}

function requestTwitchChannelOAuthStart(env, {
	invitationToken,
	integrationInvitationToken
} = {}) {
	return twitchChannelOAuthCoordinatorStub(env).fetch(
		"https://twitch-channel-oauth/oauth/start",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				redirectUri: twitchPublicUrl(env, "/twitch/channels/oauth/callback"),
				callbackUrl: twitchPublicUrl(env, "/twitch"),
				clientId: env.TWITCH_CLIENT_ID,
				clientSecret: env.TWITCH_CLIENT_SECRET,
				...(invitationToken === undefined ? {} : { invitationToken }),
				...(integrationInvitationToken === undefined
					? {}
					: { integrationInvitationToken })
			})
		}
	);
}

async function startTwitchChannelOAuth(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN || !env.TWITCH_CHANNEL_OAUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}
	return requestTwitchChannelOAuthStart(env);
}

async function createTwitchChannelInvitation(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN || !env.TWITCH_CHANNEL_OAUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}
	return twitchChannelOAuthCoordinatorStub(env).fetch(
		"https://twitch-channel-oauth/invitations/create",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				connectUrl: twitchPublicUrl(env, "/twitch/channels/connect")
			})
		}
	);
}

async function beginInvitedTwitchChannelOAuth(request, env) {
	if (!env.TWITCH_CHANNEL_OAUTH) {
		return renderTwitchOnboardingError(
			"Channel onboarding is temporarily unavailable.",
			503
		);
	}
	let invitationToken;
	try {
		invitationToken = (await request.formData()).get("invite");
	} catch {
		return renderTwitchOnboardingError("This invitation is invalid or expired.");
	}
	const response = await requestTwitchChannelOAuthStart(env, { invitationToken });
	if (!response.ok) {
		await response.text();
		return renderTwitchOnboardingError(
			response.status >= 500
				? "Channel onboarding is temporarily unavailable. Please try again later."
				: "This invitation is invalid, expired, or has already been used.",
			response.status >= 500 ? 503 : 400
		);
	}
	const result = await response.json();
	return renderTwitchOAuthTransition(result.authorizationUrl);
}

async function beginInvitedTwitchIntegrationOAuth(request, env) {
	if (!env.TWITCH_CHANNEL_OAUTH || !env.INTEGRATION_REGISTRY) {
		return renderTwitchOnboardingError(
			"Integration linking is temporarily unavailable.",
			503
		);
	}
	let integrationInvitationToken;
	try {
		integrationInvitationToken = (await request.formData()).get("invite");
	} catch {
		return renderTwitchOnboardingError("This integration invitation is invalid or expired.");
	}
	const response = await requestTwitchChannelOAuthStart(env, {
		integrationInvitationToken
	});
	if (!response.ok) {
		await response.text();
		return renderTwitchOnboardingError(
			response.status >= 500
				? "Integration linking is temporarily unavailable. Please try again later."
				: "This integration invitation is invalid, expired, or has already been used.",
			response.status >= 500 ? 503 : 400
		);
	}
	const result = await response.json();
	return renderTwitchOAuthTransition(result.authorizationUrl);
}

async function finishTwitchChannelOAuth(request, env) {
	if (!env.TWITCH_CHANNEL_OAUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	const url = new URL(request.url);
	if (url.searchParams.has("error")) {
		return renderTwitchOnboardingError("Twitch channel authorization was denied.");
	}
	const response = await twitchChannelOAuthCoordinatorStub(env).fetch(
		"https://twitch-channel-oauth/oauth/callback",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				code: url.searchParams.get("code"),
				state: url.searchParams.get("state"),
				redirectUri: twitchPublicUrl(env, "/twitch/channels/oauth/callback"),
				clientId: env.TWITCH_CLIENT_ID,
				clientSecret: env.TWITCH_CLIENT_SECRET
			})
		}
	);
	if (!response.ok) {
		await response.text();
		return renderTwitchOnboardingError(
			response.status >= 500
				? "Twitch authorization is temporarily unavailable. Please try again later."
				: "This authorization link is invalid or expired.",
			response.status >= 500 ? 503 : 400
		);
	}
	const result = await response.json();
	const channel = result.authorization?.login || result.authorization?.broadcasterUserId;
	if (result.integrationError) {
		return renderTwitchOnboardingError(
			"The Twitch channel was authorized, but the Discord integration invitation could not be completed. Ask a server manager to create a new invitation."
		);
	}
	if (result.integration || result.integrationPending) {
		return renderTwitchIntegrationSuccess(
			channel,
			result.integration,
			result.integrationPending
		);
	}
	return renderTwitchOnboardingSuccess(channel);
}

function twitchChannelAuthStub(env, broadcasterUserId) {
	return env.TWITCH_CHANNEL_AUTH.get(
		env.TWITCH_CHANNEL_AUTH.idFromName(twitchChannelAuthObjectName(broadcasterUserId))
	);
}

async function handleTwitchChannelAuthorization(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN || !env.TWITCH_CHANNEL_AUTH) {
		return new Response("Twitch channel OAuth is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}
	const broadcasterUserId = new URL(request.url).searchParams.get("broadcasterUserId");
	if (!broadcasterUserId) {
		return new Response("broadcasterUserId is required.", { status: 400 });
	}
	if (request.method === "GET") {
		return twitchChannelAuthStub(env, broadcasterUserId).fetch(
			"https://twitch-channel-auth/status"
		);
	}
	if (request.method === "DELETE") {
		return twitchChannelAuthStub(env, broadcasterUserId).fetch(
			"https://twitch-channel-auth/authorization",
			{ method: "DELETE" }
		);
	}
	return new Response("Method Not Allowed", { status: 405 });
}

function requireSetupAuthorization(request, env) {
	if (!env.TWITCH_OAUTH_SETUP_TOKEN) {
		return new Response("Twitch setup is not configured.", { status: 503 });
	}
	if (!oauthSetupAuthorized(request, env)) {
		return new Response("Unauthorized", { status: 401 });
	}
	return null;
}

export async function handleTwitchManagementRoute(
	request,
	env,
	environmentConfiguration
) {
	const url = new URL(request.url);
	if (url.pathname === "/twitch") return null;

	if (url.pathname === "/twitch/configuration") {
		const rejection = requireSetupAuthorization(request, env);
		if (rejection) return rejection;
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return Response.json(environmentConfiguration, {
			headers: { "cache-control": "no-store" }
		});
	}
	if (url.pathname === "/twitch/channels/invitations") {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		return createTwitchChannelInvitation(request, env);
	}
	if (url.pathname === "/twitch/channels/connect") {
		if (request.method === "GET") return renderTwitchConnectPage();
		if (request.method === "POST") return beginInvitedTwitchChannelOAuth(request, env);
		return new Response("Method Not Allowed", { status: 405 });
	}
	if (url.pathname === "/twitch/integrations/connect") {
		if (request.method === "GET") return renderTwitchIntegrationConnectPage();
		if (request.method === "POST") {
			return beginInvitedTwitchIntegrationOAuth(request, env);
		}
		return new Response("Method Not Allowed", { status: 405 });
	}
	if (url.pathname === "/twitch/channels/oauth/start") {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		return startTwitchChannelOAuth(request, env);
	}
	if (url.pathname === "/twitch/channels/oauth/callback") {
		if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
		return finishTwitchChannelOAuth(request, env);
	}
	if (url.pathname === "/twitch/channels/oauth") {
		return handleTwitchChannelAuthorization(request, env);
	}
	if (url.pathname === "/twitch/channels/health") {
		const rejection = requireSetupAuthorization(request, env);
		if (rejection) return rejection;
		return handleTwitchChannelHealth(request, env);
	}
	if (url.pathname === "/twitch/app-auth") {
		const rejection = requireSetupAuthorization(request, env);
		if (rejection) return rejection;
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return handleTwitchAppAuthStatus(env);
	}
	if (
		url.pathname === "/twitch/eventsub/subscriptions" ||
		url.pathname === "/twitch/eventsub/channels" ||
		url.pathname === "/twitch/eventsub/service"
	) {
		const rejection = requireSetupAuthorization(request, env);
		if (rejection) return rejection;
		if (url.pathname === "/twitch/eventsub/channels") {
			return handleTwitchChannelConfiguration(request, env);
		}
		if (url.pathname === "/twitch/eventsub/service") {
			if (request.method !== "GET") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			return getTwitchEventSubServiceStatus(env);
		}
		return handleTwitchEventSubSubscriptions(request, env);
	}
	if (url.pathname === "/twitch/oauth/start") {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		return startTwitchOAuth(request, env);
	}
	if (url.pathname === "/twitch/oauth/callback") {
		if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
		return finishTwitchOAuth(request, env);
	}
	return new Response("Not found", { status: 404 });
}
