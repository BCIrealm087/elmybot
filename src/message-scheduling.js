import { jsonResponse, getOption, ephemeralData } from "./common.js";

class SchedulingError extends Error {
  constructor(message) {
    super (message);
  }
}

export async function scheduleMessage(interaction, env, doAtHandler) {
  let schedulingResult;
  try {
    // Route all scheduling to the guild's Durable Object
    const id = env.SCHEDULER.idFromName(interaction.guild_id);
    const stub = env.SCHEDULER.get(id);

    const options = doAtHandler.getOptions(interaction);
    if (!options.data) options.data = { };
    // eval returns falsy if there were no errors, otherwise returns error description. Side effects may be applied to `options` here
    const error = doAtHandler.eval(options);
    if (error) {
      throw new SchedulingError(error);
    }

    const doAtType = doAtHandler.type;

    const r = await stub.fetch("https://do/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...options,
        guildId: interaction.guild_id,
        channelId: interaction.channel_id,
        doAtType,
        createdBy: interaction.member?.user?.id ?? interaction.user?.id ?? null,
      }),
    });
    schedulingResult = await r.json(); // {flags: 64, allowed_mentions: {...}, content: "..."}
  } catch(e) {
    schedulingResult = ephemeralData((e instanceof SchedulingError) ? e.message : "Unknown error.");
  }
  return schedulingResult;
}

export const getStandardOptions = (interaction) => ({
  repeats: Boolean(getOption(interaction, "repeat_daily") ?? false), 
  ts: Number(getOption(interaction, "timestamp"))
})

export const evalStandardTimestamp = (options) => {
  let ts = options.ts;
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return "`timestamp` must be an integer Unix timestamp in seconds.";

  if (ts > 10_000_000_000) ts = Math.floor(ts / 1000); // accept ms
  options.ts = ts;
  const now = Math.floor(Date.now() / 1000);
  if (ts <= now) return "That timestamp is in the past.";

  return null;
}

export const evalMessage = (options) => (
  options.subject.length === 0 ? "Message cannot be empty."
  : options.subject.length > 2000 ? "Message too long (max 2000 chars)."
  : null
)

const DELIVERED_TTL_MS = 14 * 24 * 60 * 60 * 1000; // keep 14 days of dedupe keys

function deliveryKey(job) {
  // One key per “instance” of the job (id + scheduled time)
  return `${job.id}:${job.ts}`;
}

function pruneDelivered(delivered, nowMs) {
  for (const [k, v] of Object.entries(delivered)) {
    if (typeof v !== "number" || v < nowMs - DELIVERED_TTL_MS) delete delivered[k];
  }
}

function formatInterval(seconds) {
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(1)}h`;
  }

  if (seconds >= 60) {
    return `${(seconds / 60).toFixed(1)}min`;
  }

  return `${seconds}s`;
}

function getDailyTimeFromTimestamp(j, rescheduling=false) {
  if (!rescheduling){ 
    const ts = Number(j.ts);
    return [ts, ts*1000];
  }
  let nextUnix = j.ts + 86400;
  let nextMs = j.runAtMs + 86_400_000;

  // catch up if we're behind
  const DAY_MS = 86_400_000;
  const DAY_S = 86_400;

  const now = Date.now();

  if (nextMs <= now) {
    const daysBehind = Math.floor((now - nextMs) / DAY_MS) + 1;
    nextUnix += daysBehind * DAY_S;
    nextMs += daysBehind * DAY_MS;
  }
  return [nextUnix, nextMs];
}

const doAtTypeHandlers = {
  "ping-role": {
    innerContent: (j)=>`<@&${j.subject}>`, 
    allowedMentions: (j)=>({ roles: [j.subject] }), 
    outerContent: (j, innerContent)=>`${innerContent} (scheduled role ping for <t:${j.ts}:F>)`,
    targetTime: getDailyTimeFromTimestamp, 
    repeatDescription: (_)=>"daily"
  },
  "ping-user": {
    innerContent: (j)=>`<@${j.subject}>`, 
    allowedMentions: (j)=>({ users: [j.subject] }), 
    outerContent: (j, innerContent)=>`${innerContent} (scheduled user ping for <t:${j.ts}:F>)`,
    targetTime: getDailyTimeFromTimestamp, 
    repeatDescription: (_)=>"daily"
  },
  "channel-message-standard": {
    innerContent: (j)=>j.subject, 
    allowedMentions: (_)=>({ parse: [] }), 
    outerContent: (_, innerContent)=>innerContent,
    targetTime: getDailyTimeFromTimestamp, 
    repeatDescription: (_)=>"daily"
  },
  "channel-message-random": {
    innerContent: (j)=>j.subject, 
    allowedMentions: (_)=>({ parse: [] }), 
    outerContent: (_, innerContent)=>innerContent,
    targetTime: (j, rescheduling = false) => {
      const randomOffset =
        Math.random() * (j.data.maxInterval - j.data.minInterval + 1) +
        j.data.minInterval;

      if (!rescheduling) {
        const nextUnix = Math.floor(Date.now() / 1000 + randomOffset);
        return [nextUnix, nextUnix * 1000];
      }

      if (!j.ts || !j.runAtMs) {
        throw new Error(`Scheduler error: job \`${j.id}\` lacks valid timestamp data.`);
      }

      const offset = Math.floor(randomOffset);
      const now = Date.now();
      const nextMs = j.runAtMs + offset * 1000;

      if (nextMs <= now) {
        const nextUnix = Math.floor(now / 1000 + offset);
        return [nextUnix, nextUnix * 1000];
      }

      return [j.ts + offset, nextMs];
    },
    repeatDescription: (j) => `randomly (min.: ${formatInterval(j.data.minInterval)} - max.: ${formatInterval(j.data.maxInterval)})`
  }
}

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
      const handler = doAtTypeHandlers[job.doAtType];
      if (!handler) {
        return jsonResponse({
          flags: 64, allowed_mentions: { parse: [] }, content: "Invalid target type."
        });
      }

      const id = crypto.randomUUID();

      // Normalize types defensively (worker should already enforce, but DO shouldn't trust input blindly)
      const [ts, runAtMs] = handler.targetTime(job);
      const j = {
        id,
        guildId: job.guildId,
        channelId: job.channelId,
        doAtType: job.doAtType,
        subject: job.subject,
        ts,
        runAtMs: runAtMs,
        data: job.data,
        repeats: job.repeats === true, // avoid Boolean("false") pitfalls
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
          flags: 64,
          allowed_mentions: { parse: [] },
          content:
            `✅ Scheduled job for <t:${j.ts}:F> (<t:${j.ts}:R>)` +
            (j.repeats ? `\n🔁 Repeats ${handler.repeatDescription(j)}.` : "") +
            `\nJob ID: \`${j.id}\``,
        });
    }

    if (url.pathname === "/list") {
      const jobs = (await this.state.storage.get("jobs")) ?? [];
      jobs.sort((a, b) => a.runAtMs - b.runAtMs);

      if (jobs.length === 0) {
        return jsonResponse({
          flags: 64, allowed_mentions: { parse: [] }, content: "No scheduled jobs."
        });
      }

      const shown = jobs.slice(0, 15).map(j => {
        const handler = doAtTypeHandlers[j.doAtType];
        const innerContent = handler.innerContent(j);
        return `• <t:${j.ts}:F> (<t:${j.ts}:R>) — ${innerContent} in <#${j.channelId}>` +
          (j.repeats ? ` 🔁 ${handler.repeatDescription(j)}` : "") +
          ` — id: \`${j.id}\``;
      }).join("\n");

      return jsonResponse({
        flags: 64,
        allowed_mentions: { parse: [] },
        content: `📌 Scheduled jobs (${jobs.length} total):\n${shown}`,
      });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      const body = await request.json();
      const jobId = String(body?.jobId ?? "").trim();

      if (!jobId) {
        return jsonResponse({
          flags: 64, allowed_mentions: { parse: [] }, content: "Provide a valid `job_id`."
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
          flags: 64, allowed_mentions: { parse: [] }, content: `No job found: \`${jobId}\``
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
          flags: 64,
          allowed_mentions: { parse: [] },
          content: `🗑️ Cancelled job \`${jobId}\` scheduled for <t:${result.removed.ts}:F>.`,
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
              (j) => j.id === job.id && j.ts === job.ts
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
          // Job remains in jobs; CF retries the alarm later.
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
          (j) => j.id === job.id && j.ts === job.ts
        );

        if (idx === -1) return; // canceled/changed while we were working; that's fine

        const cur = curJobs[idx];
        curJobs.splice(idx, 1);

        if (cur.repeats) {
          const [nextUnix, nextMs] = doAtTypeHandlers[job.doAtType].targetTime(cur, true);

          curJobs.push({
            ...cur,
            ts: nextUnix,
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