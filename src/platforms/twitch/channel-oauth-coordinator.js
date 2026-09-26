import {
  TwitchOAuthError,
  requiredString,
  twitchTokenRequest,
  validateTwitchUserToken
} from "./auth.js";
import { logError } from "../../common.js";
import { reserveIntegrationInvitation } from "../../integrations/index.js";
import { featureRegistry } from "../../features/index.js";
import { issueStateQueryGrant } from "../../state-querying/grant-client.js";
import {
  grantPermissionsForExportList,
  STATE_QUERY_GRANT_LIMITS
} from "../../state-querying/grants.js";
import { issueDurableEventGrant } from "../../durable-events/grant-client.js";
import { DURABLE_EVENT_GRANT_LIMITS } from "../../durable-events/grants.js";
import {
  INVITATION_PREFIX,
  INVITATION_TTL_MS,
  OAUTH_STATE_PREFIX,
  OAUTH_STATE_TTL_MS,
  REQUIRED_CHANNEL_SCOPES,
  assertChannelIdentity,
  channelAuthStub,
  channelOAuthError,
  checkedJsonResponse,
  integrationInvitationOAuthError,
  invitationStorageKey,
  noStoreJson,
  randomInvitationToken,
  revokeTwitchToken,
  validatedCallbackUrl,
  validatedConnectUrl,
  validatedRedirectUri
} from "./channel-auth-common.js";

export const STATE_QUERY_OAUTH_STATE_PREFIX = "stateQueryGrantOAuthState:";
export const DURABLE_EVENT_OAUTH_STATE_PREFIX = "durableEventGrantOAuthState:";
const STATE_QUERY_OAUTH_SCOPE = "openid";

function validatedStateQueryRedirectUri(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw channelOAuthError("State-query OAuth redirect URI is invalid.");
	}
	if (url.protocol !== "https:" || url.pathname !== "/state-query/operator/twitch/callback") {
		throw channelOAuthError("State-query OAuth redirect URI is invalid.");
	}
	return url.href;
}

function validatedDurableEventRedirectUri(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw channelOAuthError("Durable-event OAuth redirect URI is invalid.");
	}
	if (url.protocol !== "https:" ||
		url.pathname !== "/event-stream/operator/twitch/callback") {
		throw channelOAuthError("Durable-event OAuth redirect URI is invalid.");
	}
	return url.href;
}

export class TwitchChannelOAuthCoordinator {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.registry = featureRegistry;
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

	async startStateQueryGrantOAuth({
		redirectUri,
		clientId,
		clientSecret,
		exports,
		expiresInSeconds
	}) {
		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		redirectUri = validatedStateQueryRedirectUri(redirectUri);
		const permissions = grantPermissionsForExportList(featureRegistry, "twitch", exports);
		if (
			!Number.isSafeInteger(expiresInSeconds) ||
			expiresInSeconds < STATE_QUERY_GRANT_LIMITS.minLifetimeSeconds ||
			expiresInSeconds > STATE_QUERY_GRANT_LIMITS.maxLifetimeSeconds
		) {
			throw channelOAuthError("State-query grant lifetime is invalid.");
		}
		const state = crypto.randomUUID();
		const pending = {
			state,
			redirectUri,
			permissions,
			expiresInSeconds,
			expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS
		};
		await this.state.storage.put(`${STATE_QUERY_OAUTH_STATE_PREFIX}${state}`, pending);
		await this.scheduleCleanup(pending.expiresAtMs);

		const authorizationUrl = new URL("https://id.twitch.tv/oauth2/authorize");
		authorizationUrl.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: STATE_QUERY_OAUTH_SCOPE,
			state,
			force_verify: "true"
		}).toString();
		return { authorizationUrl: authorizationUrl.href, expiresAtMs: pending.expiresAtMs };
	}

	async startDurableEventGrantOAuth({
		redirectUri,
		clientId,
		clientSecret,
		stream,
		resetBacklog,
		expiresInSeconds
	}) {
		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		redirectUri = validatedDurableEventRedirectUri(redirectUri);
		const installed = typeof stream === "string" ? this.registry.eventStreams[stream] : null;
		if (!installed || !installed.definition.platforms.includes("twitch")) {
			throw channelOAuthError("Durable-event stream is invalid.");
		}
		if (
			!Number.isSafeInteger(expiresInSeconds) ||
			expiresInSeconds < DURABLE_EVENT_GRANT_LIMITS.minLifetimeSeconds ||
			expiresInSeconds > DURABLE_EVENT_GRANT_LIMITS.maxLifetimeSeconds ||
			typeof resetBacklog !== "boolean"
		) {
			throw channelOAuthError("Durable-event grant settings are invalid.");
		}
		const state = crypto.randomUUID();
		const pending = {
			state,
			redirectUri,
			stream,
			resetBacklog,
			expiresInSeconds,
			expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS
		};
		await this.state.storage.put(`${DURABLE_EVENT_OAUTH_STATE_PREFIX}${state}`, pending);
		await this.scheduleCleanup(pending.expiresAtMs);
		const authorizationUrl = new URL("https://id.twitch.tv/oauth2/authorize");
		authorizationUrl.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: STATE_QUERY_OAUTH_SCOPE,
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

	async finishStateQueryGrantOAuth({ code, state, redirectUri, clientId, clientSecret }) {
		if (![code, state, redirectUri].every((value) =>
			typeof value === "string" && value.length > 0
		)) {
			throw channelOAuthError("State-query OAuth callback parameters are incomplete.");
		}
		const stateKey = `${STATE_QUERY_OAUTH_STATE_PREFIX}${state}`;
		const pending = await this.state.storage.get(stateKey);
		redirectUri = validatedStateQueryRedirectUri(redirectUri);
		if (
			!pending ||
			pending.state !== state ||
			pending.redirectUri !== redirectUri ||
			pending.expiresAtMs < Date.now()
		) {
			throw channelOAuthError("State-query OAuth state is invalid or expired.");
		}
		await this.state.storage.delete(stateKey);
		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		clientSecret = requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		const tokens = await twitchTokenRequest(new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri
		}));
		try {
			const validation = await validateTwitchUserToken(tokens.access_token);
			if (
				validation?.client_id !== clientId ||
				typeof validation?.user_id !== "string" ||
				validation.user_id.length === 0 ||
				!Array.isArray(validation.scopes) ||
				!validation.scopes.includes(STATE_QUERY_OAUTH_SCOPE)
			) {
				throw channelOAuthError("The Twitch authorization identity is invalid.", {
					status: 403,
					code: "twitch_channel_oauth_wrong_identity"
				});
			}
			return await issueStateQueryGrant(this.env, featureRegistry, {
				target: { platform: "twitch", groupId: validation.user_id },
				permissions: pending.permissions,
				expiresInSeconds: pending.expiresInSeconds
			}, {
				actor: { platform: "twitch", id: validation.user_id }
			});
		} finally {
			await revokeTwitchToken(clientId, tokens.access_token);
		}
	}

	async finishDurableEventGrantOAuth({ code, state, redirectUri, clientId, clientSecret }) {
		if (![code, state, redirectUri].every((value) =>
			typeof value === "string" && value.length > 0
		)) {
			throw channelOAuthError("Durable-event OAuth callback parameters are incomplete.");
		}
		const stateKey = `${DURABLE_EVENT_OAUTH_STATE_PREFIX}${state}`;
		const pending = await this.state.storage.get(stateKey);
		redirectUri = validatedDurableEventRedirectUri(redirectUri);
		if (!pending || pending.state !== state || pending.redirectUri !== redirectUri ||
			pending.expiresAtMs < Date.now()) {
			throw channelOAuthError("Durable-event OAuth state is invalid or expired.");
		}
		await this.state.storage.delete(stateKey);
		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		clientSecret = requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		const tokens = await twitchTokenRequest(new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri
		}));
		try {
			const validation = await validateTwitchUserToken(tokens.access_token);
			if (
				validation?.client_id !== clientId ||
				typeof validation?.user_id !== "string" ||
				!/^\d{1,30}$/.test(validation.user_id) ||
				!Array.isArray(validation.scopes) ||
				!validation.scopes.includes(STATE_QUERY_OAUTH_SCOPE)
			) {
				throw channelOAuthError("The Twitch authorization identity is invalid.", {
					status: 403,
					code: "twitch_channel_oauth_wrong_identity"
				});
			}
			return await issueDurableEventGrant(this.env, this.registry, {
				target: { platform: "twitch", groupId: validation.user_id },
				stream: pending.stream,
				expiresInSeconds: pending.expiresInSeconds,
				resetBacklog: pending.resetBacklog
			}, {
				actor: { platform: "twitch", id: validation.user_id }
			});
		} finally {
			await revokeTwitchToken(clientId, tokens.access_token);
		}
	}

	async alarm() {
		const nowMs = Date.now();
		const [states, grantStates, eventGrantStates, invitations] = await Promise.all([
			this.state.storage.list({ prefix: OAUTH_STATE_PREFIX }),
			this.state.storage.list({ prefix: STATE_QUERY_OAUTH_STATE_PREFIX }),
			this.state.storage.list({ prefix: DURABLE_EVENT_OAUTH_STATE_PREFIX }),
			this.state.storage.list({ prefix: INVITATION_PREFIX })
		]);
		const expiredKeys = [];
		let nextExpiry = null;
		for (const [key, pending] of [
			...states,
			...grantStates,
			...eventGrantStates,
			...invitations
		]) {
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
			if (request.method === "POST" && url.pathname === "/state-query/oauth/start") {
				return noStoreJson(await this.startStateQueryGrantOAuth(await request.json()));
			}
			if (request.method === "POST" && url.pathname === "/state-query/oauth/callback") {
				return noStoreJson(await this.finishStateQueryGrantOAuth(await request.json()));
			}
			if (request.method === "POST" && url.pathname === "/durable-event/oauth/start") {
				return noStoreJson(await this.startDurableEventGrantOAuth(await request.json()));
			}
			if (request.method === "POST" && url.pathname === "/durable-event/oauth/callback") {
				return noStoreJson(await this.finishDurableEventGrantOAuth(await request.json()));
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
