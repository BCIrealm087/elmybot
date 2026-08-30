import {
  access,
  defineFeature,
  discordNativeCommand,
  discordOption,
  schema
} from "../../framework/index.js";

export const discordRoleAccessFeature = defineFeature({
  apiVersion: 1,
  id: "discord.role-access",
  description: "Manages Discord roles trusted by protected bot commands.",
  commands: {
    discord: [
      discordNativeCommand({
        name: "config_allow_role",
        description: "Enables a role to use scheduling commands.",
        availability: "guild",
        deferred: true,
        capability: access.capability("config.manage"),
        options: [
          discordOption({
            arg: "role",
            name: "role",
            description: "Role to allow",
            type: "role",
            required: true
          })
        ],
        input: schema.object({
          role: schema.string({ minLength: 1, maxLength: 200 })
        }),
        async execute(ctx, { role }) {
          await ctx.permissions.allowRole(role);
          return ctx.response.text(
            `Successfully added <@&${role}> to allowed roles.`,
            { ephemeral: true }
          );
        }
      })
    ],
    twitch: []
  }
});

export default discordRoleAccessFeature;
