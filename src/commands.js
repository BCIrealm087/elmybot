const getOption = (interaction, name) => {
  const opts = interaction.data?.options ?? [];
  return opts.find(o => o.name === name)?.value;
};

const roleIdValidator = (subject) => (!/^\d{5,30}$/.test(subject) ? "Invalid role." : null);
const userIdValidator = (subject) => (!/^\d{5,30}$/.test(subject) ? "Invalid user." : null);
const messageValidator = (subject) => (
  subject.length === 0 ? "Message cannot be empty."
    : subject.length > 2000 ? "Message too long (max 2000 chars)."
      : null
);

const commands = [
  {
    name: "alive",
    description: "Replies if alive.",
    options: [],
    requiresModerator: false,
    defer: false,
    response: {
      content: "I'm here!!1",
      allowed_mentions: { parse: [] },
    },
  },
  {
    name: "pingroleat",
    description: "Schedule a role ping at a Unix timestamp (seconds).",
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "role", description: "Role to ping", type: 8, required: true },
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false },
    ],
    requiresModerator: true,
    defer: true,
    schedule: {
      doAtType: "ping-role",
      subjectExtractor: (interaction) => String(getOption(interaction, "role") ?? ""),
      validator: roleIdValidator,
    },
  },
  {
    name: "doat_list",
    description: "List scheduled messages for this server.",
    options: [],
    requiresModerator: true,
    defer: true,
    action: "list",
  },
  {
    name: "doat_cancel",
    description: "Cancel a scheduled ping by job ID.",
    options: [
      { name: "job_id", description: "Job ID", type: 3, required: true },
    ],
    requiresModerator: true,
    defer: true,
    action: "cancel",
    jobIdExtractor: (interaction) => String(getOption(interaction, "job_id") ?? "").trim(),
  },
  {
    name: "pingmeat",
    description: "Schedule a user ping at a Unix timestamp (seconds).",
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "user", description: "User to ping", type: 6, required: true },
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false },
    ],
    requiresModerator: true,
    defer: true,
    schedule: {
      doAtType: "ping-user",
      subjectExtractor: (interaction) => String(getOption(interaction, "user") ?? ""),
      validator: userIdValidator,
    },
  },
  {
    name: "sayat",
    description: "Schedule a message at a Unix timestamp (seconds).",
    options: [
      { name: "timestamp", description: "Unix timestamp in seconds", type: 4, required: true },
      { name: "message", description: "Message", type: 3, required: true },
      { name: "repeat_daily", description: "If true, repeats every day", type: 5, required: false },
    ],
    requiresModerator: true,
    defer: true,
    schedule: {
      doAtType: "channel-message",
      subjectExtractor: (interaction) => String(getOption(interaction, "message") ?? ""),
      validator: messageValidator,
    },
  },
];

const commandMap = new Map(commands.map((command) => [command.name, command]));

export { commands, commandMap, getOption };
