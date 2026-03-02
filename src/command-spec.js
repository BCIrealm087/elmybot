const DISCORD_OPTION_TYPES = Object.freeze({
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  ROLE: 8,
});

const SCHEDULE_BASE_OPTIONS = Object.freeze([
  Object.freeze({
    name: "timestamp",
    description: "Unix timestamp in seconds",
    type: DISCORD_OPTION_TYPES.INTEGER,
    required: true,
  }),
  Object.freeze({
    name: "repeat_daily",
    description: "If true, repeats every day",
    type: DISCORD_OPTION_TYPES.BOOLEAN,
    required: false,
  }),
]);

const DO_AT_TYPE_BEHAVIORS = Object.freeze({
  "ping-role": Object.freeze({
    innerContent: (job) => `<@&${job.doAtSubject}>`,
    allowedMentions: (job) => ({ roles: [job.doAtSubject] }),
    outerContent: (job, innerContent) => `${innerContent} (scheduled role ping for <t:${job.scheduledUnix}:F>)`,
  }),
  "ping-user": Object.freeze({
    innerContent: (job) => `<@${job.doAtSubject}>`,
    allowedMentions: (job) => ({ users: [job.doAtSubject] }),
    outerContent: (job, innerContent) => `${innerContent} (scheduled user ping for <t:${job.scheduledUnix}:F>)`,
  }),
  "channel-message": Object.freeze({
    innerContent: (job) => job.doAtSubject,
    allowedMentions: () => ({ parse: [] }),
    outerContent: (_, innerContent) => innerContent,
  }),
});

const COMMAND_SPECS = Object.freeze({
  alive: Object.freeze({
    name: "alive",
    description: "Replies if alive.",
    deferred: false,
    requiresGuild: false,
    requiresModeratorOrOwner: false,
    kind: "simple",
    responseContent: "I'm here!!1",
  }),
  pingroleat: Object.freeze({
    name: "pingroleat",
    description: "Schedule a role ping at a Unix timestamp (seconds).",
    deferred: true,
    requiresGuild: true,
    requiresModeratorOrOwner: true,
    kind: "schedule",
    doAtType: "ping-role",
    subjectOptionName: "role",
    validateSubject: (subject) => (/^\d{5,30}$/.test(subject) ? null : "Invalid role."),
    options: Object.freeze([
      Object.freeze({
        name: "timestamp",
        description: "Unix timestamp in seconds",
        type: DISCORD_OPTION_TYPES.INTEGER,
        required: true,
      }),
      Object.freeze({
        name: "role",
        description: "Role to ping",
        type: DISCORD_OPTION_TYPES.ROLE,
        required: true,
      }),
      ...SCHEDULE_BASE_OPTIONS.slice(1),
    ]),
  }),
  pingmeat: Object.freeze({
    name: "pingmeat",
    description: "Schedule a user ping at a Unix timestamp (seconds).",
    deferred: true,
    requiresGuild: true,
    requiresModeratorOrOwner: true,
    kind: "schedule",
    doAtType: "ping-user",
    subjectOptionName: "user",
    validateSubject: (subject) => (/^\d{5,30}$/.test(subject) ? null : "Invalid user."),
    options: Object.freeze([
      Object.freeze({
        name: "timestamp",
        description: "Unix timestamp in seconds",
        type: DISCORD_OPTION_TYPES.INTEGER,
        required: true,
      }),
      Object.freeze({
        name: "user",
        description: "User to ping",
        type: DISCORD_OPTION_TYPES.USER,
        required: true,
      }),
      ...SCHEDULE_BASE_OPTIONS.slice(1),
    ]),
  }),
  sayat: Object.freeze({
    name: "sayat",
    description: "Schedule a message at a Unix timestamp (seconds).",
    deferred: true,
    requiresGuild: true,
    requiresModeratorOrOwner: true,
    kind: "schedule",
    doAtType: "channel-message",
    subjectOptionName: "message",
    validateSubject: (subject) => {
      if (subject.length === 0) return "Message cannot be empty.";
      if (subject.length > 2000) return "Message too long (max 2000 chars).";
      return null;
    },
    options: Object.freeze([
      Object.freeze({
        name: "timestamp",
        description: "Unix timestamp in seconds",
        type: DISCORD_OPTION_TYPES.INTEGER,
        required: true,
      }),
      Object.freeze({
        name: "message",
        description: "Message",
        type: DISCORD_OPTION_TYPES.STRING,
        required: true,
      }),
      ...SCHEDULE_BASE_OPTIONS.slice(1),
    ]),
  }),
  doat_list: Object.freeze({
    name: "doat_list",
    description: "List scheduled messages for this server.",
    deferred: true,
    requiresGuild: true,
    requiresModeratorOrOwner: true,
    kind: "list",
  }),
  doat_cancel: Object.freeze({
    name: "doat_cancel",
    description: "Cancel a scheduled ping by job ID.",
    deferred: true,
    requiresGuild: true,
    requiresModeratorOrOwner: true,
    kind: "cancel",
    options: Object.freeze([
      Object.freeze({
        name: "job_id",
        description: "Job ID",
        type: DISCORD_OPTION_TYPES.STRING,
        required: true,
      }),
    ]),
  }),
});

function getCommandSpec(name) {
  if (typeof name !== "string") return null;
  return COMMAND_SPECS[name] ?? null;
}

function buildRegistrationCommands() {
  return Object.values(COMMAND_SPECS).map((command) => {
    const out = {
      name: command.name,
      description: command.description,
    };

    if (command.options) out.options = command.options;

    return out;
  });
}

export {
  COMMAND_SPECS,
  DO_AT_TYPE_BEHAVIORS,
  DISCORD_OPTION_TYPES,
  buildRegistrationCommands,
  getCommandSpec,
};
