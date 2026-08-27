const TWITCH_DEPLOYMENT_ENVIRONMENTS = new Set(["production", "test"]);

export class TwitchEnvironmentError extends Error {
	constructor(message, {
		status = 503,
		code = "twitch_environment_invalid"
	} = {}) {
		super(message);
		this.name = "TwitchEnvironmentError";
		this.status = status;
		this.code = code;
	}
}

function requiredString(value, name) {
	if (typeof value !== "string" || value.length === 0) {
		throw new TwitchEnvironmentError(`${name} is not configured.`, {
			code: "twitch_environment_not_configured"
		});
	}
	return value;
}

function validatedPublicOrigin(value) {
	let parsed;
	try {
		parsed = new URL(requiredString(value, "TWITCH_PUBLIC_ORIGIN"));
	} catch (cause) {
		if (cause instanceof TwitchEnvironmentError) throw cause;
		throw new TwitchEnvironmentError("TWITCH_PUBLIC_ORIGIN is invalid.");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	) {
		throw new TwitchEnvironmentError(
			"TWITCH_PUBLIC_ORIGIN must be an HTTPS origin without a path."
		);
	}
	return parsed.origin;
}

export function twitchEnvironmentConfiguration(env) {
	const deploymentEnvironment = requiredString(
		env.TWITCH_DEPLOYMENT_ENVIRONMENT,
		"TWITCH_DEPLOYMENT_ENVIRONMENT"
	);
	if (!TWITCH_DEPLOYMENT_ENVIRONMENTS.has(deploymentEnvironment)) {
		throw new TwitchEnvironmentError(
			"TWITCH_DEPLOYMENT_ENVIRONMENT must be production or test."
		);
	}

	return Object.freeze({
		deploymentEnvironment,
		publicOrigin: validatedPublicOrigin(env.TWITCH_PUBLIC_ORIGIN),
		clientId: requiredString(env.TWITCH_CLIENT_ID, "TWITCH_CLIENT_ID"),
		botUserId: requiredString(env.TWITCH_BOT_USER_ID, "TWITCH_BOT_USER_ID")
	});
}

export function twitchPublicUrl(env, pathname) {
	if (
		typeof pathname !== "string" ||
		!pathname.startsWith("/") ||
		pathname.startsWith("//")
	) {
		throw new TwitchEnvironmentError("The Twitch public path is invalid.");
	}
	const configuration = twitchEnvironmentConfiguration(env);
	const resolved = new URL(pathname, configuration.publicOrigin);
	if (resolved.origin !== configuration.publicOrigin) {
		throw new TwitchEnvironmentError("The Twitch public path is invalid.");
	}
	return resolved.href;
}

export function assertTwitchRequestOrigin(request, env) {
	const configuration = twitchEnvironmentConfiguration(env);
	if (new URL(request.url).origin !== configuration.publicOrigin) {
		throw new TwitchEnvironmentError(
			"This request did not use the configured Twitch public origin.",
			{
				status: 421,
				code: "twitch_environment_origin_mismatch"
			}
		);
	}
	return configuration;
}
