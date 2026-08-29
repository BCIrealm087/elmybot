import { DeliveryError } from "../../message-scheduling/index.js";
import { CAPABILITIES } from "./discord-permissions.js";
import { getOption, formatInterval } from "./common.js";
import { sendDiscordChannelMessage } from "./delivery.js";
import {
  scheduleMessage, getStandardOptions, evalStandardTimestamp,
  evalMessage, getDailyTimeFromTimestamp, getRandomTimeFromInterval
} from "./message-scheduling/index.js";
import {
  evalGifOptions, gifMessageInnerContent, gifMessageOuterContent,
  gifMessageCompose
} from "./gifs-extension.js";

export const DISCORD_JOB_KINDS = Object.freeze({
  PING_ROLE: "discord.message.ping-role.v1",
  PING_USER: "discord.message.ping-user.v1",
  SEND_AT: "discord.message.send-at.v1",
  SEND_RANDOM: "discord.message.send-random.v1"
});

function defaultDoAtCompose(composer, _env, stored) {
  const innerContent = composer.innerContent(stored);
  const allowedMentions = composer.allowedMentions(stored);
  const content = composer.outerContent(stored, innerContent);
  return { content, allowed_mentions: allowedMentions };
}

async function defaultDoAtSend(env, job, messageData) {
  await sendDiscordChannelMessage(env, job.destination.channelId, messageData);
}

function makeDoAt({
  description, subjectOption = undefined, optionsOverride = undefined,
  extraOptions = [], getOptions, evaluator,
  composer: {
    innerContent, allowedMentions, outerContent,
    repeatDescription = () => "daily", composeMessage = defaultDoAtCompose,
    sendMessage = defaultDoAtSend
  },
  scheduleCalculation = getDailyTimeFromTimestamp,
  jobKind
}) {
  if (!subjectOption && !optionsOverride) {
    throw new Error("Either `subjectOption` or `optionsOverride` must be defined.");
  }
  if (subjectOption && optionsOverride) {
    throw new Error("Please only define one of `subjectOption` or `optionsOverride`, not both.");
  }
  if (!jobKind) throw new Error("A stable scheduling job kind is required.");

  const composer = {
    innerContent,
    allowedMentions,
    outerContent,
    repeatDescription,
    composeMessage,
    sendMessage,
    composeAndSend: async (env, stored) => {
      try {
        const messageData = await composeMessage(composer, env, stored);
        await sendMessage(env, stored, messageData);
      } catch (error) {
        if (error instanceof DeliveryError) throw error;
        throw new DeliveryError("Discord message delivery failed.", {
          retryable: true,
          code: "discord_delivery_error",
          cause: error
        });
      }
    }
  };
  return {
    description,
    guild: {
      capability: CAPABILITIES.SCHEDULE_CREATE
    },
    options: subjectOption ? [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      subjectOption,
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false },
      ...extraOptions
    ] : optionsOverride,
    deferred: true,
    exec: (interaction, env) => scheduleMessage(interaction, env, {
      getOptions,
      eval: evaluator,
      kind: jobKind,
      composer
    }),
    extra: {
      jobKind,
      composer,
      calcScheduleTime: scheduleCalculation
    }
  };
}

export const schedulingCommands = Object.freeze({
  "pingroleat": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.PING_ROLE,
    description: "Schedule a role ping at an Unix timestamp (seconds).",
    subjectOption: { name: "role", description: "Role to ping", type: 8, required: true },
    getOptions: (interaction) => ({
      ...getStandardOptions(interaction),
      subject: String(getOption(interaction, "role") ?? "")
    }),
    evaluator: (options) => !/^\d{5,30}$/.test(options.subject)
      ? "Invalid role."
      : evalStandardTimestamp(options),
    composer: {
      innerContent: (job) => `<@&${job.subject}>`,
      allowedMentions: (job) => ({ roles: [job.subject] }),
      outerContent: (job, innerContent) =>
        `${innerContent} (scheduled role ping for <t:${job.timestamp}:F>)`
    }
  }),

  "pingmeat": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.PING_USER,
    description: "Schedule an user ping at an Unix timestamp (seconds).",
    subjectOption: { name: "user", description: "User to ping", type: 6, required: true },
    getOptions: (interaction) => ({
      ...getStandardOptions(interaction),
      subject: String(getOption(interaction, "user") ?? "")
    }),
    evaluator: (options) => !/^\d{5,30}$/.test(options.subject)
      ? "Invalid user."
      : evalStandardTimestamp(options),
    composer: {
      innerContent: (job) => `<@${job.subject}>`,
      allowedMentions: (job) => ({ users: [job.subject] }),
      outerContent: (job, innerContent) =>
        `${innerContent} (scheduled user ping for <t:${job.timestamp}:F>)`
    }
  }),

  "sayat": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.SEND_AT,
    description: "Schedule a message at an Unix timestamp (seconds).",
    subjectOption: { name: "message", description: "Message", type: 3, required: true },
    extraOptions: [
      {
        name: "gif",
        description: "Search string for a gif to be included in the message",
        type: 3,
        required: false
      }
    ],
    getOptions: (interaction) => ({
      ...getStandardOptions(interaction),
      subject: String(getOption(interaction, "message") ?? ""),
      extraData: { gif: String(getOption(interaction, "gif") ?? "") }
    }),
    evaluator: (options) =>
      evalMessage(options) || evalGifOptions(options) || evalStandardTimestamp(options),
    composer: {
      innerContent: (job) => job.extraData.gif ? gifMessageInnerContent(job) : job.subject,
      allowedMentions: () => ({ parse: [] }),
      outerContent: (job, innerContent) =>
        job.extraData.gif ? gifMessageOuterContent(job, innerContent) : innerContent,
      composeMessage: (composer, env, stored) => stored.extraData.gif
        ? gifMessageCompose(composer, env, stored)
        : defaultDoAtCompose(composer, env, stored)
    }
  }),

  "sayat_random": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.SEND_RANDOM,
    description: "Schedule a message to be sent after a semi-random interval (in seconds; default min. 2h max. 6h).",
    optionsOverride: [
      { name: "message", description: "Message", type: 3, required: true },
      { name: "min_interval", description: "Min. interval (at least 10 minutes)", type: 4, required: false },
      { name: "max_interval", description: "Max. interval (at most 24 hours)", type: 4, required: false },
      { name: "repeats", description: "If true, repeats at bounded random intervals", type: 5, required: false },
      { name: "gif", description: "Search string for a gif to be included in the message", type: 3, required: false }
    ],
    getOptions: (interaction) => ({
      subject: String(getOption(interaction, "message") ?? ""),
      repeats: Boolean(getOption(interaction, "repeats") ?? false),
      extraData: {
        minInterval: Number(getOption(interaction, "min_interval") ?? 7200),
        maxInterval: Number(getOption(interaction, "max_interval") ?? 21600),
        gif: String(getOption(interaction, "gif") ?? "")
      }
    }),
    evaluator: (options) => {
      const minInterval = options.extraData.minInterval;
      const maxInterval = options.extraData.maxInterval;
      return evalMessage(options) || evalGifOptions(options) || (
        ![minInterval, maxInterval].every((value) => Number.isFinite(value) && Number.isInteger(value))
          ? "Intervals must be integers representing seconds."
          : minInterval <= 0 || maxInterval <= 0
            ? "Intervals cannot be null or negative."
            : minInterval < 600
              ? "Mininum interval cannot be less than 10 minutes (600 seconds)."
              : minInterval > 86400 || maxInterval > 86400
                ? "Message cannot be scheduled to be sent after more than 24 hours. Check the `repeats` option."
                : minInterval > maxInterval
                  ? "Minimum interval cannot be smaller than the maximum interval."
                  : null
      );
    },
    composer: {
      innerContent: (job) => job.extraData.gif ? gifMessageInnerContent(job) : job.subject,
      allowedMentions: () => ({ parse: [] }),
      outerContent: (job, innerContent) =>
        job.extraData.gif ? gifMessageOuterContent(job, innerContent) : innerContent,
      composeMessage: (composer, env, stored) => stored.extraData.gif
        ? gifMessageCompose(composer, env, stored)
        : defaultDoAtCompose(composer, env, stored),
      repeatDescription: (job) =>
        `randomly (min.: ${formatInterval(job.extraData.minInterval)} - ` +
        `max.: ${formatInterval(job.extraData.maxInterval)})`
    },
    scheduleCalculation: getRandomTimeFromInterval
  })
});

export const schedulingCommandsByKind = Object.freeze(Object.fromEntries(
  Object.values(schedulingCommands).map((definition) => [
    definition.extra.jobKind,
    definition
  ])
));

function isBoundedDiscordId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function validateDiscordJob(job) {
  const guildId = job.extraData.guildId;
  const channelId = job.extraData.channelId;
  if (!isBoundedDiscordId(guildId) || !isBoundedDiscordId(channelId)) {
    return "Discord scheduling requires valid guild and channel IDs.";
  }
  if (
    job.groupKey !== `discord:guild:${guildId}` ||
    job.destination.channelId !== channelId
  ) {
    return "Discord scheduling destination metadata is inconsistent.";
  }

  if (
    (job.kind === DISCORD_JOB_KINDS.PING_ROLE ||
      job.kind === DISCORD_JOB_KINDS.PING_USER) &&
    !/^\d{5,30}$/.test(job.subject)
  ) {
    return "Discord ping jobs require a valid target ID.";
  }
  if (
    (job.kind === DISCORD_JOB_KINDS.SEND_AT ||
      job.kind === DISCORD_JOB_KINDS.SEND_RANDOM) &&
    (job.subject.length === 0 || job.subject.length > 2_000)
  ) {
    return "Discord message jobs require a message of at most 2000 characters.";
  }

  const isMessageJob = job.kind === DISCORD_JOB_KINDS.SEND_AT ||
    job.kind === DISCORD_JOB_KINDS.SEND_RANDOM;
  if (isMessageJob) {
    const gif = job.extraData.gif;
    if (gif !== null && (typeof gif !== "string" || gif.length > 20)) {
      return "Discord GIF search metadata is invalid.";
    }
  }
  if (job.kind === DISCORD_JOB_KINDS.SEND_RANDOM) {
    const { minInterval, maxInterval } = job.extraData;
    if (
      !Number.isSafeInteger(minInterval) || !Number.isSafeInteger(maxInterval) ||
      minInterval < 600 || maxInterval > 86_400 || minInterval > maxInterval
    ) {
      return "Discord random interval metadata is invalid.";
    }
  }

  return null;
}

export const discordSchedulingHandlers = Object.freeze(Object.fromEntries(
  Object.values(schedulingCommands).map((definition) => [
    definition.extra.jobKind,
    Object.freeze({
      deliver: definition.extra.composer.composeAndSend,
      calcScheduleTime: definition.extra.calcScheduleTime,
      validateJob: validateDiscordJob
    })
  ])
));
