import { describe, expect, it } from "vitest";
import feature from "../src/feature.js";
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestActor,
  discordTestGroup,
  discordTestModerator,
  runDurableEventFeatureContract,
  twitchTestGroup,
  twitchTestModerator
} from "@elmybot/framework/testing";

const STREAM = "fun.health:impacts:v1";

describe("fun.health", () => {
  it("meets the durable event delivery contract", async () => {
    const result = await runDurableEventFeatureContract({
      feature,
      stream: STREAM,
      group: discordTestGroup(),
      payload: { operation: "damage", amount: 15 },
      alternatePayload: { operation: "heal", amount: 5 },
      invalidPayload: { operation: "damage", amount: 0 },
      authorizedActor: discordTestModerator(),
      unauthorizedActor: discordTestActor(),
      publish: ({ runtime, group, actor }) => runtime.discord.command(
        "health",
        {
          group,
          actor,
          args: { operation: "damage", amount: 15 }
        }
      )
    });

    expect(result).toMatchObject({ replayed: true });
  }, 15_000);

  it("delivers a Twitch command to the selected shared stream", async () => {
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();
    const runtime = createFeatureTestRuntime(feature, {
      defaultLinks: [
        defaultTestLink({ sourceGroup: discordGroup, targetGroup: twitchGroup }),
        defaultTestLink({ sourceGroup: twitchGroup, targetGroup: discordGroup })
      ]
    });

    const consumer = runtime.eventStreams.connect({
      group: discordGroup,
      stream: STREAM
    });

    (await runtime.twitch.commandText("!health heal", {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).toReply("Health event queued.");

    const event = await consumer.receive();
    expect(event.payload).toEqual({ operation: "heal", amount: 10 });

    consumer.acknowledge(event);
    consumer.disconnect();
  });

  it("rejects an invalid amount before publishing", async () => {
    const runtime = createFeatureTestRuntime(feature);

    await expect(runtime.twitch.commandText("!health damage 0", {
      actor: twitchTestModerator()
    })).rejects.toMatchObject({ code: "action_arguments_invalid" });
  });
});