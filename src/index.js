import { handleDiscordRequest } from "./platforms/discord/index.js";
import { handleTwitchRequest } from "./platforms/twitch/index.js";
import { discordSchedulingHandlers } from "./platforms/discord/commands.js";
import {
  createJobHandlerRegistry,
  GroupSchedulerBackend
} from "./message-scheduling/index.js";

const schedulerJobHandlers = createJobHandlerRegistry(
  discordSchedulingHandlers
);

/**
 * Durable objects
 */
export class GroupScheduler extends GroupSchedulerBackend {
  constructor(state, env) {
    super(state, env, schedulerJobHandlers);
  }
}
export { GroupConfig } from "./group-configuration.js";
export { TwitchAppAuth } from "./platforms/twitch/app-auth.js";
export { TwitchAuth } from "./platforms/twitch/auth.js";
export {
  TwitchChannelAuth,
  TwitchChannelOAuthCoordinator
} from "./platforms/twitch/channel-auth.js";
export { TwitchEventSubManager } from "./platforms/twitch/eventsub-manager.js";
export { TwitchEventSubService } from "./platforms/twitch/eventsub-service.js";
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
      return handleTwitchRequest(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
