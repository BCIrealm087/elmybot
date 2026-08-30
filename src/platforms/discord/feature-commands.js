import { ActionRegistryError } from "../../actions/index.js";
import { SchemaValidationError } from "../../framework/index.js";
import { discordOptionDescriptor } from "../../framework/internal.js";
import { SCHEDULED_ACTION_COMMAND_TYPE } from "../../framework/command-common.js";
import { ephemeralData } from "./common.js";
import { executeDiscordAction } from "./actions.js";
import { CAPABILITIES } from "./discord-permissions.js";
import { discordGroupConfigFetch } from "./group-config.js";
import {
  DiscordFeatureSchedulingError,
  scheduleDiscordFeatureAction
} from "./feature-scheduling.js";

function normalizeOptionValue(option, value) {
  const path = option.arg;
  if (["string", "user", "role", "channel"].includes(option.type)) {
    if (typeof value !== "string") throw new SchemaValidationError(path, "must be a string.");
    if (option.minLength !== null && value.length < option.minLength) {
      throw new SchemaValidationError(path, `must contain at least ${option.minLength} characters.`);
    }
    if (option.maxLength !== null && value.length > option.maxLength) {
      throw new SchemaValidationError(path, `must contain at most ${option.maxLength} characters.`);
    }
    return value;
  }
  if (option.type === "integer") {
    if (!Number.isSafeInteger(value)) throw new SchemaValidationError(path, "must be a safe integer.");
  } else if (option.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SchemaValidationError(path, "must be a finite number.");
    }
  } else if (option.type === "boolean") {
    if (typeof value !== "boolean") throw new SchemaValidationError(path, "must be a boolean.");
  }
  if (option.min !== null && value < option.min) {
    throw new SchemaValidationError(path, `must be at least ${option.min}.`);
  }
  if (option.max !== null && value > option.max) {
    throw new SchemaValidationError(path, `must be at most ${option.max}.`);
  }
  return value;
}

function extractArgs(interaction, options) {
  const values = new Map(
    (interaction.data?.options ?? []).map((option) => [option.name, option.value])
  );
  const args = {};
  for (const option of options) {
    if (!values.has(option.name)) {
      if (option.required) throw new SchemaValidationError(option.arg, "is required.");
      continue;
    }
    args[option.arg] = normalizeOptionValue(option, values.get(option.name));
  }
  return Object.freeze(args);
}

function discordOrigin(interaction) {
  return Object.freeze({
    group: Object.freeze({
      platform: "discord",
      kind: interaction.guild_id ? "guild" : "channel",
      id: interaction.guild_id ?? interaction.channel_id
    }),
    actor: Object.freeze({
      platform: "discord",
      id: interaction.member?.user?.id ?? interaction.user?.id
    })
  });
}

async function updateAllowedRole(env, interaction, roleId, operation) {
  const response = await discordGroupConfigFetch(
    env,
    interaction.guild_id,
    `https://config/${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": `discord:${interaction.id ?? "unknown"}`
      },
      body: JSON.stringify({ key: "allowedRoles", value: roleId })
    }
  );
  if (!response.ok) {
    await response.text();
    const error = new Error("Group configuration service returned an unexpected response.");
    error.status = response.status;
    throw error;
  }
}

function nativeContext(interaction, env, definition, runtime) {
  const permissionServiceAuthorized =
    definition.capability === CAPABILITIES.CONFIG_MANAGE &&
    runtime.authorizedCapability === CAPABILITIES.CONFIG_MANAGE;
  const updateRole = (roleId, operation) => {
    if (!permissionServiceAuthorized) {
      const error = new Error("The command cannot manage protected Discord roles.");
      error.code = "discord_permission_service_forbidden";
      throw error;
    }
    return updateAllowedRole(env, interaction, roleId, operation);
  };
  return Object.freeze({
    platform: "discord",
    origin: discordOrigin(interaction),
    sourceEventId: `discord:interaction:${interaction.id}`,
    permissions: Object.freeze({
      allowRole(roleId) {
        return updateRole(roleId, "append-to");
      },
      disallowRole(roleId) {
        return updateRole(roleId, "remove-from");
      }
    }),
    response: Object.freeze({
      text(content, { ephemeral = false } = {}) {
        if (typeof content !== "string" || content.length === 0 || content.length > 2_000) {
          throw new TypeError("Discord response text is invalid.");
        }
        return Object.freeze({
          content,
          ...(ephemeral ? { flags: 64 } : {}),
          allowed_mentions: Object.freeze({ parse: Object.freeze([]) })
        });
      }
    })
  });
}

function userFacingError(error, commandName) {
  if (error instanceof DiscordFeatureSchedulingError) {
    return ephemeralData(error.message);
  }
  if (error instanceof SchemaValidationError) return ephemeralData(error.message);
  if (error instanceof ActionRegistryError && error.code === "action_arguments_invalid") {
    return ephemeralData(error.message);
  }
  if (error instanceof ActionRegistryError && error.code === "action_forbidden") {
    return ephemeralData(`You are not authorized to use /${commandName}.`);
  }
  if (error instanceof ActionRegistryError && error.code === "action_cooldown_active") {
    return ephemeralData(
      `Try /${commandName} again in ${error.retryAfterSeconds} second(s).`
    );
  }
  return null;
}

export function compileDiscordFeatureCommands(definitions, actions, schedules = {}) {
  const compiled = Object.create(null);
  for (const definition of Object.values(definitions)) {
    const schedule = definition.mode === SCHEDULED_ACTION_COMMAND_TYPE
      ? schedules[definition.scheduleKind]
      : null;
    const action = definition.mode === "action-command"
      ? actions[definition.actionKind]
      : schedule ? actions[schedule.actionKind] : null;
    const capability = action?.capability ?? definition.capability ?? null;
    compiled[definition.name] = Object.freeze({
      description: definition.description,
      deferred: definition.deferred,
      ...(definition.mode === "action-command"
        ? { actionKind: definition.actionKind }
        : definition.mode === SCHEDULED_ACTION_COMMAND_TYPE
          ? { scheduleKind: definition.scheduleKind }
          : {}),
      ...(definition.availability === "guild"
        ? { guild: Object.freeze({ capability }) }
        : {}),
      options: Object.freeze(definition.options.map(discordOptionDescriptor)),
      exec: async (interaction, env, _name, runtime = {}) => {
        try {
          const args = extractArgs(runtime.sourceInteraction ?? interaction, definition.options);
          if (definition.mode === "action-command") {
            const result = await executeDiscordAction(
              runtime.sourceInteraction ?? interaction,
              definition.actionKind,
              args,
              {
                env,
                authorize: ({ capability: required }) =>
                  required === runtime.authorizedCapability
              }
            );
            return definition.render(result, Object.freeze({ platform: "discord" }));
          }
          if (definition.mode === SCHEDULED_ACTION_COMMAND_TYPE) {
            return await scheduleDiscordFeatureAction({
              interaction: runtime.sourceInteraction ?? interaction,
              env,
              command: definition,
              schedule,
              action,
              args,
              authorizedCapability: runtime.authorizedCapability
            });
          }
          const normalized = definition.input.parse(args, { path: "arguments" });
          return await definition.execute(
            nativeContext(
              runtime.sourceInteraction ?? interaction,
              env,
              definition,
              runtime
            ),
            normalized
          );
        } catch (error) {
          const response = userFacingError(error, definition.name);
          if (response) return response;
          throw error;
        }
      }
    });
  }
  return Object.freeze(compiled);
}

export function createDiscordCommandDescriptors(commands) {
  return Object.freeze(Object.entries(commands).map(([name, command]) => Object.freeze({
    name,
    description: command.description ?? "No description provided",
    ...(Array.isArray(command.options) && command.options.length > 0
      ? { options: command.options }
      : {})
  })));
}
