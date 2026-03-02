import nacl from "tweetnacl";

import { COMMAND_SPECS, DO_AT_TYPE_BEHAVIORS, getCommandSpec } from "./command-spec.js";
import { isModeratorOrOwner } from "./permissions.js";

const encoder = new TextEncoder();

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

function verifyDiscordRequest({ publicKeyHex, signatureHex, timestamp, bodyText }) {
  const sig = hexToU8(signatureHex);
  const pk = hexToU8(publicKeyHex);
  if (!sig || !pk) return false;

  if (sig.length !== nacl.sign.signatureLength) return false;
  if (pk.length !== nacl.sign.publicKeyLength) return false;

  try {
    const msg = encoder.encode(timestamp + bodyText);
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch {
    return false;
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function ephemeral(content) {
  return jsonResponse({
    type: 4,
    data: { content, flags: 64, allowed_mentions: { parse: [] } },
  });
}

function getOption(interaction, name) {
  const opts = interaction.data?.options ?? [];
  return opts.find((o) => o.name === name)?.value;
}

function deferredEphemeral() {
  return jsonResponse({
    type: 5,
    data: { flags: 64, allowed_mentions: { parse: [] } },
  });
}

async function editOriginalInteractionResponse(interaction, messageData) {
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;

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
    console.error("Failed to edit @original:", r.status, await r.text());
  }
}

async function checkGuildPermissions(interaction, env, commandSpec) {
  if (!commandSpec?.requiresModeratorOrOwner) {
    return { allowed: true };
  }

  const allowed = await isModeratorOrOwner(interaction, env);
  if (allowed) return { allowed: true };

  return {
    allowed: false,
    rejection: {
      type: 4,
      data: {
        content: "Only moderators or the server owner can use this command.",
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    },
  };
}

function normalizeTimestampSeconds(rawTimestamp) {
  let ts = Number(rawTimestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return { error: "`timestamp` must be an integer Unix timestamp in seconds." };
  if (ts > 10_000_000_000) ts = Math.floor(ts / 1000);

  const now = Math.floor(Date.now() / 1000);
  if (ts <= now) return { error: "That timestamp is in the past." };

  return { value: ts };
}

async function runDeferredCommand(interaction, env) {
  try {
    const name = interaction.data?.name;
    const commandSpec = getCommandSpec(name);

    if (!commandSpec || !commandSpec.deferred) {
      await editOriginalInteractionResponse(interaction, {
        content: `Unknown command: /${name}`,
        allowed_mentions: { parse: [] },
      });
      return;
    }

    if (commandSpec.requiresGuild && !interaction.guild_id) {
      await editOriginalInteractionResponse(interaction, {
        content: "Use this command inside a server.",
        allowed_mentions: { parse: [] },
      });
      return;
    }

    const permission = await checkGuildPermissions(interaction, env, commandSpec);
    if (!permission.allowed) {
      await editOriginalInteractionResponse(interaction, permission.rejection.data);
      return;
    }

    const id = env.SCHEDULER.idFromName(interaction.guild_id);
    const stub = env.SCHEDULER.get(id);

    if (commandSpec.kind === "schedule") {
      const doAtSubject = String(getOption(interaction, commandSpec.subjectOptionName) ?? "");
      const validationError = commandSpec.validateSubject(doAtSubject);
      if (validationError) {
        await editOriginalInteractionResponse(interaction, {
          content: validationError,
          allowed_mentions: { parse: [] },
        });
        return;
      }

      const tsResult = normalizeTimestampSeconds(getOption(interaction, "timestamp"));
      if (tsResult.error) {
        await editOriginalInteractionResponse(interaction, {
          content: tsResult.error,
          allowed_mentions: { parse: [] },
        });
        return;
      }

      const repeatDaily = Boolean(getOption(interaction, "repeat_daily") ?? false);
      const r = await stub.fetch("https://do/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: interaction.guild_id,
          channelId: interaction.channel_id,
          doAtType: commandSpec.doAtType,
          doAtSubject,
          scheduledUnix: tsResult.value,
          repeatDaily,
          createdBy: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        }),
      });

      const payload = await r.json();
      await editOriginalInteractionResponse(interaction, payload.data);
      return;
    }

    if (commandSpec.kind === "list") {
      const r = await stub.fetch("https://do/list");
      const payload = await r.json();
      await editOriginalInteractionResponse(interaction, payload.data);
      return;
    }

    if (commandSpec.kind === "cancel") {
      const jobId = String(getOption(interaction, "job_id") ?? "").trim();
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

const DELIVERED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function deliveryKey(job) {
  return `${job.id}:${job.scheduledUnix}`;
}

function pruneDelivered(delivered, nowMs) {
  for (const [k, v] of Object.entries(delivered)) {
    if (typeof v !== "number" || v < nowMs - DELIVERED_TTL_MS) delete delivered[k];
  }
}

export default {
  async fetch(request, env, ctx) {
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

    if (interaction.type === 1) return jsonResponse({ type: 1 });
    if (interaction.type !== 2) return new Response("Unhandled interaction type", { status: 400 });

    const name = interaction.data?.name;
    const commandSpec = getCommandSpec(name);

    if (commandSpec?.kind === "simple") {
      return jsonResponse({
        type: 4,
        data: { content: commandSpec.responseContent, allowed_mentions: { parse: [] } },
      });
    }

    if (!commandSpec || !commandSpec.deferred) {
      return jsonResponse({
        type: 4,
        data: { content: `Unknown command: /${name}`, flags: 64, allowed_mentions: { parse: [] } },
      });
    }

    ctx.waitUntil(runDeferredCommand(interaction, env));
    return deferredEphemeral();
  },
};

export class GuildScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/schedule" && request.method === "POST") {
      const job = await request.json();

      if (!(job.doAtType in DO_AT_TYPE_BEHAVIORS)) {
        return jsonResponse({
          type: 4,
          data: { flags: 64, allowed_mentions: { parse: [] }, content: "Invalid target type." },
        });
      }

      const id = crypto.randomUUID();
      const scheduledUnix = Number(job.scheduledUnix);
      const j = {
        id,
        guildId: job.guildId,
        channelId: job.channelId,
        doAtType: job.doAtType,
        doAtSubject: job.doAtSubject,
        scheduledUnix,
        runAtMs: scheduledUnix * 1000,
        repeatDaily: job.repeatDaily === true,
        createdBy: job.createdBy ?? null,
      };

      await this.state.storage.transaction(async (txn) => {
        const jobs = (await txn.get("jobs")) ?? [];
        jobs.push(j);
        jobs.sort((a, b) => a.runAtMs - b.runAtMs);
        await txn.put("jobs", jobs);
      });

      const jobsNow = (await this.state.storage.get("jobs")) ?? [];
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const next = jobsNow[0];
      if (next) await this.state.storage.setAlarm(next.runAtMs);
      else await this.state.storage.deleteAlarm();

      return jsonResponse({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content:
            `✅ Scheduled job for <t:${j.scheduledUnix}:F> (<t:${j.scheduledUnix}:R>)` +
            (j.repeatDaily ? "\n🔁 Repeats daily." : "") +
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

      const shown = jobs
        .slice(0, 15)
        .map((j) => {
          const behavior = DO_AT_TYPE_BEHAVIORS[j.doAtType];
          const innerContent = behavior?.innerContent(j) ?? "(invalid job type)";
          return `• <t:${j.scheduledUnix}:F> (<t:${j.scheduledUnix}:R>) — ${innerContent} in <#${j.channelId}>` +
            (j.repeatDaily ? " 🔁 daily" : "") +
            ` — id: \`${j.id}\``;
        })
        .join("\n");

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

      const jobsNow = (await this.state.storage.get("jobs")) ?? [];
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const next = jobsNow[0];
      if (next) await this.state.storage.setAlarm(next.runAtMs);
      else await this.state.storage.deleteAlarm();

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

  async alarm() {
    let delivered = (await this.state.storage.get("delivered")) ?? {};
    if (typeof delivered !== "object" || delivered === null) delivered = {};
    pruneDelivered(delivered, Date.now());

    while (true) {
      const nowMs = Date.now();
      const jobsNow = (await this.state.storage.get("jobs")) ?? [];
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const job = jobsNow[0];
      if (!job || job.runAtMs > nowMs) break;

      const key = deliveryKey(job);
      const alreadyDelivered = delivered[key] !== undefined;

      if (!alreadyDelivered) {
        const behavior = DO_AT_TYPE_BEHAVIORS[job.doAtType];
        if (!behavior) {
          await this.state.storage.transaction(async (txn) => {
            const curJobs = (await txn.get("jobs")) ?? [];
            const idx = curJobs.findIndex((j) => j.id === job.id && j.scheduledUnix === job.scheduledUnix);
            if (idx !== -1) {
              curJobs.splice(idx, 1);
              curJobs.sort((a, b) => a.runAtMs - b.runAtMs);
              await txn.put("jobs", curJobs);
            }
          });
          continue;
        }

        const innerContent = behavior.innerContent(job);
        const allowedMentions = behavior.allowedMentions(job);
        const content = behavior.outerContent(job, innerContent);

        const r = await fetch(`https://discord.com/api/v10/channels/${job.channelId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ content, allowed_mentions: allowedMentions }),
        });

        if (!r.ok) {
          pruneDelivered(delivered, Date.now());
          await this.state.storage.put("delivered", delivered);
          throw new Error(`Discord API error ${r.status}: ${await r.text()}`);
        }

        delivered[key] = Date.now();
        pruneDelivered(delivered, delivered[key]);
        await this.state.storage.put("delivered", delivered);
      }

      await this.state.storage.transaction(async (txn) => {
        const curJobs = (await txn.get("jobs")) ?? [];
        curJobs.sort((a, b) => a.runAtMs - b.runAtMs);

        const idx = curJobs.findIndex((j) => j.id === job.id && j.scheduledUnix === job.scheduledUnix);
        if (idx === -1) return;

        const cur = curJobs[idx];
        curJobs.splice(idx, 1);

        if (cur.repeatDaily) {
          let nextUnix = cur.scheduledUnix + 86400;
          let nextMs = cur.runAtMs + 86_400_000;

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

    pruneDelivered(delivered, Date.now());
    await this.state.storage.put("delivered", delivered);

    const finalJobs = (await this.state.storage.get("jobs")) ?? [];
    finalJobs.sort((a, b) => a.runAtMs - b.runAtMs);

    const next = finalJobs[0];
    if (next) await this.state.storage.setAlarm(next.runAtMs);
    else await this.state.storage.deleteAlarm();
  }
}

export { COMMAND_SPECS, DO_AT_TYPE_BEHAVIORS };
