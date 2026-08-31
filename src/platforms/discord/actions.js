import { actionRegistry, executeAction } from "../../actions/index.js";
import { featureRegistry } from "../../features/index.js";
import { createCommandInvocation } from "../../integrations/contracts.js";
import {
  ROUTED_MESSAGE_EFFECT_KINDS,
  resolveRoutes,
  submitRoutedEffects
} from "../../integrations/index.js";
import { createFeatureServiceRuntime } from "../../framework/service-runtime.js";

function discordOriginGroup(interaction) {
  if (typeof interaction.guild_id === "string" && interaction.guild_id.length > 0) {
    return { platform: "discord", kind: "guild", id: interaction.guild_id };
  }
  return { platform: "discord", kind: "channel", id: interaction.channel_id };
}

function discordOriginActor(interaction) {
  return {
    platform: "discord",
    id: interaction.member?.user?.id ?? interaction.user?.id,
    claims: []
  };
}

export function createDiscordActionInvocation(interaction, kind, args = {}) {
  const sourceEventId = `discord:interaction:${interaction.id}`;
  return createCommandInvocation({
    kind,
    origin: {
      group: discordOriginGroup(interaction),
      actor: discordOriginActor(interaction)
    },
    args,
    sourceEventId,
    correlationId: sourceEventId
  });
}

export async function executeDiscordAction(
  interaction,
  kind,
  args = {},
  context = {}
) {
  const invocation = createDiscordActionInvocation(interaction, kind, args);
  const result = await executeAction(
    actionRegistry,
    invocation,
    {
      ...context,
      ...createFeatureServiceRuntime(context.env, invocation),
      routeDefinitions: featureRegistry.routes,
      effectAdapters: featureRegistry.effectAdapters,
      routedMessageEffectKinds: ROUTED_MESSAGE_EFFECT_KINDS,
      resolveRoutes: (routeKind) => resolveRoutes(
        context.env,
        invocation.origin.group,
        routeKind
      )
    }
  );
  if (result.effects.length > 0) {
    await submitRoutedEffects(context.env, {
      source: invocation.origin,
      sourceEventId: invocation.sourceEventId,
      correlationId: invocation.correlationId,
      effects: result.effects
    });
  }
  return result;
}

export function discordTextActionResponse(result) {
  const message = result?.output?.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("The action did not return a Discord text response.");
  }
  return { content: message };
}
