import { sendTwitchChatMessage } from "./chat-delivery.js";

export const TWITCH_EFFECT_KINDS = Object.freeze({
  SEND_CHAT_MESSAGE: "twitch.chat.send.v1"
});

function validateTwitchChatEffect(effect) {
  if (effect.target.group.kind !== "channel") {
    return "Twitch chat effects must target a channel.";
  }
  if (Object.keys(effect.target.destination).length !== 0) {
    return "Twitch chat effects do not accept a separate destination.";
  }
  const message = effect.payload.message;
  if (typeof message !== "string" || message.length === 0 || message.length > 500) {
    return "Twitch chat messages must contain between 1 and 500 characters.";
  }
  return null;
}

export const twitchIntegrationEffectHandlers = Object.freeze({
  [TWITCH_EFFECT_KINDS.SEND_CHAT_MESSAGE]: Object.freeze({
    platform: "twitch",
    validateEffect: validateTwitchChatEffect,
    deliver: async (env, effect) => ({
      messageId: await sendTwitchChatMessage(
        env,
        { broadcaster_user_id: effect.target.group.id },
        effect.payload.message
      )
    })
  })
});
