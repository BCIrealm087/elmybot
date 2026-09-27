import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createDurableEventClient } from "../public/event-stream/client.js";
import {
  defineDurableEventStream,
  defineFeature,
  frameworkApiVersion
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import {
  durableEventId,
  durableEventRouteId,
  sha256Hex
} from "../src/durable-events/contract.js";
import { issueDurableEventGrant } from "../src/durable-events/grant-client.js";
import { handleDurableEventRequest } from "../src/durable-events/http.js";
import {
  DURABLE_EVENT_APPEND_PATH,
  durableEventInternalHeaders
} from "../src/durable-events/stream.js";

const browserEnv = {
  ...env,
  DURABLE_EVENT_STREAMS_ENABLED: "true",
  DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT: "test",
  DURABLE_EVENT_PUBLIC_ORIGIN: "https://example.com",
  DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET:
    "test-durable-event-signing-secret-32-bytes-minimum"
};
let sequence = 900_000;

function registry() {
  return createFeatureRegistry([defineFeature({
    apiVersion: frameworkApiVersion,
    id: "test.events",
    description: "Tests the maintained durable-event browser client.",
    eventStreams: [defineDurableEventStream({
      id: "updates",
      version: 1,
      label: "Updates",
      description: "Browser integration updates.",
      platforms: ["discord"],
      scope: { kind: "group_local" },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: { data: { type: "string", minLength: 1, maxLength: 400 } },
          required: ["data"]
        }
      }
    })]
  })]);
}

async function setup() {
  sequence += 1;
  const target = { platform: "discord", groupId: String(sequence) };
  const selectedRegistry = registry();
  const descriptor = {
    deploymentEnvironment: "test",
    scopeKind: "group_local",
    realmIdentity: `discord:guild:${target.groupId}`,
    featureId: "test.events",
    streamId: "updates",
    version: 1
  };
  const route = {
    routeId: await durableEventRouteId(descriptor),
    bindingRevision: 0,
    descriptor
  };
  const stub = browserEnv.DURABLE_EVENT_STREAM.get(
    browserEnv.DURABLE_EVENT_STREAM.idFromName(route.routeId)
  );
  await runInDurableObject(stub, async (instance) => {
    instance.env = browserEnv;
    instance.registry = selectedRegistry;
  });
  const issued = await issueDurableEventGrant(browserEnv, selectedRegistry, {
    target,
    stream: "test.events:updates:v1",
    expiresInSeconds: 3_600,
    resetBacklog: false
  }, { actor: { platform: "discord", id: "operator" } });
  return { target, selectedRegistry, route, stub, issued };
}

async function append(fixture, data) {
  sequence += 1;
  const payload = JSON.stringify({ data });
  const id = await durableEventId({
    featureId: "test.events",
    streamId: "updates",
    version: 1,
    originGroupKey: `discord:guild:${fixture.target.groupId}`,
    sourceEventId: `discord:interaction:${sequence}`
  });
  let response;
  await runInDurableObject(fixture.stub, async (instance) => {
    instance.env = browserEnv;
    instance.registry = fixture.selectedRegistry;
    response = await instance.fetch(new Request(
      `https://durable-event-stream${DURABLE_EVENT_APPEND_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...durableEventInternalHeaders },
        body: JSON.stringify({
          eventId: id,
          fingerprint: await sha256Hex(payload),
          featureId: "test.events",
          streamId: "updates",
          version: 1,
          route: fixture.route,
          payload
        })
      }
    ));
  });
  return response;
}

describe("durable-event browser client integration", () => {
  it("uses its isolated session and replays until the async handler succeeds", async () => {
    const fixture = await setup();
    let cookie = "";
    const statuses = [];
    let attempts = 0;
    const client = createDurableEventClient({
      baseUrl: "https://example.com",
      retryMs: 5,
      heartbeatMs: 10_000,
      heartbeatTimeoutMs: 20_000,
      fetch: async (url, init) => {
        const response = await handleDurableEventRequest(new Request(url, {
          ...init,
          headers: { ...init.headers, origin: "https://example.com", ...(cookie ? { cookie } : {}) }
        }), browserEnv, { registry: fixture.selectedRegistry });
        if (response.headers.has("set-cookie")) {
          cookie = response.headers.get("set-cookie").split(";")[0];
        }
        return response;
      },
      openWebSocket: async (url) => {
        const requestUrl = new URL(url);
        requestUrl.protocol = "https:";
        const response = await handleDurableEventRequest(new Request(requestUrl, {
          headers: { upgrade: "websocket", origin: "https://example.com", cookie }
        }), browserEnv, { registry: fixture.selectedRegistry });
        expect(response.status).toBe(101);
        response.webSocket.accept();
        return response.webSocket;
      }
    });
    try {
      await client.session(fixture.issued.credential);
      expect(cookie).toMatch(/^elmybot_durable_event=/);
      expect((await client.catalog()).target).toEqual(fixture.target);
      client.subscribe(async (event) => {
        attempts += 1;
        expect(event.payload).toEqual({ data: "play-intro" });
        await Promise.resolve();
        if (attempts === 1) throw new Error("retry this event");
      }, { onStatus: (status) => statuses.push(status) });
      await vi.waitFor(
        () => expect(statuses.some(({ state }) => state === "live")).toBe(true),
        { timeout: 3_000 }
      );
      expect((await append(fixture, "play-intro")).status).toBe(200);
      await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 3_000 });
      await vi.waitFor(async () => {
        await runInDurableObject(fixture.stub, async (_instance, state) => {
          expect(state.storage.sql.exec(
            `SELECT acknowledged_sequence, retained_count
             FROM durable_event_stream_metadata WHERE singleton = 1`
          ).one()).toMatchObject({ acknowledged_sequence: 1, retained_count: 0 });
        });
      }, { timeout: 3_000 });
      expect(statuses.some(({ state }) => state === "handler_failed")).toBe(true);
    } finally {
      await client.close();
      await vi.waitFor(async () => {
        await runInDurableObject(fixture.stub, async (_instance, state) => {
          expect(state.getWebSockets()).toHaveLength(0);
          expect(state.storage.sql.exec(
            "SELECT consumer_ready FROM durable_event_stream_metadata WHERE singleton = 1"
          ).one().consumer_ready).toBe(0);
        });
      }, { timeout: 3_000 });
    }
  }, 10_000);
});
