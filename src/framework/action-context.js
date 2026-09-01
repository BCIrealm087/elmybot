import {
  createEffect,
  createIntegrationRef,
  createPlatformGroupRef
} from "../integrations/contracts.js";
import { frameworkApiVersion } from "./api-version.js";
import { isRegisteredCapability } from "./access.js";

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

function requireFeatureKey(key) {
  if (typeof key !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(key)) {
    throw new FeatureContextError("Feature storage key is invalid.", {
      code: "feature_storage_key_invalid"
    });
  }
  return key;
}

function requireCounterSubject(subject) {
  if (typeof subject !== "string" || subject.length === 0 || subject.length > 300) {
    throw new FeatureContextError(
      "Bounded counter subjects must contain between 1 and 300 characters.",
      { code: "feature_counter_subject_invalid" }
    );
  }
  return subject;
}

function boundedCounterDescriptor(name, subject, options = {}) {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new FeatureContextError("Bounded counter options must be an object.", {
      code: "feature_counter_bounds_invalid"
    });
  }
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const initial = options.initial ?? min;
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    !Number.isSafeInteger(initial) ||
    min > max ||
    initial < min ||
    initial > max
  ) {
    throw new FeatureContextError(
      "Bounded counter min, max, and initial values must be safe integers with " +
      "min <= initial <= max.",
      { code: "feature_counter_bounds_invalid" }
    );
  }
  return Object.freeze({
    name: requireFeatureKey(name),
    subject: requireCounterSubject(subject),
    min,
    max,
    initial
  });
}

function requireCounterAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) {
    throw new FeatureContextError(
      "Bounded counter amounts must be integers between 1 and 1000000.",
      { code: "feature_counter_amount_invalid" }
    );
  }
  return amount;
}

function boundedCounter(
  action,
  runtimeContext,
  service,
  serviceArguments,
  name,
  subject,
  options
) {
  requireDeclaredService(action, service);
  const descriptor = boundedCounterDescriptor(name, subject, options);
  const run = (operation, amount) =>
    serviceMethod(action, runtimeContext, service, "boundedCounter")(
      ...serviceArguments,
      descriptor,
      operation,
      amount
    );
  return Object.freeze({
    get: () => run("get"),
    increment: (amount = 1) => run("increment", requireCounterAmount(amount)),
    decrement: (amount = 1) => run("decrement", requireCounterAmount(amount)),
    reset: () => run("reset")
  });
}

function requireDeclaredService(action, service) {
  if (!action.uses.services.includes(service)) {
    throw new FeatureContextError(
      `Action \`${action.kind}\` did not declare service \`${service}\`.`,
      { code: "feature_service_undeclared" }
    );
  }
}

function serviceMethod(action, runtimeContext, service, method) {
  return (...args) => {
    requireDeclaredService(action, service);
    const implementation = runtimeContext.featureServices?.[service]?.[method];
    if (typeof implementation !== "function") return unavailable(service)();
    return implementation(action.featureId, ...args);
  };
}

function randomInteger(action, runtimeContext, { min, max } = {}) {
  requireDeclaredService(action, "random");
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min > max ||
    !Number.isSafeInteger(max - min + 1)
  ) {
    throw new FeatureContextError(
      "Random integer bounds must be safe integers with min no greater than max.",
      { code: "feature_random_bounds_invalid" }
    );
  }
  const implementation = runtimeContext.random?.integer;
  const value = typeof implementation === "function"
    ? implementation({ min, max })
    : Math.floor(Math.random() * (max - min + 1)) + min;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new FeatureContextError("Feature random service returned an invalid integer.", {
      code: "feature_random_result_invalid"
    });
  }
  return value;
}

async function authorizationAllows(action, invocation, runtimeContext, capability) {
  requireDeclaredService(action, "authorization");
  if (!isRegisteredCapability(capability)) {
    throw new FeatureContextError("Feature authorization capability is invalid.", {
      code: "feature_authorization_capability_invalid"
    });
  }
  if (typeof runtimeContext.authorize !== "function") {
    throw new FeatureContextError(
      "Feature context service is unavailable: `authorization`.",
      { code: "feature_authorization_unavailable" }
    );
  }
  const allowed = await runtimeContext.authorize({ capability, invocation });
  if (typeof allowed !== "boolean") {
    throw new FeatureContextError("Feature authorization returned an invalid result.", {
      code: "feature_authorization_result_invalid"
    });
  }
  return allowed;
}

async function defaultLink(
  action,
  invocation,
  runtimeContext,
  resolvedDefaultLinks,
  targetPlatform
) {
  requireDeclaredService(action, "links");
  if (
    !["discord", "twitch"].includes(targetPlatform) ||
    targetPlatform === invocation.origin.group.platform
  ) {
    throw new FeatureContextError(
      "A default link must target another supported platform.",
      { code: "feature_link_target_invalid" }
    );
  }
  const implementation = runtimeContext.featureServices?.links?.default;
  if (typeof implementation !== "function") return unavailable("links")();
  const value = await implementation(action.featureId, targetPlatform);
  if (value === null) return null;

  let integration;
  let sourceGroup;
  let targetGroup;
  try {
    integration = createIntegrationRef(value?.integration);
    sourceGroup = createPlatformGroupRef(value?.sourceGroup);
    targetGroup = createPlatformGroupRef(value?.targetGroup);
  } catch {
    throw new FeatureContextError(
      "Feature default-link resolver returned an invalid value.",
      { code: "feature_link_result_invalid" }
    );
  }
  if (
    sourceGroup.key !== invocation.origin.group.key ||
    targetGroup.platform !== targetPlatform
  ) {
    throw new FeatureContextError(
      "Feature default-link resolver returned an invalid value.",
      { code: "feature_link_result_invalid" }
    );
  }
  const snapshot = Object.freeze({ integration, sourceGroup, targetGroup });
  resolvedDefaultLinks.add(snapshot);
  return snapshot;
}

function integrationStateScope(
  action,
  runtimeContext,
  resolvedDefaultLinks,
  link
) {
  requireDeclaredService(action, "integrationState");
  if (!resolvedDefaultLinks.has(link)) {
    throw new FeatureContextError(
      "Integration state requires a default link resolved by this action invocation.",
      { code: "feature_integration_state_link_invalid" }
    );
  }
  const call = (method, ...args) =>
    serviceMethod(action, runtimeContext, "integrationState", method)(link, ...args);
  return Object.freeze({
    get: (key) => call("get", requireFeatureKey(key)),
    set: (key, value) => call("set", requireFeatureKey(key), value),
    delete: (key) => call("delete", requireFeatureKey(key)),
    increment: (key, amount = 1) => call(
      "increment",
      requireFeatureKey(key),
      amount
    ),
    boundedCounter: (name, subject, options) => boundedCounter(
      action,
      runtimeContext,
      "integrationState",
      [link],
      name,
      subject,
      options
    )
  });
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
  const resolvedDefaultLinks = new WeakSet();
  return Object.freeze({
    apiVersion: frameworkApiVersion,
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
    random: Object.freeze({
      integer: (bounds) => randomInteger(action, runtimeContext, bounds)
    }),
    authorization: Object.freeze({
      allows: (capability) => authorizationAllows(
        action,
        invocation,
        runtimeContext,
        capability
      )
    }),
    links: Object.freeze({
      default: (targetPlatform) => defaultLink(
        action,
        invocation,
        runtimeContext,
        resolvedDefaultLinks,
        targetPlatform
      )
    }),
    integrationState: Object.freeze({
      for: (link) => integrationStateScope(
        action,
        runtimeContext,
        resolvedDefaultLinks,
        link
      )
    }),
    routes: routed.routes,
    effects: routed.effects,
    config: Object.freeze({
      get: (key) => serviceMethod(action, runtimeContext, "config", "get")(
        requireFeatureKey(key)
      )
    }),
    state: Object.freeze({
      get: (key) => serviceMethod(action, runtimeContext, "state", "get")(
        requireFeatureKey(key)
      ),
      set: (key, value) => serviceMethod(action, runtimeContext, "state", "set")(
        requireFeatureKey(key),
        value
      ),
      delete: (key) => serviceMethod(action, runtimeContext, "state", "delete")(
        requireFeatureKey(key)
      ),
      increment: (key, amount = 1) =>
        serviceMethod(action, runtimeContext, "state", "increment")(
          requireFeatureKey(key),
          amount
        ),
      boundedCounter: (name, subject, options) => boundedCounter(
        action,
        runtimeContext,
        "state",
        [],
        name,
        subject,
        options
      )
    }),
    log: logger(runtimeContext, action, invocation)
  });
}
