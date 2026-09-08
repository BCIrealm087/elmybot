import { describe, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
  twitchTestActor,
  twitchTestGroup
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

  it("denies member updates without changing shared state", async () => {
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
  });
});
