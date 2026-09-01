import { describe, expect, it } from "vitest";
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
import feature from "../src/feature.js";

function linkedRuntime({ integrationId = "deaths-integration" } = {}) {
  const discordGroup = discordTestGroup({ id: "deaths-guild" });
  const twitchGroup = twitchTestGroup({ id: "deaths-channel" });
  const runtime = createFeatureTestRuntime(feature, {
    defaultLinks: [
      defaultTestLink({ sourceGroup: discordGroup, targetGroup: twitchGroup, integrationId }),
      defaultTestLink({ sourceGroup: twitchGroup, targetGroup: discordGroup, integrationId })
    ]
  });
  return { runtime, discordGroup, twitchGroup };
}

describe("fun.deaths", () => {
  it("asks for a moderator-selected game when invoked without arguments", async () => {
    const { runtime, discordGroup, twitchGroup } = linkedRuntime();

    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor()
    })).toReply(
      "No game is selected yet. A moderator must check or update a named game first."
    );
    (await runtime.twitch.commandText("!deaths", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply(
      "No game is selected yet. A moderator must check or update a named game first."
    );
  });

  it("shares counts while remembering a different game for each platform group", async () => {
    const { runtime, discordGroup, twitchGroup } = linkedRuntime();

    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus", game: "Castlevania" }
    })).toReply("Castlevania deaths: 1");

    (await runtime.twitch.commandText("!deaths check Castlevania", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Castlevania deaths: 1");
    (await runtime.twitch.commandText("!deaths", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply(
      "No game is selected yet. A moderator must check or update a named game first."
    );

    (await runtime.twitch.commandText("!deaths check Sekiro", {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).toReply("Sekiro deaths: 0");
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor()
    })).toReply("Castlevania deaths: 1");
    (await runtime.twitch.commandText("!deaths check", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Sekiro deaths: 0");
  });

  it("uses an operation without a game against the remembered game", async () => {
    const { runtime, discordGroup } = linkedRuntime();
    const moderator = discordTestModerator();

    await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: moderator,
      args: { operation: "check", game: "Hades" }
    });
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: moderator,
      args: { operation: "plus" }
    })).toReply("Hades deaths: 1");
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "check" }
    })).toReply("Hades deaths: 1");
  });

  it("does not let an ordinary member change the remembered game", async () => {
    const { runtime, discordGroup } = linkedRuntime();

    await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "check", game: "Castlevania" }
    });
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "check", game: "Sekiro" }
    })).toReply("Sekiro deaths: 0");
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor()
    })).toReply("Castlevania deaths: 0");
  });

  it("denies member mutations before reading a remembered game", async () => {
    const { runtime, discordGroup } = linkedRuntime();

    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "plus" }
    })).toReply("Only moderators can change death counts.");
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "reset", game: "Hades" }
    })).toReply("Only moderators can change death counts.");
  });

  it("increments, floors decrements at zero, and resets", async () => {
    const { runtime, twitchGroup } = linkedRuntime();
    const moderator = twitchTestModerator();
    const invoke = (operation) => runtime.twitch.command("deaths", {
      group: twitchGroup,
      actor: moderator,
      args: { operation, game: "Elden Ring" }
    });

    (await invoke("plus")).toReply("Elden Ring deaths: 1");
    (await invoke("plus")).toReply("Elden Ring deaths: 2");
    (await invoke("minus")).toReply("Elden Ring deaths: 1");
    (await invoke("reset")).toReply("Elden Ring deaths: 0");
    (await invoke("minus")).toReply("Elden Ring deaths: 0");
  });

  it("selects the ledger through the current directional default", async () => {
    const { runtime, discordGroup, twitchGroup } = linkedRuntime({
      integrationId: "integration-one"
    });
    const moderator = discordTestModerator();

    await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: moderator,
      args: { operation: "plus", game: "Hades" }
    });
    runtime.links.set([
      defaultTestLink({
        sourceGroup: discordGroup,
        targetGroup: twitchTestGroup({ id: "another-channel" }),
        integrationId: "integration-two"
      }),
      defaultTestLink({
        sourceGroup: twitchGroup,
        targetGroup: discordGroup,
        integrationId: "integration-one"
      })
    ]);
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: moderator,
      args: { operation: "check", game: "Hades" }
    })).toReply("Hades deaths: 0");

    runtime.links.set([
      defaultTestLink({
        sourceGroup: discordGroup,
        targetGroup: twitchGroup,
        integrationId: "integration-one"
      })
    ]);
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor()
    })).toReply("Hades deaths: 1");
  });

  it("requires a default link and does not remember a failed selection", async () => {
    const group = discordTestGroup();
    const runtime = createFeatureTestRuntime(feature);

    (await runtime.discord.command("deaths", {
      group,
      actor: discordTestModerator(),
      args: { operation: "plus", game: "Hades" }
    })).toReply("Death counts require a default linked Twitch channel.");
    (await runtime.discord.command("deaths", {
      group,
      actor: discordTestActor()
    })).toReply(
      "No game is selected yet. A moderator must check or update a named game first."
    );
  });

  it("accepts punctuation and Unicode without exposing storage-key rules", async () => {
    const { runtime, discordGroup } = linkedRuntime();
    const game = "NieR: Automata™ 🔥";

    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus", game }
    })).toReply(`${game} deaths: 1`);
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "check", game }
    })).toReply(`${game} deaths: 1`);
  });

  it("executes the redesigned syntax from raw Twitch command text", async () => {
    const { runtime, twitchGroup } = linkedRuntime();

    (await runtime.twitch.commandText('!deaths plus "Dark Souls"', {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).toReply("Dark Souls deaths: 1");
    (await runtime.twitch.commandText("!deaths", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Dark Souls deaths: 1");
  });

  it("ignores trailing Twitch duplicate-message bypass characters", async () => {
    const { runtime, twitchGroup } = linkedRuntime();
    const moderator = twitchTestModerator();
    const member = twitchTestActor();

    (await runtime.twitch.commandText("!deaths plus Control", {
      group: twitchGroup,
      actor: moderator
    })).toReply("Control deaths: 1");
    for (const commandText of [
      "!deaths \u034F",
      "!deaths check \u034F",
      "!deaths check Control \u034F",
      "!deaths check Control \u{E0000}"
    ]) {
      (await runtime.twitch.commandText(commandText, {
        group: twitchGroup,
        actor: member
      })).toReply("Control deaths: 1");
    }
  });

  it("requires an operation before a Discord game argument", async () => {
    const { runtime, discordGroup } = linkedRuntime();

    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { game: "Hades" }
    })).toReply("Choose check, plus, minus, or reset before naming a game.");
  });

  it("rejects unsupported operations", async () => {
    const { runtime, discordGroup } = linkedRuntime();
    await expect(runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { game: "Hades", operation: "multiply" }
    })).rejects.toMatchObject({ code: "action_arguments_invalid" });
  });
});
