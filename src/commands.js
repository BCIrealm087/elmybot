import { PERMS } from "./permissions.js";
import { getOption } from "./common.js";
import {
  scheduleMessage, getStandardOptions, evalStandardTimestamp,
  evalMessage
} from "./message-scheduling.js";

function makeDoAt({
  description, subjectOption = undefined, optionsOverride = undefined,
  extraOptions = [], getOptions, 
  evaluator, doAtType
}) {
  if (!subjectOption && !optionsOverride) throw new Error("Either `subjectOption` or `optionsOverride` must be defined.");
  if (subjectOption && optionsOverride) throw new Error("Please only define one of `subjectOption` or `optionsOverride`, not both.");
  return {
    description,
    guild: true, 
    allowed: [PERMS.OWNER, PERMS.MODERATORS], 
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
        type: doAtType
      });
    }
  }
}

// exec's return value should fit the 'data' field of the json response expected by discord following a command invocation
export const commands = {
  "alive": {
    description: "Replies if alive.",
    allowed: [PERMS.ANY], 
    exec: () => ({ content: "I'm here!!1" })
  },

  "pingroleat": makeDoAt({
    description: "Schedule a role ping at an Unix timestamp (seconds).",
    subjectOption: { name: "role", description: "Role to ping", type: 8, required: true },
    getOptions: (interaction)=>({ ...getStandardOptions(interaction), subject: String(getOption(interaction, "role") ?? "") }),
    evaluator: (options)=>(!/^\d{5,30}$/.test(options.subject)) ? "Invalid role." : null || evalStandardTimestamp(options),
    doAtType: "ping-role"
  }),

  "pingmeat": makeDoAt({
    description: "Schedule an user ping at a Unix timestamp (seconds).",
    subjectOption: { name: "user", description: "User to ping", type: 6, required: true }, // USER
    getOptions: (interaction)=>({ ...getStandardOptions(interaction), subject: String(getOption(interaction, "user") ?? "") }),
    evaluator: (options)=>(!/^\d{5,30}$/.test(options.subject)) ? "Invalid user." : null || evalStandardTimestamp(options),
    doAtType: "ping-user"
  }),

  "sayat": makeDoAt({
    description: "Schedule a message at a Unix timestamp (seconds).",
    subjectOption: { name: "message", description: "Message", type: 3, required: true }, // MESSAGE
    getOptions: (interaction)=>({ ...getStandardOptions(interaction), subject: String(getOption(interaction, "message") ?? "") }),
    evaluator: (options) => evalMessage(options) || evalStandardTimestamp(options),
    doAtType: "channel-message-standard"
  }),

  "sayat_random": makeDoAt({
    description: "Schedule a message to be sent after a semi-random interval (in seconds; default min. 2h max. 6h).",
    optionsOverride: [
      { name: "message", description: "Message", type: 3, required: true }, // MESSAGE
      { name: "min_interval", description: "Min. interval", type: 4, required: false },
      { name: "max_interval", description: "Max. interval", type: 4, required: false },
      { name: "repeats", description: "If true, at bounded random intervals", type: 5, required: false }
    ],
    getOptions: (interaction)=>({
      subject: String(getOption(interaction, "message") ?? ""),
      repeats: Boolean(getOption(interaction, "repeats") ?? false),
      data: {
        minInterval: Number(getOption(interaction, "min_interval") ?? 7200), 
        maxInterval: Number(getOption(interaction, "max_interval") ?? 21600)
      }
    }),
    evaluator: (options) => {
      const minInterval = options.data.minInterval;
      const maxInterval = options.data.maxInterval;
      return evalMessage(options) || (
        ![minInterval, maxInterval].every(v=>Number.isFinite(v) && Number.isInteger(v)) ? "Intervals must be integers representing seconds."
        : minInterval <= 0 || maxInterval <= 0 ? "Intervals cannot be null or negative."
        : minInterval < 600 ? "Mininum interval cannot be less than 10 minutes (600 seconds)."
        : minInterval > 86400 || maxInterval > 86400 ? "Message cannot be scheduled to be sent after more than 24 hours. Check the `repeats` option."
        : minInterval > maxInterval ? "Minimum interval cannot be smaller than the maximum interval."
        : null
      );
    },
    doAtType: "channel-message-random"
  }),

  "doat_list": {
    description: "List scheduled messages for this server.",
    guild: true,
    allowed: [PERMS.OWNER, PERMS.MODERATORS],
    deferred: true,
    exec: async (interaction, env) => {
      const id = env.SCHEDULER.idFromName(interaction.guild_id);
      const stub = env.SCHEDULER.get(id);
      const r = await stub.fetch("https://do/list");
      return await r.json();
    }
  }, 

  "doat_cancel": {
    description: "Cancel a scheduled message by job ID.",
    guild: true,
    allowed: [PERMS.OWNER, PERMS.MODERATORS],
    deferred: true,
    options: [
      { name: "job_id", description: "Job ID", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      const id = env.SCHEDULER.idFromName(interaction.guild_id);
      const stub = env.SCHEDULER.get(id);
      const jobId = String(getOption(interaction, "job_id") ?? "").trim();
      
      const r = await stub.fetch("https://do/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });

      return await r.json();
    }
  }
}