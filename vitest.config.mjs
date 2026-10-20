import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  test: {
    // Each pool worker starts a full workerd runtime. Bound cross-file fixture
    // traffic so it does not starve native alarm/socket deadlines.
    // File isolation and the tests' explicit concurrent operations stay enabled.
    maxWorkers: 2,
    // Multi-object setup, delivery, ACK and cleanup can exceed five seconds on
    // development hosts. This is the outer harness deadline; tests keep their
    // explicit delivery-latency, lease, work-budget and retry assertions.
    testTimeout: 15_000,
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          STATE_QUERY_STREAMS_ENABLED: "true",
          STATE_EVENT_OPERATIONS_ENABLED: "true",
          // Existing recovery/cost fixtures explicitly drive alarms. Activation
          // tests opt into the production default to exercise both paths.
          STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED: "false",
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
