import { commands } from "./commands.js";
import { jsonResponse, ephemeralData, ephemeral } from "./common.js";
import { PERM_STRINGS, checkPermissions } from "./discord-permissions.js";
import {
  logError,
  unknownErrorMessage,
  withExternalRequestTimeout
} from "../../common.js";

/**
 * Entrypoint for Discord interactions.
 *
 * Responsibilities:
 * - verify Discord signatures against the raw request body
 * - answer PING validation requests
 * - route slash commands defined in `src/commands.js`
 * - use deferred responses for guild commands that may outlive Discord's
 *   initial response window
 */

const encoder = new TextEncoder();
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

let cachedPublicKeyHex = null;
let cachedPublicKeyPromise = null;

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
async function verifyDiscordRequest({ publicKeyHex, signatureHex, timestamp, bodyText }) {
  const sig = hexToU8(signatureHex);
  const pk = hexToU8(publicKeyHex);
  if (!sig || !pk) return false;

  // Length guards (Ed25519)
  if (sig.length !== ED25519_SIGNATURE_BYTES) return false;
  if (pk.length !== ED25519_PUBLIC_KEY_BYTES) return false;

  try {
    if (publicKeyHex !== cachedPublicKeyHex) {
      cachedPublicKeyHex = publicKeyHex;
      cachedPublicKeyPromise = crypto.subtle.importKey(
        "raw",
        pk,
        { name: "Ed25519" },
        false,
        ["verify"]
      );
    }

    const publicKey = await cachedPublicKeyPromise;
    const msg = encoder.encode(timestamp + bodyText);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      sig,
      msg
    );
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

  const r = await fetch(url, withExternalRequestTimeout({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  if (!r.ok) {
    await r.text();
    const error = new Error("Discord rejected the deferred response edit.");
    error.status = r.status;
    throw error;
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
  const correlationId = `discord:${interaction.id ?? crypto.randomUUID()}`;
  const sourceInteraction = interaction;
  try {
    if (def.guild) {
      // Guild-only commands rely on guild-scoped Durable Objects and
      // guild-specific permission evaluation.
      if (!interaction.guild_id) throw new CommandUserFacingError("Use this command inside a server.");
      const capability = def.guild.capability;
      if (typeof capability !== "string" || capability.length === 0) {
        throw new CommandUserFacingError("Error: permissions for this command have not been set.");
      }
      const permStatus = await checkPermissions(interaction, env, { capability });
      if (!permStatus.configured) {
        throw new CommandUserFacingError("Error: permissions for this command have not been set.");
      }
      if (!permStatus.ok) throw new CommandUserFacingError(
        `Only members that fall into one of \`[${permStatus.allowedGroups.map(v=>PERM_STRINGS[v].toUpperCase()).join(", ")}]\` can use this command.`
      );
    } else {
      // Commands without an explicit guild descriptor receive a shallow copy
      // without guild access. The source adapter separately retains the
      // authenticated origin needed to build a platform-neutral invocation.
      interaction = { ...interaction, guild_id: undefined };
    }
    commandResult = await def.exec(interaction, env, command.name, {
      sourceInteraction
    });
  } catch (e) {
    if (e instanceof CommandUserFacingError) {
      commandResult = ephemeralData(e.message);
    } else {
      logError("discord.command_failed", {
        platform: "discord",
        correlationId,
        groupId: interaction.guild_id ?? null,
        command: command.name
      }, e);
      commandResult = ephemeralData(unknownErrorMessage(correlationId));
    }
  }
  return commandResult; // expected to satisfy the 'data' field of the json response to be sent back to the discord API
}


export async function handleDiscordRequest(request, env, ctx) {
  // Optional health
  if (request.method === "GET") return new Response("OK");
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return new Response("Bad Request", { status: 400 });

  const bodyText = await request.text();

  const ok = await verifyDiscordRequest({
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
      .catch(error => logError("discord.deferred_response_failed", {
        platform: "discord",
        correlationId: `discord:${interaction.id ?? "unknown"}`,
        groupId: interaction.guild_id ?? null,
        command: command.name
      }, error))
  );
  return deferredEphemeral();
}
