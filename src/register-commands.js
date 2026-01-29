// register-commands.js
// One-off script to register global slash commands for the bot.
import "dotenv/config";

const args = process.argv.slice(2);
const test = args.includes("--test");

const [appIdKey, tokenKey, envMsg] = (test)
  ? ["TEST_APP_ID", "TEST_DISCORD_TOKEN", "Running in test environment"]
  : ["APP_ID", "DISCORD_TOKEN", "Running in production environment"];

console.log(envMsg);

const appId = process.env[appIdKey];
const token = process.env[tokenKey];

const envMissing = [];
if (!appId) envMissing.push(appIdKey);
if (!token) envMissing.push(tokenKey);
if (envMissing.length > 0) throw new Error(`Some required environment variables are missing: ${envMissing.join(", ")}`);

/**
 * Global slash commands visible in every server the bot is installed in.
 * See https://discord.com/developers/docs/interactions/application-commands
 */
const commands = [
  { name: "alive", description: "Replies if alive." },
  {
    name: "pingroleat",
    description: "Schedule a role ping at a Unix timestamp (seconds).",
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "role", description: "Role to ping", type: 8, required: true },
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false }
    ]
  },
  { name: "doat_list", description: "List scheduled messages for this server." },
  {
    name: "doat_cancel",
    description: "Cancel a scheduled ping by job ID.",
    options: [
      { name: "job_id", description: "Job ID", type: 3, required: true }
    ]
  },
  {
    name: "pingmeat",
    description: "Schedule a user ping at a Unix timestamp (seconds).",
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "user", description: "User to ping", type: 6, required: true }, // USER,
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false }
    ]
  },
  {
    name: "sayat",
    description: "Schedule a message at a Unix timestamp (seconds).",
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "message", description: "Message", type: 3, required: true }, // MESSAGE,
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false }
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
