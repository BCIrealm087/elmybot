import { createCommandInvocation } from "../../integrations/index.js";
import {
  FEATURE_SCHEDULE_JOB_SCHEMA_VERSION
} from "../../actions/scheduled-actions.js";
import { SCHEDULER_JOB_SCHEMA_VERSION } from "../../message-scheduling/index.js";
import { formatInterval } from "./common.js";

export class DiscordFeatureSchedulingError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscordFeatureSchedulingError";
    this.code = "discord_feature_scheduling_error";
  }
}

function requireMappedSchedule(value, schedule) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DiscordFeatureSchedulingError("The feature produced an invalid schedule.");
  }
  const allowed = new Set(["actionArgs", "timing", "repeats"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new DiscordFeatureSchedulingError(
        `The feature produced an unsupported schedule field: \`${key}\`.`
      );
    }
  }
  if (typeof value.actionArgs !== "object" || value.actionArgs === null ||
      Array.isArray(value.actionArgs)) {
    throw new DiscordFeatureSchedulingError("Scheduled action arguments are invalid.");
  }
  if (typeof value.timing !== "object" || value.timing === null ||
      value.timing.type !== schedule.timing) {
    throw new DiscordFeatureSchedulingError(
      `Scheduled timing must use \`${schedule.timing}\`.`
    );
  }
  if (typeof value.repeats !== "boolean") {
    throw new DiscordFeatureSchedulingError("Scheduled repeat policy is invalid.");
  }
  return value;
}

function repeatDescription(timing) {
  if (timing.type === "bounded-random") {
    return `randomly (min.: ${formatInterval(timing.minSeconds)} - ` +
      `max.: ${formatInterval(timing.maxSeconds)})`;
  }
  return timing.type === "daily" ? "daily" : null;
}

export async function scheduleDiscordFeatureAction({
  interaction,
  env,
  command,
  schedule,
  action,
  args,
  authorizedCapability
}) {
  if (!interaction.guild_id) {
    throw new DiscordFeatureSchedulingError("Use this command inside a server.");
  }
  if (action.capability !== null && authorizedCapability !== action.capability) {
    throw new DiscordFeatureSchedulingError(
      `You are not authorized to use /${command.name}.`
    );
  }
  const mapped = requireMappedSchedule(command.mapSchedule(args), schedule);
  let actionArgs;
  try {
    actionArgs = action.input.parse(mapped.actionArgs, {
      path: "scheduled arguments"
    });
  } catch (error) {
    throw new DiscordFeatureSchedulingError(
      error instanceof Error ? error.message : "Scheduled action arguments are invalid."
    );
  }
  const interactionId = String(interaction.id ?? "").trim();
  if (!interactionId) {
    throw new Error("Discord interaction lacks an ID for scheduling idempotency.");
  }
  const sourceEventId = `discord:interaction:${interactionId}`;
  const invocation = createCommandInvocation({
    kind: action.kind,
    origin: {
      group: { platform: "discord", kind: "guild", id: interaction.guild_id },
      actor: {
        platform: "discord",
        id: interaction.member?.user?.id ?? interaction.user?.id,
        claims: []
      }
    },
    args: actionArgs,
    sourceEventId,
    correlationId: sourceEventId
  });
  const framework = {
    schemaVersion: FEATURE_SCHEDULE_JOB_SCHEMA_VERSION,
    scheduleKind: schedule.kind,
    actionKind: action.kind,
    actionArgs: invocation.args,
    timing: mapped.timing,
    grant: {
      capability: action.capability,
      origin: invocation.origin,
      acceptedAt: new Date().toISOString()
    }
  };
  const stub = env.SCHEDULER.get(
    env.SCHEDULER.idFromName(invocation.origin.group.key)
  );
  const response = await stub.fetch("https://do/schedule", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": invocation.correlationId
    },
    body: JSON.stringify({
      schemaVersion: SCHEDULER_JOB_SCHEMA_VERSION,
      platform: schedule.sourcePlatform,
      kind: schedule.kind,
      groupKey: invocation.origin.group.key,
      destination: { channelId: interaction.channel_id },
      subject: typeof invocation.args.message === "string"
        ? invocation.args.message
        : schedule.kind,
      extraData: {
        guildId: interaction.guild_id,
        channelId: interaction.channel_id,
        framework
      },
      repeats: mapped.repeats,
      createdBy: invocation.origin.actor.id,
      sourceEventId
    })
  });
  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    // A non-JSON scheduler failure is kept as an internal service error.
  }
  if (!response.ok) {
    if (data?.userFacingError) {
      throw new DiscordFeatureSchedulingError(data.userFacingError);
    }
    const error = new Error("Scheduling service returned an unexpected response.");
    error.status = response.status;
    throw error;
  }
  const repeat = mapped.repeats ? repeatDescription(mapped.timing) : null;
  return Object.freeze({
    content:
      `✅ Scheduled job for <t:${data.timestamp}:F> (<t:${data.timestamp}:R>)` +
      (repeat ? `\n🔁 Repeats ${repeat}.` : "") +
      `\nJob ID: \`${data.id}\``,
    flags: 64,
    allowed_mentions: Object.freeze({ parse: Object.freeze([]) })
  });
}
