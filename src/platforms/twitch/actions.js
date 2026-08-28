import { actionRegistry, executeAction } from "../../actions/index.js";
import { createCommandInvocation } from "../../integrations/contracts.js";

function twitchActorClaims(event) {
  const badgeClaims = new Set(
    Array.isArray(event.badges)
      ? event.badges.map((badge) => badge?.set_id)
      : []
  );
  const claims = [];
  if (
    event.chatter_user_id === event.broadcaster_user_id ||
    badgeClaims.has("broadcaster")
  ) {
    claims.push("twitch.broadcaster");
  }
  if (badgeClaims.has("moderator")) claims.push("twitch.moderator");
  return claims;
}

export function createTwitchActionInvocation(event, messageId, kind, args = {}) {
  const sourceEventId = `twitch:eventsub:${messageId}`;
  return createCommandInvocation({
    kind,
    origin: {
      group: {
        platform: "twitch",
        kind: "channel",
        id: event.broadcaster_user_id
      },
      actor: {
        platform: "twitch",
        id: event.chatter_user_id,
        claims: twitchActorClaims(event)
      }
    },
    args,
    sourceEventId,
    correlationId: sourceEventId
  });
}

export async function executeTwitchAction(
  event,
  messageId,
  kind,
  args = {},
  context = {}
) {
  return executeAction(
    actionRegistry,
    createTwitchActionInvocation(event, messageId, kind, args),
    context
  );
}

export function twitchTextActionResponse(result) {
  const message = result?.output?.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("The action did not return a Twitch text response.");
  }
  return message;
}
