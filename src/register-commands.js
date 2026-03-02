// register-commands.js
// One-off script to register global slash commands for the bot.
import "dotenv/config";

import { buildRegistrationCommands } from "./command-spec.js";

const args = process.argv.slice(2);
const test = args.includes("--test");

const [appIdKey, tokenKey, envMsg] = test
  ? ["TEST_APP_ID", "TEST_DISCORD_TOKEN", "Running in test environment"]
  : ["APP_ID", "DISCORD_TOKEN", "Running in production environment"];

console.log(envMsg);

const appId = process.env[appIdKey];
const token = process.env[tokenKey];

const envMissing = [];
if (!appId) envMissing.push(appIdKey);
if (!token) envMissing.push(tokenKey);
if (envMissing.length > 0) throw new Error(`Some required environment variables are missing: ${envMissing.join(", ")}`);

const commands = buildRegistrationCommands();
const url = `https://discord.com/api/v10/applications/${appId}/commands`;

const r = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

console.log(r.status, await r.text());
