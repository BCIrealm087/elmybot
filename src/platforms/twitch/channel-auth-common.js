import {
  TwitchOAuthError,
  requiredString
} from "./auth.js";
import {
  deconfigureTwitchChannelDesiredState,
  putTwitchChannelDesiredState
} from "./eventsub.js";
import { jsonResponse, logError, withExternalRequestTimeout } from "../../common.js";
import { IntegrationRegistryError } from "../../integrations/index.js";

export const TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME = "twitch:channel-oauth";

export const CHANNEL_AUTH_KEY = "channelAuthorization";
export const OAUTH_STATE_PREFIX = "channelOAuthState:";
export const INVITATION_PREFIX = "channelInvitation:";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const INVITATION_TTL_MS = 60 * 60 * 1000;
export const VALIDATION_INTERVAL_MS = 55 * 60 * 1000;
export const VALIDATION_RETRY_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
export const REQUIRED_CHANNEL_SCOPES = Object.freeze(["channel:bot"]);

export function noStoreJson(value, status = 200) {
	const response = jsonResponse(value, status);
	response.headers.set("cache-control", "no-store");
	return response;
}

export function channelOAuthError(message, options = {}) {
	return new TwitchOAuthError(message, {
		code: "twitch_channel_oauth_error",
		...options
	});
}

export function validatedRedirectUri(value) {
	let redirectUri;
	try {
		redirectUri = new URL(value);
	} catch {
		throw channelOAuthError("Channel OAuth redirect URI is invalid.");
	}
	if (
		redirectUri.protocol !== "https:" ||
		redirectUri.pathname !== "/twitch/channels/oauth/callback"
	) {
		throw channelOAuthError("Channel OAuth redirect URI is invalid.");
	}
	return redirectUri.href;
}

export function validatedCallbackUrl(value) {
	let callbackUrl;
	try {
		callbackUrl = new URL(value);
	} catch {
		throw channelOAuthError("EventSub callback URL is invalid.");
	}
	if (callbackUrl.protocol !== "https:" || callbackUrl.pathname !== "/twitch") {
		throw channelOAuthError("EventSub callback URL is invalid.");
	}
	return callbackUrl.href;
}

export function validatedConnectUrl(value) {
	let connectUrl;
	try {
		connectUrl = new URL(value);
	} catch {
		throw channelOAuthError("Channel invitation URL is invalid.");
	}
	if (connectUrl.protocol !== "https:" || connectUrl.pathname !== "/twitch/channels/connect") {
		throw channelOAuthError("Channel invitation URL is invalid.");
	}
	connectUrl.hash = "";
	connectUrl.search = "";
	return connectUrl.href;
}

export function randomInvitationToken() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function invitationStorageKey(token) {
	if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
		throw channelOAuthError("The channel invitation is invalid or expired.", {
			code: "twitch_channel_invitation_invalid"
		});
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
	return `${INVITATION_PREFIX}${hash}`;
}

export function assertChannelIdentity(validation, clientId, expectedUserId) {
	const scopes = Array.isArray(validation?.scopes) ? validation.scopes : [];
	if (
		validation?.client_id !== clientId ||
		typeof validation?.user_id !== "string" ||
		validation.user_id.length === 0 ||
		(expectedUserId && validation.user_id !== expectedUserId)
	) {
		throw channelOAuthError("The Twitch authorization identity is invalid.", {
			status: 403,
			code: "twitch_channel_oauth_wrong_identity"
		});
	}
	if (REQUIRED_CHANNEL_SCOPES.some((scope) => !scopes.includes(scope))) {
		throw channelOAuthError("The Twitch authorization is missing the channel:bot scope.", {
			status: 403,
			code: "twitch_channel_oauth_missing_scope"
		});
	}
	if (!Number.isFinite(validation.expires_in) || validation.expires_in < 0) {
		throw channelOAuthError("Twitch returned an invalid validation response.", {
			status: 502,
			code: "twitch_channel_oauth_invalid_validation_response"
		});
	}
	return [...scopes].sort();
}

export function channelAuthStub(env, broadcasterUserId) {
	return env.TWITCH_CHANNEL_AUTH.get(
		env.TWITCH_CHANNEL_AUTH.idFromName(twitchChannelAuthObjectName(broadcasterUserId))
	);
}

export function twitchChannelAuthObjectName(broadcasterUserId) {
	return `twitch:channel-auth:${broadcasterUserId}`;
}

export function twitchChannelOAuthCoordinatorStub(env) {
	return env.TWITCH_CHANNEL_OAUTH.get(
		env.TWITCH_CHANNEL_OAUTH.idFromName(TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME)
	);
}

export async function checkedJsonResponse(response, fallbackMessage) {
	let result;
	try {
		result = await response.json();
	} catch {
		result = null;
	}
	if (!response.ok) {
		throw channelOAuthError(result?.error || fallbackMessage, {
			status: response.status,
			code: result?.code || "twitch_channel_oauth_internal_error"
		});
	}
	return result;
}

export function integrationInvitationOAuthError(error) {
	if (!(error instanceof IntegrationRegistryError)) throw error;
	throw channelOAuthError(
		error.status >= 500
			? "Integration linking is temporarily unavailable."
			: "The integration invitation is invalid, expired, or has already been used.",
		{
			status: error.status >= 500 ? 503 : 400,
			code: error.code
		}
	);
}

export function validatedIntegrationReservation(value) {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw channelOAuthError("The integration OAuth reservation is invalid.");
	}
	return {
		invitationId: requiredString(value.invitationId, "Integration invitation ID"),
		reservationId: requiredString(value.reservationId, "Integration reservation ID")
	};
}

export async function updateChannelDesiredState(env, authorization) {
	const response = await putTwitchChannelDesiredState(env, {
		broadcasterUserId: authorization.userId,
		callbackUrl: authorization.callbackUrl,
		authorizationMode: "broadcaster_oauth",
		login: authorization.login
	});
	await checkedJsonResponse(response, "Could not configure the Twitch channel.");
}

export async function disableChannelDesiredState(env, authorization, options) {
	const response = await deconfigureTwitchChannelDesiredState(env, {
		broadcasterUserId: authorization.userId,
		callbackUrl: authorization.callbackUrl
	}, options);
	await checkedJsonResponse(response, "Could not deconfigure the Twitch channel.");
}

export function publicAuthorization(authorization) {
	if (!authorization) return null;
	return {
		status: authorization.status,
		broadcasterUserId: authorization.userId,
		login: authorization.login ?? null,
		scopes: authorization.scopes ?? [],
		expiresAtMs: authorization.expiresAtMs ?? null,
		lastValidatedAtMs: authorization.lastValidatedAtMs ?? null,
		authorizedAtMs: authorization.authorizedAtMs ?? null,
		invalidatedAtMs: authorization.invalidatedAtMs ?? null,
		disconnectedAtMs: authorization.disconnectedAtMs ?? null,
		reason: authorization.reason ?? null,
		provisioningPending: Boolean(authorization.provisioningPending),
		deconfigurationPending: Boolean(authorization.deconfigurationPending),
		integrationCompletionPending: Boolean(authorization.integrationCompletionPending),
		integrationDeactivationPending: Boolean(authorization.integrationDeactivationPending)
	};
}

export function nextValidationDelay(expiresAtMs) {
	if (!Number.isFinite(expiresAtMs)) return VALIDATION_RETRY_MS;
	return Math.min(
		VALIDATION_INTERVAL_MS,
		Math.max(60 * 1000, expiresAtMs - Date.now() - ACCESS_TOKEN_REFRESH_BUFFER_MS)
	);
}

export async function revokeTwitchToken(clientId, accessToken) {
	if (!clientId || !accessToken) return;
	try {
		const response = await fetch(
			"https://id.twitch.tv/oauth2/revoke",
			withExternalRequestTimeout({
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: clientId, token: accessToken })
			})
		);
		if (!response.ok) await response.text();
	} catch (error) {
		logError("twitch.channel_oauth_revoke_failed", {
			platform: "twitch",
			correlationId: `twitch-channel-revoke:${crypto.randomUUID()}`,
			groupId: null
		}, error);
	}
}

export async function markTwitchChannelAuthorizationRevoked(env, broadcasterUserId) {
	if (!env.TWITCH_CHANNEL_AUTH) return false;
	const response = await channelAuthStub(env, broadcasterUserId).fetch(
		"https://twitch-channel-auth/revoked",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ broadcasterUserId })
		}
	);
	const result = await checkedJsonResponse(
		response,
		"Could not record the revoked Twitch channel authorization."
	);
	return Boolean(result.handled);
}

