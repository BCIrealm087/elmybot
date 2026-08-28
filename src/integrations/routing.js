import {
  createEffect,
  createIntegrationExecution
} from "./contracts.js";
import { submitIntegrationExecution } from "./coordinator.js";
import { resolveIntegrationRoutes } from "./registry.js";
import { DISCORD_EFFECT_KINDS } from "../platforms/discord/integration-effects.js";

export async function resolveRoutes(env, sourceGroup, routeKind) {
  const result = await resolveIntegrationRoutes(env, {
    sourceGroup,
    routeKind
  });
  return result.routes;
}

export function createDiscordMessageEffects(routes, {
  content,
  sourceEventId,
  correlationId
}) {
  return routes.map((route) => createEffect({
    kind: DISCORD_EFFECT_KINDS.SEND_MESSAGE,
    target: {
      group: route.targetGroup,
      destination: route.destination
    },
    payload: { content },
    integration: route.integration,
    idempotencyKey:
      `${sourceEventId}:integration:${route.integration.id}:route:${route.kind}`,
    correlationId,
    causationId: sourceEventId
  }));
}

export async function submitRoutedEffects(env, {
  source,
  sourceEventId,
  correlationId,
  effects
}) {
  const byIntegration = new Map();
  for (const effect of effects) {
    const integrationId = effect.integration?.id;
    if (!integrationId) {
      throw new TypeError("Routed effects must belong to an integration.");
    }
    const grouped = byIntegration.get(integrationId) ?? [];
    grouped.push(effect);
    byIntegration.set(integrationId, grouped);
  }

  return Promise.all([...byIntegration.entries()].map(
    ([integrationId, integrationEffects]) => submitIntegrationExecution(
      env,
      createIntegrationExecution({
        integration: { id: integrationId },
        source,
        sourceEventId,
        correlationId,
        effects: integrationEffects
      })
    )
  ));
}
