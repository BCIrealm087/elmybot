import { PERMS } from "./permissions";
import { getOption } from "./common";

// exec's return value should fit the 'data' field of the json response expected by discord following a command invocation
export const commands = {
  "alive": {
    description: "Replies if alive.",
    allowed: [PERMS.ANY], 
    exec: () => ({ content: "I'm here!!1" })
  },

  "pingroleat": {
    description: "Schedule a role ping at a Unix timestamp (seconds).",
    guild: true, 
    allowed: [PERMS.OWNER, PERMS.MODERATORS],
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "role", description: "Role to ping", type: 8, required: true },
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false }
    ], 
    deferred: true,
    exec: (interaction, env) => {
      return scheduleMessage(interaction, env, {
        getSubject: (interaction)=>String(getOption(interaction, "role") ?? ""),
        getError: (subject)=>(!/^\d{5,30}$/.test(subject)) ? "Invalid role." : null,
        type: "ping-role"
      });
    }
  },

  "pingmeat": {
    description: "Schedule an user ping at a Unix timestamp (seconds).",
    guild: true, 
    allowed: [PERMS.OWNER, PERMS.MODERATORS],
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "user", description: "User to ping", type: 6, required: true }, // USER,
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false }
    ],
    deferred: true,
    exec: (interaction, env) => {
      return scheduleMessage(interaction, env, {
        subject: (interaction)=>String(getOption(interaction, "user") ?? ""),
        errorPayload: (subject)=>(!/^\d{5,30}$/.test(subject)) ? "Invalid user." : null,
        type: "ping-user"
      });
    }
  },

  "sayat": {
    description: "Schedule a message at a Unix timestamp (seconds).",
    guild: true, 
    allowed: [PERMS.OWNER, PERMS.MODERATORS],
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "message", description: "Message", type: 3, required: true }, // MESSAGE,
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false }
    ],
    deferred: true,
    exec: (interaction, env) => {
      return scheduleMessage(interaction, env, {
        subject: (interaction)=>String(getOption(interaction, "message") ?? ""),
        errorPayload: (subject)=>(
          subject.length === 0 ? "Message cannot be empty."
          : subject.length > 2000 ? "Message too long (max 2000 chars)."
          : null
        ),
        type: "channel-message"
      });
    }
  },

  "doat_list": {
    description: "List scheduled messages for this server.",
    guild: true,
    allowed: [PERMS.OWNER, PERMS.MODERATORS],
    deferred: true,
    exec: async () => {
      const r = await stub.fetch("https://do/list");
      return await r.json();
    }
  }, 

  "doat_cancel": {
    description: "Cancel a scheduled ping by job ID.",
    guild: true,
    allowed: [PERMS.OWNER, PERMS.MODERATORS],
    deferred: true,
    options: [
      { name: "job_id", description: "Job ID", type: 3, required: true }
    ],
    exec: async (interaction) => {
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