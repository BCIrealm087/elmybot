import {
  createActionDefinition,
  createActionResult,
  createCommandInvocation,
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

function normalizedInvocation(input) {
  if (input?.schemaVersion !== INTEGRATION_CONTRACT_SCHEMA_VERSION) {
    throw new ActionRegistryError("Unsupported command invocation schema version.", {
      status: 422,
      code: "action_invocation_schema_unsupported"
    });
  }
  try {
    return createCommandInvocation(input);
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

export async function executeAction(registry, input, context = {}) {
  let invocation = normalizedInvocation(input);
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

  const value = isBoundFeatureActionDefinition(action)
    ? await action.execute(
      createFeatureActionContext(action, invocation, context),
      invocation.args
    )
    : await action.execute(invocation, Object.freeze({ ...context }));
  return normalizedResult(value, action.kind);
}
