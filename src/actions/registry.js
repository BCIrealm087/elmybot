import {
  createActionDefinition,
  createActionResult,
  createCommandInvocation,
  createEventActionInvocation,
  INTEGRATION_CONTRACT_SCHEMA_VERSION,
  IntegrationContractError
} from "../integrations/contracts.js";
import { SchemaValidationError } from "../framework/argument-schema.js";
import { createFeatureActionContext } from "../framework/action-context.js";
import {
  isBoundFeatureActionDefinition
} from "../framework/action-definition.js";

export class ActionRegistryError extends Error {
  constructor(message, {
    status = 400,
    code = "action_registry_error",
    cause
  } = {}) {
    super(message, { cause });
    this.name = "ActionRegistryError";
    this.status = status;
    this.code = code;
  }
}

export function createActionRegistry(...actionSets) {
  const registry = Object.create(null);
  for (const actionSet of actionSets) {
    for (const [kind, definition] of Object.entries(actionSet)) {
      if (registry[kind]) {
        throw new Error(`Duplicate action kind: \`${kind}\`.`);
      }
      const normalized = isBoundFeatureActionDefinition(definition)
        ? definition
        : createActionDefinition(definition);
      if (normalized.kind !== kind) {
        throw new Error(
          `Action registry key \`${kind}\` does not match definition kind ` +
          `\`${normalized.kind}\`.`
        );
      }
      registry[kind] = normalized;
    }
  }
  return Object.freeze(registry);
}

function normalizedInvocation(input, triggerKind) {
  if (input?.schemaVersion !== INTEGRATION_CONTRACT_SCHEMA_VERSION) {
    throw new ActionRegistryError("Unsupported command invocation schema version.", {
      status: 422,
      code: "action_invocation_schema_unsupported"
    });
  }
  try {
    return triggerKind === "event"
      ? createEventActionInvocation(input)
      : createCommandInvocation(input);
  } catch (cause) {
    if (cause instanceof IntegrationContractError) {
      throw new ActionRegistryError(cause.message, {
        status: 422,
        code: "action_invocation_invalid",
        cause
      });
    }
    throw cause;
  }
}

function normalizedResult(value, actionKind) {
  try {
    return createActionResult(value);
  } catch (cause) {
    if (cause instanceof IntegrationContractError) {
      throw new ActionRegistryError(
        `Action \`${actionKind}\` returned an invalid result.`,
        { status: 500, code: "action_result_invalid", cause }
      );
    }
    throw cause;
  }
}

function validateFeatureEffects(action, result, context) {
  const declared = new Set(action.uses.effects);
  for (const effect of result.effects) {
    if (!declared.has(effect.kind)) {
      throw new ActionRegistryError(
        `Action \`${action.kind}\` returned undeclared effect \`${effect.kind}\`.`,
        { status: 500, code: "feature_action_effect_undeclared" }
      );
    }
    const adapter = context.effectAdapters?.[effect.kind];
    if (!adapter || adapter.platform !== effect.target.group.platform) {
      throw new ActionRegistryError(
        `Action \`${action.kind}\` returned an effect without a compatible adapter.`,
        { status: 500, code: "feature_action_effect_adapter_invalid" }
      );
    }
    if (effect.integration === null) {
      throw new ActionRegistryError(
        `Action \`${action.kind}\` returned an unrouted effect.`,
        { status: 500, code: "feature_action_effect_unrouted" }
      );
    }
  }
}

export async function executeAction(registry, input, context = {}) {
  const triggerKind = context.triggerKind ?? "command";
  if (!["command", "event", "schedule"].includes(triggerKind)) {
    throw new ActionRegistryError("Unsupported action trigger kind.", {
      status: 500,
      code: "action_trigger_unsupported"
    });
  }
  let invocation = normalizedInvocation(input, triggerKind);
  const action = registry[invocation.kind];
  if (!action) {
    throw new ActionRegistryError(
      `No action is registered for \`${invocation.kind}\`.`,
      { status: 404, code: "action_not_found" }
    );
  }
  if (!action.supportedOrigins.includes(invocation.origin.group.platform)) {
    throw new ActionRegistryError(
      `Action \`${action.kind}\` does not support ` +
      `\`${invocation.origin.group.platform}\` commands.`,
      { status: 422, code: "action_origin_unsupported" }
    );
  }

  if (isBoundFeatureActionDefinition(action)) {
    try {
      const args = action.input.parse(invocation.args, { path: "arguments" });
      invocation = Object.freeze({ ...invocation, args });
    } catch (cause) {
      if (cause instanceof SchemaValidationError) {
        throw new ActionRegistryError(cause.message, {
          status: 422,
          code: "action_arguments_invalid",
          cause
        });
      }
      throw cause;
    }
  }

  if (action.capability !== null) {
    if (typeof context.authorize !== "function") {
      throw new ActionRegistryError(
        `Action \`${action.kind}\` requires an authorization policy.`,
        { status: 500, code: "action_authorizer_missing" }
      );
    }
    const authorized = await context.authorize({
      capability: action.capability,
      invocation
    });
    if (authorized !== true) {
      throw new ActionRegistryError("The actor is not authorized for this action.", {
        status: 403,
        code: "action_forbidden"
      });
    }
  }

  const featureAction = isBoundFeatureActionDefinition(action);
  const value = featureAction
    ? await action.execute(
      createFeatureActionContext(action, invocation, context),
      invocation.args
    )
    : await action.execute(invocation, Object.freeze({ ...context }));
  const result = normalizedResult(value, action.kind);
  if (featureAction) validateFeatureEffects(action, result, context);
  return result;
}
