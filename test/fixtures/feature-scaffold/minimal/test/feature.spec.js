import { describe, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime,
  discordTestGroup
} from "@elmybot/framework/testing";

describe("recipe.minimal", () => {
  it("executes its Discord command", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const result = await runtime.discord.command("minimal", {
      group: discordTestGroup()
    });

    result.toReply("TODO: minimal");
  });
});
