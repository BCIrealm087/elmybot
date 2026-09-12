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
import feature, { normalizeGameSubject } from "../src/feature.js";

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
  it("declares normalized local, lookup, and collection state exports", () => {
    expect(feature.readableState.map(({ id, kind, scope }) => ({ id, kind, scope })))
      .toEqual([
        { id: "remembered_game", kind: "value", scope: { kind: "group_local" } },
        {
          id: "count",
          kind: "lookup",
          scope: { kind: "effective_shareable", namespace: "game_deaths" }
        },
        {
          id: "counts",
          kind: "collection",
          scope: { kind: "effective_shareable", namespace: "game_deaths" }
        }
      ]);
    expect(normalizeGameSubject("  DARK   Souls  ")).toEqual({
      value: "dark souls",
      label: "DARK Souls"
    });
    expect(feature.readableState.find(({ id }) => id === "counts").collection)
      .toEqual({
        membership: "materialized",
        order: "canonical_subject",
        legacyCoverage: "explicit"
      });
  });

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
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "7" }
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

  it("lets moderators assign an exact count on Twitch and Discord", async () => {
    const { runtime, discordGroup, twitchGroup } = linkedRuntime();

    (await runtime.twitch.commandText('!deaths 42 "Dark Souls"', {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).toReply("Dark Souls deaths: 42");
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "check", game: "Dark Souls" }
    })).toReply("Dark Souls deaths: 42");
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "0012", game: "Hades" }
    })).toReply("Hades deaths: 12");
    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestActor()
    })).toReply("Hades deaths: 12");
  });

  it("uses an exact count without a game against the remembered game", async () => {
    const { runtime, twitchGroup } = linkedRuntime();
    const moderator = twitchTestModerator();

    await runtime.twitch.commandText("!deaths check Control", {
      group: twitchGroup,
      actor: moderator
    });
    (await runtime.twitch.commandText("!deaths 9007199254740991", {
      group: twitchGroup,
      actor: moderator
    })).toReply("Control deaths: 9007199254740991");
  });

  it("keeps numeric game names available through an explicit check", async () => {
    const { runtime, twitchGroup } = linkedRuntime();

    (await runtime.twitch.commandText("!deaths check 1999", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("1999 deaths: 0");
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

  it("works in standalone state and remembers a successful local selection", async () => {
    const group = discordTestGroup();
    const runtime = createFeatureTestRuntime(feature);

    (await runtime.discord.command("deaths", {
      group,
      actor: discordTestModerator(),
      args: { operation: "plus", game: "Hades" }
    })).toReply("Hades deaths: 1");
    (await runtime.discord.command("deaths", {
      group,
      actor: discordTestActor()
    })).toReply("Hades deaths: 1");
  });

  it("isolates standalone death ledgers by platform group", async () => {
    const discordGroup = discordTestGroup({ id: "standalone-guild" });
    const twitchGroup = twitchTestGroup({ id: "standalone-channel" });
    const runtime = createFeatureTestRuntime(feature);

    (await runtime.discord.command("deaths", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus", game: "Hades" }
    })).toReply("Hades deaths: 1");
    (await runtime.twitch.commandText("!deaths check Hades", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Hades deaths: 0");
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
    })).toReply(
      "/deaths: operation must be check, plus, minus, reset, or a whole number from 0 to " +
      "9007199254740991 (digits only) before naming a game. " +
      "Example: /deaths operation:check game:Dark Souls"
    );
  });

  it("corrects unsupported operations on both platforms without changing counts or selection", async () => {
    const runtime = createFeatureTestRuntime(feature);
    for (const [platform, actor, example] of [
      ["discord", discordTestModerator(), "/deaths operation:check game:Dark Souls"],
      ["twitch", twitchTestModerator(), '!deaths check "Dark Souls"']
    ]) {
      await runtime[platform].command("deaths", {
        actor, args: { operation: "7", game: "Hades" }
      });
      for (const operation of ["multiply", "-1", "+1", "1.5", "1e3", "9007199254740992"]) {
        const result = platform === "twitch"
          ? await runtime.twitch.commandText(`!deaths ${operation} Sekiro`, { actor })
          : await runtime.discord.command("deaths", {
            actor, args: { game: "Sekiro", operation }
          });
        result.toReply(
          `${platform === "discord" ? "/" : "!"}deaths: operation must be ` +
          "check, plus, minus, reset, or a whole number from 0 to " +
          `9007199254740991 (digits only). Example: ${example}`
        );
        expect(result.effects).toEqual([]);
        (await runtime[platform].command("deaths", { actor })).toReply("Hades deaths: 7");
        (await runtime[platform].command("deaths", {
          args: { operation: "check", game: "Sekiro" }
        })).toReply("Sekiro deaths: 0");
      }
      (await runtime[platform].command("deaths", {
        args: { operation: "check", game: "Dark Souls" }
      })).toReply("Dark Souls deaths: 0");
    }
  });

  it("corrects Twitch quoting and game length while preserving the remembered game", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const actor = twitchTestModerator();
    await runtime.twitch.commandText('!deaths 7 "Dark Souls"', { actor });
    for (const [text, correction] of [
      ["!deaths check Dark Souls", "Too many arguments. Put multi-word values in double quotes."],
      ['!deaths check "Dark Souls', "Close the double quote around multi-word text."],
      [`!deaths plus ${"a".repeat(81)}`, "game must contain at most 80 characters."]
    ]) {
      const error = await runtime.twitch.commandText(text, { actor }).catch((error) => error);
      expect(runtime.inputError("twitch", "deaths", error)).toBe(
        `!deaths: ${correction} Example: !deaths check "Dark Souls"`
      );
      (await runtime.twitch.commandText("!deaths", { actor })).toReply("Dark Souls deaths: 7");
    }
    (await runtime.twitch.commandText('!deaths check "Dark Souls"')).toReply("Dark Souls deaths: 7");
    (await runtime.twitch.commandText(`!deaths check ${"a".repeat(80)}`))
      .toReply(`${"a".repeat(80)} deaths: 0`);
  });
});
