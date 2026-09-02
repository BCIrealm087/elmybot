import { describe, it } from "vitest";
import {
  createFeatureTestRuntime,
  defaultTestLink,
  discordTestGroup,
  twitchTestGroup
} from "@elmybot/framework/testing";
import {
  defineAction,
  defineFeature,
  discordActionCommand,
  discordOption,
  discordTextResult,
  frameworkApiVersion,
  schema,
  twitchActionCommand,
  twitchTextResult,
  twitchTokens
} from "@elmybot/framework";

const scoreAction = defineAction({
  kind: "test.shareable-score.change.v1",
  supportedOrigins: ["discord", "twitch"],
  input: schema.object({
    amount: schema.integer({ min: 1, max: 100 })
  }),
  uses: { services: ["shareableState"] },
  async execute(ctx, { amount }) {
    const otherPlatform = ctx.origin.group.platform === "discord"
      ? "twitch"
      : "discord";
    const state = await ctx.shareableState.current(otherPlatform, "score");
    const value = await state.boundedCounter("score", "shared", {
      min: 0,
      max: 1_000
    }).increment(amount);
    return { output: { value, message: `score: ${value}` }, effects: [] };
  }
});

const scoreFeature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "test.shareable-score",
  description: "Tests effective shareable-state resolution.",
  shareableState: [{
    id: "score",
    label: "Shared score",
    schemaVersion: 1
  }],
  actions: [scoreAction],
  commands: {
    discord: [discordActionCommand({
      name: "shareable_score",
      description: "Change the effective shared score.",
      availability: "guild",
      actionKind: scoreAction.kind,
      options: [discordOption({
        arg: "amount",
        name: "amount",
        description: "Amount to add.",
        type: "integer",
        required: true,
        min: 1,
        max: 100
      })],
      render: discordTextResult
    })],
    twitch: [twitchActionCommand({
      name: "shareable_score",
      description: "Change the effective shared score.",
      actionKind: scoreAction.kind,
      parse: twitchTokens([{ arg: "amount", type: "integer" }]),
      render: twitchTextResult
    })]
  }
});

describe("Effective shareable-state resolution", () => {
  it("keeps standalone realms isolated when no directional default exists", async () => {
    const runtime = createFeatureTestRuntime(scoreFeature);
    const first = discordTestGroup({ id: "guild-one" });
    const second = discordTestGroup({ id: "guild-two" });

    await runtime.discord.command("shareable_score", {
      group: first,
      args: { amount: 2 }
    }).then((result) => result.toReply("score: 2"));
    await runtime.discord.command("shareable_score", {
      group: first,
      args: { amount: 1 }
    }).then((result) => result.toReply("score: 3"));
    await runtime.discord.command("shareable_score", {
      group: second,
      args: { amount: 1 }
    }).then((result) => result.toReply("score: 1"));
  });

  it("shares one integration realm across both selected directions", async () => {
    const discord = discordTestGroup({ id: "linked-guild" });
    const twitch = twitchTestGroup({ id: "linked-channel" });
    const runtime = createFeatureTestRuntime(scoreFeature, {
      defaultLinks: [
        defaultTestLink({
          sourceGroup: discord,
          targetGroup: twitch,
          integrationId: "shared-integration"
        }),
        defaultTestLink({
          sourceGroup: twitch,
          targetGroup: discord,
          integrationId: "shared-integration"
        })
      ]
    });

    await runtime.discord.command("shareable_score", {
      group: discord,
      args: { amount: 2 }
    }).then((result) => result.toReply("score: 2"));
    await runtime.twitch.command("shareable_score", {
      group: twitch,
      args: { amount: 3 }
    }).then((result) => result.toReply("score: 5"));
  });

  it("switches realms without copying and preserves standalone state", async () => {
    const discord = discordTestGroup({ id: "switching-guild" });
    const twitchOne = twitchTestGroup({ id: "channel-one" });
    const twitchTwo = twitchTestGroup({ id: "channel-two" });
    const runtime = createFeatureTestRuntime(scoreFeature);

    await runtime.discord.command("shareable_score", {
      group: discord,
      args: { amount: 4 }
    }).then((result) => result.toReply("score: 4"));

    const firstLink = defaultTestLink({
      sourceGroup: discord,
      targetGroup: twitchOne,
      integrationId: "integration-one"
    });
    const secondLink = defaultTestLink({
      sourceGroup: discord,
      targetGroup: twitchTwo,
      integrationId: "integration-two"
    });
    runtime.links.set([firstLink]);
    await runtime.discord.command("shareable_score", {
      group: discord,
      args: { amount: 2 }
    }).then((result) => result.toReply("score: 2"));

    runtime.links.set([secondLink]);
    await runtime.discord.command("shareable_score", {
      group: discord,
      args: { amount: 1 }
    }).then((result) => result.toReply("score: 1"));

    runtime.links.set([firstLink]);
    await runtime.discord.command("shareable_score", {
      group: discord,
      args: { amount: 1 }
    }).then((result) => result.toReply("score: 3"));

    runtime.links.set([]);
    await runtime.discord.command("shareable_score", {
      group: discord,
      args: { amount: 1 }
    }).then((result) => result.toReply("score: 5"));
  });
});
