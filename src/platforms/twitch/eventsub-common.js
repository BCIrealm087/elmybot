import { jsonResponse } from "../../common.js";

export const RECOVERABLE_EVENTSUB_STATUS = "notification_failures_exceeded";
export const TWITCH_CHANNEL_AUTHORIZATION_MODES = Object.freeze([
	"moderator",
	"broadcaster_oauth"
]);

export class TwitchEventSubError extends Error {
	constructor(message, { status = 400, code = "twitch_eventsub_error", cause } = {}) {
		super(message, { cause });
		this.status = status;
		this.code = code;
	}
}

export function noStoreJson(value, status = 200) {
	const response = jsonResponse(value, status);
	response.headers.set("cache-control", "no-store");
	return response;
}

export function validateEventSubMessageId(messageId) {
	if (
		typeof messageId !== "string" ||
		messageId.length === 0 ||
		messageId.length > 512
	) {
		throw new TwitchEventSubError("The EventSub message ID is invalid.", {
			status: 400,
			code: "twitch_eventsub_invalid_message_id"
		});
	}
	return messageId;
}

export function validateChannelConfig(channel) {
	if (
		typeof channel?.broadcasterUserId !== "string" ||
		channel.broadcasterUserId.length === 0 ||
		typeof channel.callbackUrl !== "string" ||
		channel.callbackUrl.length === 0
	) {
		throw new TwitchEventSubError("The Twitch channel configuration is invalid.");
	}

	let callback;
	try {
		callback = new URL(channel.callbackUrl);
	} catch {
		throw new TwitchEventSubError("The Twitch channel callback is invalid.");
	}
	if (callback.protocol !== "https:" || callback.pathname !== "/twitch") {
		throw new TwitchEventSubError("The Twitch channel callback is invalid.");
	}
	const authorizationMode = channel.authorizationMode ?? "moderator";
	if (!TWITCH_CHANNEL_AUTHORIZATION_MODES.includes(authorizationMode)) {
		throw new TwitchEventSubError("The Twitch channel authorization mode is invalid.");
	}

	return {
		broadcasterUserId: channel.broadcasterUserId,
		callbackUrl: callback.href,
		authorizationMode
	};
}
