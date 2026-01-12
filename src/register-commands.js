// register-commands.js
// One-off script to register global slash commands for the bot.
import "dotenv/config";

const appId = process.env.APP_ID;
const token = process.env.DISCORD_TOKEN;

/**
 * Global slash commands visible in every server the bot is installed in.
 * See https://discord.com/developers/docs/interactions/application-commands
 */
const commands = [
  { name: "alive", description: "Replies if alive." },
  {
    name: "pingat",
    description: "Schedule a role ping at a Unix timestamp (seconds).",
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "role", description: "Role to ping", type: 8, required: true },
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false }
    ]
  },
  { name: "pingat_list", description: "List scheduled role pings for this server." },
  {
    name: "pingat_cancel",
    description: "Cancel a scheduled role ping by job ID.",
    options: [
      { name: "job_id", description: "Job ID", type: 3, required: true }
    ]
  }
];

const url = `https://discord.com/api/v10/applications/${appId}/commands`;

const r = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

console.log(r.status, await r.text());
