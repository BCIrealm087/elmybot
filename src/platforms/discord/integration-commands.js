import {
  createIntegrationInvitation,
  defaultDiscordTwitchRoutes,
  getIntegrationCoordinatorStatus,
  getIntegrationDeadLetters,
  getIntegrationDefaultLink,
  getIntegrationManagementStatus,
  INTEGRATION_ROUTE_KINDS,
  IntegrationCoordinatorError,
  IntegrationRegistryError,
  listIntegrationAudit,
  listIntegrationsForGroup,
  retryIntegrationEffect,
  revokeIntegration,
  setIntegrationDefaultLink,
  updateIntegrationRoute
} from "../../integrations/index.js";
import { CAPABILITIES } from "./discord-permissions.js";
import { ephemeralData, getOption } from "./common.js";
import { twitchPublicUrl } from "../twitch/environment.js";

function compactDiagnosticText(value, maxLength = 120) {
  return String(value ?? "unknown")
    .replaceAll("`", "'")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function discordIntegrationGroup(interaction) {
  return {
    platform: "discord",
    kind: "guild",
    id: interaction.guild_id
  };
}

function discordIntegrationActor(interaction) {
  return {
    platform: "discord",
    id: interaction.member?.user?.id ?? interaction.user?.id,
    claims: []
  };
}

async function integrationCommandRequest(operation) {
  try {
    return { result: await operation(), userFacingError: null };
  } catch (error) {
    if (
      (error instanceof IntegrationRegistryError ||
       error instanceof IntegrationCoordinatorError) &&
      error.status < 500
    ) {
      return { result: null, userFacingError: error.message };
    }
    throw error;
  }
}

const INTEGRATION_ROUTE_CHOICES = Object.freeze([
  {
    name: "Discord announcements to Twitch chat",
    value: INTEGRATION_ROUTE_KINDS.DISCORD_ANNOUNCE_TO_TWITCH
  },
  {
    name: "Twitch announcements to Discord",
    value: INTEGRATION_ROUTE_KINDS.TWITCH_ANNOUNCE_TO_DISCORD
  },
  {
    name: "Twitch stream-online events to Discord",
    value: INTEGRATION_ROUTE_KINDS.TWITCH_STREAM_ONLINE_TO_DISCORD
  }
]);

function integrationIdOption() {
  return {
    name: "integration_id",
    description: "Integration ID from /integration_list",
    type: 3,
    required: true
  };
}

function routeSummary(route) {
  const destination = route.targetGroup.platform === "discord"
    ? ` → <#${route.destination.channelId}>`
    : "";
  return `• ${route.enabled ? "enabled" : "disabled"} — ` +
    `\`${compactDiagnosticText(route.kind, 80)}\`${destination}`;
}

function countSummary(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "none"
    : entries.map(([state, total]) => `${state}: ${total}`).join(", ");
}

function twitchMemberDescription(integration) {
  const member = integration.members.find(({ group }) => group.platform === "twitch");
  if (!member) return "unknown Twitch channel";
  const label = compactDiagnosticText(member.label, 64);
  return member.label
    ? `Twitch channel \`${label}\` (\`${member.group.id}\`)`
    : `Twitch channel \`${member.group.id}\``;
}

export const integrationCommands = Object.freeze({
  "integration_link_twitch": {
    description: "Create a secure invitation to link a Twitch channel to this server.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    exec: async (interaction, env) => {
      const { result, userFacingError } = await integrationCommandRequest(() =>
        createIntegrationInvitation(env, {
          group: discordIntegrationGroup(interaction),
          actor: discordIntegrationActor(interaction),
          connectUrl: twitchPublicUrl(env, "/twitch/integrations/connect"),
          routes: defaultDiscordTwitchRoutes(interaction.channel_id)
        })
      );
      if (userFacingError) return ephemeralData(userFacingError);
      const expiresAt = Math.floor(result.expiresAtMs / 1000);
      return ephemeralData(
        `Open this one-use invitation to link a Twitch channel to this server:\n` +
        `<${result.invitationUrl}>\n` +
        `It expires <t:${expiresAt}:R>. Only the Twitch broadcaster can complete it. ` +
        `Stream notices and Twitch announcements will be sent to this channel, ` +
        `and authorized Discord announcements can be sent to the linked Twitch chat.`
      );
    }
  },

  "integration_list": {
    description: "List active cross-platform integrations for this server.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    exec: async (interaction, env) => {
      const group = discordIntegrationGroup(interaction);
      const { result, userFacingError } = await integrationCommandRequest(async () => {
        const [listed, selected] = await Promise.all([
          listIntegrationsForGroup(env, group, { limit: 10 }),
          getIntegrationDefaultLink(env, {
            sourceGroup: group,
            targetPlatform: "twitch"
          })
        ]);
        return { ...listed, defaultLink: selected.defaultLink };
      });
      if (userFacingError) return ephemeralData(userFacingError);
      if (result.total === 0) return ephemeralData("No active integrations.");
      const shown = result.integrations.map((integration) => {
        const defaultLabel = result.defaultLink?.integration.id === integration.id
          ? " — **default**"
          : "";
        return `• ${twitchMemberDescription(integration)} — id: \`${integration.id}\`` +
          defaultLabel;
      }).join("\n");
      return ephemeralData(
        `Active integrations (${result.total} total, showing ${result.integrations.length}):\n${shown}`
      );
    }
  },

  "integration_default_set": {
    description: "Set this server's default Twitch integration.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    options: [integrationIdOption()],
    exec: async (interaction, env) => {
      const integrationId = String(getOption(interaction, "integration_id") ?? "").trim();
      const sourceGroup = discordIntegrationGroup(interaction);
      const actor = discordIntegrationActor(interaction);
      const { result, userFacingError } = await integrationCommandRequest(async () => {
        const status = await getIntegrationManagementStatus(env, {
          integrationId,
          group: sourceGroup
        });
        const target = status.integration.members.find(
          ({ group }) => group.platform === "twitch"
        );
        if (!target) {
          throw new IntegrationRegistryError(
            "The integration does not contain a Twitch channel.",
            { status: 422, code: "integration_default_target_not_member" }
          );
        }
        const selected = await setIntegrationDefaultLink(env, {
          sourceGroup,
          targetGroup: target.group,
          integrationId,
          actor
        });
        return { ...selected, integration: status.integration };
      });
      if (userFacingError) return ephemeralData(userFacingError);
      return ephemeralData(
        result.changed
          ? `Set ${twitchMemberDescription(result.integration)} as this server's default Twitch link.`
          : `${twitchMemberDescription(result.integration)} is already this server's default Twitch link.`
      );
    }
  },

  "integration_status": {
    description: "Show link, route, and delivery status for an integration.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    options: [integrationIdOption()],
    exec: async (interaction, env) => {
      const integrationId = String(getOption(interaction, "integration_id") ?? "").trim();
      const { result, userFacingError } = await integrationCommandRequest(async () => {
        const registry = await getIntegrationManagementStatus(env, {
          integrationId,
          group: discordIntegrationGroup(interaction)
        });
        const delivery = await getIntegrationCoordinatorStatus(env, integrationId);
        return { registry, delivery };
      });
      if (userFacingError) return ephemeralData(userFacingError);
      const { integration, routes } = result.registry;
      const routeLines = routes.length > 0
        ? routes.map(routeSummary).join("\n")
        : "• no routes configured";
      return ephemeralData(
        `Integration \`${integration.id}\` is **${integration.status}**.\n` +
        `${twitchMemberDescription(integration)}\n` +
        `Executions: ${countSummary(result.delivery.executions)}\n` +
        `Effects: ${countSummary(result.delivery.effects)}\n` +
        `Routes:\n${routeLines}`
      );
    }
  },

  "integration_route_set": {
    description: "Enable, disable, or retarget an integration route.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    options: [
      integrationIdOption(),
      {
        name: "route",
        description: "Cross-platform route to update",
        type: 3,
        required: true,
        choices: INTEGRATION_ROUTE_CHOICES
      },
      {
        name: "enabled",
        description: "Whether this route should process new events",
        type: 5,
        required: true
      },
      {
        name: "channel",
        description: "New Discord destination for Twitch-to-Discord routes",
        type: 7,
        required: false
      }
    ],
    exec: async (interaction, env) => {
      const integrationId = String(getOption(interaction, "integration_id") ?? "").trim();
      const routeKind = String(getOption(interaction, "route") ?? "");
      const enabled = getOption(interaction, "enabled");
      const channelId = getOption(interaction, "channel");
      if (
        channelId !== undefined &&
        routeKind === INTEGRATION_ROUTE_KINDS.DISCORD_ANNOUNCE_TO_TWITCH
      ) {
        return ephemeralData("Discord-to-Twitch routes do not accept a Discord destination.");
      }
      const { result, userFacingError } = await integrationCommandRequest(() =>
        updateIntegrationRoute(env, {
          integrationId,
          group: discordIntegrationGroup(interaction),
          actor: discordIntegrationActor(interaction),
          routeKind,
          enabled,
          ...(channelId === undefined
            ? {}
            : { destination: { channelId: String(channelId) } })
        })
      );
      if (userFacingError) return ephemeralData(userFacingError);
      return ephemeralData(`Updated route:\n${routeSummary(result.route)}`);
    }
  },

  "integration_audit": {
    description: "Show recent management history for an integration.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    options: [integrationIdOption()],
    exec: async (interaction, env) => {
      const integrationId = String(getOption(interaction, "integration_id") ?? "").trim();
      const { result, userFacingError } = await integrationCommandRequest(() =>
        listIntegrationAudit(env, {
          integrationId,
          group: discordIntegrationGroup(interaction),
          limit: 10
        })
      );
      if (userFacingError) return ephemeralData(userFacingError);
      if (result.total === 0) return ephemeralData("No audit history for this integration.");
      const lines = result.entries.map((entry) => {
        const occurredAt = Math.floor(entry.occurredAtMs / 1000);
        const actor = entry.actor
          ? ` by ${compactDiagnosticText(entry.actor.platform, 24)} actor ` +
            `\`${compactDiagnosticText(entry.actor.id, 64)}\``
          : "";
        return `• <t:${occurredAt}:F> — \`${compactDiagnosticText(entry.event, 80)}\`${actor}`;
      }).join("\n");
      return ephemeralData(
        `Audit history (${result.total} total, showing ${result.entries.length}):\n${lines}`
      );
    }
  },

  "integration_dead_letters": {
    description: "Inspect failed cross-platform deliveries for an integration.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    options: [integrationIdOption()],
    exec: async (interaction, env) => {
      const integrationId = String(getOption(interaction, "integration_id") ?? "").trim();
      const { result, userFacingError } = await integrationCommandRequest(async () => {
        await getIntegrationManagementStatus(env, {
          integrationId,
          group: discordIntegrationGroup(interaction)
        });
        return getIntegrationDeadLetters(env, integrationId, { limit: 10 });
      });
      if (userFacingError) return ephemeralData(userFacingError);
      if (result.total === 0) return ephemeralData("No dead-lettered deliveries.");
      const lines = result.effects.map((effect) =>
        `• \`${compactDiagnosticText(effect.kind, 64)}\` — attempts: ${effect.attempts}` +
        ` — \`${compactDiagnosticText(effect.lastError?.code, 64)}\`` +
        ` — key: \`${compactDiagnosticText(effect.idempotencyKey, 80)}\``
      ).join("\n");
      return ephemeralData(
        `Dead letters (${result.total} total, showing ${result.effects.length}):\n${lines}`
      );
    }
  },

  "integration_retry_effect": {
    description: "Retry one dead-lettered cross-platform delivery.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    options: [
      integrationIdOption(),
      {
        name: "idempotency_key",
        description: "Effect key from /integration_dead_letters",
        type: 3,
        required: true
      }
    ],
    exec: async (interaction, env) => {
      const integrationId = String(getOption(interaction, "integration_id") ?? "").trim();
      const idempotencyKey = String(getOption(interaction, "idempotency_key") ?? "").trim();
      const { userFacingError } = await integrationCommandRequest(async () => {
        const status = await getIntegrationManagementStatus(env, {
          integrationId,
          group: discordIntegrationGroup(interaction)
        });
        if (status.integration.status !== "active") {
          throw new IntegrationRegistryError("The integration is not active.", {
            status: 409,
            code: "integration_inactive"
          });
        }
        return retryIntegrationEffect(env, integrationId, idempotencyKey);
      });
      if (userFacingError) return ephemeralData(userFacingError);
      return ephemeralData(
        `Queued delivery \`${compactDiagnosticText(idempotencyKey, 80)}\` for retry.`
      );
    }
  },

  "integration_unlink": {
    description: "Unlink an integration from this server by integration ID.",
    guild: {
      capability: CAPABILITIES.INTEGRATION_MANAGE
    },
    deferred: true,
    options: [integrationIdOption()],
    exec: async (interaction, env) => {
      const integrationId = String(getOption(interaction, "integration_id") ?? "").trim();
      const { result, userFacingError } = await integrationCommandRequest(() =>
        revokeIntegration(env, {
          integrationId,
          group: discordIntegrationGroup(interaction),
          actor: discordIntegrationActor(interaction),
          reason: "discord_unlinked"
        })
      );
      if (userFacingError) return ephemeralData(userFacingError);
      return ephemeralData(
        result.alreadyRevoked
          ? `Integration \`${integrationId}\` was already unlinked.`
          : `Unlinked integration \`${integrationId}\`.`
      );
    }
  }
});
