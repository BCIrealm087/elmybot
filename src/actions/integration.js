import {
  createActionDefinition,
  createActionResult
} from "../integrations/contracts.js";
import { createRoutedMessageEffects } from "../integrations/routing.js";

export const INTEGRATION_ACTION_KINDS = Object.freeze({
  PUBLISH_ANNOUNCEMENT: "integration.announcement.publish.v1"
});

export const INTEGRATION_ACTION_CAPABILITIES = Object.freeze({
  PUBLISH_ANNOUNCEMENT: "integration.announcement.publish"
});

function announcementMessage(value, targetPlatform) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Announcement message is required.");
  }
  if (value.length > 2_000) {
    throw new TypeError("Announcement message must not exceed 2000 characters.");
  }
  if (targetPlatform === "twitch" && value.length > 500) {
    throw new TypeError("Twitch announcements must not exceed 500 characters.");
  }
  return value;
}

function targetDescription(platform, count) {
  const platformName = platform === "twitch" ? "Twitch" : "Discord";
  return `${platformName} ${count === 1 ? "channel" : "channels"}`;
}

function platformName(platform) {
  return platform === "twitch" ? "Twitch" : "Discord";
}

export const integrationActions = Object.freeze({
  [INTEGRATION_ACTION_KINDS.PUBLISH_ANNOUNCEMENT]: createActionDefinition({
    kind: INTEGRATION_ACTION_KINDS.PUBLISH_ANNOUNCEMENT,
    capability: INTEGRATION_ACTION_CAPABILITIES.PUBLISH_ANNOUNCEMENT,
    supportedOrigins: ["discord", "twitch"],
    execute(invocation, context) {
      const routes = Array.isArray(context.routes) ? context.routes : [];
      const targetPlatform = context.routeTargetPlatform === "twitch"
        ? "twitch"
        : "discord";
      if (routes.some((route) => route.targetGroup.platform !== targetPlatform)) {
        throw new TypeError("Announcement routes target an unexpected platform.");
      }
      const message = announcementMessage(invocation.args.message, targetPlatform);
      const effects = createRoutedMessageEffects(routes, {
        message,
        sourceEventId: invocation.sourceEventId,
        correlationId: invocation.correlationId
      });
      return createActionResult({
        output: {
          message: routes.length === 0
            ? `No ${platformName(targetPlatform)} announcement route is configured.`
            : `Announcement queued for ${routes.length} ` +
              `${targetDescription(targetPlatform, routes.length)}.`
        },
        effects
      });
    }
  })
});
