import { jsonResponse } from "../common.js";
import { SchedulingBackendUserFacingError } from "./errors.js";

// Durable Object environment: persistent job storage + alarms.

// Scheduler behavior is registered from command definitions so the DO can
// format jobs and compute repeat times without duplicating command logic.
const doAtTypeHandlers = { };

export function registerDoAtHandlers(definitions) {
  for (const [key, { extra }] of Object.entries(definitions)) {
    doAtTypeHandlers[key] = {
      composer: extra.composer,
      calcScheduleTime: extra.calcScheduleTime
    };
  }
}

class SchedulingBackedUserFacingError extends Error {
  constructor(message, status=500) {
    super (message);
    if (status !== null && status !== undefined)
      this.status = status;
  }
}

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
    base: async (state, _, pathHandler) => pathHandler(state), 
    "/list": async (state) => {
      // Return a user-facing subset of each job rather than the full stored
      // payload.
      const jobs = (await state.storage.get("jobs")) ?? [];
      jobs.sort((a, b) => a.runAtMs - b.runAtMs);

      if (jobs.length === 0) {
        return jsonResponse({
          totalJobs: 0,
          jobsPreview: []
        });
      }

      return jsonResponse({
        totalJobs: jobs.length,
        jobsPreview: jobs.slice(0, 15).map(j=>({
          id: j.id,
          timestamp: j.timestamp,
          subject: j.subject,
          repeats: j.repeats,
          extraData: j.extraData,
          type: j.type
        }))
      });
    }
  },
  "POST" : {
    base: async (state, request, pathHandler) => pathHandler(state, await request.json()), 
    "/schedule": async (state, job) => {
      const handler = doAtTypeHandlers[job.type];
      if (!handler) throw new SchedulingBackendUserFacingError("Invalid scheduling job type.", 422);

      const id = crypto.randomUUID();

      // The worker validates inputs first, but the DO still normalizes and
      // validates the scheduled timestamp defensively.
      const [ts, runAtMs] = handler.calcScheduleTime(job);
      const j = {
        id,
        type: job.type,
        subject: job.subject,
        timestamp: ts,
        runAtMs: runAtMs,
        extraData: job.extraData,
        repeats: job.repeats === true, // avoid Boolean("false") pitfalls
        createdBy: job.createdBy ?? null,
      };

      // Atomic: read -> modify -> write jobs.
      await state.storage.transaction(async (txn) => {
        const jobs = (await txn.get("jobs")) ?? [];
        jobs.push(j);
        jobs.sort((a, b) => a.runAtMs - b.runAtMs);
        await txn.put("jobs", jobs);
      });

      // Recompute from persisted state so concurrent requests cannot leave a
      // later alarm behind.
      const jobsNow = (await state.storage.get("jobs")) ?? [];
      // Sort defensively in case older unsorted data already exists.
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const next = jobsNow[0];
      if (next) {
        await state.storage.setAlarm(next.runAtMs);
      } else {
        await state.storage.deleteAlarm();
      }

      return jsonResponse({
        id: j.id,
        timestamp: j.timestamp,
        extraData: j.extraData
      });
    },
    "/cancel": async (state, body) => {
      const jobId = String(body?.jobId ?? "").trim();

      if (!jobId) throw new SchedulingBackendUserFacingError("Provide a valid `job_id`.", 422);

      // Atomic remove (read -> modify -> write).
      const result = await state.storage.transaction(async (txn) => {
        const jobs = (await txn.get("jobs")) ?? [];
        const idx = jobs.findIndex((j) => j.id === jobId);

        if (idx === -1) return { found: false };

        const removed = jobs[idx];
        jobs.splice(idx, 1);
        jobs.sort((a, b) => a.runAtMs - b.runAtMs);
        await txn.put("jobs", jobs);

        return { found: true, removed };
      });

      if (!result.found) throw new SchedulingBackendUserFacingError(`No job found: \`${jobId}\``, 422);

      // Set/clear the next alarm from persisted state to avoid racey local
      // copies.
      const jobsNow = (await state.storage.get("jobs")) ?? [];
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const next = jobsNow[0];
      if (next) {
        await state.storage.setAlarm(next.runAtMs);
      } else {
        await state.storage.deleteAlarm();
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
      return await pathHandlers.base(this.state, request, pathHandler);
    } catch (e) {
      return (e instanceof SchedulingBackendUserFacingError)
        ? jsonResponse({ userFacingError: e.message }, e.status)
        : jsonResponse({ error: "Unknown error." }, 500);
    }
  }

  /**
   * Alarm handler: delivers due pings and reschedules repeating jobs.
   */
  async alarm() {
    // Load delivered once, keep it in-memory during this alarm run, and write
    // back after any change.
    let delivered = (await this.state.storage.get("delivered")) ?? {};
    if (typeof delivered !== "object" || delivered === null) delivered = {};
    pruneDelivered(delivered, Date.now());

    while (true) {
      const nowMs = Date.now();

      // Always read the latest jobs from storage instead of trusting a stale
      // local array across deliveries/reschedules.
      const jobsNow = (await this.state.storage.get("jobs")) ?? [];
      jobsNow.sort((a, b) => a.runAtMs - b.runAtMs);

      const job = jobsNow[0];
      if (!job || job.runAtMs > nowMs) break; // nothing due

      const key = deliveryKey(job);
      const alreadyDelivered = delivered[key] !== undefined;

      // 1) Deliver outside the transaction so Discord API calls do not hold the
      // storage transaction open.
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

        const r = await handler.composer.composeAndSend(this.env, job);

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

      // 2) Atomically remove or reschedule this exact occurrence.
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

    // Final prune + persist for dedupe housekeeping.
    pruneDelivered(delivered, Date.now());
    await this.state.storage.put("delivered", delivered);

    // Point the next alarm at persisted state, not any local copy.
    const finalJobs = (await this.state.storage.get("jobs")) ?? [];
    finalJobs.sort((a, b) => a.runAtMs - b.runAtMs);

    const next = finalJobs[0];
    if (next) await this.state.storage.setAlarm(next.runAtMs);
    else await this.state.storage.deleteAlarm();
  }

}
