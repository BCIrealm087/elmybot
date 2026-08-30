import { featureRegistry } from "../../features/index.js";
import { mergeCommandDefinitions } from "../../framework/internal.js";
import { CAPABILITIES } from "./discord-permissions.js";
import { ephemeralData, formatInterval, getOption } from "./common.js";
import { discordGroupConfigFetch } from "./group-config.js";
import { compileDiscordFeatureCommands } from "./feature-commands.js";
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

function installedFeatureId(value) {
  const featureId = String(value ?? "").trim();
  return featureRegistry.featuresById[featureId] ? featureId : null;
}

function featureConfigBody(interaction, extra = {}) {
  const featureId = installedFeatureId(getOption(interaction, "feature"));
  if (!featureId) return null;
  return {
    featureId,
    key: String(getOption(interaction, "key") ?? "").trim(),
    ...extra
  };
}

async function featureConfigFetch(interaction, env, operation, body) {
  return await discordGroupConfigFetch(
    env,
    interaction.guild_id,
    `https://config/internal/framework/config/${operation}`,
    {
      method: "POST",
      headers: internalRequestHeaders(interaction),
      body: JSON.stringify(body)
    }
  );
}

const managementCommands = Object.freeze({
  "feature_config_set": {
    description: "Sets a namespaced setting for an installed feature",
    guild: { capability: CAPABILITIES.CONFIG_MANAGE },
    deferred: true,
    options: [
      { name: "feature", description: "Installed feature ID", type: 3, required: true },
      { name: "key", description: "Feature setting key", type: 3, required: true },
      { name: "json_value", description: "Setting value as JSON", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      let value;
      try {
        value = JSON.parse(String(getOption(interaction, "json_value") ?? ""));
      } catch {
        return ephemeralData(
          "The value must be valid JSON. Text values need quotes, for example `\"Wins\"`."
        );
      }
      const body = featureConfigBody(interaction, { value });
      if (!body) return ephemeralData("That feature is not installed.");
      const response = await featureConfigFetch(interaction, env, "set", body);
      if (!response.ok) return await serviceFailure(response, "Feature configuration service");
      await response.text();
      return ephemeralData(
        `Set \`${compactDiagnosticText(body.featureId, 100)}.${compactDiagnosticText(body.key, 64)}\`.`
      );
    }
  },

  "feature_config_show": {
    description: "Shows a namespaced setting for an installed feature",
    guild: { capability: CAPABILITIES.CONFIG_MANAGE },
    deferred: true,
    options: [
      { name: "feature", description: "Installed feature ID", type: 3, required: true },
      { name: "key", description: "Feature setting key", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      const body = featureConfigBody(interaction);
      if (!body) return ephemeralData("That feature is not installed.");
      const response = await featureConfigFetch(interaction, env, "get", body);
      if (!response.ok) return await serviceFailure(response, "Feature configuration service");
      const data = await response.json();
      if (data.value === null) return ephemeralData("No feature setting was found.");
      const shown = compactDiagnosticText(JSON.stringify(data.value), 1_500);
      return ephemeralData(
        `\`${compactDiagnosticText(body.featureId, 100)}.${compactDiagnosticText(body.key, 64)}\` ` +
        `is \`${shown}\`.`
      );
    }
  },

  "feature_config_delete": {
    description: "Deletes a namespaced setting for an installed feature",
    guild: { capability: CAPABILITIES.CONFIG_MANAGE },
    deferred: true,
    options: [
      { name: "feature", description: "Installed feature ID", type: 3, required: true },
      { name: "key", description: "Feature setting key", type: 3, required: true }
    ],
    exec: async (interaction, env) => {
      const body = featureConfigBody(interaction);
      if (!body) return ephemeralData("That feature is not installed.");
      const response = await featureConfigFetch(interaction, env, "delete", body);
      if (!response.ok) return await serviceFailure(response, "Feature configuration service");
      const data = await response.json();
      return ephemeralData(data.deleted ? "Feature setting deleted." : "No feature setting was found.");
    }
  },

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
        const framework = job.extraData?.framework;
        const innerContent = handler
          ? handler.extra.composer.innerContent(job)
          : framework?.actionArgs?.message ?? job.subject;
        const channelId = job.extraData?.channelId ?? job.destination?.channelId;
        const repeat = handler
          ? handler.extra.composer.repeatDescription(job)
          : framework?.timing?.type === "bounded-random"
            ? `randomly (min.: ${formatInterval(framework.timing.minSeconds)} - ` +
              `max.: ${formatInterval(framework.timing.maxSeconds)})`
            : framework?.timing?.type ?? "using its feature schedule";
        return `• <t:${job.timestamp}:F> (<t:${job.timestamp}:R>) — ` +
          `${innerContent}${channelId ? ` in <#${channelId}>` : ""}` +
          (job.repeats
            ? ` 🔁 ${repeat}`
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
const legacyCommands = {
  ...integrationCommands,
  ...schedulingCommands,
  ...managementCommands
};

export const commands = mergeCommandDefinitions(
  "discord",
  legacyCommands,
  compileDiscordFeatureCommands(
    featureRegistry.commands.discord,
    featureRegistry.actions,
    featureRegistry.schedules
  )
);
