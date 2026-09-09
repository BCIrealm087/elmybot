import { describe, expect, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
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

    await expect(runtime.twitch.commandText("!shareable multiply", {
      actor: twitchTestModerator()
    })).rejects.toMatchObject({
      code: "action_arguments_invalid"
    });
  });
});
