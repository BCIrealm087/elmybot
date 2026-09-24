import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  defineDurableEventStream,
  defineFeature,
  frameworkApiVersion
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import {
  durableEventId,
  durableEventRouteId,
  DURABLE_EVENT_CODES,
  serializeDurableEventPayload,
  sha256Hex
} from "../src/durable-events/contract.js";
import {
  DURABLE_EVENT_APPEND_PATH,
  DURABLE_EVENT_CONSUMER_PATH,
  durableEventInternalHeaders
} from "../src/durable-events/stream.js";

let uniqueSequence = 0;

function unique(label) {
  uniqueSequence += 1;
  return `${label}-${Date.now()}-${uniqueSequence}`;
}

function fixture() {
  const feature = defineFeature({
    apiVersion: frameworkApiVersion,
    id: "test.events",
    description: "Exercises durable event publication.",
    eventStreams: [defineDurableEventStream({
      id: "updates",
      version: 1,
      label: "Updates",
      description: "Test updates.",
      platforms: ["discord", "twitch"],
      scope: { kind: "group_local" },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: {
            data: { type: "string", minLength: 1, maxLength: 400 }
          },
          required: ["data"]
        }
      }
    })]
  });
  return createFeatureRegistry([feature], { availableServices: ["eventStreams"] });
}

function invocation(groupId, sourceId = unique("source")) {
  return createCommandInvocation({
    kind: "test.events.publish.v1",
    origin: {
      group: { platform: "discord", kind: "guild", id: groupId },
      actor: { platform: "discord", id: "actor-1", claims: [] }
    },
    args: {},
    sourceEventId: `discord:interaction:${sourceId}`
  });
}

async function routeFor(invocationValue) {
  const descriptor = {
    deploymentEnvironment: env.DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT,
    scopeKind: "group_local",
    realmIdentity: invocationValue.origin.group.key,
    featureId: "test.events",
    streamId: "updates",
    version: 1
  };
  return {
    routeId: await durableEventRouteId(descriptor),
    bindingRevision: 0,
    descriptor
  };
}

async function configuredStream(registry, invocationValue, { ready = true } = {}) {
  const route = await routeFor(invocationValue);
  const stub = env.DURABLE_EVENT_STREAM.get(
    env.DURABLE_EVENT_STREAM.idFromName(route.routeId)
  );
  await runInDurableObject(stub, async (instance) => {
    instance.registry = registry;
    if (ready) {
      const response = await instance.fetch(new Request(
        `https://durable-event-stream${DURABLE_EVENT_CONSUMER_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...durableEventInternalHeaders
          },
          body: JSON.stringify({ ready: true })
        }
      ));
      expect(response.status).toBe(200);
    }
  });
  return { route, stub };
}

async function publish(registry, invocationValue, data) {
  const runtime = createFeatureServiceRuntime(env, invocationValue, registry);
  const stream = await runtime.featureServices.eventStreams.local(
    "test.events",
    "updates"
  );
  return stream.publish({ data });
}

describe("durable event publication", () => {
  it("derives stable opaque event identities from the frozen tuple", async () => {
    const input = {
      featureId: "test.events",
      streamId: "updates",
      version: 1,
      originGroupKey: "discord:guild:123",
      sourceEventId: "discord:interaction:456"
    };
    const first = await durableEventId(input);
    expect(first).toBe("dev1.0DNc8tfRq41eTC0m0beGqKpDUM2zJ0Z42eoUk9jLaiY");
    await expect(durableEventId(input)).resolves.toBe(first);
    await expect(durableEventId({ ...input, sourceEventId: "discord:interaction:789" }))
      .resolves.not.toBe(first);
  });

  it("commits once and recovers the same receipt for a source retry", async () => {
    const registry = fixture();
    const action = invocation(unique("guild"));
    const { stub } = await configuredStream(registry, action);

    await expect(publish(registry, action, "play-intro"))
      .resolves.toEqual({ accepted: true });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance) => {
      instance.registry = registry;
    });
    await expect(publish(registry, action, "play-intro"))
      .resolves.toEqual({ accepted: true });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(1);
      expect(Number(state.storage.sql.exec(
        "SELECT next_sequence FROM durable_event_stream_metadata WHERE singleton = 1"
      ).one().next_sequence)).toBe(2);
      expect(state.storage.sql.exec(
        "SELECT payload_json FROM durable_event_stream_events"
      ).one().payload_json).toBe('{"data":"play-intro"}');
    });
  });

  it("recovers a committed append after the source ledger missed the response", async () => {
    const registry = fixture();
    const action = invocation(unique("guild"));
    const { route, stub } = await configuredStream(registry, action);
    const eventId = await durableEventId({
      featureId: "test.events",
      streamId: "updates",
      version: 1,
      originGroupKey: action.origin.group.key,
      sourceEventId: action.sourceEventId
    });
    const payload = serializeDurableEventPayload(
      { data: "response-lost" },
      registry.eventStreams["test.events:updates:v1"].definition.payload.schema
    ).serialized;
    const response = await stub.fetch(`https://durable-event-stream${DURABLE_EVENT_APPEND_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...durableEventInternalHeaders
      },
      body: JSON.stringify({
        eventId,
        fingerprint: await sha256Hex(payload),
        featureId: "test.events",
        streamId: "updates",
        version: 1,
        route,
        payload
      })
    });
    expect(response.status).toBe(200);

    await expect(publish(registry, action, "response-lost"))
      .resolves.toEqual({ accepted: true });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(1);
    });
    const configStub = env.CONFIG.get(env.CONFIG.idFromName(action.origin.group.key));
    await runInDurableObject(configStub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT state, sequence FROM durable_event_publications"
      ).one()).toMatchObject({ state: "committed", sequence: 1 });
    });
  });

  it("rejects a changed payload for the same source without leaking or appending it", async () => {
    const registry = fixture();
    const action = invocation(unique("guild"));
    const { stub } = await configuredStream(registry, action);
    await publish(registry, action, "first-secret");

    await expect(publish(registry, action, "second-secret")).rejects.toMatchObject({
      code: DURABLE_EVENT_CODES.sourceConflict
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT payload_json FROM durable_event_stream_events"
      ).one().payload_json).not.toContain("second-secret");
    });
  });

  it("assigns distinct ordered sequences to distinct sources with identical payloads", async () => {
    const registry = fixture();
    const groupId = unique("guild");
    const first = invocation(groupId);
    const { stub } = await configuredStream(registry, first);
    await publish(registry, first, "same-data");
    await publish(registry, invocation(groupId), "same-data");
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql.exec(
        `SELECT sequence, payload_json FROM durable_event_stream_events
         ORDER BY sequence`
      ).toArray();
      expect(rows.map((row) => Number(row.sequence))).toEqual([1, 2]);
      expect(rows[0].payload_json).toBe(rows[1].payload_json);
    });
  });

  it("stores a stable terminal rejection when no consumer is ready", async () => {
    const registry = fixture();
    const action = invocation(unique("guild"));
    await configuredStream(registry, action, { ready: false });

    await expect(publish(registry, action, "unavailable-secret")).rejects.toMatchObject({
      code: DURABLE_EVENT_CODES.consumerUnavailable
    });
    await expect(publish(registry, action, "unavailable-secret")).rejects.toMatchObject({
      code: DURABLE_EVENT_CODES.consumerUnavailable
    });

    const configStub = env.CONFIG.get(env.CONFIG.idFromName(action.origin.group.key));
    await runInDurableObject(configStub, async (_instance, state) => {
      const row = state.storage.sql.exec(
        `SELECT state, pending_payload, rejection_code
         FROM durable_event_publications`
      ).one();
      expect(row.state).toBe("rejected");
      expect(row.pending_payload).toBeNull();
      expect(row.rejection_code).toBe(DURABLE_EVENT_CODES.consumerUnavailable);
    });
  });

  it("enforces retained capacity and turns expired unacknowledged events into a gap", async () => {
    const registry = fixture();
    const groupId = unique("guild");
    const first = invocation(groupId);
    const { stub } = await configuredStream(registry, first);
    await publish(registry, first, "first");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE durable_event_stream_metadata SET retained_count = 1000
         WHERE singleton = 1`
      );
    });
    await expect(publish(registry, invocation(groupId), "second")).rejects.toMatchObject({
      code: DURABLE_EVENT_CODES.streamFull
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE durable_event_stream_metadata SET retained_count = 1
         WHERE singleton = 1`
      );
      state.storage.sql.exec(
        "UPDATE durable_event_stream_events SET expires_at_ms = 0"
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(publish(registry, invocation(groupId), "third")).rejects.toMatchObject({
      code: DURABLE_EVENT_CODES.gapRequiresReset
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const meta = state.storage.sql.exec(
        `SELECT retained_count, retained_bytes, gap_first_sequence,
                gap_last_sequence FROM durable_event_stream_metadata
         WHERE singleton = 1`
      ).one();
      expect(Number(meta.retained_count)).toBe(0);
      expect(Number(meta.retained_bytes)).toBe(0);
      expect(Number(meta.gap_first_sequence)).toBe(1);
      expect(Number(meta.gap_last_sequence)).toBe(1);
    });
  });

  it("enforces retained-byte and one-second ingress bounds without discarding events", async () => {
    const registry = fixture();
    const groupId = unique("guild");
    const action = invocation(groupId);
    const { stub } = await configuredStream(registry, action);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE durable_event_stream_metadata SET retained_bytes = 1048575
         WHERE singleton = 1`
      );
    });
    await expect(publish(registry, action, "bytes"))
      .rejects.toMatchObject({ code: DURABLE_EVENT_CODES.streamFull });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(0);
      state.storage.sql.exec(
        `UPDATE durable_event_stream_metadata SET retained_bytes = 0
         WHERE singleton = 1`
      );
      const nowMs = Date.now();
      for (let index = 0; index < 10; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO durable_event_stream_ingress (event_id, accepted_at_ms)
           VALUES (?, ?)`,
          `rate-${index}`,
          nowMs
        );
      }
    });
    await expect(publish(registry, invocation(groupId), "rate"))
      .rejects.toMatchObject({ code: DURABLE_EVENT_CODES.streamFull });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_stream_events"
      ).one().total)).toBe(0);
    });
  });

  it("rejects invalid payloads before creating source-ledger rows", async () => {
    const registry = fixture();
    const action = invocation(unique("guild"));
    await configuredStream(registry, action);
    await expect(publish(registry, action, "")).rejects.toMatchObject({
      code: DURABLE_EVENT_CODES.payloadInvalid
    });
    const configStub = env.CONFIG.get(env.CONFIG.idFromName(action.origin.group.key));
    await runInDurableObject(configStub, async (_instance, state) => {
      expect(Number(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM durable_event_publications"
      ).one().total)).toBe(0);
    });
  });
});
