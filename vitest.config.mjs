import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          TWITCH_CLIENT_ID: "client-id",
          TWITCH_CLIENT_SECRET: "test-client-secret",
          TWITCH_BOT_USER_ID: "bot-user-id",
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
});
