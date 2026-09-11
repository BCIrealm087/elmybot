import { describe, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime
} from "@elmybot/framework/testing";

describe("recipe.shared", () => {
  it("executes the same behavior on Discord and Twitch", async () => {
    const runtime = createFeatureTestRuntime(feature);

    (await runtime.discord.command("shared"))
      .toReply("TODO: shared");
    (await runtime.twitch.commandText("!shared"))
      .toReply("TODO: shared");
  });
});
