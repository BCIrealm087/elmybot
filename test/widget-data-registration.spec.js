import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { commands } from "../src/platforms/discord/commands.js";
import {
  createDiscordCommandDescriptors
} from "../src/platforms/discord/feature-commands.js";

describe("Widget-data Discord registration", () => {
  it("generates the guild-only moderator command descriptor", () => {
    const descriptor = createDiscordCommandDescriptors(commands)
      .find(({ name }) => name === "widget_data");

    expect(descriptor).toEqual({
      name: "widget_data",
      description: "Publish the current widget data.",
      options: [{
        name: "data",
        description: "Data to publish to subscribed widgets.",
        type: 3,
        required: true,
        min_length: 1
      }]
    });
    expect(commands.widget_data.guild).toEqual({
      capability: "framework.moderators"
    });
  });

  it("applies the shared maximum after trimming without reflecting rejected data", async () => {
    const guildId = `widget-data-registration-${crypto.randomUUID()}`;
    const execute = async (data) => {
      const interaction = {
        id: crypto.randomUUID(),
        type: 2,
        guild_id: guildId,
        channel_id: "widget-data-channel",
        data: {
          name: "widget_data",
          options: [{ name: "data", value: data }]
        },
        member: {
          permissions: "8192",
          roles: [],
          user: { id: "widget-data-moderator" }
        }
      };
      return await commands.widget_data.exec(
        interaction,
        env,
        "widget_data",
        {
          sourceInteraction: interaction,
          authorizedCapability: "framework.moderators"
        }
      );
    };

    const rejectedData = "private-" + "x".repeat(400);
    const rejected = await execute(rejectedData);
    expect(rejected).toMatchObject({
      flags: 64,
      content: expect.stringContaining("at most 400 characters")
    });
    expect(rejected.content).not.toContain(rejectedData);

    const accepted = await execute(`  ${"x".repeat(400)}  `);
    expect(accepted).toEqual({
      content: "Widget data updated.",
      allowed_mentions: { parse: [] }
    });
  });
});
