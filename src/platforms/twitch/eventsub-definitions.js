import { logError } from "../../common.js";
import { markTwitchChannelAuthorizationRevoked } from "./channel-auth.js";
import { processTwitchChatNotification } from "./chat.js";
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
		handleNotification({ payload, env, messageId }) {
			return processTwitchChatNotification(payload, env, messageId);
		},
		handleRevocation: handleChatRevocation
	})
});
