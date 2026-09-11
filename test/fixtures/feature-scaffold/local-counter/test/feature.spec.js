import { describe, expect, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
  runCapabilityCases,
  twitchTestActor,
  twitchTestGroup,
  twitchTestModerator
} from "@elmybot/framework/testing";

describe("recipe.local", () => {
  it("keeps scores local while protecting updates", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();

    (await runtime.discord.command("local", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus" }
    })).toReply("Score: 1");
    (await runtime.discord.command("local", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "plus" }
    })).toReply("Only moderators can change the score.");
    (await runtime.discord.command("local", {
      group: discordGroup,
      actor: discordTestActor()
    })).toReply("Score: 1");
    (await runtime.twitch.commandText("!local", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Score: 0");
    (await runtime.twitch.commandText("!local minus", {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).toReply("Score: 0");
  });

  it("rejects unsupported operations from raw Twitch text", async () => {
    const runtime = createFeatureTestRuntime(feature);

    const error = await runtime.twitch.commandText("!local multiply", {
      actor: twitchTestModerator()
    }).catch((error) => error);
    expect(error).toMatchObject({ code: "action_arguments_invalid" });
    expect(runtime.inputError("twitch", "local", error)).toBe(
      "!local: operation must be one of: show, plus, minus, reset. " +
      "Example: !local show"
    );
    (await runtime.twitch.commandText("!local show")).toReply("Score: 0");
  });

  it("checks each protected mode with and without the moderator capability", async () => {
    for (const [operation, expected] of [["plus", 3], ["minus", 1], ["reset", 0]]) {
      const runtime = createFeatureTestRuntime(feature);
      const group = discordTestGroup();
      const invoke = (operation, actor) => runtime.discord.command("local", {
        group, actor, args: { operation }
      });
      await invoke("plus", discordTestModerator());
      await invoke("plus", discordTestModerator());
      const { withoutCapability: denied, withCapability: allowed } = await runCapabilityCases({
        actor: discordTestActor(),
        capability: "framework.moderators",
        invoke: (actor) => invoke(operation, actor),
        readState: async () => (await invoke("show", discordTestActor())).output
      });

      expect(denied.error).toBeNull();
      denied.result.toReply("Only moderators can change the score.");
      expect(denied.result.effects).toEqual([]);
      expect(denied.stateAfter).toEqual(denied.stateBefore);
      expect(allowed.error).toBeNull();
      allowed.result.toReply(`Score: ${expected}`);
      expect(allowed.stateAfter).toEqual({ message: `Score: ${expected}` });
    }
  });
});
