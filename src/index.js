import { handleDiscordRequest } from "./platforms/discord/index.js";
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

/**
 * Cloudflare Worker entrypoint for Discord interactions.
 */

export default {
  /**
   * Cloudflare Worker fetch handler (Discord interactions entrypoint).
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/discord") {
      return handleDiscordRequest(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
