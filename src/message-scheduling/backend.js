import { jsonResponse } from "../common.js";

// Durable Object environment: persistent job storage + alarms.

// Scheduler behavior is registered from command definitions so the DO can
// format jobs and compute repeat times without duplicating command logic.
const doAtTypeHandlers = { };

export function registerDoAtHandlers(definitions) {
  for (const [key, { extra }] of Object.entries(definitions)) {
    doAtTypeHandlers[key] = {
      deliver: extra.composer.composeAndSend,
      calcScheduleTime: extra.calcScheduleTime
    };
  }
}

class SchedulingBackendUserFacingError extends Error {
  constructor(message, status=500) {
    super (message);
    if (status !== null && status !== undefined)
      this.status = status;
  }
}

export class DeliveryError extends Error {
  constructor(message, {
    retryable = false,
    code = "delivery_failed",
    metadata = {},
    cause = undefined
  } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.retryable = retryable;
    this.code = code;
    this.metadata = metadata;
    if (cause !== undefined) this.cause = cause;
  }
}

const DELIVERED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
const MAX_JOBS_PER_ALARM = 25;
const MAX_DEAD_LETTERS = 100;

function deliveryAttemptAt(job) {
  const nextAttemptAtMs = job.delivery?.nextAttemptAtMs;
  return Number.isFinite(nextAttemptAtMs) ? nextAttemptAtMs : job.runAtMs;
}

function sortJobs(jobs) {
  jobs.sort((a, b) =>
    deliveryAttemptAt(a) - deliveryAttemptAt(b) ||
    a.runAtMs - b.runAtMs
  );
}

function pendingDelivery(runAtMs) {
  return {
    state: "pending",
    attempts: 0,
    nextAttemptAtMs: runAtMs,
    lastAttemptAtMs: null,
    lastError: null
  };
}

function retryDelayMs(attempts) {
  return Math.min(
    RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1)),
    RETRY_MAX_DELAY_MS
  );
}

function deliveryFailure(error) {
  if (error instanceof DeliveryError) {
    return {
      retryable: error.retryable === true,
      code: error.code,
      message: String(error.message).slice(0, 500),
      metadata: error.metadata
    };
  }

  return {
    retryable: true,
    code: "unexpected_delivery_error",
    message: (
      error instanceof Error ? error.message : "Unknown delivery error."
    ).slice(0, 500),
    metadata: {}
  };
}

async function setNextAlarm(state) {
  const jobs = (await state.storage.get("jobs")) ?? [];
  sortJobs(jobs);

  const next = jobs[0];
  if (next) await state.storage.setAlarm(deliveryAttemptAt(next));
  else await state.storage.deleteAlarm();
}

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
      sortJobs(jobs);

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
        delivery: pendingDelivery(runAtMs)
      };

      // Atomic: read -> modify -> write jobs.
      await state.storage.transaction(async (txn) => {
        const jobs = (await txn.get("jobs")) ?? [];
        jobs.push(j);
        sortJobs(jobs);
        await txn.put("jobs", jobs);
      });

      // Recompute from persisted state so concurrent requests cannot leave a
      // later alarm behind.
      await setNextAlarm(state);

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
        sortJobs(jobs);
        await txn.put("jobs", jobs);

        return { found: true, removed };
      });

      if (!result.found) throw new SchedulingBackendUserFacingError(`No job found: \`${jobId}\``, 422);

      // Set/clear the next alarm from persisted state to avoid racey local
      // copies.
      await setNextAlarm(state);

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
    let delivered = (await this.state.storage.get("delivered")) ?? {};
    if (typeof delivered !== "object" || delivered === null) delivered = {};
    pruneDelivered(delivered, Date.now());

    try {
      for (let processed = 0; processed < MAX_JOBS_PER_ALARM; processed++) {
        const jobsNow = (await this.state.storage.get("jobs")) ?? [];
        sortJobs(jobsNow);

        const job = jobsNow[0];
        const nowMs = Date.now();
        if (!job || deliveryAttemptAt(job) > nowMs) break;

        const handler = doAtTypeHandlers[job.type];
        const key = deliveryKey(job);

        if (delivered[key] !== undefined) {
          if (!handler) {
            await this.failOccurrence(
              job,
              new DeliveryError("No delivery handler is registered for this job type.", {
                retryable: false,
                code: "unknown_job_type"
              })
            );
          } else {
            await this.completeOccurrence(job, handler);
          }
          continue;
        }

        const claimedJob = await this.claimOccurrence(job, nowMs);
        if (!claimedJob) continue;

        try {
          if (!handler) {
            throw new DeliveryError("No delivery handler is registered for this job type.", {
              retryable: false,
              code: "unknown_job_type"
            });
          }

          await handler.deliver(this.env, claimedJob);
        } catch (error) {
          await this.failOccurrence(claimedJob, error);
          continue;
        }

        // Persist the occurrence marker before removing/rescheduling the job.
        // This narrows, but cannot eliminate, the provider-accepted/persist-failed
        // duplicate-delivery window.
        delivered[key] = Date.now();
        pruneDelivered(delivered, delivered[key]);
        await this.state.storage.put("delivered", delivered);

        await this.completeOccurrence(claimedJob, handler);
      }
    } finally {
      pruneDelivered(delivered, Date.now());
      try {
        await this.state.storage.put("delivered", delivered);
      } finally {
        await setNextAlarm(this.state);
      }
    }
  }

  async claimOccurrence(job, attemptedAtMs) {
    return await this.state.storage.transaction(async (txn) => {
      const jobs = (await txn.get("jobs")) ?? [];
      const idx = jobs.findIndex(
        (candidate) =>
          candidate.id === job.id &&
          candidate.timestamp === job.timestamp
      );
      if (idx === -1) return null;

      const current = jobs[idx];
      const attempts = (current.delivery?.attempts ?? 0) + 1;
      current.delivery = {
        ...current.delivery,
        state: "attempting",
        attempts,
        nextAttemptAtMs: attemptedAtMs,
        lastAttemptAtMs: attemptedAtMs
      };

      sortJobs(jobs);
      await txn.put("jobs", jobs);
      return current;
    });
  }

  async failOccurrence(job, error) {
    const failedAtMs = Date.now();
    const failure = deliveryFailure(error);

    await this.state.storage.transaction(async (txn) => {
      const jobs = (await txn.get("jobs")) ?? [];
      const idx = jobs.findIndex(
        (candidate) =>
          candidate.id === job.id &&
          candidate.timestamp === job.timestamp
      );
      if (idx === -1) return;

      const current = jobs[idx];
      const attempts = current.delivery?.attempts ?? 1;
      const lastError = {
        code: failure.code,
        message: failure.message,
        metadata: failure.metadata,
        failedAtMs
      };

      if (failure.retryable && attempts < MAX_DELIVERY_ATTEMPTS) {
        current.delivery = {
          ...current.delivery,
          state: "retry_wait",
          attempts,
          nextAttemptAtMs: failedAtMs + retryDelayMs(attempts),
          lastError
        };
      } else {
        jobs.splice(idx, 1);

        let deadLetters = (await txn.get("deadLetters")) ?? [];
        if (!Array.isArray(deadLetters)) deadLetters = [];
        deadLetters.push({
          ...current,
          delivery: {
            ...current.delivery,
            state: "dead_letter",
            attempts,
            nextAttemptAtMs: null,
            lastError
          }
        });
        if (deadLetters.length > MAX_DEAD_LETTERS) {
          deadLetters.splice(0, deadLetters.length - MAX_DEAD_LETTERS);
        }
        await txn.put("deadLetters", deadLetters);
      }

      sortJobs(jobs);
      await txn.put("jobs", jobs);
    });
  }

  async completeOccurrence(job, handler) {
    await this.state.storage.transaction(async (txn) => {
      const jobs = (await txn.get("jobs")) ?? [];
      const idx = jobs.findIndex(
        (candidate) =>
          candidate.id === job.id &&
          candidate.timestamp === job.timestamp
      );
      if (idx === -1) return;

      const current = jobs[idx];
      jobs.splice(idx, 1);

      if (current.repeats) {
        const [nextUnix, nextMs] = handler.calcScheduleTime(current, true);
        jobs.push({
          ...current,
          timestamp: nextUnix,
          runAtMs: nextMs,
          delivery: pendingDelivery(nextMs)
        });
      }

      sortJobs(jobs);
      await txn.put("jobs", jobs);
    });
  }
}
