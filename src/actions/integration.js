import {
  createActionDefinition,
  createActionResult
} from "../integrations/contracts.js";
import { createDiscordMessageEffects } from "../integrations/routing.js";

export const INTEGRATION_ACTION_KINDS = Object.freeze({
  PUBLISH_ANNOUNCEMENT: "integration.announcement.publish.v1"
});

export const INTEGRATION_ACTION_CAPABILITIES = Object.freeze({
  PUBLISH_ANNOUNCEMENT: "integration.announcement.publish"
});

function announcementMessage(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Announcement message is required.");
  }
  if (value.length > 2_000) {
    throw new TypeError("Announcement message must not exceed 2000 characters.");
  }
  return value;
}

export const integrationActions = Object.freeze({
  [INTEGRATION_ACTION_KINDS.PUBLISH_ANNOUNCEMENT]: createActionDefinition({
    kind: INTEGRATION_ACTION_KINDS.PUBLISH_ANNOUNCEMENT,
    capability: INTEGRATION_ACTION_CAPABILITIES.PUBLISH_ANNOUNCEMENT,
    supportedOrigins: ["discord", "twitch"],
    execute(invocation, context) {
      const routes = Array.isArray(context.routes) ? context.routes : [];
      const message = announcementMessage(invocation.args.message);
      const effects = createDiscordMessageEffects(routes, {
        content: message,
        sourceEventId: invocation.sourceEventId,
        correlationId: invocation.correlationId
      });
      return createActionResult({
        output: {
          message: routes.length === 0
            ? "No Discord announcement route is configured."
            : `Announcement queued for ${routes.length} Discord ` +
              `${routes.length === 1 ? "channel" : "channels"}.`
        },
        effects
      });
    }
  })
});
