import { CORE_ACTION_KINDS } from "../../actions/index.js";
import { discordTextActionResponse, executeDiscordAction } from "./actions.js";
import { CAPABILITIES } from "./discord-permissions.js";
import { ephemeralData, getOption } from "./common.js";
import { discordGroupConfigFetch } from "./group-config.js";
import { integrationCommands } from "./integration-commands.js";
import {
  DISCORD_JOB_KINDS,
  discordSchedulingHandlers,
  schedulingCommands,
  schedulingCommandsByKind
} from "./scheduling-commands.js";

export { DISCORD_JOB_KINDS, discordSchedulingHandlers };

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

function compactDiagnosticText(value, maxLength = 120) {
  return String(value ?? "unknown")
    .replaceAll("`", "'")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

const managementCommands = Object.freeze({
  "config_show_value": {
    description: "Displays the value of a given configuration entry",
    guild: { capability: CAPABILITIES.CONFIG_MANAGE },
    deferred: true,
    options: [
      { name: "entry", description: "Configuration entry name", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      const key = String(getOption(interaction, "entry") ?? "");
      const response = await discordGroupConfigFetch(
        env,
        interaction.guild_id,
        "https://config/get",
        {
          method: "POST",
          headers: internalRequestHeaders(interaction),
          body: JSON.stringify({ key })
        }
      );
      if (!response.ok) {
        return await serviceFailure(response, "Group configuration service");
      }
      const data = await response.json();
      return ephemeralData(
        data.value !== null && data.value !== undefined
          ? `${key}'s (${typeof data.value}) value is: \n` +
            `\`    ${JSON.stringify(data.value)}    \`\n.`
          : `No entry named \`${key}\` was found.`
      );
    }
  },

  "config_list_entries": {
    description: "Lists the configured entry keys",
    guild: { capability: CAPABILITIES.CONFIG_MANAGE },
    deferred: true,
    exec: async (interaction, env) => {
      const response = await discordGroupConfigFetch(
        env,
        interaction.guild_id,
        "https://config/list",
        { headers: internalRequestHeaders(interaction) }
      );
      if (!response.ok) {
        return await serviceFailure(response, "Group configuration service");
      }
      const data = await response.json();
      if (data.totalEntries === 0) return ephemeralData("No configured entries.");
      const shown = data.keys.map((key) => `"${key}"`).join(", ");
      return ephemeralData(
        `Entries (${data.totalEntries} total, showing ${data.keys.length}):\n` +
        `\`{${shown}}\``
      );
    }
  },

  "config_allow_role": {
    description: "Enables a role to use scheduling commands.",
    guild: { capability: CAPABILITIES.CONFIG_MANAGE },
    deferred: true,
    options: [
      { name: "role", description: "Role to allow", type: 8, required: true }
    ],
    exec: async (interaction, env) => {
      const role = String(getOption(interaction, "role") ?? "");
      const response = await discordGroupConfigFetch(
        env,
        interaction.guild_id,
        "https://config/append-to",
        {
          method: "POST",
          headers: internalRequestHeaders(interaction),
          body: JSON.stringify({ key: "allowedRoles", value: role })
        }
      );
      if (!response.ok) {
        return await serviceFailure(response, "Group configuration service");
      }
      return ephemeralData(`Successfully added <@&${role}> to allowed roles.`);
    }
  },

  "config_disallow_role": {
    description: "Removes protected command access from role",
    guild: { capability: CAPABILITIES.CONFIG_MANAGE },
    deferred: true,
    options: [
      { name: "role", description: "Role to diallow", type: 8, required: true }
    ],
    exec: async (interaction, env) => {
      const role = String(getOption(interaction, "role") ?? "");
      const response = await discordGroupConfigFetch(
        env,
        interaction.guild_id,
        "https://config/remove-from",
        {
          method: "POST",
          headers: internalRequestHeaders(interaction),
          body: JSON.stringify({ key: "allowedRoles", value: role })
        }
      );
      if (!response.ok) {
        return await serviceFailure(response, "Group configuration service");
      }
      return ephemeralData(`Successfully removed <@&${role}> from allowed roles.`);
    }
  },

  "doat_list": {
    description: "List scheduled messages for this server.",
    guild: { capability: CAPABILITIES.SCHEDULE_VIEW },
    deferred: true,
    exec: async (interaction, env) => {
      const id = env.SCHEDULER.idFromName(`discord:guild:${interaction.guild_id}`);
      const stub = env.SCHEDULER.get(id);
      const response = await stub.fetch("https://do/list", {
        headers: internalRequestHeaders(interaction)
      });
      if (!response.ok) return await serviceFailure(response, "Scheduling service");
      const data = await response.json();
      if (data.totalJobs === 0) return ephemeralData("No scheduled jobs.");

      const shown = data.jobsPreview.map((job) => {
        const handler = schedulingCommandsByKind[job.kind];
        const innerContent = handler.extra.composer.innerContent(job);
        return `• <t:${job.timestamp}:F> (<t:${job.timestamp}:R>) — ` +
          `${innerContent} in <#${job.extraData.channelId}>` +
          (job.repeats
            ? ` 🔁 ${handler.extra.composer.repeatDescription(job)}`
            : "") +
          ` — id: \`${job.id}\``;
      }).join("\n");
      return ephemeralData(
        `📌 Scheduled jobs (${data.totalJobs} total, showing ${data.jobsPreview.length}):\n` +
        shown
      );
    }
  },

  "doat_dead_letters": {
    description: "Show recent scheduled-message delivery failures.",
    guild: { capability: CAPABILITIES.SCHEDULE_VIEW },
    deferred: true,
    exec: async (interaction, env) => {
      const id = env.SCHEDULER.idFromName(`discord:guild:${interaction.guild_id}`);
      const stub = env.SCHEDULER.get(id);
      const response = await stub.fetch("https://do/dead-letters", {
        headers: internalRequestHeaders(interaction)
      });
      if (!response.ok) return await serviceFailure(response, "Scheduling service");
      const data = await response.json();
      if (data.totalDeadLetters === 0) {
        return ephemeralData("No recent failed scheduled-message deliveries.");
      }

      const shown = data.deadLettersPreview.map(({ failedAtMs, job }) => {
        const failedAt = Math.floor(failedAtMs / 1000);
        const error = job.delivery?.lastError;
        const channelId = job.extraData?.channelId;
        return `• <t:${failedAt}:F> — \`${compactDiagnosticText(job.kind, 80)}\`` +
          (channelId ? ` in <#${channelId}>` : "") +
          ` — ${job.delivery?.attempts ?? 0} attempt(s)` +
          ` — \`${compactDiagnosticText(error?.code)}\`: ` +
          `${compactDiagnosticText(error?.message)}` +
          ` — id: \`${compactDiagnosticText(job.id, 80)}\``;
      }).join("\n");
      return ephemeralData(
        `💀 Failed scheduled deliveries (${data.totalDeadLetters} total, ` +
        `showing ${data.deadLettersPreview.length}):\n${shown}`
      );
    }
  },

  "doat_cancel": {
    description: "Cancel a scheduled message by job ID.",
    guild: { capability: CAPABILITIES.SCHEDULE_CANCEL },
    deferred: true,
    options: [
      { name: "job_id", description: "Job ID", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      const id = env.SCHEDULER.idFromName(`discord:guild:${interaction.guild_id}`);
      const stub = env.SCHEDULER.get(id);
      const jobId = String(getOption(interaction, "job_id") ?? "").trim();
      const response = await stub.fetch("https://do/cancel", {
        method: "POST",
        headers: internalRequestHeaders(interaction),
        body: JSON.stringify({ jobId })
      });
      if (!response.ok) return await serviceFailure(response, "Scheduling service");
      const data = await response.json();
      return ephemeralData(
        `🗑️ Cancelled job \`${jobId}\` scheduled for <t:${data.timestamp}:F>.`
      );
    }
  }
});

// `exec` return values are Discord interaction `data` payloads, not full
// `Response` instances. Commands without a guild descriptor will not receive
// a guild_id on execution.
export const commands = {
  "alive": {
    description: "Replies if alive.",
    actionKind: CORE_ACTION_KINDS.ALIVE,
    exec: async (_interaction, env, _name, context) =>
      discordTextActionResponse(await executeDiscordAction(
        context.sourceInteraction,
        CORE_ACTION_KINDS.ALIVE,
        {},
        { env }
      ))
  },
  ...integrationCommands,
  ...schedulingCommands,
  ...managementCommands
};
