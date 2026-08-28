import { logError } from "../../common.js";
import { sendTwitchChatMessage } from "./chat-delivery.js";
import { commands } from "./commands.js";

function commandFromMessage(messageText) {
	const match = messageText.trim().match(/^!([^\s]+)(?:\s|$)/);
	if (!match) return null;
	return commands[match[1].toLowerCase()] ?? null;
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
