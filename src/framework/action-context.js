import { createEffect } from "../integrations/contracts.js";

export class FeatureContextError extends Error {
  constructor(message, { code = "feature_context_unavailable" } = {}) {
    super(message);
    this.name = "FeatureContextError";
    this.code = code;
  }
}

function requireMessage(value, name, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new FeatureContextError(
      `${name} must contain between 1 and ${maxLength} characters.`,
      { code: "feature_effect_payload_invalid" }
    );
  }
  return value;
}

function routedServices(action, invocation, runtimeContext) {
  const allowedRoutes = new Set(action.uses.routes);
  const allowedEffects = new Set(action.uses.effects);
  const routeDefinitions = runtimeContext.routeDefinitions ?? {};
  const effectAdapters = runtimeContext.effectAdapters ?? {};
  const routedMessageEffectKinds = runtimeContext.routedMessageEffectKinds ?? {};
  const resolvedRouteDefinitions = new WeakMap();

  async function resolve(routeKind) {
    if (!allowedRoutes.has(routeKind)) {
      throw new FeatureContextError(
        `Action \`${action.kind}\` did not declare route \`${routeKind}\`.`,
        { code: "feature_route_undeclared" }
      );
    }
    const definition = routeDefinitions[routeKind];
    if (!definition || typeof runtimeContext.resolveRoutes !== "function") {
      throw new FeatureContextError(`Feature route is unavailable: \`${routeKind}\`.`);
    }
    if (definition.sourcePlatform !== invocation.origin.group.platform) {
      throw new FeatureContextError(
        `Feature route \`${routeKind}\` cannot be resolved from this origin.`,
        { code: "feature_route_origin_unsupported" }
      );
    }
    const values = await runtimeContext.resolveRoutes(routeKind);
    if (!Array.isArray(values)) {
      throw new FeatureContextError(`Feature route resolver returned an invalid value.`);
    }
    return Object.freeze(values.map((route) => {
      if (
        route?.kind !== routeKind ||
        route?.sourceGroup?.key !== invocation.origin.group.key ||
        route?.targetGroup?.platform !== definition.targetPlatform
      ) {
        throw new FeatureContextError(
          `Feature route resolver returned an invalid \`${routeKind}\` route.`,
          { code: "feature_route_result_invalid" }
        );
      }
      const snapshot = Object.freeze({
        kind: route.kind,
        integration: route.integration,
        sourceGroup: route.sourceGroup,
        targetGroup: route.targetGroup,
        destination: route.destination
      });
      resolvedRouteDefinitions.set(snapshot, definition);
      return snapshot;
    }));
  }

  function createRoutedEffect(route, kind, payload) {
    const routeDefinition = resolvedRouteDefinitions.get(route);
    if (!routeDefinition) {
      throw new FeatureContextError(
        "Effects require a route resolved by this action invocation.",
        { code: "feature_effect_route_invalid" }
      );
    }
    if (!allowedEffects.has(kind)) {
      throw new FeatureContextError(
        `Action \`${action.kind}\` did not declare effect \`${kind}\`.`,
        { code: "feature_effect_undeclared" }
      );
    }
    const adapter = effectAdapters[kind];
    if (!adapter || adapter.platform !== routeDefinition.targetPlatform) {
      throw new FeatureContextError(
        `Effect \`${kind}\` cannot target this route.`,
        { code: "feature_effect_target_invalid" }
      );
    }
    return createEffect({
      kind,
      target: {
        group: route.targetGroup,
        destination: route.destination
      },
      payload,
      integration: route.integration,
      idempotencyKey:
        `${invocation.sourceEventId}:integration:${route.integration.id}:route:${route.kind}`,
      correlationId: invocation.correlationId,
      causationId: invocation.sourceEventId
    });
  }

  const discordMessage = (route, { content } = {}) => createRoutedEffect(
    route,
    routedMessageEffectKinds.discord,
    { content: requireMessage(content, "Discord message content", 2_000) }
  );
  const twitchChat = (route, { message } = {}) => createRoutedEffect(
    route,
    routedMessageEffectKinds.twitch,
    { message: requireMessage(message, "Twitch chat message", 500) }
  );

  return Object.freeze({
    routes: Object.freeze({ resolve }),
    effects: Object.freeze({
      routedMessage(route, { message } = {}) {
        const definition = resolvedRouteDefinitions.get(route);
        if (!definition) {
          throw new FeatureContextError(
            "Effects require a route resolved by this action invocation.",
            { code: "feature_effect_route_invalid" }
          );
        }
        if (definition.targetPlatform === "discord") {
          return discordMessage(route, { content: message });
        }
        if (definition.targetPlatform === "twitch") {
          return twitchChat(route, { message });
        }
        throw new FeatureContextError("The routed-message target is unsupported.");
      },
      discord: Object.freeze({ message: discordMessage }),
      twitch: Object.freeze({ chat: twitchChat })
    })
  });
}

function unavailable(name) {
  return () => {
    throw new FeatureContextError(`Feature context service is unavailable: \`${name}\`.`);
  };
}

function logger(runtimeContext, action, invocation) {
  const write = (level, event, metadata) => {
    if (typeof runtimeContext.log === "function") {
      runtimeContext.log(level, event, {
        ...metadata,
        featureId: action.featureId,
        actionKind: action.kind,
        platform: invocation.origin.group.platform,
        groupKey: invocation.origin.group.key,
        correlationId: invocation.correlationId
      });
    }
  };
  return Object.freeze({
    debug: (event, metadata = {}) => write("debug", event, metadata),
    info: (event, metadata = {}) => write("info", event, metadata),
    warn: (event, metadata = {}) => write("warn", event, metadata)
  });
}

export function createFeatureActionContext(action, invocation, runtimeContext = {}) {
  const clockNow = typeof runtimeContext.clock?.now === "function"
    ? runtimeContext.clock.now.bind(runtimeContext.clock)
    : () => new Date();
  const routed = routedServices(action, invocation, runtimeContext);
  return Object.freeze({
    apiVersion: 1,
    featureId: action.featureId,
    trigger: Object.freeze({ kind: runtimeContext.triggerKind ?? "command" }),
    origin: invocation.origin,
    sourceEventId: invocation.sourceEventId,
    correlationId: invocation.correlationId,
    clock: Object.freeze({
      now() {
        const value = clockNow();
        if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
          throw new FeatureContextError("Feature clock returned an invalid Date.");
        }
        return new Date(value.getTime());
      }
    }),
    random: Object.freeze({ integer: unavailable("random") }),
    routes: routed.routes,
    effects: routed.effects,
    config: Object.freeze({ get: unavailable("config") }),
    state: Object.freeze({
      get: unavailable("state"),
      set: unavailable("state"),
      delete: unavailable("state"),
      increment: unavailable("state")
    }),
    log: logger(runtimeContext, action, invocation)
  });
}
