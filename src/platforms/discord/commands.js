import { CAPABILITIES } from "./discord-permissions.js";
import { getOption, ephemeralData, formatInterval } from "./common.js";
import { DeliveryError } from "../../message-scheduling/index.js";
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

/**
 * Build a guild-only deferred scheduling command and register the metadata
 * needed by the scheduler Durable Object to render and reschedule jobs.
 */
function defaultDoAtCompose(c, _, stored) {
  const IC = c.innerContent(stored);
  const AM = c.allowedMentions(stored);
  const OC = c.outerContent(stored, IC);
  return { content: OC, allowed_mentions: AM };
}

async function defaultDoAtSend(env, job, messageData) {
  let response;
  try {
    response = await fetch(
      `https://discord.com/api/v10/channels/${job.extraData.channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${env.DISCORD_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(messageData),
      }
    );
  } catch (cause) {
    throw new DeliveryError("Discord API request failed.", {
      retryable: true,
      code: "discord_network_error",
      cause
    });
  }

  if (!response.ok) {
    throw new DeliveryError(
      `Discord API request failed with status ${response.status}.`,
      {
        retryable: response.status === 429 || response.status >= 500,
        code: "discord_http_error",
        metadata: { status: response.status }
      }
    );
  }
}

function makeDoAt({
  description, subjectOption = undefined, optionsOverride = undefined,
  extraOptions = [], getOptions, evaluator, 
  composer: {
    innerContent, allowedMentions, outerContent, 
    repeatDescription = (_)=>"daily", composeMessage = defaultDoAtCompose, 
    sendMessage = defaultDoAtSend
  }, 
  scheduleCalculation = getDailyTimeFromTimestamp, 
  jobKind
}) {
  if (!subjectOption && !optionsOverride) throw new Error("Either `subjectOption` or `optionsOverride` must be defined.");
  if (subjectOption && optionsOverride) throw new Error("Please only define one of `subjectOption` or `optionsOverride`, not both.");
  if (!jobKind) throw new Error("A stable scheduling job kind is required.");

  const composer = {
    innerContent, allowedMentions, outerContent,
    repeatDescription, composeMessage, sendMessage,
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
  }
  return {
    description,
    guild: {
      capability: CAPABILITIES.SCHEDULE_CREATE
    },
    options: (subjectOption) ? [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      subjectOption,
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false },
      ...extraOptions
    ] : optionsOverride,
    deferred: true,
    exec: (interaction, env) => {
      return scheduleMessage(interaction, env, {
        getOptions,
        eval: evaluator,
        kind: jobKind,
        composer
      });
    },
    extra: {
      jobKind,
      composer,
      calcScheduleTime: scheduleCalculation
    }
  }
}

const doAtSchedulingCommands = {
  "pingroleat": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.PING_ROLE,
    description: "Schedule a role ping at an Unix timestamp (seconds).",
    subjectOption: { name: "role", description: "Role to ping", type: 8, required: true },
    getOptions: (interaction)=>({ ...getStandardOptions(interaction), subject: String(getOption(interaction, "role") ?? "") }),
    evaluator: (options)=>(!/^\d{5,30}$/.test(options.subject)) ? "Invalid role." : evalStandardTimestamp(options),
    composer: {
      innerContent: (j)=>`<@&${j.subject}>`, 
      allowedMentions: (j)=>({ roles: [j.subject] }), 
      outerContent: (j, innerContent)=>`${innerContent} (scheduled role ping for <t:${j.timestamp}:F>)`
    }
  }),

  "pingmeat": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.PING_USER,
    description: "Schedule an user ping at an Unix timestamp (seconds).",
    subjectOption: { name: "user", description: "User to ping", type: 6, required: true }, // USER
    getOptions: (interaction)=>({ ...getStandardOptions(interaction), subject: String(getOption(interaction, "user") ?? "") }),
    evaluator: (options)=>(!/^\d{5,30}$/.test(options.subject)) ? "Invalid user." : evalStandardTimestamp(options),
    composer: {
      innerContent: (j)=>`<@${j.subject}>`, 
      allowedMentions: (j)=>({ users: [j.subject] }), 
      outerContent: (j, innerContent)=>`${innerContent} (scheduled user ping for <t:${j.timestamp}:F>)`
    }
  }),

  "sayat": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.SEND_AT,
    description: "Schedule a message at an Unix timestamp (seconds).",
    subjectOption: { name: "message", description: "Message", type: 3, required: true }, // MESSAGE
    extraOptions: [{ name: "gif", description: "Search string for a gif to be included in the message", type: 3, required: false }],
    getOptions: (interaction)=>({
      ...getStandardOptions(interaction),
      subject: String(getOption(interaction, "message") ?? ""),
      extraData: { gif: String(getOption(interaction, "gif") ?? "") }
    }),
    evaluator: (options) => evalMessage(options) || evalGifOptions(options) || evalStandardTimestamp(options),
    composer: {
      innerContent: (j) => j.extraData.gif ? gifMessageInnerContent(j) : j.subject,
      allowedMentions: (_) => ({ parse: [] }),
      outerContent: (j, innerContent) => j.extraData.gif ? gifMessageOuterContent(j, innerContent) : innerContent,
      composeMessage: (c, env, stored) => stored.extraData.gif
        ? gifMessageCompose(c, env, stored)
        : defaultDoAtCompose(c, env, stored)
    }
  }),

  "sayat_random": makeDoAt({
    jobKind: DISCORD_JOB_KINDS.SEND_RANDOM,
    description: "Schedule a message to be sent after a semi-random interval (in seconds; default min. 2h max. 6h).",
    optionsOverride: [
      { name: "message", description: "Message", type: 3, required: true }, // MESSAGE
      { name: "min_interval", description: "Min. interval", type: 4, required: false },
      { name: "max_interval", description: "Max. interval", type: 4, required: false },
      { name: "repeats", description: "If true, repeats at bounded random intervals", type: 5, required: false },
      { name: "gif", description: "Search string for a gif to be included in the message", type: 3, required: false }
    ],
    getOptions: (interaction)=>({
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
        ![minInterval, maxInterval].every(v=>Number.isFinite(v) && Number.isInteger(v)) ? "Intervals must be integers representing seconds."
        : minInterval <= 0 || maxInterval <= 0 ? "Intervals cannot be null or negative."
        : minInterval < 600 ? "Mininum interval cannot be less than 10 minutes (600 seconds)."
        : minInterval > 86400 || maxInterval > 86400 ? "Message cannot be scheduled to be sent after more than 24 hours. Check the `repeats` option."
        : minInterval > maxInterval ? "Minimum interval cannot be smaller than the maximum interval."
        : null
      );
    },
    composer: {
      innerContent: (j)=>j.extraData.gif ? gifMessageInnerContent(j) : j.subject,
      allowedMentions: (_)=>({ parse: [] }), 
      outerContent: (j, innerContent) => j.extraData.gif ? gifMessageOuterContent(j, innerContent) : innerContent,
      composeMessage: (c, env, stored) => stored.extraData.gif
        ? gifMessageCompose(c, env, stored)
        : defaultDoAtCompose(c, env, stored),
      repeatDescription: (j) => `randomly (min.: ${formatInterval(j.extraData.minInterval)} - max.: ${formatInterval(j.extraData.maxInterval)})`
    }, 
    scheduleCalculation: getRandomTimeFromInterval
  })
}

const schedulingCommandsByKind = Object.freeze(Object.fromEntries(
  Object.values(doAtSchedulingCommands).map((definition) => [
    definition.extra.jobKind,
    definition
  ])
));

function internalRequestHeaders(interaction) {
  return {
    "content-type": "application/json",
    "x-correlation-id": `discord:${interaction.id ?? "unknown"}`
  };
}

async function serviceFailure(response, serviceName) {
  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    // Unexpected bodies are not reflected to Discord or copied into logs.
  }

  if (data?.userFacingError) return ephemeralData(data.userFacingError);

  const error = new Error(`${serviceName} returned an unexpected response.`);
  error.status = response.status;
  throw error;
}

export const discordSchedulingHandlers = Object.freeze(Object.fromEntries(
  Object.values(doAtSchedulingCommands).map((definition) => [
    definition.extra.jobKind,
    Object.freeze({
      deliver: definition.extra.composer.composeAndSend,
      calcScheduleTime: definition.extra.calcScheduleTime
    })
  ])
));

// `exec` return values are Discord interaction `data` payloads, not full
// `Response` instances.
// Commands without a guild descriptor will not receive a guild_id on execution.
export const commands = {
  "alive": {
    description: "Replies if alive.",
    exec: () => ({ content: "I'm here!!1" })
  },

  ...doAtSchedulingCommands,

  "config_show_value": {
    description: `Displays the value of a given configuration entry`,
    guild: {
      capability: CAPABILITIES.CONFIG_MANAGE
    },
    deferred: true,
    options: [
      { name: "entry", description: "Configuration entry name", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      const id = env.CONFIG.idFromName(interaction.guild_id);
      const stub = env.CONFIG.get(id);
      const key = String(getOption(interaction, "entry") ?? "");

      const r = await stub.fetch("https://config/get", {
        method: "POST",
        headers: internalRequestHeaders(interaction),
        body: JSON.stringify({
          key
        })
      });
      if (!r.ok) {
        return await serviceFailure(r, "Group configuration service");
      }
      const data = await r.json();

      return ephemeralData(
        (data.value !== null && data.value !== undefined)
          ? `${key}'s (${typeof data.value}) value is: \n\`    ${JSON.stringify(data.value)}    \`\n.`
          : `No entry named \`${key}\` was found.`
      );
    }
  },

  "config_list_entries": {
    description: `Lists the configured entry keys`,
    guild: {
      capability: CAPABILITIES.CONFIG_MANAGE
    }, 
    deferred: true,
    exec: async (interaction, env) => {
      const id = env.CONFIG.idFromName(interaction.guild_id);
      const stub = env.CONFIG.get(id);

      const r = await stub.fetch("https://config/list", {
        headers: internalRequestHeaders(interaction)
      });
      if (!r.ok) {
        return await serviceFailure(r, "Group configuration service");
      }
      const data = await r.json();

      if (data.totalEntries === 0) {
        return ephemeralData("No configured entries.");
      }

      const shown = data.keys.map(key => `"${key}"`).join(", ");

      return ephemeralData(`Entries (${data.totalEntries} total, showing ${data.keys.length}):\n\`{${shown}}\``);
    }
  },

  "config_allow_role": {
    description: "Enables a role to use scheduling commands.",
    guild: {
      capability: CAPABILITIES.CONFIG_MANAGE
    }, 
    deferred: true,
    options: [
      { name: "role", description: "Role to allow", type: 8, required: true }
    ],
    exec: async (interaction, env) => {
      const id = env.CONFIG.idFromName(interaction.guild_id);
      const stub = env.CONFIG.get(id);
      const role = String(getOption(interaction, "role") ?? "");

      const r = await stub.fetch("https://config/append-to", {
        method: "POST",
        headers: internalRequestHeaders(interaction),
        body: JSON.stringify({
          key: "allowedRoles",
          value: role
        })
      });
      if (!r.ok) {
        return await serviceFailure(r, "Group configuration service");
      }
      return ephemeralData(`Successfully added <@&${role}> to allowed roles.`);
    }
  },

  "config_disallow_role": {
    description: `Removes protected command access from role`,
    guild: {
      capability: CAPABILITIES.CONFIG_MANAGE
    }, 
    deferred: true,
    options: [
      { name: "role", description: "Role to diallow", type: 8, required: true }
    ],
    exec: async (interaction, env) => {
      const id = env.CONFIG.idFromName(interaction.guild_id);
      const stub = env.CONFIG.get(id);
      const role = String(getOption(interaction, "role") ?? "");

      const r = await stub.fetch("https://config/remove-from", {
        method: "POST",
        headers: internalRequestHeaders(interaction),
        body: JSON.stringify({
          key: "allowedRoles",
          value: role
        })
      });
      if (!r.ok) {
        return await serviceFailure(r, "Group configuration service");
      }
      return ephemeralData(`Successfully removed <@&${role}> from allowed roles.`);
    }
  },

  "doat_list": {
    description: "List scheduled messages for this server.",
    guild: {
      capability: CAPABILITIES.SCHEDULE_VIEW
    },
    deferred: true,
    exec: async (interaction, env) => {
      const id = env.SCHEDULER.idFromName(
        `discord:guild:${interaction.guild_id}`
      );
      const stub = env.SCHEDULER.get(id);
      const r = await stub.fetch("https://do/list", {
        headers: internalRequestHeaders(interaction)
      });
      if (!r.ok) {
        return await serviceFailure(r, "Scheduling service");
      }
      const data = await r.json();

      if (data.totalJobs === 0) {
        return ephemeralData("No scheduled jobs.");
      }

      const shown = data.jobsPreview.map(j => {
        const handler = schedulingCommandsByKind[j.kind];
        const innerContent = handler.extra.composer.innerContent(j);
        return `• <t:${j.timestamp}:F> (<t:${j.timestamp}:R>) — ${innerContent} in <#${j.extraData.channelId}>` +
          (j.repeats ? ` 🔁 ${handler.extra.composer.repeatDescription(j)}` : "") +
          ` — id: \`${j.id}\``;
      }).join("\n");

      return ephemeralData(`📌 Scheduled jobs (${data.totalJobs} total, showing ${data.jobsPreview.length}):\n${shown}`);
    }
  }, 

  "doat_cancel": {
    description: "Cancel a scheduled message by job ID.",
    guild: {
      capability: CAPABILITIES.SCHEDULE_CANCEL
    },
    deferred: true,
    options: [
      { name: "job_id", description: "Job ID", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      const id = env.SCHEDULER.idFromName(
        `discord:guild:${interaction.guild_id}`
      );
      const stub = env.SCHEDULER.get(id);
      const jobId = String(getOption(interaction, "job_id") ?? "").trim();
      
      const r = await stub.fetch("https://do/cancel", {
        method: "POST",
        headers: internalRequestHeaders(interaction),
        body: JSON.stringify({ jobId })
      });
      if (!r.ok) {
        return await serviceFailure(r, "Scheduling service");
      }
      const data = await r.json();
      return ephemeralData(`🗑️ Cancelled job \`${jobId}\` scheduled for <t:${data.timestamp}:F>.`);
    }
  }
}
