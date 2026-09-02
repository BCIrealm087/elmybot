import { handleDiscordRequest } from "./platforms/discord/index.js";
import { handleTwitchRequest } from "./platforms/twitch/index.js";
import { discordSchedulingHandlers } from "./platforms/discord/commands.js";
import { featureSchedulingHandlers } from "./actions/index.js";
import {
  createJobHandlerRegistry,
  GroupSchedulerBackend
} from "./message-scheduling/index.js";
import {
  createEffectHandlerRegistry,
  IntegrationCoordinatorBackend
} from "./integrations/index.js";
import { discordIntegrationEffectHandlers } from "./platforms/discord/integration-effects.js";
import { twitchIntegrationEffectHandlers } from "./platforms/twitch/integration-effects.js";
import { twitchEventSubDefinitions } from "./platforms/twitch/eventsub-definitions.js";
import { TwitchEventSubInboxBackend } from "./platforms/twitch/eventsub-inbox.js";
import { TwitchEventSubManagerBackend } from "./platforms/twitch/eventsub-manager.js";
import { createTwitchEventSubRegistry } from "./platforms/twitch/eventsub-registry.js";
import { TwitchEventSubServiceBackend } from "./platforms/twitch/eventsub-service.js";
import { featureRegistry } from "./features/index.js";
import { ShareableStateRealmBackend } from "./shareable-state/index.js";

const schedulerJobHandlers = createJobHandlerRegistry(
  discordSchedulingHandlers,
  featureSchedulingHandlers
);
const integrationEffectHandlers = createEffectHandlerRegistry(
  discordIntegrationEffectHandlers,
  twitchIntegrationEffectHandlers
);
const twitchEventSubRegistry = createTwitchEventSubRegistry(
  twitchEventSubDefinitions
);

/**
 * Durable objects
 */
export class GroupScheduler extends GroupSchedulerBackend {
  constructor(state, env) {
    super(state, env, schedulerJobHandlers);
  }
}
export class IntegrationCoordinator extends IntegrationCoordinatorBackend {
  constructor(state, env) {
    super(state, env, integrationEffectHandlers);
  }
}
export class TwitchEventSubManager extends TwitchEventSubManagerBackend {
  constructor(state, env) {
    super(state, env, twitchEventSubRegistry);
  }
}
export class TwitchEventSubService extends TwitchEventSubServiceBackend {
  constructor(state, env) {
    super(state, env, twitchEventSubRegistry);
  }
}
export class TwitchEventSubInbox extends TwitchEventSubInboxBackend {
  constructor(state, env) {
    super(state, env, twitchEventSubRegistry);
  }
}
export class ShareableStateRealm extends ShareableStateRealmBackend {
  constructor(state, env) {
    super(state, env, featureRegistry);
  }
}
export { GroupConfig } from "./group-configuration.js";
export { TwitchAppAuth } from "./platforms/twitch/app-auth.js";
export { TwitchAuth } from "./platforms/twitch/auth.js";
export {
  TwitchChannelAuth,
  TwitchChannelOAuthCoordinator
} from "./platforms/twitch/channel-auth.js";
export { TwitchChannelRegistry } from "./platforms/twitch/channel-registry.js";
export { IntegrationRegistry } from "./integrations/index.js";

/**
 * Cloudflare Worker entrypoint for platform requests.
 */

export default {
  /**
   * Cloudflare Worker fetch handler.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/discord") {
      return handleDiscordRequest(request, env, ctx);
    }
    if (url.pathname === "/twitch" || url.pathname.startsWith("/twitch/")) {
      return handleTwitchRequest(request, env, ctx, twitchEventSubRegistry);
    }
    return new Response("Not found", { status: 404 });
  },
};
