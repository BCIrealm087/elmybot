import { describe, expect, it, vi } from "vitest";
import {
  actionRegistry,
  CORE_ACTION_KINDS,
  createActionRegistry,
  executeAction
} from "../src/actions/index.js";
import {
  createActionDefinition,
  createCommandInvocation
} from "../src/integrations/index.js";
import { createDiscordActionInvocation } from "../src/platforms/discord/actions.js";
import { createTwitchActionInvocation } from "../src/platforms/twitch/actions.js";

function invocation({
  platform,
  kind = CORE_ACTION_KINDS.ALIVE,
  sourceEventId = `${platform}:command:1`
}) {
  return createCommandInvocation({
    kind,
    origin: {
      group: {
        platform,
        kind: platform === "discord" ? "guild" : "channel",
        id: `${platform}-group`
      },
      actor: {
        platform,
        id: `${platform}-actor`,
        claims: []
      }
    },
    sourceEventId
  });
}

describe("Platform-neutral action registry", () => {
  it("registers immutable definitions and rejects duplicate kinds", () => {
    const action = createActionDefinition({
      kind: "test.health.check.v1",
      supportedOrigins: ["discord"],
      execute: () => ({ output: { ok: true } })
    });
    const registry = createActionRegistry({ [action.kind]: action });

    expect(registry[action.kind]).toMatchObject({
      kind: action.kind,
      capability: null,
      supportedOrigins: ["discord"]
    });
    expect(() => { registry[action.kind] = null; }).toThrow(TypeError);
    expect(() => { registry["test.other.v1"] = action; }).toThrow(TypeError);
    expect(() => createActionRegistry(
      { [action.kind]: action },
      { [action.kind]: action }
    )).toThrow(`Duplicate action kind: \`${action.kind}\`.`);
  });

  it("executes the same alive action for Discord and Twitch invocations", async () => {
    const discordResult = await executeAction(
      actionRegistry,
      invocation({ platform: "discord" })
    );
    const twitchResult = await executeAction(
      actionRegistry,
      invocation({ platform: "twitch" })
    );

    expect(discordResult).toEqual(twitchResult);
    expect(discordResult).toEqual({
      schemaVersion: 1,
      output: { message: "I'm here!!1" },
      effects: []
    });
    expect(Object.isFrozen(discordResult.output)).toBe(true);
  });

  it("keeps platform authentication details in the ingress adapters", () => {
    const discord = createDiscordActionInvocation({
      id: "interaction-1",
      guild_id: "guild-1",
      channel_id: "channel-1",
      member: { user: { id: "discord-user-1" } }
    }, CORE_ACTION_KINDS.ALIVE);
    const twitch = createTwitchActionInvocation({
      broadcaster_user_id: "broadcaster-1",
      chatter_user_id: "moderator-1",
      badges: [{ set_id: "moderator", id: "1" }]
    }, "notification-1", CORE_ACTION_KINDS.ALIVE);

    expect(discord).toMatchObject({
      origin: {
        group: { key: "discord:guild:guild-1" },
        actor: { id: "discord-user-1", claims: [] }
      },
      sourceEventId: "discord:interaction:interaction-1"
    });
    expect(twitch).toMatchObject({
      origin: {
        group: { key: "twitch:channel:broadcaster-1" },
        actor: { id: "moderator-1", claims: ["twitch.moderator"] }
      },
      sourceEventId: "twitch:eventsub:notification-1"
    });
  });

  it("rejects unknown actions and unsupported source platforms", async () => {
    await expect(executeAction(actionRegistry, invocation({
      platform: "discord",
      kind: "core.unknown.command.v1"
    }))).rejects.toMatchObject({
      status: 404,
      code: "action_not_found"
    });
    await expect(executeAction(
      actionRegistry,
      invocation({ platform: "youtube" })
    )).rejects.toMatchObject({
      status: 422,
      code: "action_origin_unsupported"
    });
  });

  it("fails closed for protected actions until a policy authorizes them", async () => {
    const execute = vi.fn(() => ({ output: { accepted: true } }));
    const action = createActionDefinition({
      kind: "integration.announcement.publish.v1",
      capability: "integration.announcement.publish",
      supportedOrigins: ["twitch"],
      execute
    });
    const registry = createActionRegistry({ [action.kind]: action });
    const input = invocation({ platform: "twitch", kind: action.kind });

    await expect(executeAction(registry, input)).rejects.toMatchObject({
      status: 500,
      code: "action_authorizer_missing"
    });
    await expect(executeAction(registry, input, {
      authorize: async () => false
    })).rejects.toMatchObject({
      status: 403,
      code: "action_forbidden"
    });
    expect(execute).not.toHaveBeenCalled();

    const authorize = vi.fn(async ({ capability, invocation: authorizedInput }) => {
      expect(capability).toBe("integration.announcement.publish");
      expect(authorizedInput.origin.actor.id).toBe("twitch-actor");
      return true;
    });
    await expect(executeAction(registry, input, { authorize })).resolves.toEqual({
      schemaVersion: 1,
      output: { accepted: true },
      effects: []
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
