import nacl from "tweetnacl";

import { commandMap, getOption } from "./commands.js";
import { isModeratorOrOwner } from "./permissions.js";

/**
 * Cloudflare Worker entrypoint for Discord interactions.
 * Handles request verification, command routing, and delegates scheduling
 * to a Durable Object per guild.
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

/**
 * Build a JSON response with the expected Discord response headers.
 */
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Generate an ephemeral response (visible only to the invoking user).
 */
function ephemeral(content) {
  return jsonResponse({
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
}

function deferredEphemeral() {
  // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  // Immediate ACK so we never miss the 3-second deadline.
  return jsonResponse({
    type: 5,
    data: { flags: 64, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteractionResponse(interaction, messageData) {
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

  // For PATCH @original, send a "message object" shape (content, embeds, components, allowed_mentions...)
  const body = {
    content: messageData?.content ?? "",
    allowed_mentions: messageData?.allowed_mentions ?? { parse: [] },
    embeds: messageData?.embeds,
    components: messageData?.components,
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

/**
 * Commands that affect schedules are permission-gated.
 */
async function checkGuildPermissions(interaction, env, command) {
  const allowed = command?.requiresModerator
    ? await isModeratorOrOwner(interaction, env)
    : true;
  return {
    allowed, 
    rejection: (!allowed)
      ? {
          type: 4,
          data: {
            content: "Only moderators or the server owner can use this command.",
            flags: 64, // ephemeral
          },
        }
      : undefined
  };
}

const doAtTypeHandlers = {
  "ping-role": {
    innerContent: (j)=>`<@&${j.doAtSubject}>`, 
    allowedMentions: (j)=>({ roles: [j.doAtSubject] }), 
    outerContent: (j, innerContent)=>`${innerContent} (scheduled role ping for <t:${j.scheduledUnix}:F>)`
  },
  "ping-user": {
    innerContent: (j)=>`<@${j.doAtSubject}>`, 
    allowedMentions: (j)=>({ users: [j.doAtSubject] }), 
    outerContent: (j, innerContent)=>`${innerContent} (scheduled user ping for <t:${j.scheduledUnix}:F>)`
  },
  "channel-message": {
    innerContent: (j)=>j.doAtSubject, 
    allowedMentions: (_)=>({ parse: [] }), 
    outerContent: (_, innerContent)=>innerContent
  }
}

const DELIVERED_TTL_MS = 14 * 24 * 60 * 60 * 1000; // keep 14 days of dedupe keys

function deliveryKey(job) {
  // One key per “instance” of the job (id + scheduled time)
  return `${job.id}:${job.scheduledUnix}`;
}

function pruneDelivered(delivered, nowMs) {
  for (const [k, v] of Object.entries(delivered)) {
    if (typeof v !== "number" || v < nowMs - DELIVERED_TTL_MS) delete delivered[k];
  }
}

async function runDeferredCommand(interaction, env) {
  try {
    const name = interaction.data?.name;
    const command = commandMap.get(name);

    // Commands below require guild context
    if (!interaction.guild_id) {
      await editOriginalInteractionResponse(interaction, { content: "Use this command inside a server.", allowed_mentions: { parse: [] } });
      return;
    }

    const permission = await checkGuildPermissions(interaction, env, command);
    if (!permission.allowed) {
      // permission.rejection is an interaction response { type: 4, data: {...} }
      await editOriginalInteractionResponse(interaction, permission.rejection.data);
      return;
    }

    // Route all scheduling to the guild's Durable Object
    const id = env.SCHEDULER.idFromName(interaction.guild_id);
    const stub = env.SCHEDULER.get(id);

    if (command?.schedule) {
      const doAtSubject = command.schedule.subjectExtractor(interaction);
      const validationError = command.schedule.validator?.(doAtSubject);
      if (validationError) {
        await editOriginalInteractionResponse(interaction, { content: validationError, allowed_mentions: { parse: [] } });
        return;
      }

      const doAtType = command.schedule.doAtType;

      let ts = Number(getOption(interaction, "timestamp"));
      const repeatDaily = Boolean(getOption(interaction, "repeat_daily") ?? false);

      if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
        await editOriginalInteractionResponse(interaction, { content: "`timestamp` must be an integer Unix timestamp in seconds.", allowed_mentions: { parse: [] } });
        return;
      }
      if (ts > 10_000_000_000) ts = Math.floor(ts / 1000); // accept ms
      const now = Math.floor(Date.now() / 1000);
      if (ts <= now) {
        await editOriginalInteractionResponse(interaction, { content: "That timestamp is in the past.", allowed_mentions: { parse: [] } });
        return;
      }

      const r = await stub.fetch("https://do/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: interaction.guild_id,
          channelId: interaction.channel_id,
          doAtType,
          doAtSubject,
          scheduledUnix: ts,
          repeatDaily,
          createdBy: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        }),
      });

      const payload = await r.json(); // {type:4,data:{...}}
      await editOriginalInteractionResponse(interaction, payload.data);
      return;
    }

    if (command?.action === "list") {
      const r = await stub.fetch("https://do/list");
      const payload = await r.json();
      await editOriginalInteractionResponse(interaction, payload.data);
      return;
    }

    if (command?.action === "cancel") {
      const jobId = command.jobIdExtractor(interaction);

      const r = await stub.fetch("https://do/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });

      const payload = await r.json();
      await editOriginalInteractionResponse(interaction, payload.data);
      return;
    }

    await editOriginalInteractionResponse(interaction, {
      content: `Unknown command: /${name}`,
      allowed_mentions: { parse: [] },
    });
  } catch (err) {
    console.error("Deferred command failed:", err);
    await editOriginalInteractionResponse(interaction, {
      content: "❌ Something went wrong while processing that command.",
      allowed_mentions: { parse: [] },
    });
  }
}

export default {
  /**
   * Cloudflare Worker fetch handler (Discord interactions entrypoint).
   */
  async fetch(request, env, ctx) {
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
    const command = commandMap.get(name);

    if (command?.response && command.defer === false) {
      return jsonResponse({ type: 4, data: command.response });
    }

    // Only defer the commands that might do slow work (permissions / DO / network)
    const isDeferredCmd = command?.defer === true;

    if (!isDeferredCmd) {
      return jsonResponse({ type: 4, data: { content: `Unknown command: /${name}` } });
    }

    // ACK immediately (must be within 3 seconds or token invalidated)
    ctx.waitUntil(runDeferredCommand(interaction, env));
    return deferredEphemeral();
  },
};

export class GuildScheduler {
  /**
   * Durable Object per guild responsible for storing and firing schedules.
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Durable Object fetch handler for scheduling/listing/canceling.
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/schedule" && request.method === "POST") {
      const job = await request.json();

      if (!(job.doAtType in doAtTypeHandlers)) {
        return jsonResponse({
          type: 4,
          data: { flags: 64, allowed_mentions: { parse: [] }, content: "Invalid target type." }
        });
      }

      const id = crypto.randomUUID();

      // Normalize types defensively (worker should already enforce, but DO shouldn't trust input blindly)
      const scheduledUnix = Number(job.scheduledUnix);
      const j = {
        id,
        guildId: job.guildId,
        channelId: job.channelId,
        doAtType: job.doAtType,
        doAtSubject: job.doAtSubject,
        scheduledUnix,
        runAtMs: scheduledUnix * 1000,
        repeatDaily: job.repeatDaily === true, // avoid Boolean("false") pitfalls
        createdBy: job.createdBy ?? null,
      };

      // Atomic: read -> modify -> write jobs
      await this.state.storage.transaction(async (txn) => {
        const jobs = (await txn.get("jobs")) ?? [];
        jobs.push(j);
        jobs.sort((a, b) => a.runAtMs - b.runAtMs);
        await txn.put("jobs", jobs);
      });

      // Compute alarm from CURRENT stored state to avoid "last writer sets later alarm" race
      const jobsNow = (await this.state.storage.get("jobs")) ?? [];
      // sort defensively in case older data exists
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const next = jobsNow[0];
      if (next) {
        await this.state.storage.setAlarm(next.runAtMs);
      } else {
        await this.state.storage.deleteAlarm();
      }

      return jsonResponse({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content:
            `✅ Scheduled job for <t:${j.scheduledUnix}:F> (<t:${j.scheduledUnix}:R>)` +
            (j.repeatDaily ? `\n🔁 Repeats daily.` : "") +
            `\nJob ID: \`${j.id}\``,
        },
      });
    }

    if (url.pathname === "/list") {
      const jobs = (await this.state.storage.get("jobs")) ?? [];
      jobs.sort((a, b) => a.runAtMs - b.runAtMs);

      if (jobs.length === 0) {
        return jsonResponse({
          type: 4,
          data: { flags: 64, allowed_mentions: { parse: [] }, content: "No scheduled jobs." },
        });
      }

      const shown = jobs.slice(0, 15).map(j => {
        const innerContent = doAtTypeHandlers[j.doAtType].innerContent(j);
        return `• <t:${j.scheduledUnix}:F> (<t:${j.scheduledUnix}:R>) — ${innerContent} in <#${j.channelId}>` +
          (j.repeatDaily ? " 🔁 daily" : "") +
          ` — id: \`${j.id}\``;
      }).join("\n");

      return jsonResponse({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content: `📌 Scheduled jobs (${jobs.length} total):\n${shown}`,
        },
      });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      const body = await request.json();
      const jobId = String(body?.jobId ?? "").trim();

      if (!jobId) {
        return jsonResponse({
          type: 4,
          data: { flags: 64, allowed_mentions: { parse: [] }, content: "Provide a valid `job_id`." },
        });
      }

      // Atomic remove (read -> modify -> write)
      const result = await this.state.storage.transaction(async (txn) => {
        const jobs = (await txn.get("jobs")) ?? [];
        const idx = jobs.findIndex((j) => j.id === jobId);

        if (idx === -1) return { found: false };

        const removed = jobs[idx];
        jobs.splice(idx, 1);
        jobs.sort((a, b) => a.runAtMs - b.runAtMs);
        await txn.put("jobs", jobs);

        return { found: true, removed };
      });

      if (!result.found) {
        return jsonResponse({
          type: 4,
          data: { flags: 64, allowed_mentions: { parse: [] }, content: `No job found: \`${jobId}\`` },
        });
      }

      // Set/clear alarm based on CURRENT persisted state (avoid alarm override races)
      const jobsNow = (await this.state.storage.get("jobs")) ?? [];
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const next = jobsNow[0];
      if (next) {
        await this.state.storage.setAlarm(next.runAtMs);
      } else {
        await this.state.storage.deleteAlarm();
      }

      return jsonResponse({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content: `🗑️ Cancelled job \`${jobId}\` scheduled for <t:${result.removed.scheduledUnix}:F>.`,
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Alarm handler: delivers due pings and reschedules repeating jobs.
   */
  async alarm() {
    // Load delivered once; keep it in-memory and persist updates as we go.
    let delivered = (await this.state.storage.get("delivered")) ?? {};
    if (typeof delivered !== "object" || delivered === null) delivered = {};
    pruneDelivered(delivered, Date.now());

    while (true) {
      const nowMs = Date.now();

      // Always read the latest jobs from storage (don't keep a stale local copy)
      const jobsNow = (await this.state.storage.get("jobs")) ?? [];
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const job = jobsNow[0];
      if (!job || job.runAtMs > nowMs) break; // nothing due

      const key = deliveryKey(job);
      const alreadyDelivered = delivered[key] !== undefined;

      // 1) Deliver outside transaction
      if (!alreadyDelivered) {
        const handler = doAtTypeHandlers[job.doAtType];
        if (!handler) {
          // Corrupt/unknown job type: remove it so alarms don't get stuck
          await this.state.storage.transaction(async (txn) => {
            const curJobs = (await txn.get("jobs")) ?? [];
            const idx = curJobs.findIndex(
              (j) => j.id === job.id && j.scheduledUnix === job.scheduledUnix
            );
            if (idx !== -1) {
              curJobs.splice(idx, 1);
              curJobs.sort((a, b) => a.runAtMs - b.runAtMs);
              await txn.put("jobs", curJobs);
            }
          });
          continue;
        }

        const innerContent = handler.innerContent(job);
        const allowedMentions = handler.allowedMentions(job);
        const content = handler.outerContent(job, innerContent);

        const r = await fetch(
          `https://discord.com/api/v10/channels/${job.channelId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
          }
        );

        if (!r.ok) {
          // Keep your existing behavior: job remains in jobs; CF retries the alarm later.
          pruneDelivered(delivered, Date.now());
          await this.state.storage.put("delivered", delivered);
          throw new Error(`Discord API error ${r.status}: ${await r.text()}`);
        }

        // Mark delivered ASAP to prevent duplicates if something fails after sending
        delivered[key] = Date.now();
        pruneDelivered(delivered, delivered[key]);
        await this.state.storage.put("delivered", delivered);
      }

      // 2) Atomically remove/reschedule this exact occurrence
      await this.state.storage.transaction(async (txn) => {
        const curJobs = (await txn.get("jobs")) ?? [];
        curJobs.sort((a, b) => a.runAtMs - b.runAtMs);

        const idx = curJobs.findIndex(
          (j) => j.id === job.id && j.scheduledUnix === job.scheduledUnix
        );

        if (idx === -1) return; // canceled/changed while we were working; that's fine

        const cur = curJobs[idx];
        curJobs.splice(idx, 1);

        if (cur.repeatDaily) {
          let nextUnix = cur.scheduledUnix + 86400;
          let nextMs = cur.runAtMs + 86_400_000;

          // catch up if we're behind
          while (nextMs <= Date.now()) {
            nextUnix += 86400;
            nextMs += 86_400_000;
          }

          curJobs.push({
            ...cur,
            scheduledUnix: nextUnix,
            runAtMs: nextMs,
          });
        }

        curJobs.sort((a, b) => a.runAtMs - b.runAtMs);
        await txn.put("jobs", curJobs);
      });
    }

    // Final prune + persist (cheap housekeeping)
    pruneDelivered(delivered, Date.now());
    await this.state.storage.put("delivered", delivered);

    // Point alarm at next job based on persisted truth
    const finalJobs = (await this.state.storage.get("jobs")) ?? [];
    finalJobs.sort((a, b) => a.runAtMs - b.runAtMs);

    const next = finalJobs[0];
    if (next) await this.state.storage.setAlarm(next.runAtMs);
    else await this.state.storage.deleteAlarm();
  }

}
