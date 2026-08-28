import { sendDiscordChannelMessage } from "./delivery.js";

export const DISCORD_EFFECT_KINDS = Object.freeze({
  SEND_MESSAGE: "discord.message.send.v1"
});

function validateDiscordMessageEffect(effect) {
  if (effect.target.group.kind !== "guild") {
    return "Discord message effects must target a guild.";
  }
  const channelId = effect.target.destination.channelId;
  if (typeof channelId !== "string" || channelId.length === 0 || channelId.length > 200) {
    return "Discord message effects require a valid channel ID.";
  }
  const content = effect.payload.content;
  if (typeof content !== "string" || content.length === 0 || content.length > 2_000) {
    return "Discord message content must contain between 1 and 2000 characters.";
  }
  return null;
}

export const discordIntegrationEffectHandlers = Object.freeze({
  [DISCORD_EFFECT_KINDS.SEND_MESSAGE]: Object.freeze({
    platform: "discord",
    validateEffect: validateDiscordMessageEffect,
    deliver: async (env, effect) => {
      await sendDiscordChannelMessage(
        env,
        effect.target.destination.channelId,
        {
          content: effect.payload.content,
          allowed_mentions: { parse: [] }
        }
      );
      return null;
    }
  })
});
