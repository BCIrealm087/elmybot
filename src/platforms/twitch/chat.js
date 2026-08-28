import { logError, withExternalRequestTimeout } from "../../common.js";
import { getTwitchAppAccessToken } from "./app-auth.js";
import { commands } from "./commands.js";

const TWITCH_CHAT_METADATA_STRING_MAX_LENGTH = 500;

function commandFromMessage(messageText) {
	const match = messageText.trim().match(/^!([^\s]+)(?:\s|$)/);
	if (!match) return null;
	return commands[match[1].toLowerCase()] ?? null;
}

class TwitchChatDeliveryError extends Error {
	constructor(message, {
		classification,
		code,
		status,
		retryable = false,
		metadata = {},
		cause
	}) {
		super(message, { cause });
		this.name = "TwitchChatDeliveryError";
		this.classification = classification;
		this.code = code;
		this.retryable = retryable;
		if (status !== undefined) this.status = status;
		if (Object.keys(metadata).length > 0) this.metadata = metadata;
	}
}

function boundedTwitchChatMetadataString(value) {
	return typeof value === "string"
		? value.slice(0, TWITCH_CHAT_METADATA_STRING_MAX_LENGTH)
		: null;
}

function twitchChatHttpError(status) {
	if (status === 401) {
		return new TwitchChatDeliveryError(
			"Twitch rejected the refreshed chat authorization.",
			{
				classification: "authentication",
				code: "twitch_chat_authentication_failed",
				status
			}
		);
	}
	if (status === 403) {
		return new TwitchChatDeliveryError(
			"The bot is not permitted to send to this Twitch channel.",
			{
				classification: "authorization",
				code: "twitch_chat_authorization_failed",
				status
			}
		);
	}
	if (status === 429) {
		return new TwitchChatDeliveryError("Twitch chat rate limit exceeded.", {
			classification: "rate_limit",
			code: "twitch_chat_rate_limited",
			status,
			retryable: true
		});
	}
	if (status >= 500) {
		return new TwitchChatDeliveryError("Twitch chat is temporarily unavailable.", {
			classification: "service",
			code: "twitch_chat_service_unavailable",
			status,
			retryable: true
		});
	}
	if (status === 400 || status === 422) {
		return new TwitchChatDeliveryError("Twitch rejected the chat request.", {
			classification: "invalid_request",
			code: "twitch_chat_invalid_request",
			status
		});
	}
	return new TwitchChatDeliveryError("Twitch rejected the chat request.", {
		classification: "http",
		code: "twitch_chat_http_error",
		status
	});
}

async function postTwitchChatMessage(env, event, message, accessToken) {
	try {
		return await fetch(
			"https://api.twitch.tv/helix/chat/messages",
			withExternalRequestTimeout({
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Client-Id": env.TWITCH_CLIENT_ID,
					"content-type": "application/json"
				},
				body: JSON.stringify({
					broadcaster_id: event.broadcaster_user_id,
					sender_id: env.TWITCH_BOT_USER_ID,
					message
				})
			})
		);
	} catch (cause) {
		throw new TwitchChatDeliveryError("Twitch chat request failed.", {
			classification: "network",
			code: "twitch_chat_network_error",
			retryable: true,
			cause
		});
	}
}

async function validateTwitchChatResponse(response) {
	if (!response.ok) {
		await response.text();
		throw twitchChatHttpError(response.status);
	}

	let result;
	try {
		result = await response.json();
	} catch (cause) {
		throw new TwitchChatDeliveryError(
			"Twitch returned an invalid chat response.",
			{
				classification: "invalid_response",
				code: "twitch_chat_invalid_response",
				retryable: true,
				cause
			}
		);
	}

	const sent = result?.data?.[0];
	if (sent?.is_sent === false) {
		throw new TwitchChatDeliveryError("Twitch dropped the chat message.", {
			classification: "dropped",
			code: "twitch_chat_message_dropped",
			metadata: {
				dropReason: {
					code: boundedTwitchChatMetadataString(sent.drop_reason?.code),
					message: boundedTwitchChatMetadataString(sent.drop_reason?.message)
				}
			}
		});
	}
	if (
		sent?.is_sent !== true ||
		typeof sent.message_id !== "string" ||
		sent.message_id.length === 0
	) {
		throw new TwitchChatDeliveryError(
			"Twitch returned an invalid chat response.",
			{
				classification: "invalid_response",
				code: "twitch_chat_invalid_response",
				retryable: true
			}
		);
	}
	return sent.message_id;
}

async function sendTwitchChatMessage(env, event, message) {
	if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || !env.TWITCH_BOT_USER_ID) {
		throw new Error("Twitch chat credentials are not configured.");
	}
	if (!event?.broadcaster_user_id) {
		throw new Error("Twitch chat event is missing its broadcaster ID.");
	}

	let accessToken = await getTwitchAppAccessToken(env);
	let response = await postTwitchChatMessage(env, event, message, accessToken);
	if (response.status === 401) {
		await response.text();
		accessToken = await getTwitchAppAccessToken(env, accessToken);
		response = await postTwitchChatMessage(env, event, message, accessToken);
	}

	return validateTwitchChatResponse(response);
}

export function handleTwitchChatNotification(payload, env, ctx, messageId) {
	if (payload.subscription?.type !== "channel.chat.message") return;

	const messageText = payload.event?.message?.text;
	if (typeof messageText !== "string") return;

	const command = commandFromMessage(messageText);
	if (!command) return;

	const reply = command.exec(payload.event, env);
	if (typeof reply !== "string" || reply.length === 0) return;

	ctx.waitUntil(
		sendTwitchChatMessage(env, payload.event, reply).catch((error) =>
			logError("twitch.command_failed", {
				platform: "twitch",
				correlationId: `twitch:${messageId}`,
				groupId: payload.event.broadcaster_user_id,
				command: messageText.trim().split(/\s+/, 1)[0]
			}, error)
		)
	);
}
