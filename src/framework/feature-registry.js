import {
  FEATURE_FRAMEWORK_API_VERSION,
  FeatureDefinitionError,
  isFeatureDefinition
} from "./define-feature.js";

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

function addUnique(target, key, value, description, code) {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new FeatureRegistryError(`Duplicate ${description}: \`${key}\`.`, {
      code
    });
  }
  target[key] = value;
}

export function createFeatureRegistry(features) {
  requireFeatureList(features);
  const featuresById = Object.create(null);
  const actions = Object.create(null);
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
    feature.actions.forEach((action, index) => addUnique(
      actions,
      actionKind(action, feature.id, index),
      action,
      "feature action kind",
      "duplicate_feature_action"
    ));
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

  return Object.freeze({
    apiVersion: FEATURE_FRAMEWORK_API_VERSION,
    features: Object.freeze([...features]),
    featuresById: Object.freeze(featuresById),
    actions: Object.freeze(actions),
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
