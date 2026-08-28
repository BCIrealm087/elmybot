import { describe, expect, it } from "vitest";
import {
  createActionDefinition,
  createCommandInvocation,
  createDomainEvent,
  createEffect,
  createIntegrationExecution,
  createIntegrationRef,
  createPlatformActorRef,
  createPlatformGroupRef,
  INTEGRATION_CONTRACT_SCHEMA_VERSION,
  IntegrationContractError
} from "../src/integrations/index.js";

const twitchChannel = {
  platform: "twitch",
  kind: "channel",
  id: "100"
};

const twitchModerator = {
  platform: "twitch",
  id: "200",
  claims: ["twitch.moderator"]
};

const discordGuild = {
  platform: "discord",
  kind: "guild",
  id: "300"
};

describe("Cross-platform interaction contracts", () => {
  it("builds stable immutable platform and integration identities", () => {
    const group = createPlatformGroupRef(discordGuild);
    const actor = createPlatformActorRef({
      platform: "discord",
      id: "400",
      claims: ["discord.owner", "discord.administrator"]
    });
    const integration = createIntegrationRef({ id: "link-1" });

    expect(group).toEqual({
      platform: "discord",
      kind: "guild",
      id: "300",
      key: "discord:guild:300"
    });
    expect(actor.claims).toEqual(["discord.administrator", "discord.owner"]);
    expect(integration).toEqual({ id: "link-1", key: "integration:link-1" });
    expect(Object.isFrozen(group)).toBe(true);
    expect(Object.isFrozen(actor.claims)).toBe(true);
    expect(Object.isFrozen(integration)).toBe(true);
  });

  it("allows shared and platform-native action definitions", () => {
    const execute = async () => [];
    const shared = createActionDefinition({
      kind: "integration.announcement.publish.v1",
      capability: "integration.announcement.publish",
      supportedOrigins: ["twitch", "discord"],
      execute
    });
    const twitchOnly = createActionDefinition({
      kind: "twitch.poll.start.v1",
      capability: "twitch.poll.manage",
      supportedOrigins: ["twitch"],
      execute
    });

    expect(shared.supportedOrigins).toEqual(["discord", "twitch"]);
    expect(twitchOnly.supportedOrigins).toEqual(["twitch"]);
    expect(twitchOnly.execute).toBe(execute);
  });

  it("normalizes a Twitch command without coupling its action kind to Twitch", () => {
    const args = { message: "Starting soon", nested: { emphasis: true } };
    const invocation = createCommandInvocation({
      kind: "integration.announcement.publish.v1",
      origin: { group: twitchChannel, actor: twitchModerator },
      args,
      sourceEventId: "twitch:eventsub:message-1"
    });

    args.nested.emphasis = false;

    expect(invocation.schemaVersion).toBe(INTEGRATION_CONTRACT_SCHEMA_VERSION);
    expect(invocation.kind).toBe("integration.announcement.publish.v1");
    expect(invocation.origin.group.key).toBe("twitch:channel:100");
    expect(invocation.args.nested.emphasis).toBe(true);
    expect(invocation.correlationId).toBe("twitch:eventsub:message-1");
    expect(Object.isFrozen(invocation.args.nested)).toBe(true);
  });

  it("represents automatic platform events without inventing an actor", () => {
    const event = createDomainEvent({
      kind: "twitch.stream.online.v1",
      source: { group: twitchChannel },
      occurredAt: "2026-08-28T12:00:00Z",
      payload: { streamId: "stream-1" },
      sourceEventId: "twitch:eventsub:notification-1"
    });

    expect(event.source.actor).toBeNull();
    expect(event.occurredAt).toBe("2026-08-28T12:00:00.000Z");
    expect(event.payload).toEqual({ streamId: "stream-1" });
  });

  it("keeps a Twitch cause separate from its Discord target effect", () => {
    const effect = createEffect({
      kind: "discord.message.send.v1",
      target: {
        group: discordGuild,
        destination: { channelId: "500" }
      },
      payload: { content: "The stream is live" },
      integration: { id: "link-1" },
      idempotencyKey: "twitch:notification-1:integration:link-1:route:online",
      correlationId: "twitch:eventsub:notification-1",
      causationId: "twitch:eventsub:notification-1"
    });

    expect(effect.kind).toBe("discord.message.send.v1");
    expect(effect.target.group.platform).toBe("discord");
    expect(effect.causationId).toBe("twitch:eventsub:notification-1");
    expect(effect.integration.key).toBe("integration:link-1");
  });

  it("does not require an integration for platform-native effects", () => {
    const effect = createEffect({
      kind: "discord.message.send.v1",
      target: {
        group: discordGuild,
        destination: { channelId: "500" }
      },
      payload: { content: "Discord-only response" },
      idempotencyKey: "discord:interaction-1:response",
      correlationId: "discord:interaction-1",
      causationId: "discord:interaction-1"
    });

    expect(effect.target.group.platform).toBe("discord");
    expect(effect.integration).toBeNull();
  });

  it("binds an execution's effects to one source, correlation, and integration", () => {
    const sourceEventId = "twitch:eventsub:message-3";
    const integration = createIntegrationRef({ id: "link-1" });
    const effect = createEffect({
      kind: "discord.message.send.v1",
      target: {
        group: discordGuild,
        destination: { channelId: "500" }
      },
      payload: { content: "Hello" },
      integration,
      idempotencyKey: "effect-1",
      correlationId: sourceEventId,
      causationId: sourceEventId
    });
    const execution = createIntegrationExecution({
      integration,
      source: { group: twitchChannel },
      sourceEventId,
      effects: [effect]
    });

    expect(execution).toMatchObject({
      integration: { id: "link-1" },
      sourceEventId,
      correlationId: sourceEventId,
      effects: [{ idempotencyKey: "effect-1" }]
    });
    expect(Object.isFrozen(execution)).toBe(true);
    expect(() => createIntegrationExecution({
      integration,
      source: execution.source,
      sourceEventId,
      effects: [createEffect({
        ...effect,
        causationId: "twitch:eventsub:different"
      })]
    })).toThrow("must match the execution source event ID");
  });

  it("rejects mismatched actors, unversioned kinds, and unsafe payloads", () => {
    expect(() => createCommandInvocation({
      kind: "integration.announcement.publish.v1",
      origin: {
        group: twitchChannel,
        actor: { platform: "discord", id: "200", claims: [] }
      },
      sourceEventId: "twitch:eventsub:message-2"
    })).toThrow(IntegrationContractError);

    expect(() => createActionDefinition({
      kind: "twitch.poll.start",
      capability: "twitch.poll.manage",
      supportedOrigins: ["twitch"],
      execute: async () => []
    })).toThrow("Action kind is invalid.");

    expect(() => createDomainEvent({
      kind: "twitch.stream.online.v1",
      source: { group: twitchChannel },
      occurredAt: "2026-08-28T12:00:00Z",
      payload: { invalid: undefined },
      sourceEventId: "twitch:eventsub:notification-2"
    })).toThrow("Event payload.invalid must contain only JSON values.");

    expect(() => createPlatformActorRef({
      platform: "twitch",
      id: "200",
      claims: ["discord.owner"]
    })).toThrow("must be namespaced to the actor platform");
  });
});
