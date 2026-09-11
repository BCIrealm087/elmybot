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
	renderTwitchIntegrationCancelled,
	renderTwitchConnectPage,
	renderTwitchIntegrationConnectPage,
	renderTwitchIntegrationPending,
	renderTwitchIntegrationSuccess,
	renderTwitchOAuthTransition,
	renderTwitchOnboardingError,
	renderTwitchOnboardingSuccess
} from "./onboarding.js";
import { twitchPublicUrl } from "./environment.js";
import { handleTwitchChannelHealth } from "./channel-registry.js";
import {
	activatePendingIntegration,
	cancelPendingIntegration,
	IntegrationRegistryError,
	resolvePendingIntegrationState,
	resumePendingIntegration
} from "../../integrations/index.js";

const INTEGRATION_RESUME_COOKIE = "elmybot_integration_resume";
const INTEGRATION_RESUME_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

function cookieValue(request, name) {
	const header = request.headers.get("cookie") ?? "";
	for (const part of header.split(";")) {
		const [candidate, ...value] = part.trim().split("=");
		if (candidate === name) return value.join("=");
	}
	return null;
}

function integrationResumeCookie(value) {
	return `${INTEGRATION_RESUME_COOKIE}=${value}; ` +
		`Path=/twitch/integrations; HttpOnly; Secure; SameSite=Lax; ` +
		`Max-Age=${INTEGRATION_RESUME_COOKIE_MAX_AGE_SECONDS}`;
}

function integrationPendingRedirect(reservationId) {
	return new Response(null, {
		status: 303,
		headers: {
			"cache-control": "no-store",
			location: "/twitch/integrations/pending",
			"set-cookie": integrationResumeCookie(reservationId)
		}
	});
}

function sameOriginRequest(request, env) {
	const expected = new URL(twitchPublicUrl(env, "/")).origin;
	return request.headers.get("origin") === expected;
}

async function pendingIntegrationPage(request, env) {
	const reservationId = cookieValue(request, INTEGRATION_RESUME_COOKIE);
	if (!reservationId) {
		return renderTwitchOnboardingError(
			"This pending integration continuation is unavailable or expired.",
			404
		);
	}
	let result;
	try {
		result = await resumePendingIntegration(env, { reservationId });
	} catch (error) {
		if (
			error instanceof IntegrationRegistryError &&
			error.code.startsWith("integration_state_discovery_")
		) {
			return renderTwitchOnboardingError(
				"Shareable state could not be inspected yet. Refresh this page to retry.",
				503
			);
		}
		return renderTwitchOnboardingError(
			"This pending integration continuation is unavailable or expired.",
			404
		);
	}
	const pending = result.pendingIntegration;
	if (pending.status === "active") {
		return renderTwitchIntegrationSuccess(
			pending.twitchLabel ?? pending.twitchGroup?.id,
			result.integration
		);
	}
	if (pending.status === "cancelled") return renderTwitchIntegrationCancelled();
	if (pending.status === "expired") {
		return renderTwitchOnboardingError("This pending integration expired.", 410);
	}
	return renderTwitchIntegrationPending(pending);
}

async function cancelPendingIntegrationRoute(request, env) {
	if (!sameOriginRequest(request, env)) {
		return new Response("Forbidden", { status: 403 });
	}
	const reservationId = cookieValue(request, INTEGRATION_RESUME_COOKIE);
	if (!reservationId) {
		return renderTwitchOnboardingError(
			"This pending integration continuation is unavailable or expired.",
			404
		);
	}
	let result;
	try {
		result = await cancelPendingIntegration(env, { reservationId });
	} catch {
		return renderTwitchOnboardingError(
			"This pending integration could not be cancelled.",
			409
		);
	}
	if (result.pendingIntegration.status === "expired") {
		return renderTwitchOnboardingError("This pending integration expired.", 410);
	}
	return renderTwitchIntegrationCancelled();
}

async function finalizePendingIntegration(env, pending, reservationId) {
	try {
		const result = await activatePendingIntegration(env, {
			invitationId: pending.invitationId,
			reservationId
		});
		return renderTwitchIntegrationSuccess(
			pending.twitchLabel ?? pending.twitchGroup?.id,
			result.integration
		);
	} catch (error) {
		if (
			error instanceof IntegrationRegistryError &&
			error.code === "integration_pending_expired"
		) {
			return renderTwitchOnboardingError("This pending integration expired.", 410);
		}
		let current = pending;
		try {
			current = (await resumePendingIntegration(env, { reservationId }))
				.pendingIntegration;
		} catch {
			// Keep the last safe pending representation for the retry page.
		}
		if (
			error instanceof IntegrationRegistryError &&
			error.code === "integration_state_rediscovery_required"
		) {
			return renderTwitchIntegrationPending(current, {
				error: "Shareable state changed during finalization. Review the latest state choices.",
				status: 409
			});
		}
		return renderTwitchIntegrationPending(current, {
			error: "The link could not be finalized yet. Your choices are saved; try again.",
			status: error instanceof IntegrationRegistryError && error.status === 409
				? 409
				: 503
		});
	}
}

async function finalizePendingIntegrationRoute(request, env) {
	if (!sameOriginRequest(request, env)) {
		return new Response("Forbidden", { status: 403 });
	}
	const reservationId = cookieValue(request, INTEGRATION_RESUME_COOKIE);
	if (!reservationId) {
		return renderTwitchOnboardingError(
			"This pending integration continuation is unavailable or expired.",
			404
		);
	}
	let resumed;
	try {
		resumed = await resumePendingIntegration(env, { reservationId });
	} catch {
		return renderTwitchOnboardingError(
			"This pending integration continuation is unavailable or expired.",
			404
		);
	}
	const pending = resumed.pendingIntegration;
	if (pending.status === "active") {
		return renderTwitchIntegrationSuccess(
			pending.twitchLabel ?? pending.twitchGroup?.id,
			resumed.integration
		);
	}
	if (pending.status === "cancelled") return renderTwitchIntegrationCancelled();
	if (pending.status === "expired") {
		return renderTwitchOnboardingError("This pending integration expired.", 410);
	}
	return finalizePendingIntegration(env, pending, reservationId);
}

async function resolvePendingIntegrationStateRoute(request, env) {
	if (!sameOriginRequest(request, env)) {
		return new Response("Forbidden", { status: 403 });
	}
	const reservationId = cookieValue(request, INTEGRATION_RESUME_COOKIE);
	if (!reservationId) {
		return renderTwitchOnboardingError(
			"This pending integration continuation is unavailable or expired.",
			404
		);
	}
	let resumed;
	try {
		resumed = await resumePendingIntegration(env, { reservationId });
	} catch {
		return renderTwitchOnboardingError(
			"This pending integration continuation is unavailable or expired.",
			404
		);
	}
	const pending = resumed.pendingIntegration;
	if (pending.status === "active") {
		return renderTwitchIntegrationSuccess(
			pending.twitchLabel ?? pending.twitchGroup?.id,
			resumed.integration
		);
	}
	if (pending.status === "cancelled") return renderTwitchIntegrationCancelled();
	if (pending.status === "expired") {
		return renderTwitchOnboardingError("This pending integration expired.", 410);
	}
	if (pending.status !== "awaiting_state_resolution") {
		return renderTwitchIntegrationPending(pending);
	}
	if (pending?.stateResolution) {
		return renderTwitchIntegrationPending(pending);
	}
	const discovery = pending?.stateDiscovery;
	const collisions = discovery?.namespaces.filter(
		(namespace) => namespace.outcome === "collision"
	) ?? [];
	if (!discovery?.requiresResolution || collisions.length === 0) {
		return renderTwitchIntegrationPending(pending, {
			error: "This integration has no state choices awaiting input."
		});
	}

	let form;
	try {
		form = await request.formData();
	} catch {
		return renderTwitchIntegrationPending(pending, {
			error: "The submitted state choices could not be read."
		});
	}
	const versionText = form.get("discovery_version");
	const discoveryVersion = typeof versionText === "string" &&
		/^[1-9]\d*$/.test(versionText)
		? Number(versionText)
		: null;
	const choices = new Set(["discord", "twitch", "reset"]);
	const selections = collisions.map((namespace, index) => ({
		featureId: namespace.featureId,
		namespaceId: namespace.namespaceId,
		selection: form.get(`choice_${index}`)
	}));
	if (!Number.isSafeInteger(discoveryVersion) || discoveryVersion !== discovery.version) {
		return renderTwitchIntegrationPending(pending, {
			error: "This page is out of date. Review the latest choices and try again."
		});
	}
	if (selections.some(({ selection }) => !choices.has(selection))) {
		return renderTwitchIntegrationPending(pending, {
			error: "Choose Discord, Twitch, or reset for every conflicting feature."
		});
	}

	try {
		const result = await resolvePendingIntegrationState(env, {
			reservationId,
			discoveryVersion,
			selections
		});
		return finalizePendingIntegration(
			env,
			result.pendingIntegration,
			reservationId
		);
	} catch (error) {
		if (
			error instanceof IntegrationRegistryError &&
			error.code === "integration_pending_expired"
		) {
			return renderTwitchOnboardingError("This pending integration expired.", 410);
		}
		if (
			error instanceof IntegrationRegistryError &&
			error.code === "integration_state_resolution_stale"
		) {
			return renderTwitchIntegrationPending(pending, {
				error: "Shareable state changed. Refresh and review the latest choices."
			});
		}
		return renderTwitchIntegrationPending(pending, {
			error: "These state choices could not be saved. Refresh and try again."
		});
	}
}

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
	if (result.integrationResumeToken) {
		return integrationPendingRedirect(result.integrationResumeToken);
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
	if (url.pathname === "/twitch/integrations/pending") {
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return pendingIntegrationPage(request, env);
	}
	if (url.pathname === "/twitch/integrations/cancel") {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return cancelPendingIntegrationRoute(request, env);
	}
	if (url.pathname === "/twitch/integrations/resolve-state") {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return resolvePendingIntegrationStateRoute(request, env);
	}
	if (url.pathname === "/twitch/integrations/finalize") {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return finalizePendingIntegrationRoute(request, env);
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
