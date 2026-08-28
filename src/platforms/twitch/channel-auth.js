import {
	TwitchOAuthError,
	requiredString,
	twitchTokenRequest,
	validateTwitchUserToken
} from "./auth.js";
import {
	deconfigureTwitchChannelDesiredState,
	putTwitchChannelDesiredState
} from "./eventsub.js";
import { jsonResponse, logError, withExternalRequestTimeout } from "../../common.js";
import {
	completeIntegrationInvitation,
	IntegrationRegistryError,
	reserveIntegrationInvitation,
	revokeIntegrationsForGroup
} from "../../integrations/index.js";

export const TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME = "twitch:channel-oauth";

const CHANNEL_AUTH_KEY = "channelAuthorization";
const OAUTH_STATE_PREFIX = "channelOAuthState:";
const INVITATION_PREFIX = "channelInvitation:";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const INVITATION_TTL_MS = 60 * 60 * 1000;
const VALIDATION_INTERVAL_MS = 55 * 60 * 1000;
const VALIDATION_RETRY_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const REQUIRED_CHANNEL_SCOPES = Object.freeze(["channel:bot"]);

function noStoreJson(value, status = 200) {
	const response = jsonResponse(value, status);
	response.headers.set("cache-control", "no-store");
	return response;
}

function channelOAuthError(message, options = {}) {
	return new TwitchOAuthError(message, {
		code: "twitch_channel_oauth_error",
		...options
	});
}

function validatedRedirectUri(value) {
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

function validatedCallbackUrl(value) {
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

function validatedConnectUrl(value) {
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

function randomInvitationToken() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function invitationStorageKey(token) {
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

function assertChannelIdentity(validation, clientId, expectedUserId) {
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

function channelAuthStub(env, broadcasterUserId) {
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

async function checkedJsonResponse(response, fallbackMessage) {
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

function integrationInvitationOAuthError(error) {
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

function validatedIntegrationReservation(value) {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw channelOAuthError("The integration OAuth reservation is invalid.");
	}
	return {
		invitationId: requiredString(value.invitationId, "Integration invitation ID"),
		reservationId: requiredString(value.reservationId, "Integration reservation ID")
	};
}

async function updateChannelDesiredState(env, authorization) {
	const response = await putTwitchChannelDesiredState(env, {
		broadcasterUserId: authorization.userId,
		callbackUrl: authorization.callbackUrl,
		authorizationMode: "broadcaster_oauth",
		login: authorization.login
	});
	await checkedJsonResponse(response, "Could not configure the Twitch channel.");
}

async function disableChannelDesiredState(env, authorization, options) {
	const response = await deconfigureTwitchChannelDesiredState(env, {
		broadcasterUserId: authorization.userId,
		callbackUrl: authorization.callbackUrl
	}, options);
	await checkedJsonResponse(response, "Could not deconfigure the Twitch channel.");
}

function publicAuthorization(authorization) {
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

function nextValidationDelay(expiresAtMs) {
	if (!Number.isFinite(expiresAtMs)) return VALIDATION_RETRY_MS;
	return Math.min(
		VALIDATION_INTERVAL_MS,
		Math.max(60 * 1000, expiresAtMs - Date.now() - ACCESS_TOKEN_REFRESH_BUFFER_MS)
	);
}

async function revokeTwitchToken(clientId, accessToken) {
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

export class TwitchChannelOAuthCoordinator {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async scheduleCleanup(expiresAtMs) {
		const alarmAtMs = await this.state.storage.getAlarm();
		if (alarmAtMs === null || expiresAtMs < alarmAtMs) {
			await this.state.storage.setAlarm(expiresAtMs);
		}
	}

	async createInvitation({ connectUrl }) {
		connectUrl = validatedConnectUrl(connectUrl);
		const token = randomInvitationToken();
		const nowMs = Date.now();
		const invitation = {
			createdAtMs: nowMs,
			expiresAtMs: nowMs + INVITATION_TTL_MS
		};
		await this.state.storage.put(await invitationStorageKey(token), invitation);
		await this.scheduleCleanup(invitation.expiresAtMs);
		return {
			invitationUrl: `${connectUrl}#invite=${token}`,
			expiresAtMs: invitation.expiresAtMs
		};
	}

	async startOAuth({
		redirectUri,
		callbackUrl,
		clientId,
		clientSecret,
		invitationToken,
		integrationInvitationToken
	}) {
		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		redirectUri = validatedRedirectUri(redirectUri);
		callbackUrl = validatedCallbackUrl(callbackUrl);

		const state = crypto.randomUUID();
		const pending = {
			state,
			redirectUri,
			callbackUrl,
			expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS
		};
		const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
		if (invitationToken !== undefined && integrationInvitationToken !== undefined) {
			throw channelOAuthError("Only one channel invitation can be used at a time.");
		}
		if (integrationInvitationToken !== undefined) {
			let reservation;
			try {
				reservation = await reserveIntegrationInvitation(this.env, {
					token: integrationInvitationToken,
					reservationId: state,
					reservationExpiresAtMs: pending.expiresAtMs
				});
			} catch (error) {
				integrationInvitationOAuthError(error);
			}
			pending.integrationReservation = {
				invitationId: reservation.invitationId,
				reservationId: reservation.reservationId
			};
			await this.state.storage.put(stateKey, pending);
		} else if (invitationToken === undefined) {
			await this.state.storage.put(stateKey, pending);
		} else {
			const invitationKey = await invitationStorageKey(invitationToken);
			await this.state.storage.transaction(async (transaction) => {
				const invitation = await transaction.get(invitationKey);
				if (!invitation || invitation.expiresAtMs < Date.now()) {
					throw channelOAuthError("The channel invitation is invalid or expired.", {
						code: "twitch_channel_invitation_invalid"
					});
				}
				await transaction.delete(invitationKey);
				await transaction.put(stateKey, pending);
			});
		}
		await this.scheduleCleanup(pending.expiresAtMs);

		const authorizationUrl = new URL("https://id.twitch.tv/oauth2/authorize");
		authorizationUrl.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: REQUIRED_CHANNEL_SCOPES.join(" "),
			state,
			force_verify: "true"
		}).toString();
		return { authorizationUrl: authorizationUrl.href, expiresAtMs: pending.expiresAtMs };
	}

	async finishOAuth({ code, state, redirectUri, clientId, clientSecret }) {
		if (![code, state, redirectUri].every((value) =>
			typeof value === "string" && value.length > 0
		)) {
			throw channelOAuthError("Channel OAuth callback parameters are incomplete.");
		}
		const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
		const pending = await this.state.storage.get(stateKey);
		redirectUri = validatedRedirectUri(redirectUri);
		if (
			!pending ||
			pending.state !== state ||
			pending.redirectUri !== redirectUri ||
			pending.expiresAtMs < Date.now()
		) {
			throw channelOAuthError("Channel OAuth state is invalid or expired.", {
				code: "twitch_channel_oauth_invalid_state"
			});
		}
		await this.state.storage.delete(stateKey);

		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		clientSecret = requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		const tokens = await twitchTokenRequest(
			new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri
			}),
			{
				rejectedMessage: "Twitch rejected the channel authorization code.",
				rejectedCode: "twitch_channel_oauth_exchange_rejected"
			}
		);
		const validation = await validateTwitchUserToken(tokens.access_token);
		const scopes = assertChannelIdentity(validation, clientId);
		const response = await channelAuthStub(this.env, validation.user_id).fetch(
			"https://twitch-channel-auth/authorize",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accessToken: tokens.access_token,
					refreshToken: tokens.refresh_token,
					expiresIn: tokens.expires_in,
					clientId,
					clientSecret,
					userId: validation.user_id,
					login: validation.login ?? null,
					scopes,
					callbackUrl: pending.callbackUrl,
					integrationReservation: pending.integrationReservation ?? null
				})
			}
		);
		return checkedJsonResponse(response, "Could not store the Twitch channel authorization.");
	}

	async alarm() {
		const nowMs = Date.now();
		const [states, invitations] = await Promise.all([
			this.state.storage.list({ prefix: OAUTH_STATE_PREFIX }),
			this.state.storage.list({ prefix: INVITATION_PREFIX })
		]);
		const expiredKeys = [];
		let nextExpiry = null;
		for (const [key, pending] of [...states, ...invitations]) {
			if (!Number.isFinite(pending?.expiresAtMs) || pending.expiresAtMs <= nowMs) {
				expiredKeys.push(key);
			} else if (nextExpiry === null || pending.expiresAtMs < nextExpiry) {
				nextExpiry = pending.expiresAtMs;
			}
		}
		if (expiredKeys.length > 0) await this.state.storage.delete(expiredKeys);
		if (nextExpiry === null) await this.state.storage.deleteAlarm();
		else await this.state.storage.setAlarm(nextExpiry);
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/invitations/create") {
				return noStoreJson(await this.createInvitation(await request.json()), 201);
			}
			if (request.method === "POST" && url.pathname === "/oauth/start") {
				return noStoreJson(await this.startOAuth(await request.json()));
			}
			if (request.method === "POST" && url.pathname === "/oauth/callback") {
				return noStoreJson(await this.finishOAuth(await request.json()));
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchOAuthError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			logError("twitch.channel_oauth_failed", {
				platform: "twitch",
				correlationId: `twitch-channel-oauth:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Twitch channel OAuth failed." }, 500);
		}
	}
}

export class TwitchChannelAuth {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.state.blockConcurrencyWhile(async () => {
			const [authorization, alarmAtMs] = await Promise.all([
				this.state.storage.get(CHANNEL_AUTH_KEY),
				this.state.storage.getAlarm()
			]);
			if (
				authorization &&
					(
						authorization.status === "authorized" ||
						authorization.provisioningPending ||
						authorization.deconfigurationPending ||
						authorization.integrationCompletionPending ||
						authorization.integrationDeactivationPending
				) &&
				alarmAtMs === null
			) {
				await this.state.storage.setAlarm(Date.now());
			}
		});
	}

	async configure(authorization) {
		try {
			await updateChannelDesiredState(this.env, authorization);
			authorization.provisioningPending = false;
			return true;
		} catch (error) {
			authorization.provisioningPending = true;
			logError("twitch.channel_oauth_provisioning_failed", {
				platform: "twitch",
				correlationId: `twitch-channel-provision:${crypto.randomUUID()}`,
				groupId: authorization.userId
			}, error);
			return false;
		}
	}

	async deconfigure(authorization, options) {
		try {
			await disableChannelDesiredState(this.env, authorization, options);
			authorization.deconfigurationPending = false;
			return true;
		} catch (error) {
			authorization.deconfigurationPending = true;
			logError("twitch.channel_oauth_deprovisioning_failed", {
				platform: "twitch",
				correlationId: `twitch-channel-deprovision:${crypto.randomUUID()}`,
				groupId: authorization.userId
			}, error);
			return false;
		}
	}

	async completePendingIntegration(authorization) {
		const pending = authorization.integrationCompletionPending;
		if (!pending) return { result: null, error: null };
		try {
			const result = await completeIntegrationInvitation(this.env, {
				invitationId: pending.invitationId,
				reservationId: pending.reservationId,
				group: {
					platform: "twitch",
					kind: "channel",
					id: authorization.userId
				},
				actor: {
					platform: "twitch",
					id: authorization.userId,
					claims: ["twitch.broadcaster"]
				},
				groupLabel: authorization.login
			});
			authorization.integrationCompletionPending = null;
			return { result, error: null };
		} catch (error) {
			logError("twitch.channel_integration_completion_failed", {
				platform: "twitch",
				correlationId: `twitch-integration-completion:${crypto.randomUUID()}`,
				groupId: authorization.userId
			}, error);
			if (error instanceof IntegrationRegistryError && error.status < 500) {
				authorization.integrationCompletionPending = null;
				return { result: null, error: error.code };
			}
			return { result: null, error: null };
		}
	}

	async deactivateLinkedIntegrations(authorization, reason) {
		try {
			await revokeIntegrationsForGroup(this.env, {
				group: {
					platform: "twitch",
					kind: "channel",
					id: authorization.userId
				},
				actor: {
					platform: "twitch",
					id: authorization.userId,
					claims: ["twitch.broadcaster"]
				},
				reason
			});
			authorization.integrationDeactivationPending = false;
			return true;
		} catch (error) {
			authorization.integrationDeactivationPending = true;
			logError("twitch.channel_integration_deactivation_failed", {
				platform: "twitch",
				correlationId: `twitch-integration-deactivation:${crypto.randomUUID()}`,
				groupId: authorization.userId
			}, error);
			return false;
		}
	}

	async authorize(input) {
		const clientId = requiredString(input.clientId, "TWITCH_CLIENT_ID");
		requiredString(input.clientSecret, "TWITCH_CLIENT_SECRET");
		const userId = requiredString(input.userId, "Twitch broadcaster user ID");
		const accessToken = requiredString(input.accessToken, "Twitch channel access token");
		const refreshToken = requiredString(input.refreshToken, "Twitch channel refresh token");
		const callbackUrl = validatedCallbackUrl(input.callbackUrl);
		if (!Number.isFinite(input.expiresIn) || input.expiresIn <= 0) {
			throw channelOAuthError("Twitch returned an invalid token expiry.", { status: 502 });
		}
		if (!Array.isArray(input.scopes) || !input.scopes.includes("channel:bot")) {
			throw channelOAuthError("The Twitch authorization is missing the channel:bot scope.", {
				status: 403,
				code: "twitch_channel_oauth_missing_scope"
			});
		}

		const nowMs = Date.now();
		const authorization = {
			status: "authorized",
			accessToken,
			refreshToken,
			expiresAtMs: nowMs + input.expiresIn * 1000,
			lastValidatedAtMs: nowMs,
			authorizedAtMs: nowMs,
			clientId,
			userId,
			login: typeof input.login === "string" ? input.login : null,
			scopes: [...input.scopes].sort(),
			callbackUrl,
			provisioningPending: false,
			deconfigurationPending: false,
			integrationCompletionPending: validatedIntegrationReservation(
				input.integrationReservation
			),
			integrationDeactivationPending: false
		};
		const configured = await this.configure(authorization);
		const integrationCompletion = await this.completePendingIntegration(authorization);
		await this.state.storage.put(CHANNEL_AUTH_KEY, authorization);
		await this.state.storage.setAlarm(
			Date.now() + (
				configured && !authorization.integrationCompletionPending
					? nextValidationDelay(authorization.expiresAtMs)
					: VALIDATION_RETRY_MS
			)
		);
		return {
			authorized: true,
			configured,
			authorization: publicAuthorization(authorization),
			integration: integrationCompletion.result?.integration ?? null,
			integrationAlreadyLinked: integrationCompletion.result?.alreadyLinked ?? false,
			integrationPending: Boolean(authorization.integrationCompletionPending),
			integrationError: integrationCompletion.error
		};
	}

	async refresh(authorization, clientSecret) {
		const tokens = await twitchTokenRequest(
			new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: authorization.refreshToken,
				client_id: authorization.clientId,
				client_secret: requiredString(clientSecret, "TWITCH_CLIENT_SECRET")
			}),
			{
				rejectedMessage: "Twitch rejected the channel refresh token.",
				rejectedCode: "twitch_channel_oauth_refresh_rejected",
				rejectedStatus: 401
			}
		);
		const scopes = Array.isArray(tokens.scope) ? tokens.scope : authorization.scopes;
		if (!scopes.includes("channel:bot")) {
			throw channelOAuthError("The refreshed Twitch authorization is missing channel:bot.", {
				status: 403,
				code: "twitch_channel_oauth_missing_scope"
			});
		}
		return {
			...authorization,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAtMs: Date.now() + tokens.expires_in * 1000,
			scopes: [...scopes].sort()
		};
	}

	async validate(authorization) {
		const configuredClientId = requiredString(
			this.env?.TWITCH_CLIENT_ID ?? authorization.clientId,
			"TWITCH_CLIENT_ID"
		);
		if (authorization.clientId !== configuredClientId) {
			throw channelOAuthError(
				"The stored Twitch channel authorization belongs to a different application.",
				{
					status: 403,
					code: "twitch_channel_oauth_wrong_identity"
				}
			);
		}
		let current = authorization;
		let validation;
		try {
			validation = await validateTwitchUserToken(current.accessToken);
		} catch (error) {
			if (!(error instanceof TwitchOAuthError) || error.code !== "twitch_oauth_token_invalid") {
				throw error;
			}
			current = await this.refresh(current, this.env.TWITCH_CLIENT_SECRET);
			validation = await validateTwitchUserToken(current.accessToken);
		}
		const scopes = assertChannelIdentity(
			validation,
			current.clientId,
			current.userId
		);
		const nowMs = Date.now();
		return {
			...current,
			status: "authorized",
			expiresAtMs: nowMs + validation.expires_in * 1000,
			lastValidatedAtMs: nowMs,
			login: validation.login ?? current.login ?? null,
			scopes
		};
	}

	async invalidate(authorization, reason) {
		const invalidated = {
			status: "reauthorization_required",
			clientId: authorization.clientId,
			userId: authorization.userId,
			login: authorization.login ?? null,
			scopes: authorization.scopes ?? [],
			callbackUrl: authorization.callbackUrl,
			authorizedAtMs: authorization.authorizedAtMs ?? null,
			invalidatedAtMs: Date.now(),
			reason,
			provisioningPending: false,
			deconfigurationPending: true,
			integrationCompletionPending: null,
			integrationDeactivationPending: true
		};
		const deconfigured = await this.deconfigure(invalidated);
		const integrationsDeactivated = await this.deactivateLinkedIntegrations(
			invalidated,
			reason
		);
		await this.state.storage.put(CHANNEL_AUTH_KEY, invalidated);
		if (deconfigured && integrationsDeactivated) await this.state.storage.deleteAlarm();
		else await this.state.storage.setAlarm(Date.now() + VALIDATION_RETRY_MS);
		return invalidated;
	}

	async disconnect() {
		const authorization = await this.state.storage.get(CHANNEL_AUTH_KEY);
		if (!authorization?.userId) {
			return { disconnected: true, authorization: null };
		}
		const disconnected = {
			status: "disconnected",
			clientId: authorization.clientId,
			userId: authorization.userId,
			login: authorization.login ?? null,
			scopes: [],
			callbackUrl: authorization.callbackUrl,
			authorizedAtMs: authorization.authorizedAtMs ?? null,
			disconnectedAtMs: Date.now(),
			reason: "disconnected",
			provisioningPending: false,
			deconfigurationPending: true,
			integrationCompletionPending: null,
			integrationDeactivationPending: true
		};
		await revokeTwitchToken(authorization.clientId, authorization.accessToken);
		const deconfigured = await this.deconfigure(disconnected, { unregister: true });
		const integrationsDeactivated = await this.deactivateLinkedIntegrations(
			disconnected,
			"twitch_disconnected"
		);
		await this.state.storage.put(CHANNEL_AUTH_KEY, disconnected);
		if (deconfigured && integrationsDeactivated) await this.state.storage.deleteAlarm();
		else await this.state.storage.setAlarm(Date.now() + VALIDATION_RETRY_MS);
		return { disconnected: true, authorization: publicAuthorization(disconnected) };
	}

	async alarm() {
		let authorization = await this.state.storage.get(CHANNEL_AUTH_KEY);
		if (!authorization) return;

		if (authorization.status !== "authorized") {
			if (authorization.deconfigurationPending) {
				await this.deconfigure(
					authorization,
					authorization.status === "disconnected"
						? { unregister: true }
						: undefined
				);
			}
			if (authorization.integrationDeactivationPending) {
				await this.deactivateLinkedIntegrations(
					authorization,
					authorization.reason ?? "twitch_authorization_inactive"
				);
			}
			await this.state.storage.put(CHANNEL_AUTH_KEY, authorization);
			if (
				!authorization.deconfigurationPending &&
				!authorization.integrationDeactivationPending
			) await this.state.storage.deleteAlarm();
			else await this.state.storage.setAlarm(Date.now() + VALIDATION_RETRY_MS);
			return;
		}

		try {
			authorization = await this.validate(authorization);
			if (authorization.provisioningPending) {
				await this.configure(authorization);
			}
			if (authorization.integrationCompletionPending) {
				await this.completePendingIntegration(authorization);
			}
			await this.state.storage.put(CHANNEL_AUTH_KEY, authorization);
			await this.state.storage.setAlarm(
				Date.now() + (
					authorization.provisioningPending ||
					authorization.integrationCompletionPending
						? VALIDATION_RETRY_MS
						: nextValidationDelay(authorization.expiresAtMs)
				)
			);
		} catch (error) {
			if (
				error instanceof TwitchOAuthError &&
				[
					"twitch_channel_oauth_refresh_rejected",
					"twitch_channel_oauth_missing_scope",
					"twitch_channel_oauth_wrong_identity",
					"twitch_oauth_token_invalid"
				].includes(error.code)
			) {
				await this.invalidate(authorization, error.code);
				return;
			}
			logError("twitch.channel_oauth_validation_failed", {
				platform: "twitch",
				correlationId: `twitch-channel-validation:${crypto.randomUUID()}`,
				groupId: authorization.userId
			}, error);
			await this.state.storage.setAlarm(Date.now() + VALIDATION_RETRY_MS);
		}
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/authorize") {
				return noStoreJson(await this.authorize(await request.json()), 202);
			}
			if (request.method === "POST" && url.pathname === "/revoked") {
				const input = await request.json();
				const authorization = await this.state.storage.get(CHANNEL_AUTH_KEY);
				if (
					authorization?.status !== "authorized" ||
					authorization.userId !== input.broadcasterUserId
				) {
					return noStoreJson({ handled: false });
				}
				await this.invalidate(authorization, "eventsub_authorization_revoked");
				return noStoreJson({ handled: true });
			}
			if (request.method === "GET" && url.pathname === "/status") {
				const authorization = await this.state.storage.get(CHANNEL_AUTH_KEY);
				return noStoreJson({
					authorized: authorization?.status === "authorized",
					authorization: publicAuthorization(authorization)
				});
			}
			if (request.method === "DELETE" && url.pathname === "/authorization") {
				return noStoreJson(await this.disconnect());
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchOAuthError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			logError("twitch.channel_auth_failed", {
				platform: "twitch",
				correlationId: `twitch-channel-auth:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Twitch channel authorization failed." }, 500);
		}
	}
}
