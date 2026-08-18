import { handleDiscordRequest } from "./platforms/discord/index.js";

/**
 * Durable objects
 */
export { GuildScheduler } from "./message-scheduling/index.js";
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
