import { jsonResponse } from "../common";
import { commands } from "../commands";
import { SchedulingUserFacingError } from "./errors";

// SECONDARY ENVIRONMENT (storage + alarms)

// Scheduler behaviour derived from commands
const doAtTypeHandlers = Object.fromEntries(Object.entries(commands).reduce((acc, [key, { extra }]) => 
  acc.push([key, { composeMessage: extra.composer.composeMessage, calcScheduleTime: extra.calcScheduleTime }]), []));

const DELIVERED_TTL_MS = 14 * 24 * 60 * 60 * 1000; // keep 14 days of dedupe keys

function deliveryKey(job) {
  // One key per “instance” of the job (id + scheduled time)
  return `${job.id}:${job.timestamp}`;
}

function pruneDelivered(delivered, nowMs) {
  for (const [k, v] of Object.entries(delivered)) {
    if (typeof v !== "number" || v < nowMs - DELIVERED_TTL_MS) delete delivered[k];
  }
}

const requestHandlers = {
  "GET": {
    base: async (_, pathHandler) => pathHandler(), 
    "/list": async () => {
      const jobs = (await this.state.storage.get("jobs")) ?? [];
      jobs.sort((a, b) => a.runAtMs - b.runAtMs);

      if (jobs.length === 0) {
        return jsonResponse({
          jobs: []
        });
      }

      return jsonResponse({
        jobs: jobs.slice(0, 15).map(j=>({
          id: j.id,
          timestamp: j.timestamp,
          subject: j.subject,
          repeats: j.repeats,
          extraData: j.extraData,
          type: j.type,
          channelId: j.channelId
        }))
      });
    }
  },
  "POST" : {
    base: async (request, pathHandler) => pathHandler(await request.json()), 
    "/schedule": async (job) => {
      const handler = doAtTypeHandlers[job.type];
      if (!handler) throw new SchedulingUserFacingError("Invalid scheduling job type.", 422);

      const id = crypto.randomUUID();

      // Normalize types defensively (worker should already enforce, but DO shouldn't trust input blindly)
      const [ts, runAtMs] = handler.calcScheduleTime(job);
      const j = {
        id,
        guildId: job.guildId,
        channelId: job.channelId,
        type: job.type,
        subject: job.subject,
        timestamp: ts,
        runAtMs: runAtMs,
        extraData: job.extraData,
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
        timestamp: j.timestamp,
        id: j.id
      });
    },
    "/cancel": async (body) => {
      const jobId = String(body?.jobId ?? "").trim();

      if (!jobId) throw new SchedulingUserFacingError("Provide a valid `job_id`.", 422);

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

      if (!result.found) throw new SchedulingUserFacingError(`No job found: \`${jobId}\``, 422);

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
        timestamp: result.removed.timestamp
      });
    }
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

    const pathHandlers = requestHandlers[request.method];
    const pathHandler = pathHandlers && pathHandlers[url.pathname];
    if (!pathHandler) return new Response("Not Found", { status: 404 });
    try {
      return pathHandlers.base(request, pathHandler);
    } catch (e) {
      return (e instanceof SchedulingUserFacingError)
        ? jsonResponse({ userError: e.message }, e.status)
        : jsonResponse({ error: "Unknown error." }, 500);
    }
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
        const handler = doAtTypeHandlers[job.type];
        if (!handler) {
          // Corrupt/unknown job type: remove it so alarms don't get stuck
          await this.state.storage.transaction(async (txn) => {
            const curJobs = (await txn.get("jobs")) ?? [];
            const idx = curJobs.findIndex(
              (j) => j.id === job.id && j.timestamp === job.timestamp
            );
            if (idx !== -1) {
              curJobs.splice(idx, 1);
              curJobs.sort((a, b) => a.runAtMs - b.runAtMs);
              await txn.put("jobs", curJobs);
            }
          });
          continue;
        }

        messageData = handler.composeMessage(job);

        const r = await fetch(
          `https://discord.com/api/v10/channels/${job.channelId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(messageData),
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
          (j) => j.id === job.id && j.timestamp === job.timestamp
        );

        if (idx === -1) return; // canceled/changed while we were working; that's fine

        const cur = curJobs[idx];
        curJobs.splice(idx, 1);

        if (cur.repeats) {
          const [nextUnix, nextMs] = doAtTypeHandlers[job.type].calcScheduleTime(cur, true);

          curJobs.push({
            ...cur,
            timestamp: nextUnix,
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