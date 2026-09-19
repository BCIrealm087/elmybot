import { describe, expect, it } from "vitest";
import { commands } from "../src/platforms/discord/commands.js";
import {
  createDiscordCommandDescriptors
} from "../src/platforms/discord/feature-commands.js";

describe("Widget-data Discord registration", () => {
  it("generates the bounded guild-only moderator command descriptor", () => {
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
        min_length: 1,
        max_length: 400
      }]
    });
    expect(commands.widget_data.guild).toEqual({
      capability: "framework.moderators"
    });
  });
});
