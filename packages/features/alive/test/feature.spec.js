import { describe, expect, it } from "vitest";
import * as workspaceFramework from "@elmybot/framework";
import { createFeatureTestRuntime } from "@elmybot/framework/testing";
import feature from "../src/feature.js";

describe("@elmybot/feature-alive", () => {
  it("uses the same stable API surface exposed to repository-local features", async () => {
    expect(workspaceFramework.frameworkApiVersion).toBe(1);
    expect(feature).toMatchObject({
      apiVersion: workspaceFramework.frameworkApiVersion,
      id: "core.alive"
    });

    const runtime = createFeatureTestRuntime(feature);
    (await runtime.discord.command("alive")).toReply("I'm here!!1");
    (await runtime.twitch.command("alive")).toReply("I'm here!!1");
  });
});
