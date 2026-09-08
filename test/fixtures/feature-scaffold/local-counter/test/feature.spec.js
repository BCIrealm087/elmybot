import { describe, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
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
});
