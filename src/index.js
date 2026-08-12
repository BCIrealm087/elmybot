import nacl from "tweetnacl";

import { commands } from "./commands.js";
import { jsonResponse, ephemeralData, ephemeral } from "./common.js";
import { PERM_STRINGS, checkPermissions } from "./discord-permissions.js";

/**
 * Durable objects
 */
export { GuildScheduler } from "./message-scheduling/index.js";
export { GuildConfig } from "./guild-configuration.js";

/**
 * Cloudflare Worker entrypoint for Discord interactions.
 *
 * Responsibilities:
 * - verify Discord signatures against the raw request body
 * - answer PING validation requests
 * - route slash commands defined in `src/commands.js`
 * - use deferred responses for guild commands that may outlive Discord's
 *   initial response window
 */

const encoder = new TextEncoder();

/**
 * Convert a hex string to Uint8Array for signature verification.
 */
function hexToU8(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Verify the Ed25519 signature for a Discord interaction request.
 */
function verifyDiscordRequest({ publicKeyHex, signatureHex, timestamp, bodyText }) {
  const sig = hexToU8(signatureHex);
  const pk = hexToU8(publicKeyHex);
  if (!sig || !pk) return false;

  // Length guards (Ed25519)
  if (sig.length !== nacl.sign.signatureLength) return false; // 64
  if (pk.length !== nacl.sign.publicKeyLength) return false;  // 32

  try {
    const msg = encoder.encode(timestamp + bodyText);
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch {
    return false;
  }
}

function deferredEphemeral() {
  // Discord interaction response type 5:
  // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  return jsonResponse({
    type: 5,
    data: ephemeralData(null),
  });
}

async function editOriginalInteractionResponse(interaction, messageData) {
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

  // Discord expects a regular message object when editing the original
  // deferred interaction response.
  const body = {
    content: messageData?.content ?? "",
    allowed_mentions: messageData?.allowed_mentions ?? { parse: [] },
    embeds: messageData?.embeds,
    components: messageData?.components,
    flags: messageData?.flags,
  };

  const r = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    // Last resort logging; the user won't see this if patch fails.
    console.error("Failed to edit @original:", r.status, await r.text());
  }
}

class CommandUserFacingError extends Error {
  constructor(message) {
    super (message);
  }
}

async function handleCommand(interaction, env, command) {
  let commandResult;
  const def = command.definition;
  try {
    if (def.guild) {
      // Guild-only commands rely on guild-scoped Durable Objects and
      // guild-specific permission evaluation.
      if (!interaction.guild_id) throw new CommandUserFacingError("Use this command inside a server.");
      const allowedGroups = def.guild.allowed;
      if (!Array.isArray(allowedGroups) || allowedGroups === 0) {
        throw new CommandUserFacingError("Error: permissions for this command have not been set.");
      }
      const permStatus = await checkPermissions(interaction, env, { name: command.name, allowedGroups });
      if (!permStatus.ok) throw new CommandUserFacingError(
        `Only members that fall into one of \`[${permStatus.allowedGroups.map(v=>PERM_STRINGS[v].toUpperCase()).join(", ")}]\` can use this command.`
      );
    } else {
      interaction.guild_id = undefined; // commands without explicit guild descriptor should lose access to guild functionality
    }
    commandResult = await def.exec(interaction, env, command.name);
  } catch (e) {
    commandResult = ephemeralData((e instanceof CommandUserFacingError) ? e.message : "Unknown error.");
  }
  return commandResult; // expected to satisfy the 'data' field of the json response to be sent back to the discord API
}

export default {
  /**
   * Cloudflare Worker fetch handler (Discord interactions entrypoint).
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/discord") {
      // Optional health
      if (request.method === "GET") return new Response("OK");
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

      const signature = request.headers.get("X-Signature-Ed25519");
      const timestamp = request.headers.get("X-Signature-Timestamp");
      if (!signature || !timestamp) return new Response("Bad Request", { status: 400 });

      const bodyText = await request.text();

      const ok = verifyDiscordRequest({
        publicKeyHex: env.PUBLIC_KEY,
        signatureHex: signature,
        timestamp,
        bodyText,
      });
      if (!ok) return new Response("Invalid signature", { status: 401 });

      let interaction;
      try {
        interaction = JSON.parse(bodyText);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      // PING -> PONG
      // (Discord validates the endpoint this way)
      if (interaction.type === 1) return jsonResponse({ type: 1 });

      if (interaction.type !== 2) return new Response("Unhandled interaction type", { status: 400 });

      const name = interaction.data?.name;

      const command = { name, definition: commands[name] };
      if (!command.definition) return ephemeral(`Unknown command: /${name}`)
      
      let commandResult;
      if (!command.definition.deferred) {
        commandResult = await handleCommand(interaction, env, command);
        return jsonResponse({ type: 4, data: commandResult });
      }
      // ACK immediately so Discord keeps the interaction token alive, then
      // finish the command in the background and patch @original.
      ctx.waitUntil(
        handleCommand(interaction, env, command)
          .then(commandResult => editOriginalInteractionResponse(interaction, commandResult))
      );
      return deferredEphemeral();
    }

    return new Response("Not found", { status: 404 });
  },
};
