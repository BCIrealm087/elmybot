import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          STATE_QUERY_STREAMS_ENABLED: "true",
          TWITCH_CLIENT_ID: "client-id",
          TWITCH_CLIENT_SECRET: "test-client-secret",
          TWITCH_BOT_USER_ID: "bot-user-id",
          STATE_QUERY_CREDENTIAL_SIGNING_SECRET:
            "test-state-query-signing-secret-32-bytes-minimum",
          DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET:
            "test-durable-event-signing-secret-32-bytes-minimum",
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
});
