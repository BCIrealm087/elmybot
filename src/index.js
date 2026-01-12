import nacl from "tweetnacl";

import { isModeratorOrOwner } from "./permissions";

const encoder = new TextEncoder();

function hexToU8(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function verifyDiscordRequest({ publicKeyHex, signatureHex, timestamp, bodyText }) {
  const sig = hexToU8(signatureHex);
  const pk = hexToU8(publicKeyHex);
  if (!sig || !pk) return false;

  const msg = encoder.encode(timestamp + bodyText);
  return nacl.sign.detached.verify(msg, sig, pk);
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

// Discord permission bit: Manage Guild = 0x20
const PERM_MANAGE_GUILD = 0x20n;

function hasManageGuild(interaction) {
  const permsStr = interaction.member?.permissions;
  if (!permsStr) return false;
  return (BigInt(permsStr) & PERM_MANAGE_GUILD) === PERM_MANAGE_GUILD;
}

function getOption(interaction, name) {
  const opts = interaction.data?.options ?? [];
  return opts.find(o => o.name === name)?.value;
}

const protectedCommands = new Set(["pingat", "pingat_list", "pingat_cancel"]);
async function checkPermissions(interaction, env) {
  const allowed = (protectedCommands.has(interaction.data?.name))
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

export default {
  async fetch(request, env) {
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

    const interaction = JSON.parse(bodyText);

    // 1 = PING, reply with PONG (type 1)
    // (Discord validates the endpoint this way)
    if (interaction.type === 1) {
      return jsonResponse({ type: 1 });
    }

    // Slash commands: type 2
    if (interaction.type !== 2) {
      return new Response("Unhandled interaction type", { status: 400 });
    }

    const name = interaction.data?.name;

    const permission = await checkPermissions(interaction, env);
    if (!permission.allowed) return jsonResponse(permission.rejection);

    if (name === "alive") {
      // Respond fast (Discord requires initial response within 3 seconds)
      return jsonResponse({ type: 4, data: { content: "I'm here!!1" } });
    }

    // Commands below require guild context
    if (!interaction.guild_id) return ephemeral("Use this command inside a server.");

    // Route all scheduling to the guild's Durable Object
    const id = env.SCHEDULER.idFromName(interaction.guild_id);
    const stub = env.SCHEDULER.get(id);

    if (name === "pingat") {
      if (!hasManageGuild(interaction)) {
        return ephemeral("You need **Manage Server** to schedule/cancel pings.");
      }

      let ts = Number(getOption(interaction, "timestamp"));
      const roleId = String(getOption(interaction, "role") ?? "");
      const repeatDaily = Boolean(getOption(interaction, "repeat_daily") ?? false);

      if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
        return ephemeral("`timestamp` must be an integer Unix timestamp in seconds.");
      }
      if (ts > 10_000_000_000) ts = Math.floor(ts / 1000); // accept ms
      const now = Math.floor(Date.now() / 1000);
      if (ts <= now) return ephemeral("That timestamp is in the past.");

      const r = await stub.fetch("https://do/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guildId: interaction.guild_id,
          channelId: interaction.channel_id,
          roleId,
          scheduledUnix: ts,
          repeatDaily,
          createdBy: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        }),
      });

      return r;
    }

    if (name === "pingat_list") {
      return stub.fetch("https://do/list");
    }

    if (name === "pingat_cancel") {
      if (!hasManageGuild(interaction)) {
        return ephemeral("You need **Manage Server** to cancel pings.");
      }
      const jobId = String(getOption(interaction, "job_id") ?? "").trim();
      return stub.fetch("https://do/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
    }

    return jsonResponse({ type: 4, data: { content: `Unknown command: /${name}` } });
  },
};

export class GuildScheduler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async setNextAlarmFromJobs() {
    const jobs = (await this.state.storage.get("jobs")) ?? [];
    jobs.sort((a, b) => a.runAtMs - b.runAtMs);

    await this.state.storage.put("jobs", jobs);

    const next = jobs[0];
    if (next) {
      await this.state.storage.setAlarm(next.runAtMs);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/schedule" && request.method === "POST") {
      const job = await request.json();

      const jobs = (await this.state.storage.get("jobs")) ?? [];
      const id = crypto.randomUUID();

      const j = {
        id,
        guildId: job.guildId,
        channelId: job.channelId,
        roleId: job.roleId,
        scheduledUnix: job.scheduledUnix,
        runAtMs: job.scheduledUnix * 1000,
        repeatDaily: Boolean(job.repeatDaily),
        createdBy: job.createdBy ?? null,
      };

      jobs.push(j);
      await this.state.storage.put("jobs", jobs);
      await this.setNextAlarmFromJobs();

      return jsonResponse({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content:
            `✅ Scheduled ping for <t:${j.scheduledUnix}:F> (<t:${j.scheduledUnix}:R>)` +
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
          data: { flags: 64, allowed_mentions: { parse: [] }, content: "No scheduled role pings." },
        });
      }

      const shown = jobs.slice(0, 15).map(j =>
        `• <t:${j.scheduledUnix}:F> (<t:${j.scheduledUnix}:R>) — <@&${j.roleId}> in <#${j.channelId}>` +
        (j.repeatDaily ? " 🔁 daily" : "") +
        ` — id: \`${j.id}\``
      ).join("\n");

      return jsonResponse({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content: `📌 Scheduled role pings (${jobs.length} total):\n${shown}`,
        },
      });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      const { jobId } = await request.json();
      let jobs = (await this.state.storage.get("jobs")) ?? [];
      const idx = jobs.findIndex(j => j.id === jobId);

      if (idx === -1) {
        return jsonResponse({
          type: 4,
          data: { flags: 64, allowed_mentions: { parse: [] }, content: `No job found: \`${jobId}\`` },
        });
      }

      const removed = jobs[idx];
      jobs.splice(idx, 1);
      await this.state.storage.put("jobs", jobs);
      await this.setNextAlarmFromJobs();

      return jsonResponse({
        type: 4,
        data: {
          flags: 64,
          allowed_mentions: { parse: [] },
          content: `🗑️ Cancelled job \`${jobId}\` scheduled for <t:${removed.scheduledUnix}:F>.`,
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm() {
    // Alarms are at-least-once; keep alarm handler idempotent-ish.
    const jobs = (await this.state.storage.get("jobs")) ?? [];
    const now = Date.now();

    const due = jobs.filter(j => j.runAtMs <= now);
    const pending = jobs.filter(j => j.runAtMs > now);

    for (const job of due) {
      // Send message to Discord
      const content = `<@&${job.roleId}> (scheduled ping for <t:${job.scheduledUnix}:F>)`;

      const r = await fetch(`https://discord.com/api/v10/channels/${job.channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content,
          allowed_mentions: { roles: [job.roleId] },
        }),
      });

      if (!r.ok) {
        // throw -> Cloudflare retries alarm with backoff automatically
        // (at-least-once execution + retries)
        throw new Error(`Discord API error ${r.status}: ${await r.text()}`);
      }

      if (job.repeatDaily) {
        job.scheduledUnix += 86400;
        job.runAtMs += 86_400_000;
        pending.push(job);
      }
    }

    await this.state.storage.put("jobs", pending);
    await this.setNextAlarmFromJobs();
  }
}
