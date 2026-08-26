import {
	jsonResponse,
	logError,
	withExternalRequestTimeout
} from "../../common.js";

export const TWITCH_AUTH_OBJECT_NAME = "twitch:bot";

const OAUTH_STATE_KEY = "oauthState";
const OAUTH_TOKENS_KEY = "oauthTokens";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const TOKEN_VALIDATION_MAX_AGE_MS = 60 * 60 * 1000;
const TOKEN_VALIDATION_ALARM_DELAY_MS = 55 * 60 * 1000;
const TOKEN_VALIDATION_RETRY_MS = 5 * 60 * 1000;
const REQUIRED_BOT_SCOPES = Object.freeze([
	"user:read:chat",
	"user:write:chat",
	"user:bot"
]);

class TwitchOAuthError extends Error {
	constructor(message, { status = 400, code = "twitch_oauth_error", cause } = {}) {
		super(message, { cause });
		this.status = status;
		this.code = code;
	}
}

function noStoreJson(obj, status = 200) {
	const response = jsonResponse(obj, status);
	response.headers.set("cache-control", "no-store");
	return response;
}

function requiredString(value, name) {
	if (typeof value !== "string" || value.length === 0) {
		throw new TwitchOAuthError(`${name} is not configured.`, {
			status: 503,
			code: "twitch_oauth_not_configured"
		});
	}
	return value;
}

async function twitchTokenRequest(body, {
	rejectedMessage = "Twitch rejected the token request.",
	rejectedCode = "twitch_oauth_token_rejected",
	rejectedStatus = 502
} = {}) {
	let response;
	try {
		response = await fetch(
			"https://id.twitch.tv/oauth2/token",
			withExternalRequestTimeout({
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body
			})
		);
	} catch (cause) {
		throw new TwitchOAuthError("Twitch token exchange was unavailable.", {
			status: 502,
			code: "twitch_oauth_network_error",
			cause
		});
	}

	if (!response.ok) {
		await response.text();
		throw new TwitchOAuthError(rejectedMessage, {
			status: rejectedStatus,
			code: rejectedCode
		});
	}

	const tokens = await response.json();
	if (
		typeof tokens.access_token !== "string" ||
		typeof tokens.refresh_token !== "string" ||
		!Number.isFinite(tokens.expires_in) ||
		tokens.expires_in <= 0
	) {
		throw new TwitchOAuthError("Twitch returned an invalid token response.", {
			status: 502,
			code: "twitch_oauth_invalid_token_response"
		});
	}

	return tokens;
}

async function validateTwitchUserToken(accessToken) {
	let response;
	try {
		response = await fetch(
			"https://id.twitch.tv/oauth2/validate",
			withExternalRequestTimeout({
				headers: { Authorization: `OAuth ${accessToken}` }
			})
		);
	} catch (cause) {
		throw new TwitchOAuthError("Twitch token validation was unavailable.", {
			status: 502,
			code: "twitch_oauth_validation_network_error",
			cause
		});
	}

	if (!response.ok) {
		await response.text();
		if (response.status === 401) {
			throw new TwitchOAuthError("The Twitch access token is invalid.", {
				status: 401,
				code: "twitch_oauth_token_invalid"
			});
		}
		throw new TwitchOAuthError("Twitch rejected the new access token.", {
			status: 502,
			code: "twitch_oauth_validation_rejected"
		});
	}

	return response.json();
}

export class TwitchAuth {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.refreshPromise = null;
		this.state.blockConcurrencyWhile(async () => {
			const [storedTokens, alarm] = await Promise.all([
				this.state.storage.get(OAUTH_TOKENS_KEY),
				this.state.storage.getAlarm()
			]);
			if (storedTokens?.accessToken && alarm === null) {
				await this.state.storage.setAlarm(Date.now());
			}
		});
	}

	async scheduleValidation(delayMs = TOKEN_VALIDATION_ALARM_DELAY_MS) {
		await this.state.storage.setAlarm(Date.now() + delayMs);
	}

	async ensureValidationAlarm() {
		if (await this.state.storage.getAlarm() === null) {
			await this.scheduleValidation();
		}
	}

	assertTokenIdentity(validation, { clientId, botUserId }) {
		const scopes = Array.isArray(validation.scopes) ? validation.scopes : [];
		if (validation.client_id !== clientId || validation.user_id !== botUserId) {
			throw new TwitchOAuthError("The Twitch authorization does not match the configured bot.", {
				status: 403,
				code: "twitch_oauth_wrong_user"
			});
		}
		const missingScopes = REQUIRED_BOT_SCOPES.filter((scope) => !scopes.includes(scope));
		if (missingScopes.length > 0) {
			throw new TwitchOAuthError("The Twitch authorization is missing required bot scopes.", {
				status: 403,
				code: "twitch_oauth_missing_scopes"
			});
		}
		if (!Number.isFinite(validation.expires_in) || validation.expires_in < 0) {
			throw new TwitchOAuthError("Twitch returned an invalid validation response.", {
				status: 502,
				code: "twitch_oauth_invalid_validation_response"
			});
		}
		return scopes;
	}

	async startOAuth({ redirectUri, clientId, clientSecret, botUserId }) {
		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		requiredString(botUserId, "TWITCH_BOT_USER_ID");

		let parsedRedirect;
		try {
			parsedRedirect = new URL(redirectUri);
		} catch {
			throw new TwitchOAuthError("OAuth redirect URI is invalid.");
		}
		if (parsedRedirect.protocol !== "https:" || parsedRedirect.pathname !== "/twitch/oauth/callback") {
			throw new TwitchOAuthError("OAuth redirect URI is invalid.");
		}

		const oauthState = {
			value: crypto.randomUUID(),
			redirectUri: parsedRedirect.href,
			expiresAtMs: Date.now() + OAUTH_STATE_TTL_MS
		};
		await this.state.storage.put(OAUTH_STATE_KEY, oauthState);

		const authorizationUrl = new URL("https://id.twitch.tv/oauth2/authorize");
		authorizationUrl.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: oauthState.redirectUri,
			scope: REQUIRED_BOT_SCOPES.join(" "),
			state: oauthState.value,
			force_verify: "true"
		}).toString();

		return {
			authorizationUrl: authorizationUrl.href,
			expiresAtMs: oauthState.expiresAtMs
		};
	}

	async finishOAuth({ code, state, redirectUri, clientId, clientSecret, botUserId }) {
		if (![code, state, redirectUri].every((value) => typeof value === "string" && value.length > 0)) {
			throw new TwitchOAuthError("OAuth callback parameters are incomplete.");
		}

		const expectedState = await this.state.storage.get(OAUTH_STATE_KEY);
		if (
			!expectedState ||
			expectedState.value !== state ||
			expectedState.redirectUri !== redirectUri ||
			expectedState.expiresAtMs < Date.now()
		) {
			throw new TwitchOAuthError("OAuth state is invalid or expired.", {
				code: "twitch_oauth_invalid_state"
			});
		}

		await this.state.storage.delete(OAUTH_STATE_KEY);

		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		clientSecret = requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		botUserId = requiredString(botUserId, "TWITCH_BOT_USER_ID");
		const tokens = await twitchTokenRequest(
			new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri
			}),
			{
				rejectedMessage: "Twitch rejected the authorization code.",
				rejectedCode: "twitch_oauth_exchange_rejected"
			}
		);
		const validation = await validateTwitchUserToken(tokens.access_token);
		const scopes = this.assertTokenIdentity(validation, { clientId, botUserId });

		const nowMs = Date.now();
		const storedTokens = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAtMs: nowMs + tokens.expires_in * 1000,
			lastValidatedAtMs: nowMs,
			clientId,
			userId: validation.user_id,
			login: validation.login ?? null,
			scopes: [...scopes].sort()
		};
		await this.state.storage.put(OAUTH_TOKENS_KEY, storedTokens);
		await this.scheduleValidation();

		return {
			authorized: true,
			userId: storedTokens.userId,
			login: storedTokens.login,
			scopes: storedTokens.scopes,
			expiresAtMs: storedTokens.expiresAtMs
		};
	}

	async refreshTokens({ storedTokens, clientId, clientSecret, botUserId }) {
		if (storedTokens.userId !== botUserId) {
			throw new TwitchOAuthError("The stored Twitch authorization belongs to a different bot.", {
				status: 403,
				code: "twitch_oauth_wrong_user"
			});
		}
		if (storedTokens.clientId && storedTokens.clientId !== clientId) {
			throw new TwitchOAuthError("The stored Twitch authorization belongs to a different application.", {
				status: 403,
				code: "twitch_oauth_wrong_client"
			});
		}

		const tokens = await twitchTokenRequest(
			new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: storedTokens.refreshToken,
				client_id: clientId,
				client_secret: clientSecret
			}),
			{
				rejectedMessage: "Twitch rejected the refresh token; authorize the bot again.",
				rejectedCode: "twitch_oauth_refresh_rejected",
				rejectedStatus: 401
			}
		);
		const scopes = Array.isArray(tokens.scope) ? tokens.scope : storedTokens.scopes;
		const missingScopes = REQUIRED_BOT_SCOPES.filter((scope) => !scopes?.includes(scope));
		if (missingScopes.length > 0) {
			throw new TwitchOAuthError("The refreshed Twitch authorization is missing required bot scopes.", {
				status: 403,
				code: "twitch_oauth_missing_scopes"
			});
		}

		const refreshedTokens = {
			...storedTokens,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAtMs: Date.now() + tokens.expires_in * 1000,
			clientId,
			scopes: [...scopes].sort()
		};
		await this.state.storage.put(OAUTH_TOKENS_KEY, refreshedTokens);
		return refreshedTokens;
	}

	async validateStoredSession({ storedTokens, clientId, clientSecret, botUserId }) {
		let currentTokens = storedTokens;
		let validation;
		try {
			validation = await validateTwitchUserToken(currentTokens.accessToken);
		} catch (error) {
			if (!(error instanceof TwitchOAuthError) || error.code !== "twitch_oauth_token_invalid") {
				throw error;
			}

			try {
				clientSecret = requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
				currentTokens = await this.refreshTokens({
					storedTokens: currentTokens,
					clientId,
					clientSecret,
					botUserId
				});
				validation = await validateTwitchUserToken(currentTokens.accessToken);
			} catch (recoveryError) {
				if (
					recoveryError instanceof TwitchOAuthError &&
					[
						"twitch_oauth_refresh_rejected",
						"twitch_oauth_token_invalid",
						"twitch_oauth_wrong_user",
						"twitch_oauth_wrong_client",
						"twitch_oauth_missing_scopes"
					].includes(recoveryError.code)
				) {
					await this.state.storage.delete(OAUTH_TOKENS_KEY);
					await this.state.storage.deleteAlarm();
				}
				throw recoveryError;
			}
		}

		let scopes;
		try {
			scopes = this.assertTokenIdentity(validation, { clientId, botUserId });
		} catch (error) {
			if (error instanceof TwitchOAuthError && error.status === 403) {
				await this.state.storage.delete(OAUTH_TOKENS_KEY);
				await this.state.storage.deleteAlarm();
			}
			throw error;
		}

		const nowMs = Date.now();
		const validatedTokens = {
			...currentTokens,
			expiresAtMs: nowMs + validation.expires_in * 1000,
			lastValidatedAtMs: nowMs,
			clientId,
			userId: validation.user_id,
			login: validation.login ?? currentTokens.login ?? null,
			scopes: [...scopes].sort()
		};
		await this.state.storage.put(OAUTH_TOKENS_KEY, validatedTokens);
		return validatedTokens;
	}

	async getAccessToken({ clientId, clientSecret, botUserId, rejectedAccessToken }) {
		clientId = requiredString(clientId, "TWITCH_CLIENT_ID");
		clientSecret = requiredString(clientSecret, "TWITCH_CLIENT_SECRET");
		botUserId = requiredString(botUserId, "TWITCH_BOT_USER_ID");

		let storedTokens = await this.state.storage.get(OAUTH_TOKENS_KEY);
		if (!storedTokens?.accessToken || !storedTokens?.refreshToken) {
			throw new TwitchOAuthError("The Twitch bot has not been authorized.", {
				status: 503,
				code: "twitch_oauth_not_authorized"
			});
		}
		if (storedTokens.userId !== botUserId) {
			throw new TwitchOAuthError("The stored Twitch authorization belongs to a different bot.", {
				status: 403,
				code: "twitch_oauth_wrong_user"
			});
		}
		if (storedTokens.clientId && storedTokens.clientId !== clientId) {
			throw new TwitchOAuthError("The stored Twitch authorization belongs to a different application.", {
				status: 403,
				code: "twitch_oauth_wrong_client"
			});
		}
		const validationIsStale = !Number.isFinite(storedTokens.lastValidatedAtMs) ||
			storedTokens.lastValidatedAtMs <= Date.now() - TOKEN_VALIDATION_MAX_AGE_MS;
		if (validationIsStale) {
			storedTokens = await this.validateStoredSession({
				storedTokens,
				clientId,
				clientSecret,
				botUserId
			});
			await this.scheduleValidation();
		} else {
			await this.ensureValidationAlarm();
		}

		const tokenWasRejected = typeof rejectedAccessToken === "string" &&
			rejectedAccessToken === storedTokens.accessToken;
		const tokenExpiresSoon = !Number.isFinite(storedTokens.expiresAtMs) ||
			storedTokens.expiresAtMs <= Date.now() + ACCESS_TOKEN_REFRESH_BUFFER_MS;
		if (!tokenWasRejected && !tokenExpiresSoon) {
			return {
				accessToken: storedTokens.accessToken,
				expiresAtMs: storedTokens.expiresAtMs
			};
		}

		if (!this.refreshPromise) {
			this.refreshPromise = this.refreshTokens({
				storedTokens,
				clientId,
				clientSecret,
				botUserId
			}).finally(() => {
				this.refreshPromise = null;
			});
		}
		const refreshedTokens = await this.refreshPromise;
		return {
			accessToken: refreshedTokens.accessToken,
			expiresAtMs: refreshedTokens.expiresAtMs
		};
	}

	async alarm() {
		const storedTokens = await this.state.storage.get(OAUTH_TOKENS_KEY);
		if (!storedTokens?.accessToken || !storedTokens?.refreshToken) return;

		try {
			const clientId = requiredString(this.env?.TWITCH_CLIENT_ID ?? storedTokens.clientId, "TWITCH_CLIENT_ID");
			const clientSecret = this.env?.TWITCH_CLIENT_SECRET;
			const botUserId = requiredString(this.env?.TWITCH_BOT_USER_ID ?? storedTokens.userId, "TWITCH_BOT_USER_ID");
			await this.validateStoredSession({
				storedTokens,
				clientId,
				clientSecret,
				botUserId
			});
			await this.scheduleValidation();
		} catch (error) {
			logError("twitch.oauth_validation_failed", {
				platform: "twitch",
				correlationId: `twitch-validation:${crypto.randomUUID()}`,
				groupId: null
			}, error);

			if (await this.state.storage.get(OAUTH_TOKENS_KEY)) {
				await this.scheduleValidation(TOKEN_VALIDATION_RETRY_MS);
			}
		}
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/oauth/start") {
				return noStoreJson(await this.startOAuth(await request.json()));
			}
			if (request.method === "POST" && url.pathname === "/oauth/callback") {
				return noStoreJson(await this.finishOAuth(await request.json()));
			}
			if (request.method === "POST" && url.pathname === "/oauth/access-token") {
				return noStoreJson(await this.getAccessToken(await request.json()));
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchOAuthError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}

			logError("twitch.oauth_failed", {
				platform: "twitch",
				correlationId: `twitch-oauth:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Twitch OAuth failed." }, 500);
		}
	}
}
