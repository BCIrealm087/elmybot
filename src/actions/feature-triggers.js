import { executeAction } from "./registry.js";
import {
  createEventActionInvocation,
  ROUTED_MESSAGE_EFFECT_KINDS,
  resolveRoutes,
  submitRoutedEffects
} from "../integrations/index.js";

function routedRuntime(featureRegistry, env, invocation, triggerKind, extra = {}) {
  return {
    ...extra,
    env,
    triggerKind,
    routeDefinitions: featureRegistry.routes,
    effectAdapters: featureRegistry.effectAdapters,
    routedMessageEffectKinds: ROUTED_MESSAGE_EFFECT_KINDS,
    resolveRoutes: async (routeKind) => {
      const routes = await resolveRoutes(env, invocation.origin.group, routeKind);
      if (typeof extra.onRoutesResolved === "function") {
        extra.onRoutesResolved(routeKind, routes);
      }
      return routes;
    }
  };
}

async function submitResult(env, invocation, result) {
  if (result.effects.length === 0) return;
  await submitRoutedEffects(env, {
    source: invocation.origin,
    sourceEventId: invocation.sourceEventId,
    correlationId: invocation.correlationId,
    effects: result.effects
  });
}

export async function executeFeatureEvent({
  featureRegistry,
  actionRegistry,
  event,
  env
}) {
  const binding = featureRegistry.events[event.kind];
  if (!binding) {
    throw new Error(`No feature action is registered for event \`${event.kind}\`.`);
  }
  const invocation = createEventActionInvocation({
    kind: binding.actionKind,
    origin: event.source,
    args: binding.mapPayload(event),
    sourceEventId: event.sourceEventId,
    correlationId: event.correlationId
  });
  const result = await executeAction(
    actionRegistry,
    invocation,
    routedRuntime(featureRegistry, env, invocation, "event")
  );
  await submitResult(env, invocation, result);
  return result;
}

export { routedRuntime, submitResult };
