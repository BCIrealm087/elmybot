import { logError } from "../../common.js";
import { sendTwitchChatMessage } from "./chat-delivery.js";
import { commands } from "./commands.js";

function commandFromMessage(messageText) {
	const match = messageText.trim().match(/^!([^\s]+)(?:\s|$)/);
	if (!match) return null;
	const name = match[1].toLowerCase();
	const definition = commands[name];
	if (!definition) return null;
	return {
		name,
		definition,
		argsText: messageText.trim().slice(match[0].length).trim()
	};
}

export function isRecognizedTwitchCommandNotification(payload) {
	if (payload.subscription?.type !== "channel.chat.message") return false;
	const messageText = payload.event?.message?.text;
	return typeof messageText === "string" && commandFromMessage(messageText) !== null;
}

export async function processTwitchChatNotification(payload, env, messageId) {
	if (payload.subscription?.type !== "channel.chat.message") return;

	const messageText = payload.event?.message?.text;
	if (typeof messageText !== "string") return;

	const command = commandFromMessage(messageText);
	if (!command) return;

	try {
		const reply = await Promise.resolve(command.definition.exec(payload.event, env, {
			messageId,
			argsText: command.argsText
		}));
		if (typeof reply !== "string" || reply.length === 0) return;
		await sendTwitchChatMessage(env, payload.event, reply);
	} catch (error) {
		logError("twitch.command_failed", {
			platform: "twitch",
			correlationId: `twitch:${messageId}`,
			groupId: payload.event.broadcaster_user_id,
			command: messageText.trim().split(/\s+/, 1)[0]
		}, error);
		if ((typeof error === "object" && error !== null) || typeof error === "function") {
			Object.defineProperty(error, "eventSubLogged", { value: true });
		}
		throw error;
	}
}

export function handleTwitchChatNotification(payload, env, ctx, messageId) {
	ctx.waitUntil(processTwitchChatNotification(payload, env, messageId));
}
