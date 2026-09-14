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
          STATE_QUERY_CREDENTIAL_SIGNING_SECRET:
            "test-state-query-signing-secret-32-bytes-minimum",
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
});
