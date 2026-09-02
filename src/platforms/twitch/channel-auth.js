import {
  TwitchOAuthError,
  requiredString,
  twitchTokenRequest,
  validateTwitchUserToken
} from "./auth.js";
import { logError } from "../../common.js";
import {
  IntegrationRegistryError,
  revokeIntegrationsForGroup,
  verifyIntegrationInvitation
} from "../../integrations/index.js";
import {
  CHANNEL_AUTH_KEY,
  VALIDATION_RETRY_MS,
  assertChannelIdentity,
  channelOAuthError,
  disableChannelDesiredState,
  nextValidationDelay,
  noStoreJson,
  publicAuthorization,
  revokeTwitchToken,
  updateChannelDesiredState,
  validatedCallbackUrl,
  validatedIntegrationReservation
} from "./channel-auth-common.js";

export {
  markTwitchChannelAuthorizationRevoked,
  TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME,
  twitchChannelAuthObjectName,
  twitchChannelOAuthCoordinatorStub
} from "./channel-auth-common.js";
export { TwitchChannelOAuthCoordinator } from "./channel-oauth-coordinator.js";

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

	async verifyPendingIntegration(authorization) {
		const pending = authorization.integrationCompletionPending;
		if (!pending) return { result: null, error: null };
		try {
			const result = await verifyIntegrationInvitation(this.env, {
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
			logError("twitch.channel_integration_verification_failed", {
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
		const integrationVerification = await this.verifyPendingIntegration(authorization);
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
			integration: integrationVerification.result?.integration ?? null,
			pendingIntegration:
				integrationVerification.result?.pendingIntegration ?? null,
			integrationResumeToken:
				input.integrationReservation?.reservationId ?? null,
			integrationAlreadyLinked:
				integrationVerification.result?.alreadyLinked ?? false,
			integrationPending: Boolean(authorization.integrationCompletionPending),
			integrationError: integrationVerification.error
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
				await this.verifyPendingIntegration(authorization);
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
