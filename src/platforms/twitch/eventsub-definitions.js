import { logError } from "../../common.js";
import { executeInstalledFeatureEvent } from "../../actions/index.js";
import { createDomainEvent } from "../../integrations/contracts.js";
import { markTwitchChannelAuthorizationRevoked } from "./channel-auth.js";
import {
	isRecognizedTwitchCommandNotification,
	processTwitchChatNotification
} from "./chat.js";
import {
	queueTwitchEventSubRecovery,
	RECOVERABLE_EVENTSUB_STATUS
} from "./eventsub.js";
import { TWITCH_EVENTSUB_KINDS } from "./eventsub-kinds.js";

export { TWITCH_EVENTSUB_KINDS } from "./eventsub-kinds.js";

async function handleChatRevocation({ payload, env, messageId, callbackUrl }) {
	const subscription = payload.subscription;
	const status = subscription?.status;
	const broadcasterUserId = subscription?.condition?.broadcaster_user_id;
	const context = {
		platform: "twitch",
		correlationId: `twitch:${messageId}`,
		groupId: broadcasterUserId ?? null,
		subscriptionId: subscription?.id ?? null
	};

	console.warn(JSON.stringify({
		level: "warn",
		event: "twitch.eventsub_revoked",
		...context,
		subscriptionType: subscription?.type ?? null,
		status: status ?? null,
		recoverable: status === RECOVERABLE_EVENTSUB_STATUS
	}));

	const operations = [];
	if (
		status === "authorization_revoked" &&
		typeof broadcasterUserId === "string" &&
		broadcasterUserId.length > 0
	) {
		operations.push(
			markTwitchChannelAuthorizationRevoked(env, broadcasterUserId).catch((error) => {
				logError("twitch.channel_oauth_revocation_failed", context, error);
				throw error;
			})
		);
	}

	if (
		status === RECOVERABLE_EVENTSUB_STATUS &&
		typeof broadcasterUserId === "string" &&
		broadcasterUserId.length > 0
	) {
		operations.push(
			queueTwitchEventSubRecovery(env, {
				broadcasterUserId,
				callbackUrl,
				reason: status,
				sourceSubscriptionId: subscription.id
			}).catch((error) => {
				logError("twitch.eventsub_recovery_queue_failed", context, error);
				throw error;
			})
		);
	}

	await Promise.all(operations);
}

function invalidStreamOnlineEvent(message) {
	const error = new TypeError(message);
	error.retryable = false;
	error.code = "twitch_stream_online_event_invalid";
	return error;
}

function streamOnlineEvent(payload, messageId, messageTimestamp) {
	const event = payload?.event;
	if (
		typeof event?.id !== "string" || event.id.length === 0 ||
		typeof event?.broadcaster_user_id !== "string" ||
		event.broadcaster_user_id.length === 0 ||
		typeof event?.broadcaster_user_login !== "string" ||
		!/^[a-z0-9_]{1,25}$/.test(event.broadcaster_user_login) ||
		typeof event?.broadcaster_user_name !== "string" ||
		event.broadcaster_user_name.length === 0 ||
		event.broadcaster_user_name.length > 100 ||
		!Number.isFinite(Date.parse(event.started_at))
	) {
		throw invalidStreamOnlineEvent("The Twitch stream-online event is invalid.");
	}
	const sourceEventId = `twitch:eventsub:${messageId}`;
	return createDomainEvent({
		kind: TWITCH_EVENTSUB_KINDS.STREAM_ONLINE,
		source: {
			group: {
				platform: "twitch",
				kind: "channel",
				id: event.broadcaster_user_id
			},
			actor: null
		},
		occurredAt: event.started_at ?? messageTimestamp,
		payload: {
			streamId: event.id,
			broadcasterLogin: event.broadcaster_user_login,
			broadcasterName: event.broadcaster_user_name,
			streamType: typeof event.type === "string" ? event.type : "live"
		},
		sourceEventId,
		correlationId: sourceEventId
	});
}

export async function processTwitchStreamOnlineNotification(
	payload,
	env,
	messageId,
	messageTimestamp
) {
	const event = streamOnlineEvent(payload, messageId, messageTimestamp);
	await executeInstalledFeatureEvent(event, env);
}

async function handleStreamOnlineRevocation({
	payload,
	env,
	messageId,
	callbackUrl
}) {
	const subscription = payload.subscription;
	const status = subscription?.status;
	const broadcasterUserId = subscription?.condition?.broadcaster_user_id;
	console.warn(JSON.stringify({
		level: "warn",
		event: "twitch.eventsub_revoked",
		platform: "twitch",
		correlationId: `twitch:${messageId}`,
		groupId: broadcasterUserId ?? null,
		subscriptionId: subscription?.id ?? null,
		subscriptionType: subscription?.type ?? null,
		status: status ?? null,
		recoverable: status === RECOVERABLE_EVENTSUB_STATUS
	}));
	if (
		status === RECOVERABLE_EVENTSUB_STATUS &&
		typeof broadcasterUserId === "string" &&
		broadcasterUserId.length > 0
	) {
		await queueTwitchEventSubRecovery(env, {
			broadcasterUserId,
			callbackUrl,
			reason: status,
			sourceSubscriptionId: subscription.id
		});
	}
}

export const twitchEventSubDefinitions = Object.freeze({
	[TWITCH_EVENTSUB_KINDS.CHAT_MESSAGE]: Object.freeze({
		kind: TWITCH_EVENTSUB_KINDS.CHAT_MESSAGE,
		type: "channel.chat.message",
		version: "1",
		needsBotUserId: true,
		condition({ channel, credentials }) {
			return {
				broadcaster_user_id: channel.broadcasterUserId,
				user_id: credentials.botUserId
			};
		},
		shouldEnqueueNotification({ payload }) {
			return isRecognizedTwitchCommandNotification(payload);
		},
		handleNotification({ payload, env, messageId }) {
			return processTwitchChatNotification(payload, env, messageId);
		},
		handleRevocation: handleChatRevocation
	}),
	[TWITCH_EVENTSUB_KINDS.STREAM_ONLINE]: Object.freeze({
		kind: TWITCH_EVENTSUB_KINDS.STREAM_ONLINE,
		type: "stream.online",
		version: "1",
		needsBotUserId: false,
		condition({ channel }) {
			return { broadcaster_user_id: channel.broadcasterUserId };
		},
		handleNotification({ payload, env, messageId, messageTimestamp }) {
			return processTwitchStreamOnlineNotification(
				payload,
				env,
				messageId,
				messageTimestamp
			);
		},
		handleRevocation: handleStreamOnlineRevocation
	})
});
