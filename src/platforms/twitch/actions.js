import {
  actionRegistry,
  executeAction,
  INTEGRATION_ACTION_CAPABILITIES
} from "../../actions/index.js";
import { createCommandInvocation } from "../../integrations/contracts.js";
import {
  resolveRoutes,
  submitRoutedEffects
} from "../../integrations/index.js";
import { FRAMEWORK_CAPABILITIES } from "../../framework/index.js";

export function twitchActorClaims(event) {
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

export function twitchCapabilityAllowed(capability, actorClaims) {
  if (capability === null) return true;
  const claims = new Set(actorClaims);
  if (capability === FRAMEWORK_CAPABILITIES.MEMBERS) return true;
  if (capability === FRAMEWORK_CAPABILITIES.MODERATORS) {
    return claims.has("twitch.broadcaster") || claims.has("twitch.moderator");
  }
  if (capability === FRAMEWORK_CAPABILITIES.MANAGERS) {
    return claims.has("twitch.broadcaster");
  }
  if (capability === INTEGRATION_ACTION_CAPABILITIES.PUBLISH_ANNOUNCEMENT) {
    return claims.has("twitch.broadcaster") || claims.has("twitch.moderator");
  }
  return false;
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

function authorizeTwitchAction({ capability, invocation }) {
  return twitchCapabilityAllowed(capability, invocation.origin.actor.claims);
}

export async function executeTwitchRoutedAction(
  event,
  messageId,
  kind,
  args,
  { env, routeKind }
) {
  const invocation = createTwitchActionInvocation(event, messageId, kind, args);
  const routes = await resolveRoutes(env, invocation.origin.group, routeKind);
  const result = await executeAction(actionRegistry, invocation, {
    env,
    routes,
    routeTargetPlatform: "discord",
    authorize: authorizeTwitchAction
  });
  await submitRoutedEffects(env, {
    source: invocation.origin,
    sourceEventId: invocation.sourceEventId,
    correlationId: invocation.correlationId,
    effects: result.effects
  });
  return result;
}

export function twitchTextActionResponse(result) {
  const message = result?.output?.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("The action did not return a Twitch text response.");
  }
  return message;
}
