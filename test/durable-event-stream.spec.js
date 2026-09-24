import { describe, expect, it, vi } from "vitest";
import {
  defineAction,
  defineDurableEventStream,
  defineEventAction,
  defineFeature,
  defineScheduledAction,
  discordActionCommand,
  DurableEventStreamDefinitionError,
  frameworkApiVersion,
  schema
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/internal.js";
import { createActionRegistry, executeAction } from "../src/actions/registry.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";

const ACTION_KIND = "test.events.emit.v1";

function stream(overrides = {}) {
  return defineDurableEventStream({
    id: "updates",
    version: 1,
    label: " Updates ",
    description: "Durable test updates.",
    platforms: ["twitch", "discord"],
    scope: { kind: "effective_shareable" },
    access: { kind: "operator_grant" },
    payload: {
      schema: {
        type: "object",
        properties: {
          data: { type: "string", minLength: 1, maxLength: 400 },
          origin: { type: "string", minLength: 6, maxLength: 7 }
        },
        required: ["data", "origin"]
      }
    },
    ...overrides
  });
}

function publishingAction(overrides = {}) {
  return defineAction({
    kind: ACTION_KIND,
    supportedOrigins: ["discord", "twitch"],
    input: schema.object({
      data: schema.string({ minLength: 1, maxLength: 400 })
    }),
    uses: { services: ["eventStreams"] },
    cooldown: { scope: "group", seconds: 1 },
    async execute(ctx, { data }) {
      const target = ctx.origin.group.platform === "discord" ? "twitch" : "discord";
      const updates = await ctx.eventStreams.current(target, "updates");
      await updates.publish({ data, origin: ctx.origin.group.platform });
      return { output: { message: "Queued." }, effects: [] };
    },
    ...overrides
  });
}

function actionCommand(actionKind = ACTION_KIND) {
  return discordActionCommand({
    name: "emit",
    description: "Emit one update.",
    availability: "guild",
    actionKind
  });
}

function eventFeature({
  eventStreams = [stream()],
  action = publishingAction(),
  commands = [actionCommand()],
  events = [],
  schedules = []
} = {}) {
  return defineFeature({
    apiVersion: frameworkApiVersion,
    id: "test.events",
    description: "Tests durable event stream declarations.",
    eventStreams,
    actions: [action],
    commands: { discord: commands },
    events,
    schedules
  });
}

function registry(feature = eventFeature()) {
  return createFeatureRegistry([feature], {
    availableServices: ["eventStreams", "state"]
  });
}

describe("durable event stream declarations", () => {
  it("normalizes and freezes an optional contributor declaration", () => {
    const definition = stream();
    expect(definition).toMatchObject({
      id: "updates",
      version: 1,
      label: "Updates",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable" },
      access: { kind: "operator_grant" }
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.payload.schema.properties)).toBe(true);

    const withoutStreams = defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.empty",
      description: "Has no event streams."
    });
    expect(withoutStreams.eventStreams).toEqual([]);
    expect(Object.isFrozen(withoutStreams.eventStreams)).toBe(true);
  });

  it("rejects raw, duplicate, malformed, and unsupported declarations", () => {
    expect(() => defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.raw",
      description: "Uses a raw declaration.",
      eventStreams: [{ id: "updates" }]
    })).toThrow(/defineDurableEventStream/);
    expect(() => defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.duplicate",
      description: "Duplicates a declaration.",
      eventStreams: [stream(), stream()]
    })).toThrow(/duplicates a stream ID and version/);

    for (const override of [
      { id: "Updates" },
      { version: 0 },
      { platforms: [] },
      { scope: { kind: "integration" } },
      { access: { kind: "public" } },
      { payload: { schema: { type: "unknown" } } },
      { payload: { schema: { type: "string" } } },
      { extra: true }
    ]) {
      expect(() => stream(override)).toThrow(DurableEventStreamDefinitionError);
    }
  });

  it("builds a deterministic value-free public catalog", () => {
    const catalog = createFeatureRegistry([
      defineFeature({
        apiVersion: frameworkApiVersion,
        id: "zeta.events",
        description: "Second event feature.",
        eventStreams: [stream({ id: "alerts", scope: { kind: "group_local" } })]
      }),
      defineFeature({
        apiVersion: frameworkApiVersion,
        id: "alpha.events",
        description: "First event feature.",
        eventStreams: [stream()]
      })
    ]).eventCatalog;

    expect(catalog.map(({ feature, stream: streamId }) =>
      `${feature}:${streamId}`
    )).toEqual(["alpha.events:updates", "zeta.events:alerts"]);
    expect(catalog[0]).toEqual({
      feature: "alpha.events",
      stream: "updates",
      version: 1,
      label: "Updates",
      description: "Durable test updates.",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable" },
      access: { kind: "operator_grant" },
      payload: { schema: stream().payload.schema },
      delivery: {
        kind: "bounded_at_least_once",
        consumers: 1,
        retentionSeconds: 1_800,
        maxRetainedEvents: 1_000,
        maxRetainedBytes: 1_048_576
      }
    });
    expect(JSON.stringify(catalog)).not.toContain("payloads");
    expect(JSON.stringify(catalog)).not.toContain("realm");
    expect(Object.isFrozen(catalog[0].delivery)).toBe(true);
  });

  it("registers a command-only event action and exposes feature-bound accessors", async () => {
    const publish = vi.fn(async () => ({ eventId: "dev1.receipt" }));
    const current = vi.fn(async () => ({ publish }));
    const actions = createActionRegistry(registry().actions);
    const result = await executeAction(actions, createCommandInvocation({
      kind: ACTION_KIND,
      args: { data: "play-intro" },
      origin: {
        group: { platform: "discord", kind: "guild", id: "guild" },
        actor: { platform: "discord", id: "actor", claims: [] }
      },
      sourceEventId: "discord:interaction:123"
    }), {
      featureServices: { eventStreams: { current } },
      claimFeatureCooldown: async () => ({ allowed: true, retryAfterSeconds: 0 })
    });

    expect(result).toMatchObject({ output: { message: "Queued." }, effects: [] });
    expect(current).toHaveBeenCalledWith("test.events", "twitch", "updates");
    expect(publish).toHaveBeenCalledWith({ data: "play-intro", origin: "discord" });
  });

  it("requires a declaration, isolated dependencies, cooldown, and compatible origin", () => {
    const cases = [
      [eventFeature({ eventStreams: [] }), "feature_action_event_stream_undeclared"],
      [
        eventFeature({ action: publishingAction({ cooldown: null }) }),
        "feature_action_event_stream_cooldown_required"
      ],
      [
        eventFeature({
          action: publishingAction({
            uses: { services: ["eventStreams", "state"] }
          })
        }),
        "feature_action_event_stream_mixed_dependencies"
      ],
      [
        eventFeature({ eventStreams: [stream({ platforms: ["discord"] })] }),
        "feature_action_event_stream_origin_unsupported"
      ],
      [eventFeature({ commands: [] }), "feature_action_event_stream_command_required"]
    ];
    for (const [feature, code] of cases) {
      expect(() => registry(feature)).toThrow(expect.objectContaining({ code }));
    }
  });

  it("rejects event and scheduled triggers for event-publishing actions", () => {
    const event = defineEventAction({
      eventKind: "discord.test.message.v1",
      actionKind: ACTION_KIND,
      mapPayload: () => ({ data: "event" })
    });
    expect(() => registry(eventFeature({ events: [event] }))).toThrow(
      expect.objectContaining({
        code: "feature_event_event_stream_action_unsupported"
      })
    );

    const schedule = defineScheduledAction({
      kind: "discord.test.events.v1",
      sourcePlatform: "discord",
      actionKind: ACTION_KIND,
      timing: "timestamp",
      authorization: "grant-at-creation"
    });
    expect(() => registry(eventFeature({ schedules: [schedule] }))).toThrow(
      expect.objectContaining({
        code: "feature_schedule_event_stream_action_unsupported"
      })
    );
  });
});
