import { describe, expect, it } from "vitest";
import {
  createFeatureTestRuntime,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
  twitchTestActor,
  twitchTestGroup,
  twitchTestModerator
} from "@elmybot/framework/testing";
import feature from "../src/feature.js";

describe("fun.deaths", () => {
  it("shows zero to ordinary members on Discord and Twitch", async () => {
    const runtime = createFeatureTestRuntime(feature);

    (await runtime.discord.command("deaths", {
      group: discordTestGroup(),
      actor: discordTestActor(),
      args: { game: "Dark Souls" }
    })).toReply("Dark Souls deaths: 0");
    (await runtime.twitch.command("deaths", {
      group: twitchTestGroup(),
      actor: twitchTestActor(),
      args: { game: "Dark Souls" }
    })).toReply("Dark Souls deaths: 0");
  });

  it("lets Discord moderators increase, decrease, and reset a game", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = discordTestGroup();
    const moderator = discordTestModerator();
    const invoke = (operation) => runtime.discord.command("deaths", {
      group,
      actor: moderator,
      args: { game: "Dark Souls", operation }
    });

    (await invoke("plus")).toReply("Dark Souls deaths: 1");
    (await invoke("plus")).toReply("Dark Souls deaths: 2");
    (await invoke("minus")).toReply("Dark Souls deaths: 1");
    (await invoke("reset")).toReply("Dark Souls deaths: 0");
    (await invoke("minus")).toReply("Dark Souls deaths: 0");
  });

  it("lets Twitch moderators increase, decrease, and reset a game", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = twitchTestGroup();
    const moderator = twitchTestModerator();
    const invoke = (operation) => runtime.twitch.command("deaths", {
      group,
      actor: moderator,
      args: { game: "Elden Ring", operation }
    });

    (await invoke("plus")).toReply("Elden Ring deaths: 1");
    (await invoke("minus")).toReply("Elden Ring deaths: 0");
    (await invoke("reset")).toReply("Elden Ring deaths: 0");
  });

  it("denies member mutations without changing the count", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = discordTestGroup();
    const member = discordTestActor();

    (await runtime.discord.command("deaths", {
      group,
      actor: member,
      args: { game: "Hades", operation: "plus" }
    })).toReply("Only moderators can change death counts.");
    (await runtime.discord.command("deaths", {
      group,
      actor: member,
      args: { game: "Hades" }
    })).toReply("Hades deaths: 0");
  });

  it("keeps games and origin groups independently namespaced", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const firstGroup = discordTestGroup({ id: "guild-one" });
    const secondGroup = discordTestGroup({ id: "guild-two" });
    const moderator = discordTestModerator();

    await runtime.discord.command("deaths", {
      group: firstGroup,
      actor: moderator,
      args: { game: "Dark Souls", operation: "plus" }
    });
    await runtime.discord.command("deaths", {
      group: firstGroup,
      actor: moderator,
      args: { game: "Elden Ring", operation: "plus" }
    });

    (await runtime.discord.command("deaths", {
      group: firstGroup,
      args: { game: "dark   souls" }
    })).toReply("dark souls deaths: 1");
    (await runtime.discord.command("deaths", {
      group: secondGroup,
      args: { game: "Dark Souls" }
    })).toReply("Dark Souls deaths: 0");
  });

  it("parses quoted multi-word Twitch game names", () => {
    expect(feature.commands.twitch[0].parse.parse('"Dark Souls" plus')).toEqual({
      game: "Dark Souls",
      operation: "plus"
    });
  });

  it("rejects unsupported operations", async () => {
    const runtime = createFeatureTestRuntime(feature);
    await expect(runtime.discord.command("deaths", {
      actor: discordTestModerator(),
      args: { game: "Hades", operation: "multiply" }
    })).rejects.toMatchObject({ code: "action_arguments_invalid" });
  });
});
