import { withExternalRequestTimeout } from "../../common.js";
import { DeliveryError } from "../../message-scheduling/index.js";

export async function sendDiscordChannelMessage(env, channelId, messageData) {
  let response;
  try {
    response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      withExternalRequestTimeout({
        method: "POST",
        headers: {
          Authorization: `Bot ${env.DISCORD_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(messageData)
      })
    );
  } catch (cause) {
    throw new DeliveryError("Discord API request failed.", {
      retryable: true,
      code: "discord_network_error",
      cause
    });
  }

  if (!response.ok) {
    throw new DeliveryError(
      `Discord API request failed with status ${response.status}.`,
      {
        retryable: response.status === 429 || response.status >= 500,
        code: "discord_http_error",
        metadata: { status: response.status }
      }
    );
  }
}
