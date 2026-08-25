import { getOption, ephemeralData } from "../common.js";
import { logError, unknownErrorMessage } from "../../../common.js";

class SchedulingUserFacingError extends Error {
  constructor(message) {
    super (message);
  }
}

// Worker-side scheduling helpers. These validate interaction input and forward
// normalized jobs to the scheduler Durable Object.

export async function scheduleMessage(interaction, env, doAtHandler) {
  let schedulingResult;
  const correlationId = `discord:${interaction.id ?? crypto.randomUUID()}`;
  try {
    const interactionId = String(interaction.id ?? "").trim();
    if (!interactionId) {
      throw new Error("Discord interaction lacks an ID for scheduling idempotency.");
    }

    // Route all scheduling through the guild-scoped scheduler DO so storage and
    // alarm ownership stay in one place.
    const id = env.SCHEDULER.idFromName(
      `discord:guild:${interaction.guild_id}`
    );
    const stub = env.SCHEDULER.get(id);

    const options = doAtHandler.getOptions(interaction);
    if (!options.extraData) options.extraData = { };
    options.extraData = {
      ...options.extraData,
      guildId: interaction.guild_id,
      channelId: interaction.channel_id
    };
    // `eval` returns a user-facing error message or may mutate options for normalization
    // in-place when needed.
    const error = doAtHandler.eval(options);
    if (error) {
      throw new SchedulingUserFacingError(error);
    }

    const r = await stub.fetch("https://do/schedule", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": correlationId
      },
      body: JSON.stringify({
        ...options,
        kind: doAtHandler.kind,
        sourceEventId: `discord:${interactionId}`,
        createdBy: interaction.member?.user?.id ?? interaction.user?.id ?? null
      })
    });
    if (!r.ok) {
      const responseText = await r.text();
      let errData = null;
      try {
        errData = responseText ? JSON.parse(responseText) : null;
      } catch {
        // The status and content type are sufficient for safe diagnostics.
      }
      throw errData?.userFacingError
        ? new SchedulingUserFacingError(errData.userFacingError)
        : Object.assign(
          new Error("Scheduling service returned an unexpected response."),
          { status: r.status }
        );
    }
    const data = await r.json();
    schedulingResult = ephemeralData(
      `✅ Scheduled job for <t:${data.timestamp}:F> (<t:${data.timestamp}:R>)` +
      (options.repeats ? `\n🔁 Repeats ${doAtHandler.composer.repeatDescription(data)}.` : "") +
      `\nJob ID: \`${data.id}\``,
    );
  } catch(e) {
    if (e instanceof SchedulingUserFacingError) {
      schedulingResult = ephemeralData(e.message);
    } else {
      logError("discord.scheduling_failed", {
        platform: "discord",
        correlationId,
        groupId: interaction.guild_id ?? null,
        command: interaction.data?.name ?? null,
        jobKind: doAtHandler.kind
      }, e);
      schedulingResult = ephemeralData(unknownErrorMessage(correlationId));
    }
  }
  return schedulingResult;
}

export const getStandardOptions = (interaction) => ({
  repeats: Boolean(getOption(interaction, "repeat_daily") ?? false), 
  timestamp: Number(getOption(interaction, "timestamp"))
})

export const evalStandardTimestamp = (options) => {
  let ts = options.timestamp;
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return "`timestamp` must be an integer Unix timestamp in seconds.";

  if (ts > 10_000_000_000) ts = Math.floor(ts / 1000); // accept ms
  options.timestamp = ts;
  const now = Math.floor(Date.now() / 1000);
  if (ts <= now) return "That timestamp is in the past.";

  return null;
}

export const evalMessage = (options) => (
  options.subject.length === 0 ? "Message cannot be empty."
  : options.subject.length > 2000 ? "Message too long (max 2000 chars)."
  : null
)

export function getDailyTimeFromTimestamp(j, rescheduling=false) {
  if (!rescheduling){ 
    const ts = Number(j.timestamp);
    return [ts, ts*1000];
  }
  let nextUnix = j.timestamp + 86400;
  let nextMs = j.runAtMs + 86_400_000;

  // Catch up if alarm delivery was delayed and the next daily occurrence would
  // already be in the past.
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

export function getRandomTimeFromInterval(j, rescheduling = false){
  const offset = Math.floor(
    Math.random() * (j.extraData.maxInterval - j.extraData.minInterval + 1)
  ) + j.extraData.minInterval;

  if (!rescheduling) {
    const nextUnix = Math.floor(Date.now() / 1000) + offset;
    return [nextUnix, nextUnix * 1000];
  }

  if (!j.timestamp || !j.runAtMs) {
    throw new Error(`Scheduling error: job \`${j.id}\` lacks valid timestamp data.`);
  }

  const now = Date.now();
  const nextMs = j.runAtMs + offset * 1000;

  if (nextMs <= now) {
    const nextUnix = Math.floor(now / 1000 + offset);
    return [nextUnix, nextUnix * 1000];
  }

  return [j.timestamp + offset, nextMs];
}
