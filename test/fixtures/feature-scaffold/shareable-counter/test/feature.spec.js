import { describe, expect, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
  runCapabilityCases,
  twitchTestActor,
  twitchTestGroup,
  twitchTestModerator
} from "@elmybot/framework/testing";

describe("recipe.shareable", () => {
  it("isolates standalone groups and shares through selected links", async () => {
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();
    const standalone = createFeatureTestRuntime(feature);

    (await standalone.discord.command("shareable", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus" }
    })).toReply("Score: 1");
    (await standalone.twitch.commandText("!shareable", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Score: 0");

    const linked = createFeatureTestRuntime(feature, {
      defaultLinks: [
        defaultTestLink({ sourceGroup: discordGroup, targetGroup: twitchGroup }),
        defaultTestLink({ sourceGroup: twitchGroup, targetGroup: discordGroup })
      ]
    });
    (await linked.discord.command("shareable", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus" }
    })).toReply("Score: 1");
    (await linked.twitch.commandText("!shareable", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Score: 1");
  });

  it("protects updates and floors the counter at zero", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = discordTestGroup();

    (await runtime.discord.command("shareable", {
      group,
      actor: discordTestActor(),
      args: { operation: "plus" }
    })).toReply("Only moderators can change the score.");
    (await runtime.discord.command("shareable", {
      group,
      actor: discordTestActor()
    })).toReply("Score: 0");
    (await runtime.discord.command("shareable", {
      group,
      actor: discordTestModerator(),
      args: { operation: "minus" }
    })).toReply("Score: 0");
  });

  it("rejects unsupported operations from raw Twitch text", async () => {
    const runtime = createFeatureTestRuntime(feature);

    const error = await runtime.twitch.commandText("!shareable multiply", {
      actor: twitchTestModerator()
    }).catch((error) => error);
    expect(error).toMatchObject({ code: "action_arguments_invalid" });
    expect(runtime.inputError("twitch", "shareable", error)).toBe(
      "!shareable: operation must be one of: show, plus, minus, reset. " +
      "Example: !shareable show"
    );
    (await runtime.twitch.commandText("!shareable show")).toReply("Score: 0");
  });

  it("checks each protected mode with and without the moderator capability", async () => {
    for (const [operation, expected] of [["plus", 3], ["minus", 1], ["reset", 0]]) {
      const runtime = createFeatureTestRuntime(feature);
      const group = discordTestGroup();
      const invoke = (operation, actor) => runtime.discord.command("shareable", {
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
