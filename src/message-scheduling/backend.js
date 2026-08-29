import { jsonResponse, logError } from "../common.js";
import { alarmDrainTimeRemaining } from "../alarm-drain.js";

// Durable Object environment: indexed job storage + alarms.

export const SCHEDULER_JOB_SCHEMA_VERSION = 1;

const JOB_KIND_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\.v\d+$/;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_SOURCE_EVENT_ID_LENGTH = 200;
const MAX_GROUP_KEY_LENGTH = 200;
const MAX_ACTOR_ID_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 2_000;
const MAX_DESTINATION_BYTES = 4 * 1024;
const MAX_EXTRA_DATA_BYTES = 32 * 1024;
const MAX_JOB_BYTES = 64 * 1024;

export function createJobHandlerRegistry(...handlerSets) {
  // Registries are immutable snapshots by contract. Scheduler instances may
  // safely retain one for their lifetime without adapters replacing handlers
  // after validation or while an alarm is running.
  const registry = Object.create(null);

  for (const handlerSet of handlerSets) {
    for (const [kind, handler] of Object.entries(handlerSet)) {
      if (registry[kind]) {
        throw new Error(`Duplicate scheduling job kind: \`${kind}\`.`);
      }
      if (!JOB_KIND_PATTERN.test(kind)) {
        throw new Error(`Scheduling job kind must be namespaced and versioned: \`${kind}\`.`);
      }
      if (
        typeof handler?.deliver !== "function" ||
        typeof handler?.calcScheduleTime !== "function" ||
        typeof handler?.validateJob !== "function"
      ) {
        throw new Error(`Invalid scheduling handler for job kind: \`${kind}\`.`);
      }

      registry[kind] = Object.freeze({
        deliver: handler.deliver,
        calcScheduleTime: handler.calcScheduleTime,
        validateJob: handler.validateJob
      });
    }
  }

  return Object.freeze(registry);
}

class SchedulingBackendUserFacingError extends Error {
  constructor(message, status=500) {
    super(message);
    if (status !== null && status !== undefined) this.status = status;
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
// A Discord GIF delivery can make two external requests (KLIPY + Discord).
// Twenty jobs therefore leave headroom below the Workers Free 50-subrequest
// limit for redirects or other delivery-handler requests.
const MAX_JOBS_PER_ALARM = 20;
const MAX_DEAD_LETTERS = 100;
const MAX_DEAD_LETTERS_PREVIEW = 5;
const MAX_SCHEDULE_SOURCES = 10_000;

function isPlainObject(value) {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function serializedByteLength(value, fieldName, limit) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SchedulingBackendUserFacingError(`${fieldName} must be JSON-serializable.`, 422);
  }
  if (serialized === undefined) {
    throw new SchedulingBackendUserFacingError(`${fieldName} must be JSON-serializable.`, 422);
  }
  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > limit) {
    throw new SchedulingBackendUserFacingError(`${fieldName} is too large.`, 422);
  }
  return { serialized, size };
}

function requireBoundedString(value, fieldName, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SchedulingBackendUserFacingError(`${fieldName} is invalid.`, 422);
  }
}

function validateScheduleRequest(job, handler) {
  if (!isPlainObject(job)) {
    throw new SchedulingBackendUserFacingError("Scheduling payload must be an object.", 422);
  }
  serializedByteLength(job, "Scheduling payload", MAX_JOB_BYTES);

  if (job.schemaVersion !== SCHEDULER_JOB_SCHEMA_VERSION) {
    throw new SchedulingBackendUserFacingError("Unsupported scheduling schema version.", 422);
  }
  if (typeof job.platform !== "string" || !PLATFORM_PATTERN.test(job.platform)) {
    throw new SchedulingBackendUserFacingError("Scheduling platform is invalid.", 422);
  }
  if (typeof job.kind !== "string" || !job.kind.startsWith(`${job.platform}.`)) {
    throw new SchedulingBackendUserFacingError("Scheduling job kind does not match its platform.", 422);
  }

  requireBoundedString(job.groupKey, "Scheduling group key", MAX_GROUP_KEY_LENGTH);
  if (!job.groupKey.startsWith(`${job.platform}:`)) {
    throw new SchedulingBackendUserFacingError("Scheduling group key does not match its platform.", 422);
  }

  if (!isPlainObject(job.destination) || Object.keys(job.destination).length === 0) {
    throw new SchedulingBackendUserFacingError("Scheduling destination is required.", 422);
  }
  serializedByteLength(job.destination, "Scheduling destination", MAX_DESTINATION_BYTES);

  if (typeof job.subject !== "string" || job.subject.length > MAX_SUBJECT_LENGTH) {
    throw new SchedulingBackendUserFacingError("Scheduling subject is invalid.", 422);
  }
  if (!isPlainObject(job.extraData)) {
    throw new SchedulingBackendUserFacingError("Scheduling platform data must be an object.", 422);
  }
  serializedByteLength(job.extraData, "Scheduling platform data", MAX_EXTRA_DATA_BYTES);

  if (typeof job.repeats !== "boolean") {
    throw new SchedulingBackendUserFacingError("Scheduling repeat policy is invalid.", 422);
  }
  if (job.createdBy !== null && job.createdBy !== undefined) {
    requireBoundedString(job.createdBy, "Scheduling actor ID", MAX_ACTOR_ID_LENGTH);
  }

  requireBoundedString(job.sourceEventId, "Scheduling source event ID", MAX_SOURCE_EVENT_ID_LENGTH);
  if (!job.sourceEventId.startsWith(`${job.platform}:`)) {
    throw new SchedulingBackendUserFacingError("Scheduling source event ID does not match its platform.", 422);
  }

  const adapterError = handler.validateJob(job);
  if (adapterError) {
    throw new SchedulingBackendUserFacingError(String(adapterError).slice(0, 500), 422);
  }
}

function validateCalculatedSchedule(result) {
  if (!Array.isArray(result) || result.length !== 2) {
    throw new SchedulingBackendUserFacingError("Scheduling handler produced invalid time metadata.", 422);
  }
  const [timestamp, runAtMs] = result;
  if (
    !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
    !Number.isSafeInteger(runAtMs) || runAtMs <= 0 ||
    Math.floor(runAtMs / 1000) !== timestamp
  ) {
    throw new SchedulingBackendUserFacingError("Scheduling handler produced invalid time metadata.", 422);
  }
  return [timestamp, runAtMs];
}

function deliveryAttemptAt(job) {
  const nextAttemptAtMs = job.delivery?.nextAttemptAtMs;
  return Number.isSafeInteger(nextAttemptAtMs) ? nextAttemptAtMs : job.runAtMs;
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

function initializeSchedulerTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_jobs (
      id TEXT PRIMARY KEY,
      next_attempt_at_ms INTEGER NOT NULL,
      run_at_ms INTEGER NOT NULL,
      job_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduler_jobs_due
      ON scheduler_jobs (next_attempt_at_ms, run_at_ms, id);
    CREATE TABLE IF NOT EXISTS scheduler_sources (
      source_event_id TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL,
      response_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduler_sources_created
      ON scheduler_sources (created_at_ms, source_event_id);
    CREATE TABLE IF NOT EXISTS scheduler_dead_letters (
      dead_letter_id INTEGER PRIMARY KEY AUTOINCREMENT,
      failed_at_ms INTEGER NOT NULL,
      job_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduler_dead_letters_recent
      ON scheduler_dead_letters (failed_at_ms DESC, dead_letter_id DESC);
  `);
}

function decodeJobRow(row) {
  return row ? JSON.parse(row.job_json) : null;
}

function firstJob(sql) {
  const row = sql.exec(`
    SELECT job_json
    FROM scheduler_jobs
    ORDER BY next_attempt_at_ms, run_at_ms, id
    LIMIT 1
  `).toArray()[0];
  return decodeJobRow(row);
}

function findJob(sql, id) {
  return decodeJobRow(sql.exec(
    "SELECT job_json FROM scheduler_jobs WHERE id = ?",
    id
  ).toArray()[0]);
}

function insertJob(sql, job) {
  const jobJson = serializedByteLength(job, "Stored scheduling job", MAX_JOB_BYTES).serialized;
  sql.exec(
    `INSERT INTO scheduler_jobs (id, next_attempt_at_ms, run_at_ms, job_json)
     VALUES (?, ?, ?, ?)`,
    job.id,
    deliveryAttemptAt(job),
    job.runAtMs,
    jobJson
  );
}

function updateJob(sql, job) {
  const jobJson = serializedByteLength(job, "Stored scheduling job", MAX_JOB_BYTES).serialized;
  sql.exec(
    `UPDATE scheduler_jobs
     SET next_attempt_at_ms = ?, run_at_ms = ?, job_json = ?
     WHERE id = ?`,
    deliveryAttemptAt(job),
    job.runAtMs,
    jobJson,
    job.id
  );
}

async function setNextAlarm(state) {
  const next = state.storage.sql.exec(`
    SELECT next_attempt_at_ms
    FROM scheduler_jobs
    ORDER BY next_attempt_at_ms, run_at_ms, id
    LIMIT 1
  `).toArray()[0];
  if (next) {
    await state.storage.setAlarm(Math.max(next.next_attempt_at_ms, Date.now()));
  } else await state.storage.deleteAlarm();
}

function deliveryKey(job) {
  return `${job.id}:${job.timestamp}`;
}

function pruneDelivered(delivered, nowMs) {
  for (const [key, deliveredAtMs] of Object.entries(delivered)) {
    if (typeof deliveredAtMs !== "number" || deliveredAtMs < nowMs - DELIVERED_TTL_MS) {
      delete delivered[key];
    }
  }
}

const requestHandlers = {
  "GET": {
    base: async (scheduler, _, pathHandler) => await pathHandler(scheduler),
    "/list": async ({ state }) => {
      const totalJobs = state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM scheduler_jobs"
      ).one().count;
      const jobsPreview = state.storage.sql.exec(`
        SELECT job_json
        FROM scheduler_jobs
        ORDER BY next_attempt_at_ms, run_at_ms, id
        LIMIT 15
      `).toArray().map(decodeJobRow).map(job => ({
        id: job.id,
        timestamp: job.timestamp,
        subject: job.subject,
        repeats: job.repeats,
        extraData: job.extraData,
        kind: job.kind,
        delivery: job.delivery
      }));

      return jsonResponse({ totalJobs, jobsPreview });
    },
    "/dead-letters": async ({ state }) => {
      const totalDeadLetters = state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM scheduler_dead_letters"
      ).one().count;
      const deadLettersPreview = state.storage.sql.exec(`
        SELECT failed_at_ms, job_json
        FROM scheduler_dead_letters
        ORDER BY failed_at_ms DESC, dead_letter_id DESC
        LIMIT ?
      `, MAX_DEAD_LETTERS_PREVIEW).toArray().map(row => ({
        failedAtMs: row.failed_at_ms,
        job: decodeJobRow(row)
      }));

      return jsonResponse({ totalDeadLetters, deadLettersPreview });
    }
  },
  "POST": {
    base: async (scheduler, request, pathHandler) => {
      let body;
      try {
        body = await request.json();
      } catch {
        throw new SchedulingBackendUserFacingError("Request body must be valid JSON.", 400);
      }
      return await pathHandler(scheduler, body);
    },
    "/schedule": async ({ state, jobHandlers }, job) => {
      const handler = jobHandlers[job?.kind];
      if (!handler) {
        throw new SchedulingBackendUserFacingError("Invalid scheduling job kind.", 422);
      }
      validateScheduleRequest(job, handler);

      const result = state.storage.transactionSync(() => {
        const existing = state.storage.sql.exec(
          "SELECT response_json FROM scheduler_sources WHERE source_event_id = ?",
          job.sourceEventId
        ).toArray()[0];
        if (existing) return JSON.parse(existing.response_json);

        const [timestamp, runAtMs] = validateCalculatedSchedule(
          handler.calcScheduleTime(job)
        );
        const scheduledJob = {
          schemaVersion: SCHEDULER_JOB_SCHEMA_VERSION,
          id: crypto.randomUUID(),
          platform: job.platform,
          kind: job.kind,
          groupKey: job.groupKey,
          destination: job.destination,
          subject: job.subject,
          timestamp,
          runAtMs,
          extraData: job.extraData,
          repeats: job.repeats,
          createdBy: job.createdBy ?? null,
          sourceEventId: job.sourceEventId,
          delivery: pendingDelivery(runAtMs)
        };
        insertJob(state.storage.sql, scheduledJob);

        const response = {
          id: scheduledJob.id,
          timestamp: scheduledJob.timestamp,
          extraData: scheduledJob.extraData,
          sourceEventId: scheduledJob.sourceEventId,
          createdAtMs: Date.now()
        };
        state.storage.sql.exec(
          `INSERT INTO scheduler_sources (source_event_id, created_at_ms, response_json)
           VALUES (?, ?, ?)`,
          scheduledJob.sourceEventId,
          response.createdAtMs,
          JSON.stringify(response)
        );
        state.storage.sql.exec(`
          DELETE FROM scheduler_sources
          WHERE source_event_id NOT IN (
            SELECT source_event_id
            FROM scheduler_sources
            ORDER BY created_at_ms DESC, source_event_id DESC
            LIMIT ?
          )
        `, MAX_SCHEDULE_SOURCES);

        return response;
      });

      await setNextAlarm(state);
      return jsonResponse(result);
    },
    "/cancel": async ({ state }, body) => {
      const jobId = String(body?.jobId ?? "").trim();
      if (!jobId) {
        throw new SchedulingBackendUserFacingError("Provide a valid `job_id`.", 422);
      }

      const removed = state.storage.transactionSync(() => {
        const job = findJob(state.storage.sql, jobId);
        if (!job) return null;
        state.storage.sql.exec("DELETE FROM scheduler_jobs WHERE id = ?", jobId);
        return job;
      });
      if (!removed) {
        throw new SchedulingBackendUserFacingError(`No job found: \`${jobId}\``, 422);
      }

      await setNextAlarm(state);
      return jsonResponse({ timestamp: removed.timestamp });
    }
  }
};

export class GroupSchedulerBackend {
  constructor(state, env, jobHandlers) {
    this.state = state;
    this.env = env;
    this.jobHandlers = jobHandlers;
    initializeSchedulerTables(state);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathHandlers = requestHandlers[request.method];
    const pathHandler = pathHandlers && pathHandlers[url.pathname];
    if (!pathHandler) return new Response("Not Found", { status: 404 });
    try {
      return await pathHandlers.base(this, request, pathHandler);
    } catch (error) {
      if (error instanceof SchedulingBackendUserFacingError) {
        return jsonResponse({ userFacingError: error.message }, error.status);
      }

      const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
      logError("scheduler.request_failed", {
        platform: "shared",
        correlationId,
        method: request.method,
        route: url.pathname
      }, error);
      return jsonResponse({ error: "Unknown error.", correlationId }, 500);
    }
  }

  async alarm() {
    const startedAtMs = Date.now();
    let delivered = (await this.state.storage.get("delivered")) ?? {};
    if (!isPlainObject(delivered)) delivered = {};
    pruneDelivered(delivered, Date.now());

    try {
      for (let processed = 0; processed < MAX_JOBS_PER_ALARM; processed++) {
        if (!alarmDrainTimeRemaining(startedAtMs, processed)) break;
        const job = firstJob(this.state.storage.sql);
        const nowMs = Date.now();
        if (!job || deliveryAttemptAt(job) > nowMs) break;

        const handler = this.jobHandlers[job.kind];
        const key = deliveryKey(job);
        if (delivered[key] !== undefined) {
          if (!handler) {
            await this.failOccurrence(job, new DeliveryError(
              "No delivery handler is registered for this job type.",
              { retryable: false, code: "unknown_job_type" }
            ));
          } else {
            await this.completeOccurrence(job, handler);
          }
          continue;
        }

        const claimedJob = this.claimOccurrence(job, nowMs);
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
          this.failOccurrence(claimedJob, error);
          continue;
        }

        delivered[key] = Date.now();
        pruneDelivered(delivered, delivered[key]);
        await this.state.storage.put("delivered", delivered);
        this.completeOccurrence(claimedJob, handler);
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

  claimOccurrence(job, attemptedAtMs) {
    return this.state.storage.transactionSync(() => {
      const current = findJob(this.state.storage.sql, job.id);
      if (!current || current.timestamp !== job.timestamp) return null;

      const attempts = (current.delivery?.attempts ?? 0) + 1;
      current.delivery = {
        ...current.delivery,
        state: "attempting",
        attempts,
        nextAttemptAtMs: attemptedAtMs,
        lastAttemptAtMs: attemptedAtMs
      };
      updateJob(this.state.storage.sql, current);
      return current;
    });
  }

  failOccurrence(job, error) {
    const failedAtMs = Date.now();
    const failure = deliveryFailure(error);

    logError("scheduler.delivery_failed", {
      platform: job.platform ?? String(job.kind ?? "unknown").split(".")[0],
      correlationId: job.sourceEventId ?? job.id,
      groupId: job.extraData?.guildId ?? null,
      jobKind: job.kind ?? null,
      jobId: job.id ?? null,
      attempt: job.delivery?.attempts ?? 1,
      retryable: failure.retryable
    }, error);

    this.state.storage.transactionSync(() => {
      const current = findJob(this.state.storage.sql, job.id);
      if (!current || current.timestamp !== job.timestamp) return;

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
        updateJob(this.state.storage.sql, current);
        return;
      }

      current.delivery = {
        ...current.delivery,
        state: "dead_letter",
        attempts,
        nextAttemptAtMs: null,
        lastError
      };
      this.state.storage.sql.exec("DELETE FROM scheduler_jobs WHERE id = ?", current.id);
      this.state.storage.sql.exec(
        `INSERT INTO scheduler_dead_letters (failed_at_ms, job_json)
         VALUES (?, ?)`,
        failedAtMs,
        JSON.stringify(current)
      );
      this.state.storage.sql.exec(`
        DELETE FROM scheduler_dead_letters
        WHERE dead_letter_id NOT IN (
          SELECT dead_letter_id
          FROM scheduler_dead_letters
          ORDER BY failed_at_ms DESC, dead_letter_id DESC
          LIMIT ?
        )
      `, MAX_DEAD_LETTERS);
    });
  }

  completeOccurrence(job, handler) {
    this.state.storage.transactionSync(() => {
      const current = findJob(this.state.storage.sql, job.id);
      if (!current || current.timestamp !== job.timestamp) return;
      this.state.storage.sql.exec("DELETE FROM scheduler_jobs WHERE id = ?", current.id);

      if (current.repeats) {
        const [nextUnix, nextMs] = validateCalculatedSchedule(
          handler.calcScheduleTime(current, true)
        );
        insertJob(this.state.storage.sql, {
          ...current,
          timestamp: nextUnix,
          runAtMs: nextMs,
          delivery: pendingDelivery(nextMs)
        });
      }
    });
  }
}
