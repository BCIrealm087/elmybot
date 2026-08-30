import { ActionRegistryError, executeAction } from "./registry.js";
import { routedRuntime } from "./feature-triggers.js";
import {
  createCommandInvocation,
  submitRoutedEffects
} from "../integrations/index.js";
import { DeliveryError } from "../message-scheduling/index.js";

const PLAN_SCHEMA_VERSION = 1;
const FRAMEWORK_JOB_SCHEMA_VERSION = 1;
const MIN_RANDOM_SECONDS = 600;
const MAX_RANDOM_SECONDS = 86_400;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timingError(timing, expectedType) {
  if (!isObject(timing) || timing.type !== expectedType) {
    return `Scheduled action timing must be \`${expectedType}\`.`;
  }
  if (expectedType === "bounded-random") {
    if (
      !Number.isSafeInteger(timing.minSeconds) ||
      !Number.isSafeInteger(timing.maxSeconds) ||
      timing.minSeconds < MIN_RANDOM_SECONDS ||
      timing.maxSeconds > MAX_RANDOM_SECONDS ||
      timing.minSeconds > timing.maxSeconds
    ) {
      return "Bounded-random intervals must be integer seconds between 600 and " +
        "86400, with the minimum no greater than the maximum.";
    }
  } else if (!Number.isSafeInteger(timing.atUnix) || timing.atUnix <= 0) {
    return "Scheduled action timing requires a positive Unix timestamp.";
  }
  return null;
}

function randomOffset({ minSeconds, maxSeconds }) {
  return Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
}

function calculateScheduleTime(schedule, job, rescheduling = false) {
  const timing = job.extraData.framework.timing;
  if (schedule.timing === "bounded-random") {
    const offset = randomOffset(timing);
    const baseMs = rescheduling ? Math.max(job.runAtMs, Date.now()) : Date.now();
    const nextUnix = Math.floor(baseMs / 1000) + offset;
    return [nextUnix, nextUnix * 1000];
  }
  if (!rescheduling) return [timing.atUnix, timing.atUnix * 1000];
  if (schedule.timing !== "daily") {
    throw new DeliveryError("A one-time scheduled action cannot repeat.", {
      retryable: false,
      code: "feature_schedule_repeat_invalid"
    });
  }
  let nextUnix = job.timestamp + 86_400;
  const nowUnix = Math.floor(Date.now() / 1000);
  if (nextUnix <= nowUnix) {
    nextUnix += (Math.floor((nowUnix - nextUnix) / 86_400) + 1) * 86_400;
  }
  return [nextUnix, nextUnix * 1000];
}

function validateFrameworkJob(schedule, action, job) {
  const data = job.extraData?.framework;
  if (
    !isObject(data) ||
    data.schemaVersion !== FRAMEWORK_JOB_SCHEMA_VERSION ||
    data.scheduleKind !== schedule.kind ||
    data.actionKind !== schedule.actionKind ||
    !isObject(data.actionArgs) ||
    !isObject(data.grant) ||
    !isObject(data.grant.origin) ||
    data.grant.capability !== action.capability ||
    typeof data.grant.acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(data.grant.acceptedAt))
  ) {
    return "Scheduled action framework metadata is invalid.";
  }
  if (
    job.platform !== schedule.sourcePlatform ||
    data.grant.origin.group?.key !== job.groupKey ||
    data.grant.origin.actor?.platform !== schedule.sourcePlatform ||
    job.createdBy !== data.grant.origin.actor?.id
  ) {
    return "Scheduled action authorization grant is inconsistent.";
  }
  const timingValidation = timingError(data.timing, schedule.timing);
  if (timingValidation) return timingValidation;
  if (schedule.timing === "timestamp" && job.repeats) {
    return "Timestamp scheduled actions cannot repeat.";
  }
  try {
    action.input.parse(data.actionArgs, { path: "scheduled arguments" });
  } catch (error) {
    return error instanceof Error ? error.message : "Scheduled action arguments are invalid.";
  }
  return null;
}

function terminalPreparationError(error) {
  return error instanceof ActionRegistryError && [
    "action_not_found",
    "action_origin_unsupported",
    "action_arguments_invalid",
    "action_forbidden",
    "action_authorizer_missing"
  ].includes(error.code);
}

async function prepareOccurrence({
  featureRegistry,
  actionRegistry,
  schedule,
  action,
  env,
  job
}) {
  const validationError = validateFrameworkJob(schedule, action, job);
  if (validationError) {
    throw new DeliveryError(validationError, {
      retryable: false,
      code: "feature_schedule_contract_invalid"
    });
  }
  const data = job.extraData.framework;
  const sourceEventId = `${job.platform}:schedule:${job.id}:occurrence:${job.timestamp}`;
  const invocation = createCommandInvocation({
    kind: schedule.actionKind,
    origin: data.grant.origin,
    args: data.actionArgs,
    sourceEventId,
    correlationId: sourceEventId
  });
  const resolvedRoutes = [];
  let result;
  try {
    result = await executeAction(
      actionRegistry,
      invocation,
      routedRuntime(featureRegistry, env, invocation, "schedule", {
        authorize: ({ capability }) => capability === data.grant.capability,
        onRoutesResolved(routeKind, routes) {
          resolvedRoutes.push(...routes.map((route) => ({
            kind: routeKind,
            integration: route.integration,
            sourceGroup: route.sourceGroup,
            targetGroup: route.targetGroup,
            destination: route.destination
          })));
        }
      })
    );
  } catch (error) {
    if (terminalPreparationError(error)) {
      throw new DeliveryError("The scheduled action is no longer compatible.", {
        retryable: false,
        code: error.code,
        cause: error
      });
    }
    throw error;
  }
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    actionKind: action.kind,
    actionArgs: invocation.args,
    origin: invocation.origin,
    sourceEventId: invocation.sourceEventId,
    correlationId: invocation.correlationId,
    routes: resolvedRoutes,
    effects: result.effects
  };
}

function validateStoredPlan(schedule, action, job) {
  const plan = job.occurrencePlan;
  const expectedSource = `${job.platform}:schedule:${job.id}:occurrence:${job.timestamp}`;
  return isObject(plan) &&
    plan.schemaVersion === PLAN_SCHEMA_VERSION &&
    plan.actionKind === schedule.actionKind &&
    action.kind === schedule.actionKind &&
    job.extraData.framework.grant.capability === action.capability &&
    plan.sourceEventId === expectedSource &&
    plan.correlationId === expectedSource &&
    Array.isArray(plan.routes) &&
    Array.isArray(plan.effects);
}

async function deliverPlan(schedule, action, env, job) {
  if (!validateStoredPlan(schedule, action, job)) {
    throw new DeliveryError("The stored scheduled-action occurrence plan is invalid.", {
      retryable: false,
      code: "feature_schedule_plan_invalid"
    });
  }
  if (job.occurrencePlan.effects.length === 0) return;
  await submitRoutedEffects(env, {
    source: job.occurrencePlan.origin,
    sourceEventId: job.occurrencePlan.sourceEventId,
    correlationId: job.occurrencePlan.correlationId,
    effects: job.occurrencePlan.effects
  });
}

export function createFeatureSchedulingHandlers(featureRegistry, actionRegistry) {
  return Object.freeze(Object.fromEntries(
    Object.values(featureRegistry.schedules).map((schedule) => {
      const action = featureRegistry.actions[schedule.actionKind];
      return [schedule.kind, Object.freeze({
        validateJob: (job) => validateFrameworkJob(schedule, action, job),
        calcScheduleTime: (job, rescheduling = false) =>
          calculateScheduleTime(schedule, job, rescheduling),
        prepareOccurrence: (env, job) => prepareOccurrence({
          featureRegistry,
          actionRegistry,
          schedule,
          action,
          env,
          job
        }),
        deliver: (env, job) => deliverPlan(schedule, action, env, job)
      })];
    })
  ));
}

export const FEATURE_SCHEDULE_JOB_SCHEMA_VERSION = FRAMEWORK_JOB_SCHEMA_VERSION;
