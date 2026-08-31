import {
  FeatureDefinitionError,
  isFeatureDefinition
} from "./define-feature.js";
import { frameworkApiVersion } from "./api-version.js";
import {
  bindFeatureActionDefinition,
  isFeatureActionDefinition,
  validateFeatureActionCapability
} from "./action-definition.js";
import {
  ACTION_COMMAND_TYPE,
  isCommandDefinition,
  NATIVE_COMMAND_TYPE,
  SCHEDULED_ACTION_COMMAND_TYPE,
  validateRegisteredCapability
} from "./command-common.js";
import { isRouteDefinition } from "./route-definition.js";
import { FEATURE_RUNTIME_SERVICES } from "./service-runtime.js";
import {
  isEventActionDefinition,
  isScheduledActionDefinition
} from "./trigger-definitions.js";

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const PLATFORMS = Object.freeze(["discord", "twitch"]);

export class FeatureRegistryError extends Error {
  constructor(message, { code = "feature_registry_error" } = {}) {
    super(message);
    this.name = "FeatureRegistryError";
    this.code = code;
  }
}

function requireFeatureList(features) {
  if (!Array.isArray(features)) {
    throw new FeatureRegistryError("Installed features must be an array.", {
      code: "feature_catalog_invalid"
    });
  }
  for (const [index, feature] of features.entries()) {
    if (!isFeatureDefinition(feature)) {
      throw new FeatureDefinitionError(
        "must be created with defineFeature().",
        { path: `Installed features[${index}]` }
      );
    }
  }
}

function actionKind(action, featureId, index) {
  if (!isFeatureActionDefinition(action)) {
    throw new FeatureRegistryError(
      `Feature \`${featureId}\` action at index ${index} must use defineAction().`,
      { code: "feature_action_invalid" }
    );
  }
  const kind = action?.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    throw new FeatureRegistryError(
      `Feature \`${featureId}\` action at index ${index} has no kind.`,
      { code: "feature_action_invalid" }
    );
  }
  return kind;
}

function commandName(command, platform, featureId, index) {
  if (!isCommandDefinition(command, platform)) {
    throw new FeatureRegistryError(
      `Feature \`${featureId}\` ${platform} command at index ${index} must use ` +
      `a ${platform} command helper.`,
      { code: "feature_command_invalid" }
    );
  }
  const name = command?.name;
  if (typeof name !== "string" || !COMMAND_NAME_PATTERN.test(name)) {
    throw new FeatureRegistryError(
      `Feature \`${featureId}\` ${platform} command at index ${index} ` +
      "has an invalid name.",
      { code: "feature_command_invalid" }
    );
  }
  return name;
}

function routeKind(route, featureId, index) {
  if (!isRouteDefinition(route)) {
    throw new FeatureRegistryError(
      `Feature \`${featureId}\` route at index ${index} must use defineRoute().`,
      { code: "feature_route_invalid" }
    );
  }
  return route.kind;
}

function eventKind(event, featureId, index) {
  if (!isEventActionDefinition(event)) {
    throw new FeatureRegistryError(
      `Feature \`${featureId}\` event at index ${index} must use defineEventAction().`,
      { code: "feature_event_invalid" }
    );
  }
  return event.eventKind;
}

function scheduleKind(schedule, featureId, index) {
  if (!isScheduledActionDefinition(schedule)) {
    throw new FeatureRegistryError(
      `Feature \`${featureId}\` schedule at index ${index} must use ` +
      "defineScheduledAction().",
      { code: "feature_schedule_invalid" }
    );
  }
  return schedule.kind;
}

function addUnique(target, key, value, description, code) {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new FeatureRegistryError(`Duplicate ${description}: \`${key}\`.`, {
      code
    });
  }
  target[key] = value;
}

function collectEffectAdapters(effectAdapters) {
  const collected = Object.create(null);
  for (const platform of PLATFORMS) {
    const platformAdapters = effectAdapters?.[platform] ?? {};
    if (
      typeof platformAdapters !== "object" ||
      platformAdapters === null ||
      Array.isArray(platformAdapters)
    ) {
      throw new FeatureRegistryError(
        `Effect adapters for ${platform} must be an object.`,
        { code: "feature_effect_adapter_invalid" }
      );
    }
    for (const [kind, adapter] of Object.entries(platformAdapters)) {
      if (
        typeof adapter !== "object" ||
        adapter === null ||
        adapter.platform !== platform ||
        typeof adapter.validateEffect !== "function" ||
        typeof adapter.deliver !== "function"
      ) {
        throw new FeatureRegistryError(
          `Effect adapter \`${kind}\` is invalid.`,
          { code: "feature_effect_adapter_invalid" }
        );
      }
      addUnique(
        collected,
        kind,
        adapter,
        "effect adapter kind",
        "duplicate_feature_effect_adapter"
      );
    }
  }
  return collected;
}

function collectAvailableServices(availableServices) {
  if (!Array.isArray(availableServices)) {
    throw new FeatureRegistryError("Available feature services must be an array.", {
      code: "feature_services_invalid"
    });
  }
  const supported = new Set(FEATURE_RUNTIME_SERVICES);
  if (
    availableServices.some((service) => !supported.has(service)) ||
    new Set(availableServices).size !== availableServices.length
  ) {
    throw new FeatureRegistryError("Available feature services are invalid.", {
      code: "feature_services_invalid"
    });
  }
  return new Set(availableServices);
}

export function createFeatureRegistry(features, {
  effectAdapters = {},
  availableServices = []
} = {}) {
  requireFeatureList(features);
  const featuresById = Object.create(null);
  const rawActions = Object.create(null);
  const actions = Object.create(null);
  const routes = Object.create(null);
  const events = Object.create(null);
  const schedules = Object.create(null);
  const adapters = collectEffectAdapters(effectAdapters);
  const services = collectAvailableServices(availableServices);
  const commands = Object.fromEntries(PLATFORMS.map((platform) => [
    platform,
    Object.create(null)
  ]));

  for (const feature of features) {
    addUnique(
      featuresById,
      feature.id,
      feature,
      "feature ID",
      "duplicate_feature_id"
    );
    feature.actions.forEach((action, index) => {
      const kind = actionKind(action, feature.id, index);
      try {
        validateFeatureActionCapability(action);
      } catch (cause) {
        throw new FeatureRegistryError(cause.message, {
          code: "feature_action_capability_unknown"
        });
      }
      addUnique(
        rawActions,
        kind,
        { action, featureId: feature.id },
        "feature action kind",
        "duplicate_feature_action"
      );
    });
    feature.routes.forEach((route, index) => addUnique(
      routes,
      routeKind(route, feature.id, index),
      route,
      "feature route kind",
      "duplicate_feature_route"
    ));
    feature.events.forEach((event, index) => addUnique(
      events,
      eventKind(event, feature.id, index),
      event,
      "feature event kind",
      "duplicate_feature_event"
    ));
    feature.schedules.forEach((schedule, index) => addUnique(
      schedules,
      scheduleKind(schedule, feature.id, index),
      schedule,
      "feature schedule kind",
      "duplicate_feature_schedule"
    ));
    if (PLATFORMS.some((platform) => feature.effectAdapters[platform].length > 0)) {
      throw new FeatureRegistryError(
        `Feature \`${feature.id}\` declares feature-owned effect adapters, which are ` +
        "not available in the current framework stage.",
        { code: "feature_effect_adapter_unavailable" }
      );
    }
    for (const platform of PLATFORMS) {
      feature.commands[platform].forEach((command, index) => addUnique(
        commands[platform],
        commandName(command, platform, feature.id, index),
        command,
        `${platform} feature command`,
        "duplicate_feature_command"
      ));
    }
  }

  for (const [kind, { action, featureId }] of Object.entries(rawActions)) {
    const unavailableServices = action.uses.services.filter(
      (service) => !services.has(service)
    );
    if (unavailableServices.length > 0) {
      throw new FeatureRegistryError(
        `Feature action \`${kind}\` requires unavailable service ` +
        `\`${unavailableServices[0]}\`.`,
        { code: "feature_action_dependency_unavailable" }
      );
    }
    const routeTargetPlatforms = new Set();
    for (const usedRouteKind of action.uses.routes) {
      const route = routes[usedRouteKind];
      if (!route) {
        throw new FeatureRegistryError(
          `Feature action \`${kind}\` refers to an uninstalled route ` +
          `\`${usedRouteKind}\`.`,
          { code: "feature_action_route_unknown" }
        );
      }
      if (!action.supportedOrigins.includes(route.sourcePlatform)) {
        throw new FeatureRegistryError(
          `Feature action \`${kind}\` cannot use route \`${usedRouteKind}\` from an ` +
          "unsupported origin.",
          { code: "feature_action_route_origin_unsupported" }
        );
      }
      routeTargetPlatforms.add(route.targetPlatform);
    }
    for (const effectKind of action.uses.effects) {
      const adapter = adapters[effectKind];
      if (!adapter) {
        throw new FeatureRegistryError(
          `Feature action \`${kind}\` refers to an unavailable effect ` +
          `\`${effectKind}\`.`,
          { code: "feature_action_effect_unknown" }
        );
      }
      if (!routeTargetPlatforms.has(adapter.platform)) {
        throw new FeatureRegistryError(
          `Feature action \`${kind}\` effect \`${effectKind}\` has no compatible ` +
          "declared route.",
          { code: "feature_action_effect_route_missing" }
        );
      }
    }
    actions[kind] = bindFeatureActionDefinition(action, featureId);
  }

  for (const event of Object.values(events)) {
    const action = actions[event.actionKind];
    if (!action) {
      throw new FeatureRegistryError(
        `Feature event \`${event.eventKind}\` refers to an uninstalled action ` +
        `\`${event.actionKind}\`.`,
        { code: "feature_event_action_unknown" }
      );
    }
    const sourcePlatform = event.eventKind.split(".")[0];
    if (!action.supportedOrigins.includes(sourcePlatform)) {
      throw new FeatureRegistryError(
        `Feature event \`${event.eventKind}\` refers to an action that does not ` +
        `support ${sourcePlatform}.`,
        { code: "feature_event_action_origin_unsupported" }
      );
    }
    if (action.capability !== null) {
      throw new FeatureRegistryError(
        `Feature event \`${event.eventKind}\` cannot invoke a protected action ` +
        "without a trusted event authorization policy.",
        { code: "feature_event_action_protected" }
      );
    }
    if (action.cooldown?.scope === "actor") {
      throw new FeatureRegistryError(
        `Feature event \`${event.eventKind}\` cannot invoke an actor-cooldown action.`,
        { code: "feature_event_actor_cooldown_unsupported" }
      );
    }
  }

  for (const schedule of Object.values(schedules)) {
    const action = actions[schedule.actionKind];
    if (!action) {
      throw new FeatureRegistryError(
        `Feature schedule \`${schedule.kind}\` refers to an uninstalled action ` +
        `\`${schedule.actionKind}\`.`,
        { code: "feature_schedule_action_unknown" }
      );
    }
    if (!action.supportedOrigins.includes(schedule.sourcePlatform)) {
      throw new FeatureRegistryError(
        `Feature schedule \`${schedule.kind}\` refers to an action that does not ` +
        `support ${schedule.sourcePlatform}.`,
        { code: "feature_schedule_action_origin_unsupported" }
      );
    }
  }

  for (const [platform, definitions] of Object.entries(commands)) {
    for (const command of Object.values(definitions)) {
      if (command.mode === ACTION_COMMAND_TYPE) {
        const action = actions[command.actionKind];
        if (!action) {
          throw new FeatureRegistryError(
            `${platform} command \`${command.name}\` refers to an uninstalled action ` +
            `\`${command.actionKind}\`.`,
            { code: "feature_command_action_unknown" }
          );
        }
        if (!action.supportedOrigins.includes(platform)) {
          throw new FeatureRegistryError(
            `${platform} command \`${command.name}\` refers to an action that does not ` +
            `support ${platform}.`,
            { code: "feature_command_action_origin_unsupported" }
          );
        }
        if (
          platform === "discord" &&
          action.capability !== null &&
          command.availability !== "guild"
        ) {
          throw new FeatureRegistryError(
            `Protected Discord command \`${command.name}\` must be guild-only.`,
            { code: "feature_command_protected_global" }
          );
        }
      } else if (command.mode === SCHEDULED_ACTION_COMMAND_TYPE) {
        const schedule = schedules[command.scheduleKind];
        if (!schedule) {
          throw new FeatureRegistryError(
            `${platform} command \`${command.name}\` refers to an uninstalled schedule ` +
            `\`${command.scheduleKind}\`.`,
            { code: "feature_command_schedule_unknown" }
          );
        }
        if (schedule.sourcePlatform !== platform) {
          throw new FeatureRegistryError(
            `${platform} command \`${command.name}\` refers to a schedule for ` +
            `${schedule.sourcePlatform}.`,
            { code: "feature_command_schedule_platform_unsupported" }
          );
        }
        if (platform !== "discord" || command.availability !== "guild") {
          throw new FeatureRegistryError(
            `Scheduled command \`${command.name}\` must be a guild-only Discord command.`,
            { code: "feature_command_schedule_availability_invalid" }
          );
        }
      } else if (command.mode === NATIVE_COMMAND_TYPE) {
        try {
          validateRegisteredCapability(command.capability);
        } catch (cause) {
          throw new FeatureRegistryError(cause.message, {
            code: "feature_command_capability_unknown"
          });
        }
        if (
          platform === "discord" &&
          command.capability !== null &&
          command.availability !== "guild"
        ) {
          throw new FeatureRegistryError(
            `Protected Discord command \`${command.name}\` must be guild-only.`,
            { code: "feature_command_protected_global" }
          );
        }
      }
    }
  }

  return Object.freeze({
    apiVersion: frameworkApiVersion,
    features: Object.freeze([...features]),
    featuresById: Object.freeze(featuresById),
    actions: Object.freeze(actions),
    routes: Object.freeze(routes),
    events: Object.freeze(events),
    schedules: Object.freeze(schedules),
    services: Object.freeze([...services].sort()),
    effectAdapters: Object.freeze(adapters),
    commands: Object.freeze(Object.fromEntries(PLATFORMS.map((platform) => [
      platform,
      Object.freeze(commands[platform])
    ])))
  });
}

export function mergeCommandDefinitions(platform, ...commandSets) {
  if (!PLATFORMS.includes(platform)) {
    throw new FeatureRegistryError(
      `Unsupported command platform: \`${platform}\`.`,
      { code: "command_platform_unsupported" }
    );
  }
  const merged = Object.create(null);
  for (const [setIndex, commandSet] of commandSets.entries()) {
    if (
      typeof commandSet !== "object" ||
      commandSet === null ||
      Array.isArray(commandSet)
    ) {
      throw new FeatureRegistryError(
        `${platform} command set at index ${setIndex} must be an object.`,
        { code: "command_set_invalid" }
      );
    }
    for (const [name, definition] of Object.entries(commandSet)) {
      if (!COMMAND_NAME_PATTERN.test(name)) {
        throw new FeatureRegistryError(
          `Invalid ${platform} command name: \`${name}\`.`,
          { code: "command_name_invalid" }
        );
      }
      addUnique(
        merged,
        name,
        definition,
        `${platform} command name`,
        "duplicate_command_name"
      );
    }
  }
  return Object.freeze(merged);
}
