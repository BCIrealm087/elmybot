// One-off script that registers the current slash command set defined in
// `src/commands.js` with Discord.
import "dotenv/config";

import { commands } from "./commands.js";
import { putDiscordCommands } from "./register-commands-request.js";

const args = process.argv.slice(2);
const cliArgs = {
  "--test": { name: "test" }
};
const config = { };
args.forEach(arg=>{
  let argInfo;
  if (!(argInfo = cliArgs[arg])) {
    throw new Error(`Unknown CLI argument: \`${arg}\`\nAvailable arguments: \`${Object.keys(cliArgs)}\``);
  }

  config[argInfo.name] = true;
});

const [appIdKey, tokenKey, envMsg] = (config.test)
  ? ["TEST_APP_ID", "TEST_DISCORD_TOKEN", "Running in test environment"]
  : ["APP_ID", "DISCORD_TOKEN", "Running in production environment"];

console.log(envMsg);

const appId = process.env[appIdKey];
const token = process.env[tokenKey];

const envMissing = [];
if (!appId) envMissing.push(appIdKey);
if (!token) envMissing.push(tokenKey);
if (envMissing.length > 0) {
  throw new Error(`Some required environment variables are missing: ${envMissing.join(", ")}`);
}

/**
 * Global slash commands visible in every server the bot is installed in.
 * See https://discord.com/developers/docs/interactions/application-commands
 */
const commandDescriptors = Object.entries(commands).map(([name, { description="No description provided", options }])=>({
  name,
  description,
  options
}));

await putDiscordCommands({ appId, token, commandDescriptors });
