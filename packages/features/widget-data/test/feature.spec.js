import { describe, it } from "vitest";
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

describe("fun.health", () => {
  it("shares health across the selected Discord and Twitch link", async () => {
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();
    const runtime = createFeatureTestRuntime(feature, {
      defaultLinks: [
        defaultTestLink({
          sourceGroup: discordGroup,
          targetGroup: twitchGroup
        }),
        defaultTestLink({
          sourceGroup: twitchGroup,
          targetGroup: discordGroup
        })
      ]
    });

    (await runtime.discord.command("health", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "damage", amount: 15 }
    })).toReply("Health: 85/100");

    (await runtime.twitch.commandText("!health", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Health: 85/100");

    (await runtime.twitch.commandText("!health heal 5", {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).toReply("Health: 90/100");
  });

  it("denies a non-moderator's update without changing health", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = discordTestGroup();

    (await runtime.discord.command("health", {
      group,
      actor: discordTestActor(),
      args: { operation: "damage", amount: 20 }
    })).toReply("Only moderators can change health.");

    (await runtime.discord.command("health", {
      group,
      actor: discordTestActor()
    })).toReply("Health: 100/100");
  });
});