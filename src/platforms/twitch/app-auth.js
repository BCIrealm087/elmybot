import {
	jsonResponse,
	logError,
	withExternalRequestTimeout
} from "../../common.js";

export const TWITCH_APP_AUTH_OBJECT_NAME = "twitch:app-auth";

const APP_TOKEN_KEY = "appAccessToken";
const APP_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const APP_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

export class TwitchAppAuthError extends Error {
	constructor(message, { status = 400, code = "twitch_app_auth_error", cause } = {}) {
		super(message, { cause });
		this.status = status;
		this.code = code;
	}
}

function noStoreJson(value, status = 200) {
	const response = jsonResponse(value, status);
	response.headers.set("cache-control", "no-store");
	return response;
}

function requiredString(value, name) {
	if (typeof value !== "string" || value.length === 0) {
		throw new TwitchAppAuthError(`${name} is not configured.`, {
			status: 503,
			code: "twitch_app_auth_not_configured"
		});
	}
	return value;
}

function validateCredentials(input) {
	return {
		clientId: requiredString(input?.clientId, "TWITCH_CLIENT_ID"),
		clientSecret: requiredString(input?.clientSecret, "TWITCH_CLIENT_SECRET")
	};
}

async function requestAppAccessToken(credentials) {
	let response;
	try {
		response = await fetch(
			APP_TOKEN_URL,
			withExternalRequestTimeout({
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: credentials.clientId,
					client_secret: credentials.clientSecret,
					grant_type: "client_credentials"
				})
			})
		);
	} catch (cause) {
		throw new TwitchAppAuthError("Twitch app authentication was unavailable.", {
			status: 502,
			code: "twitch_app_auth_network_error",
			cause
		});
	}
	if (!response.ok) {
		await response.text();
		throw new TwitchAppAuthError("Twitch rejected the application credentials.", {
			status: 502,
			code: "twitch_app_auth_rejected"
		});
	}
	let token;
	try {
		token = await response.json();
	} catch (cause) {
		throw new TwitchAppAuthError("Twitch returned an invalid app-token response.", {
			status: 502,
			code: "twitch_app_auth_invalid_response",
			cause
		});
	}
	if (
		typeof token.access_token !== "string" ||
		token.access_token.length === 0 ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0
	) {
		throw new TwitchAppAuthError("Twitch returned an invalid app-token response.", {
			status: 502,
			code: "twitch_app_auth_invalid_response"
		});
	}
	const nowMs = Date.now();
	return {
		accessToken: token.access_token,
		clientId: credentials.clientId,
		obtainedAtMs: nowMs,
		expiresAtMs: nowMs + token.expires_in * 1000
	};
}

function appAuthStub(env) {
	if (!env.TWITCH_APP_AUTH) {
		throw new TwitchAppAuthError("TWITCH_APP_AUTH is not configured.", {
			status: 503,
			code: "twitch_app_auth_not_configured"
		});
	}
	return env.TWITCH_APP_AUTH.get(
		env.TWITCH_APP_AUTH.idFromName(TWITCH_APP_AUTH_OBJECT_NAME)
	);
}

async function checkedAppAuthJson(response) {
	let result;
	try {
		result = await response.json();
	} catch (cause) {
		throw new TwitchAppAuthError("Twitch app authentication returned an invalid response.", {
			status: 502,
			code: "twitch_app_auth_invalid_service_response",
			cause
		});
	}
	if (!response.ok) {
		throw new TwitchAppAuthError(result?.error || "Twitch app authentication failed.", {
			status: response.status,
			code: result?.code || "twitch_app_auth_service_failed"
		});
	}
	return result;
}

export async function getTwitchAppAccessToken(env, rejectedAccessToken = null) {
	const result = await checkedAppAuthJson(await appAuthStub(env).fetch(
		"https://twitch-app-auth/access-token",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientId: env.TWITCH_CLIENT_ID,
				clientSecret: env.TWITCH_CLIENT_SECRET,
				rejectedAccessToken
			})
		}
	));
	if (typeof result.accessToken !== "string" || result.accessToken.length === 0) {
		throw new TwitchAppAuthError("Twitch app authentication returned an invalid response.", {
			status: 502,
			code: "twitch_app_auth_invalid_service_response"
		});
	}
	return result.accessToken;
}

export async function handleTwitchAppAuthStatus(env) {
	try {
		return await appAuthStub(env).fetch("https://twitch-app-auth/status");
	} catch (error) {
		if (error instanceof TwitchAppAuthError) {
			return noStoreJson({ error: error.message, code: error.code }, error.status);
		}
		logError("twitch.app_auth_status_failed", {
			platform: "twitch",
			correlationId: `twitch-app-auth:${crypto.randomUUID()}`,
			groupId: null
		}, error);
		return noStoreJson({ error: "Twitch app authentication status failed." }, 500);
	}
}

export class TwitchAppAuth {
	constructor(state) {
		this.state = state;
		this.tokenPromise = null;
	}

	async getAccessToken(credentials, rejectedAccessToken = null) {
		for (;;) {
			const cached = await this.state.storage.get(APP_TOKEN_KEY);
			if (
				cached?.clientId === credentials.clientId &&
				cached.accessToken !== rejectedAccessToken &&
				Number.isFinite(cached.expiresAtMs) &&
				cached.expiresAtMs - Date.now() > APP_TOKEN_REFRESH_BUFFER_MS
			) {
				return cached.accessToken;
			}
			if (this.tokenPromise) {
				await this.tokenPromise;
				continue;
			}
			this.tokenPromise = (async () => {
				const token = await requestAppAccessToken(credentials);
				await this.state.storage.put(APP_TOKEN_KEY, token);
				return token.accessToken;
			})();
			try {
				return await this.tokenPromise;
			} finally {
				this.tokenPromise = null;
			}
		}
	}

	async status() {
		const token = await this.state.storage.get(APP_TOKEN_KEY);
		return {
			cached: Boolean(token),
			usable: Boolean(
				token &&
				Number.isFinite(token.expiresAtMs) &&
				token.expiresAtMs - Date.now() > APP_TOKEN_REFRESH_BUFFER_MS
			),
			clientId: token?.clientId ?? null,
			obtainedAtMs: token?.obtainedAtMs ?? null,
			expiresAtMs: token?.expiresAtMs ?? null
		};
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (request.method === "GET" && url.pathname === "/status") {
				return noStoreJson(await this.status());
			}
			if (request.method === "POST" && url.pathname === "/access-token") {
				const input = await request.json();
				const credentials = validateCredentials(input);
				const rejectedAccessToken = typeof input?.rejectedAccessToken === "string"
					? input.rejectedAccessToken
					: null;
				return noStoreJson({
					accessToken: await this.getAccessToken(credentials, rejectedAccessToken)
				});
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof TwitchAppAuthError) {
				return noStoreJson({ error: error.message, code: error.code }, error.status);
			}
			logError("twitch.app_auth_failed", {
				platform: "twitch",
				correlationId: `twitch-app-auth:${crypto.randomUUID()}`,
				groupId: null
			}, error);
			return noStoreJson({ error: "Twitch app authentication failed." }, 500);
		}
	}
}
