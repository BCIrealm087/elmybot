import { ActionRegistryError, createActionRegistry, executeAction } from "../actions/registry.js";
import {
  createCommandInvocation,
  createDomainEvent,
  createEventActionInvocation,
  createIntegrationRef,
  createPlatformGroupRef
} from "../integrations/contracts.js";
import {
  ACTION_COMMAND_TYPE,
  NATIVE_COMMAND_TYPE,
  SCHEDULED_ACTION_COMMAND_TYPE
} from "./command-common.js";
import { createFeatureRegistry } from "./feature-registry.js";
import { FEATURE_RUNTIME_SERVICES } from "./service-runtime.js";
import { parseTwitchCommandText } from "./twitch-command-text.js";

const ROUTED_MESSAGE_EFFECT_KINDS = Object.freeze({
  discord: "discord.message.send.v1",
  twitch: "twitch.chat.send.v1"
});
const TEST_CAPABILITIES = Object.freeze({
  member: "framework.members",
  moderator: "framework.moderators",
  manager: "framework.managers"
});
const MAX_DUE_SCHEDULES_PER_RUN = 100;

export class FeatureTestRuntimeError extends Error {
  constructor(message, { code = "feature_test_runtime_error" } = {}) {
    super(message);
    this.name = "FeatureTestRuntimeError";
    this.code = code;
  }
}

function freezeJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new FeatureTestRuntimeError("Test data contains a non-finite number.", {
      code: "feature_test_json_invalid"
    });
  }
  if (typeof value !== "object") {
    throw new FeatureTestRuntimeError("Test data must contain only JSON values.", {
      code: "feature_test_json_invalid"
    });
  }
  if (ancestors.has(value)) {
    throw new FeatureTestRuntimeError("Test data must not contain cycles.", {
      code: "feature_test_json_invalid"
    });
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJson(entry, nextAncestors)));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FeatureTestRuntimeError("Test data must contain only plain objects.", {
      code: "feature_test_json_invalid"
    });
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      freezeJson(entry, nextAncestors)
    ])
  ));
}

function requirePlatform(platform) {
  if (!Object.hasOwn(ROUTED_MESSAGE_EFFECT_KINDS, platform)) {
    throw new FeatureTestRuntimeError(`Unsupported test platform: \`${platform}\`.`);
  }
  return platform;
}

function defaultGroup(platform) {
  return createPlatformGroupRef({
    platform,
    kind: platform === "discord" ? "guild" : "channel",
    id: `${platform}-test-group`
  });
}

export function discordTestGroup({ id = "discord-test-guild" } = {}) {
  return createPlatformGroupRef({ platform: "discord", kind: "guild", id });
}

export function twitchTestGroup({ id = "twitch-test-channel" } = {}) {
  return createPlatformGroupRef({ platform: "twitch", kind: "channel", id });
}

function testActor(platform, {
  id = `${platform}-test-actor`,
  claims = [],
  capabilities = [TEST_CAPABILITIES.member]
} = {}) {
  requirePlatform(platform);
  if (!Array.isArray(claims) || !Array.isArray(capabilities)) {
    throw new FeatureTestRuntimeError("Test actor claims and capabilities must be arrays.");
  }
  return Object.freeze({
    platform,
    id,
    claims: Object.freeze([...claims]),
    capabilities: Object.freeze([...new Set(capabilities)])
  });
}

export function discordTestActor(options = {}) {
  return testActor("discord", options);
}

export function twitchTestActor(options = {}) {
  return testActor("twitch", options);
}

export function discordTestModerator(options = {}) {
  return discordTestActor({
    ...options,
    capabilities: options.capabilities ?? [
      TEST_CAPABILITIES.member,
      TEST_CAPABILITIES.moderator
    ]
  });
}

export function twitchTestModerator(options = {}) {
  return twitchTestActor({
    ...options,
    claims: options.claims ?? ["twitch.moderator"],
    capabilities: options.capabilities ?? [
      TEST_CAPABILITIES.member,
      TEST_CAPABILITIES.moderator
    ]
  });
}

export function discordTestManager(options = {}) {
  return discordTestActor({
    ...options,
    capabilities: options.capabilities ?? [
      TEST_CAPABILITIES.member,
      TEST_CAPABILITIES.manager
    ]
  });
}

export function twitchTestBroadcaster(options = {}) {
  return twitchTestActor({
    ...options,
    claims: options.claims ?? ["twitch.broadcaster"],
    capabilities: options.capabilities ?? [
      TEST_CAPABILITIES.member,
      TEST_CAPABILITIES.moderator,
      TEST_CAPABILITIES.manager
    ]
  });
}

export function linkedTestRoute({
  kind,
  sourceGroup,
  targetGroup,
  destination = {},
  integrationId = "test-integration"
}) {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new FeatureTestRuntimeError("A test route kind is required.");
  }
  return Object.freeze({
    kind,
    integration: createIntegrationRef({ id: integrationId }),
    sourceGroup: createPlatformGroupRef(sourceGroup),
    targetGroup: createPlatformGroupRef(targetGroup),
    destination: freezeJson(destination)
  });
}

export function defaultTestLink({
  sourceGroup,
  targetGroup,
  integrationId = "test-integration"
}) {
  const source = createPlatformGroupRef(sourceGroup);
  const target = createPlatformGroupRef(targetGroup);
  if (source.platform === target.platform) {
    throw new FeatureTestRuntimeError(
      "A test default link must connect different platforms."
    );
  }
  return Object.freeze({
    integration: createIntegrationRef({ id: integrationId }),
    sourceGroup: source,
    targetGroup: target
  });
}

function normalizedDefaultLinks(values) {
  if (!Array.isArray(values)) {
    throw new FeatureTestRuntimeError("Test default links must be an array.");
  }
  const normalized = values.map((link, index) => {
    let value;
    try {
      if (typeof link?.integration?.id !== "string") throw new TypeError();
      value = defaultTestLink({
        sourceGroup: link?.sourceGroup,
        targetGroup: link?.targetGroup,
        integrationId: link?.integration?.id
      });
    } catch (cause) {
      if (cause instanceof FeatureTestRuntimeError) throw cause;
      throw new FeatureTestRuntimeError(
        `Test default link at index ${index} is invalid.`,
        { code: "feature_test_default_link_invalid" }
      );
    }
    return value;
  });
  const keys = normalized.map((link) =>
    `${link.sourceGroup.key}\u0000${link.targetGroup.platform}`
  );
  if (new Set(keys).size !== keys.length) {
    throw new FeatureTestRuntimeError(
      "Test default links must not contain duplicate directions.",
      { code: "feature_test_default_link_duplicate" }
    );
  }
  return normalized;
}

function effectAdaptersFor(features) {
  const adapters = { discord: Object.create(null), twitch: Object.create(null) };
  for (const feature of features) {
    for (const action of feature.actions) {
      for (const effectKind of action.uses.effects) {
        const platform = effectKind.split(".")[0];
        requirePlatform(platform);
        adapters[platform][effectKind] ??= Object.freeze({
          platform,
          validateEffect: () => null,
          deliver: async () => null
        });
      }
    }
  }
  return adapters;
}

function normalizedFeatures(featureOrFeatures) {
  const features = Array.isArray(featureOrFeatures)
    ? featureOrFeatures
    : [featureOrFeatures];
  if (features.length === 0) {
    throw new FeatureTestRuntimeError("At least one feature is required.");
  }
  return features;
}

function actorRef(actor, platform) {
  if (actor?.platform !== platform || typeof actor.id !== "string") {
    throw new FeatureTestRuntimeError(`A ${platform} test actor is required.`);
  }
  return { platform, id: actor.id, claims: actor.claims ?? [] };
}

function actorCan(actor, capability) {
  return capability === null || actor.capabilities?.includes(capability) === true;
}

function responseText(value) {
  if (typeof value === "string") return value;
  if (typeof value?.content === "string") return value.content;
  if (typeof value?.message === "string") return value.message;
  return null;
}

function assertEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new FeatureTestRuntimeError(
      `${description}: expected ${JSON.stringify(expected)}, received ` +
      `${JSON.stringify(actual)}.`,
      { code: "feature_test_assertion_failed" }
    );
  }
}

function featureTestResult({
  platform,
  triggerKind,
  response = null,
  actionResult = null,
  effects = actionResult?.effects ?? [],
  schedules = [],
  occurrencePlan = null,
  nativeOperations = []
}) {
  const reply = responseText(response) ?? responseText(actionResult?.output);
  const normalizedEffects = Object.freeze([...effects]);
  const normalizedSchedules = Object.freeze([...schedules]);
  const result = {
    platform,
    triggerKind,
    reply,
    response,
    output: actionResult?.output ?? null,
    effects: normalizedEffects,
    schedules: normalizedSchedules,
    occurrencePlan,
    nativeOperations: Object.freeze([...nativeOperations]),
    toReply(expected) {
      assertEqual(reply, expected, "Feature reply mismatch");
      return result;
    },
    toEmitDiscordMessage(expected) {
      const messages = normalizedEffects
        .filter(({ kind }) => kind === ROUTED_MESSAGE_EFFECT_KINDS.discord)
        .map(({ payload }) => payload.content);
      if (!messages.includes(expected)) {
        throw new FeatureTestRuntimeError(
          `Expected a Discord message ${JSON.stringify(expected)}; emitted ` +
          `${JSON.stringify(messages)}.`,
          { code: "feature_test_assertion_failed" }
        );
      }
      return result;
    },
    toEmitTwitchChat(expected) {
      const messages = normalizedEffects
        .filter(({ kind }) => kind === ROUTED_MESSAGE_EFFECT_KINDS.twitch)
        .map(({ payload }) => payload.message);
      if (!messages.includes(expected)) {
        throw new FeatureTestRuntimeError(
          `Expected a Twitch chat message ${JSON.stringify(expected)}; emitted ` +
          `${JSON.stringify(messages)}.`,
          { code: "feature_test_assertion_failed" }
        );
      }
      return result;
    },
    toSchedule(scheduleKind) {
      if (!normalizedSchedules.some(({ kind }) => kind === scheduleKind)) {
        throw new FeatureTestRuntimeError(
          `Expected schedule \`${scheduleKind}\`; created ` +
          `${JSON.stringify(normalizedSchedules.map(({ kind }) => kind))}.`,
          { code: "feature_test_assertion_failed" }
        );
      }
      return result;
    }
  };
  return Object.freeze(result);
}

function createClock(initialTime) {
  let nowMs = new Date(initialTime ?? "2030-01-01T00:00:00.000Z").getTime();
  if (!Number.isFinite(nowMs)) {
    throw new FeatureTestRuntimeError("The initial test time is invalid.");
  }
  return Object.freeze({
    now: () => new Date(nowMs),
    advance({ seconds = 0, milliseconds = 0 } = {}) {
      if (!Number.isFinite(seconds) || !Number.isFinite(milliseconds)) {
        throw new FeatureTestRuntimeError("Clock advancement must be finite.");
      }
      nowMs += seconds * 1000 + milliseconds;
      return new Date(nowMs);
    },
    unix: () => Math.floor(nowMs / 1000)
  });
}

function createMemoryServices(clock) {
  const config = new Map();
  const state = new Map();
  const integrationState = new Map();
  const cooldowns = new Map();
  const storageKey = (ownerKey, featureId, key) =>
    `${ownerKey}\u0000${featureId}\u0000${key}`;
  const value = (map, key) => map.has(key) ? freezeJson(map.get(key)) : null;

  function stateService(map, ownerKey, { integrationScoped = false } = {}) {
    const argumentsAfterOwner = (args) => integrationScoped ? args.slice(1) : args;
    return Object.freeze({
      get: async (featureId, ...args) => {
        const [key] = argumentsAfterOwner(args);
        return value(map, storageKey(ownerKey(args), featureId, key));
      },
      set: async (featureId, ...args) => {
        const [key, nextValue] = argumentsAfterOwner(args);
        map.set(
          storageKey(ownerKey(args), featureId, key),
          freezeJson(nextValue)
        );
      },
      delete: async (featureId, ...args) => {
        const [key] = argumentsAfterOwner(args);
        return map.delete(storageKey(ownerKey(args), featureId, key));
      },
      increment: async (featureId, ...args) => {
        const [key, amount = 1] = argumentsAfterOwner(args);
        const namespaced = storageKey(ownerKey(args), featureId, key);
        const current = map.get(namespaced) ?? 0;
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(amount) ||
            !Number.isSafeInteger(current + amount)) {
          throw new FeatureTestRuntimeError(
            "The in-memory state value is not safely incrementable."
          );
        }
        const nextValue = current + amount;
        map.set(namespaced, nextValue);
        return nextValue;
      },
      boundedCounter: async (featureId, ...args) => {
        const [descriptor, operation, amount] = argumentsAfterOwner(args);
        const namespaced = storageKey(
          ownerKey(args),
          featureId,
          `bounded-counter\u0000${descriptor.name}\u0000${descriptor.subject}`
        );
        const current = map.get(namespaced) ?? descriptor.initial;
        if (
          !Number.isSafeInteger(current) ||
          current < descriptor.min ||
          current > descriptor.max
        ) {
          throw new FeatureTestRuntimeError(
            "The in-memory state value is not a valid bounded counter."
          );
        }
        if (operation === "get") return current;
        let nextValue = descriptor.initial;
        if (operation !== "reset") {
          const direction = operation === "increment" ? 1n : -1n;
          const candidate = BigInt(current) + direction * BigInt(amount);
          nextValue = Number(
            candidate < BigInt(descriptor.min)
              ? BigInt(descriptor.min)
              : candidate > BigInt(descriptor.max)
                ? BigInt(descriptor.max)
                : candidate
          );
        }
        if (map.has(namespaced) || nextValue !== descriptor.initial) {
          map.set(namespaced, nextValue);
        }
        return nextValue;
      }
    });
  }

  return Object.freeze({
    runtime(groupKey) {
      return Object.freeze({
        featureServices: Object.freeze({
          config: Object.freeze({
            get: async (featureId, key) => value(
              config,
              storageKey(groupKey, featureId, key)
            )
          }),
          state: stateService(state, () => groupKey),
          integrationState: stateService(
            integrationState,
            (args) => args[0]?.integration?.id,
            { integrationScoped: true }
          )
        }),
        async claimFeatureCooldown({ featureId, actionKind, scopeKey, seconds }) {
          const key = `${groupKey}\u0000${featureId}\u0000${actionKind}\u0000${scopeKey}`;
          const nowMs = clock.now().getTime();
          const expiresAtMs = cooldowns.get(key) ?? 0;
          if (expiresAtMs > nowMs) {
            return {
              allowed: false,
              retryAfterSeconds: Math.ceil((expiresAtMs - nowMs) / 1000)
            };
          }
          cooldowns.set(key, nowMs + seconds * 1000);
          return { allowed: true, retryAfterSeconds: 0 };
        }
      });
    },
    config: Object.freeze({
      set(group, featureId, key, nextValue) {
        const normalized = createPlatformGroupRef(group);
        config.set(storageKey(normalized.key, featureId, key), freezeJson(nextValue));
      },
      get(group, featureId, key) {
        const normalized = createPlatformGroupRef(group);
        return value(config, storageKey(normalized.key, featureId, key));
      },
      delete(group, featureId, key) {
        const normalized = createPlatformGroupRef(group);
        return config.delete(storageKey(normalized.key, featureId, key));
      }
    }),
    state: Object.freeze({
      get(group, featureId, key) {
        const normalized = createPlatformGroupRef(group);
        return value(state, storageKey(normalized.key, featureId, key));
      },
      clear() {
        state.clear();
        integrationState.clear();
        cooldowns.clear();
      }
    }),
    integrationState: Object.freeze({
      get(integrationId, featureId, key) {
        return value(
          integrationState,
          storageKey(integrationId, featureId, key)
        );
      }
    })
  });
}

function validateMappedSchedule(mapped, schedule) {
  if (typeof mapped !== "object" || mapped === null || Array.isArray(mapped)) {
    throw new FeatureTestRuntimeError("The command produced an invalid schedule.");
  }
  if (
    typeof mapped.actionArgs !== "object" ||
    mapped.actionArgs === null ||
    Array.isArray(mapped.actionArgs) ||
    typeof mapped.timing !== "object" ||
    mapped.timing === null ||
    mapped.timing.type !== schedule.timing ||
    typeof mapped.repeats !== "boolean"
  ) {
    throw new FeatureTestRuntimeError("The command produced invalid schedule fields.");
  }
  return mapped;
}

function scheduleUnix(timing, clock, randomInteger) {
  if (timing.type === "bounded-random") {
    const { minSeconds, maxSeconds } = timing;
    if (
      !Number.isSafeInteger(minSeconds) ||
      !Number.isSafeInteger(maxSeconds) ||
      minSeconds > maxSeconds
    ) {
      throw new FeatureTestRuntimeError("Bounded-random test timing is invalid.");
    }
    return clock.unix() + randomInteger({ min: minSeconds, max: maxSeconds });
  }
  if (!Number.isSafeInteger(timing.atUnix) || timing.atUnix <= 0) {
    throw new FeatureTestRuntimeError("Timestamp test timing is invalid.");
  }
  return timing.atUnix;
}

export function createFeatureTestRuntime(featureOrFeatures, {
  initialTime,
  defaultLinks = [],
  routes = [],
  randomInteger = ({ min }) => min
} = {}) {
  const features = normalizedFeatures(featureOrFeatures);
  const registry = createFeatureRegistry(features, {
    availableServices: FEATURE_RUNTIME_SERVICES,
    effectAdapters: effectAdaptersFor(features)
  });
  const actions = createActionRegistry(registry.actions);
  const clock = createClock(initialTime);
  const memory = createMemoryServices(clock);
  const configuredDefaultLinks = normalizedDefaultLinks(defaultLinks);
  const configuredRoutes = [...routes];
  const pendingSchedules = [];
  const logs = [];
  let sourceCounter = 0;
  let scheduleCounter = 0;

  function nextSourceId(platform, trigger) {
    sourceCounter += 1;
    return `${platform}:feature-test:${trigger}:${sourceCounter}`;
  }

  function normalizedGroup(platform, value) {
    const group = value ? createPlatformGroupRef(value) : defaultGroup(platform);
    if (group.platform !== platform) {
      throw new FeatureTestRuntimeError("The test group platform is inconsistent.");
    }
    return group;
  }

  function routeSet(inputRoutes) {
    return inputRoutes === undefined ? configuredRoutes : inputRoutes;
  }

  function runtimeContext(invocation, actor, triggerKind, inputRoutes, onRoute) {
    const memoryRuntime = memory.runtime(invocation.origin.group.key);
    return {
      ...memoryRuntime,
      featureServices: Object.freeze({
        ...memoryRuntime.featureServices,
        links: Object.freeze({
          async default(_featureId, targetPlatform) {
            return configuredDefaultLinks.find((link) =>
              link.sourceGroup.key === invocation.origin.group.key &&
              link.targetGroup.platform === targetPlatform
            ) ?? null;
          }
        })
      }),
      triggerKind,
      clock,
      random: { integer: randomInteger },
      routeDefinitions: registry.routes,
      effectAdapters: registry.effectAdapters,
      routedMessageEffectKinds: ROUTED_MESSAGE_EFFECT_KINDS,
      authorize: ({ capability }) => actorCan(actor, capability),
      resolveRoutes: async (kind) => {
        const matching = routeSet(inputRoutes).filter((route) =>
          route.kind === kind &&
          route.sourceGroup.key === invocation.origin.group.key
        );
        if (typeof onRoute === "function") onRoute(kind, matching);
        return matching;
      },
      log(level, event, metadata) {
        logs.push(Object.freeze({ level, event, metadata: freezeJson(metadata) }));
      }
    };
  }

  async function executeFeatureAction({
    actionKind,
    platform,
    group,
    actor,
    args,
    sourceEventId,
    triggerKind,
    inputRoutes,
    onRoute
  }) {
    const origin = {
      group,
      actor: triggerKind === "event" ? null : actorRef(actor, platform)
    };
    const invocation = triggerKind === "event"
      ? createEventActionInvocation({
        kind: actionKind,
        origin,
        args,
        sourceEventId
      })
      : createCommandInvocation({
        kind: actionKind,
        origin,
        args,
        sourceEventId
      });
    return await executeAction(
      actions,
      invocation,
      runtimeContext(invocation, actor, triggerKind, inputRoutes, onRoute)
    );
  }

  function nativeContext(platform, group, actor, sourceEventId, operations) {
    const origin = Object.freeze({
      group,
      actor: Object.freeze(actorRef(actor, platform))
    });
    const response = Object.freeze({
      text(content, { ephemeral = false } = {}) {
        if (typeof content !== "string" || content.length === 0) {
          throw new FeatureTestRuntimeError("Native response text is invalid.");
        }
        return platform === "discord"
          ? Object.freeze({ content, ...(ephemeral ? { flags: 64 } : {}) })
          : content;
      }
    });
    return Object.freeze({
      platform,
      origin,
      sourceEventId,
      permissions: Object.freeze({
        async allowRole(roleId) {
          operations.push(Object.freeze({ kind: "discord.role.allow", roleId }));
        },
        async disallowRole(roleId) {
          operations.push(Object.freeze({ kind: "discord.role.disallow", roleId }));
        }
      }),
      response
    });
  }

  function commandDefinition(platform, name) {
    const definition = registry.commands[platform][name];
    if (!definition) {
      throw new FeatureTestRuntimeError(
        `No ${platform} feature command named \`${name}\` is installed.`,
        { code: "feature_test_command_not_found" }
      );
    }
    return definition;
  }

  async function command(platform, name, {
    args = {},
    actor = testActor(platform),
    group: groupInput,
    routes: inputRoutes
  } = {}) {
    const definition = commandDefinition(platform, name);
    const group = normalizedGroup(platform, groupInput);
    const sourceEventId = nextSourceId(platform, "command");

    if (definition.mode === ACTION_COMMAND_TYPE) {
      const actionResult = await executeFeatureAction({
        actionKind: definition.actionKind,
        platform,
        group,
        actor,
        args,
        sourceEventId,
        triggerKind: "command",
        inputRoutes
      });
      const response = definition.render(actionResult, Object.freeze({ platform }));
      return featureTestResult({
        platform,
        triggerKind: "command",
        response,
        actionResult
      });
    }

    if (definition.mode === NATIVE_COMMAND_TYPE) {
      if (!actorCan(actor, definition.capability)) {
        throw new ActionRegistryError("The actor is not authorized for this command.", {
          status: 403,
          code: "action_forbidden"
        });
      }
      const parsed = definition.input.parse(args, { path: "arguments" });
      const operations = [];
      const response = await definition.execute(
        nativeContext(platform, group, actor, sourceEventId, operations),
        parsed
      );
      return featureTestResult({
        platform,
        triggerKind: "command",
        response,
        nativeOperations: operations
      });
    }

    if (definition.mode === SCHEDULED_ACTION_COMMAND_TYPE) {
      const schedule = registry.schedules[definition.scheduleKind];
      const action = registry.actions[schedule.actionKind];
      if (!actorCan(actor, action.capability)) {
        throw new ActionRegistryError("The actor is not authorized for this schedule.", {
          status: 403,
          code: "action_forbidden"
        });
      }
      const mapped = validateMappedSchedule(definition.mapSchedule(args), schedule);
      const actionArgs = action.input.parse(mapped.actionArgs, {
        path: "scheduled arguments"
      });
      scheduleCounter += 1;
      const record = {
        id: `feature-test-schedule-${scheduleCounter}`,
        kind: schedule.kind,
        actionKind: schedule.actionKind,
        platform,
        group,
        actor,
        actionArgs,
        timing: freezeJson(mapped.timing),
        repeats: mapped.repeats,
        nextUnix: scheduleUnix(mapped.timing, clock, randomInteger),
        routes: inputRoutes,
        occurrence: 0
      };
      pendingSchedules.push(record);
      return featureTestResult({
        platform,
        triggerKind: "command",
        response: `Scheduled ${schedule.kind}.`,
        schedules: [Object.freeze({ ...record })]
      });
    }

    throw new FeatureTestRuntimeError("The feature command mode is unsupported.");
  }

  async function twitchCommandText(messageText, input = {}) {
    const parsed = parseTwitchCommandText(messageText);
    if (!parsed) {
      throw new FeatureTestRuntimeError(
        "Twitch command text must start with a bang-prefixed command name.",
        { code: "feature_test_twitch_command_text_invalid" }
      );
    }

    const definition = commandDefinition("twitch", parsed.name);

    return command("twitch", parsed.name, {
      ...input,
      args: definition.parse.parse(parsed.argsText)
    });
  }

  async function event(kind, {
    payload = {},
    group: groupInput,
    routes: inputRoutes,
    occurredAt = clock.now().toISOString(),
    sourceEventId
  } = {}) {
    const binding = registry.events[kind];
    if (!binding) {
      throw new FeatureTestRuntimeError(`No feature event \`${kind}\` is installed.`, {
        code: "feature_test_event_not_found"
      });
    }
    const platform = kind.split(".")[0];
    const group = normalizedGroup(platform, groupInput);
    const resolvedSourceId = sourceEventId ?? nextSourceId(platform, "event");
    const domainEvent = createDomainEvent({
      kind,
      source: { group, actor: null },
      occurredAt,
      payload,
      sourceEventId: resolvedSourceId
    });
    const actionResult = await executeFeatureAction({
      actionKind: binding.actionKind,
      platform,
      group,
      actor: testActor(platform),
      args: binding.mapPayload(domainEvent),
      sourceEventId: resolvedSourceId,
      triggerKind: "event",
      inputRoutes
    });
    return featureTestResult({
      platform,
      triggerKind: "event",
      actionResult
    });
  }

  async function runDueSchedules() {
    const results = [];
    let processed = 0;
    for (const record of [...pendingSchedules]) {
      if (record.nextUnix > clock.unix()) continue;
      processed += 1;
      if (processed > MAX_DUE_SCHEDULES_PER_RUN) {
        throw new FeatureTestRuntimeError("Too many due test schedules.");
      }
      record.occurrence += 1;
      const sourceEventId =
        `${record.platform}:feature-test:schedule:${record.id}:${record.nextUnix}`;
      const resolvedRoutes = [];
      const actionResult = await executeFeatureAction({
        actionKind: record.actionKind,
        platform: record.platform,
        group: record.group,
        actor: record.actor,
        args: record.actionArgs,
        sourceEventId,
        triggerKind: "schedule",
        inputRoutes: record.routes,
        onRoute: (kind, matching) => resolvedRoutes.push(...matching.map((route) => ({
          kind,
          integration: route.integration,
          sourceGroup: route.sourceGroup,
          targetGroup: route.targetGroup,
          destination: route.destination
        })))
      });
      const occurrencePlan = freezeJson({
        actionKind: record.actionKind,
        actionArgs: record.actionArgs,
        origin: {
          group: record.group,
          actor: actorRef(record.actor, record.platform)
        },
        sourceEventId,
        routes: resolvedRoutes,
        effects: actionResult.effects
      });
      results.push(featureTestResult({
        platform: record.platform,
        triggerKind: "schedule",
        actionResult,
        occurrencePlan
      }));

      if (record.repeats) {
        if (record.timing.type === "daily") {
          record.nextUnix += 86_400;
        } else if (record.timing.type === "bounded-random") {
          record.nextUnix = scheduleUnix(record.timing, clock, randomInteger);
        } else {
          throw new FeatureTestRuntimeError("A repeating timestamp schedule is invalid.");
        }
      } else {
        pendingSchedules.splice(pendingSchedules.indexOf(record), 1);
      }
    }
    return Object.freeze(results);
  }

  return Object.freeze({
    registry,
    discord: Object.freeze({ command: (name, input) => command("discord", name, input) }),
    twitch: Object.freeze({
      command: (name, input) => command("twitch", name, input),
      commandText: twitchCommandText
    }),
    event,
    clock,
    links: Object.freeze({
      set(nextLinks) {
        const normalized = normalizedDefaultLinks(nextLinks);
        configuredDefaultLinks.splice(
          0,
          configuredDefaultLinks.length,
          ...normalized
        );
      },
      all: () => Object.freeze([...configuredDefaultLinks])
    }),
    routes: Object.freeze({
      set(nextRoutes) {
        if (!Array.isArray(nextRoutes)) {
          throw new FeatureTestRuntimeError("Test routes must be an array.");
        }
        configuredRoutes.splice(0, configuredRoutes.length, ...nextRoutes);
      },
      all: () => Object.freeze([...configuredRoutes])
    }),
    config: memory.config,
    state: memory.state,
    integrationState: memory.integrationState,
    schedules: Object.freeze({
      pending: () => Object.freeze(pendingSchedules.map((record) =>
        Object.freeze({ ...record })
      )),
      runDue: runDueSchedules,
      replay(occurrencePlan) {
        const plan = freezeJson(occurrencePlan);
        return featureTestResult({
          platform: plan.origin.group.platform,
          triggerKind: "schedule-replay",
          effects: plan.effects,
          occurrencePlan: plan
        });
      }
    }),
    logs: Object.freeze({ all: () => Object.freeze([...logs]) })
  });
}
