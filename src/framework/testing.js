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
import { formatCommandInputError } from "./command-input-error.js";
import { isRegisteredCapability } from "./access.js";
import { FEATURE_RUNTIME_SERVICES } from "./service-runtime.js";
import { parseTwitchCommandText } from "./twitch-command-text.js";
import { evaluateStateQuery } from "../state-querying/evaluator.js";
import {
  DURABLE_EVENT_CODES,
  DURABLE_EVENT_LIMITS,
  durableEventError,
  durableEventId,
  serializeDurableEventPayload,
  sha256Base64Url
} from "../durable-events/contract.js";

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
const DURABLE_EVENT_SOCKET_PROTOCOL = "durable-event-socket/v1";

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

// Runs the same input twice, changing only one explicit capability. This helper
// records evidence; callers must assert denial, no mutation, and allowed behavior.
export async function runCapabilityCases({ actor, capability, invoke, readState }) {
  if (capability === null || !isRegisteredCapability(capability)) {
    throw new FeatureTestRuntimeError("A registered non-public capability is required.");
  }
  if (!actor || !Array.isArray(actor.capabilities) ||
      typeof invoke !== "function" || typeof readState !== "function") {
    throw new FeatureTestRuntimeError(
      "Capability cases require an explicit actor, invoke, and readState."
    );
  }
  const base = actor.capabilities.filter((value) => value !== capability);
  const without = testActor(actor.platform, { ...actor, capabilities: base });
  const withGrant = testActor(actor.platform, {
    ...actor, capabilities: [...base, capability]
  });
  async function run(caseActor) {
    const stateBefore = freezeJson(await readState());
    let result = null;
    let error = null;
    try {
      result = await invoke(caseActor);
    } catch (cause) {
      error = cause;
    }
    return Object.freeze({
      result, error, stateBefore, stateAfter: freezeJson(await readState())
    });
  }
  const withoutCapability = await run(without);
  const withCapability = await run(withGrant);
  return Object.freeze({ withoutCapability, withCapability });
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

function createMemoryServices(clock, registry) {
  const config = new Map();
  const state = new Map();
  const integrationState = new Map();
  const shareableState = new Map();
  const cooldowns = new Map();
  const revisions = new Map();
  const counterSubjects = new Map();
  const changeListeners = new Set();
  const storageKey = (ownerKey, featureId, key) =>
    `${ownerKey}\u0000${featureId}\u0000${key}`;
  const value = (map, key) => map.has(key) ? freezeJson(map.get(key)) : null;

  function revisionKey(storeKind, ownerKey, featureId) {
    return `${storeKind}\u0000${ownerKey}\u0000${featureId}`;
  }

  function touch(storeKind, ownerKey, featureId) {
    const key = revisionKey(storeKind, ownerKey, featureId);
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    for (const listener of changeListeners) listener("value_changed");
  }

  function counterSubjectKey(storeKind, ownerKey, featureId, name, subject) {
    return [storeKind, ownerKey, featureId, name, subject].join("\u0000");
  }

  function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function stateService(map, storeKind, ownerKey, {
    integrationScoped = false,
    canonicalReset = false
  } = {}) {
    const argumentsAfterOwner = (args) => integrationScoped ? args.slice(1) : args;
    return Object.freeze({
      get: async (featureId, ...args) => {
        const [key] = argumentsAfterOwner(args);
        return value(map, storageKey(ownerKey(args), featureId, key));
      },
      set: async (featureId, ...args) => {
        const [key, nextValue] = argumentsAfterOwner(args);
        const owner = ownerKey(args);
        const namespaced = storageKey(owner, featureId, key);
        const normalized = freezeJson(nextValue);
        if (map.has(namespaced) && sameJson(map.get(namespaced), normalized)) return;
        map.set(namespaced, normalized);
        touch(storeKind, owner, featureId);
      },
      delete: async (featureId, ...args) => {
        const [key] = argumentsAfterOwner(args);
        const owner = ownerKey(args);
        const deleted = map.delete(storageKey(owner, featureId, key));
        if (deleted) touch(storeKind, owner, featureId);
        return deleted;
      },
      increment: async (featureId, ...args) => {
        const [key, amount = 1] = argumentsAfterOwner(args);
        const owner = ownerKey(args);
        const namespaced = storageKey(owner, featureId, key);
        const current = map.get(namespaced) ?? 0;
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(amount) ||
            !Number.isSafeInteger(current + amount)) {
          throw new FeatureTestRuntimeError(
            "The in-memory state value is not safely incrementable."
          );
        }
        const nextValue = current + amount;
        if (nextValue === current) return nextValue;
        map.set(namespaced, nextValue);
        touch(storeKind, owner, featureId);
        return nextValue;
      },
      boundedCounter: async (featureId, ...args) => {
        const [descriptor, operation, operand] = argumentsAfterOwner(args);
        const owner = ownerKey(args);
        const namespaced = storageKey(
          owner,
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
        if (operation === "set" && (
          !Number.isSafeInteger(operand) ||
          operand < descriptor.min ||
          operand > descriptor.max
        )) {
          throw new FeatureTestRuntimeError(
            "The in-memory bounded counter value is outside its bounds."
          );
        }
        let nextValue = operation === "set" ? operand : descriptor.initial;
        if (!["reset", "set"].includes(operation)) {
          const direction = operation === "increment" ? 1n : -1n;
          const candidate = BigInt(current) + direction * BigInt(operand);
          nextValue = Number(
            candidate < BigInt(descriptor.min)
              ? BigInt(descriptor.min)
              : candidate > BigInt(descriptor.max)
                ? BigInt(descriptor.max)
                : candidate
          );
        }
        const metadataKey = counterSubjectKey(
          storeKind,
          owner,
          featureId,
          descriptor.name,
          descriptor.subject
        );
        let changed = false;
        if (canonicalReset && operation === "reset") {
          const deletedValue = map.delete(namespaced);
          const deletedSubject = counterSubjects.delete(metadataKey);
          changed = deletedValue || deletedSubject;
        } else if (map.has(namespaced) || nextValue !== descriptor.initial) {
          changed = !map.has(namespaced) || map.get(namespaced) !== nextValue;
          map.set(namespaced, nextValue);
          if (descriptor.subjectLabel !== undefined && !counterSubjects.has(metadataKey)) {
            counterSubjects.set(metadataKey, Object.freeze({
              identity: descriptor.subject,
              label: descriptor.subjectLabel,
              name: descriptor.name,
              valueKey: namespaced
            }));
            changed = true;
          }
        }
        if (changed) touch(storeKind, owner, featureId);
        return nextValue;
      }
    });
  }

  function readableSource(map, storeKind, owner, featureId, bindingKey) {
    const counterValue = (name, subject, options = {}) => {
      const initial = options.initial ?? options.min ?? 0;
      return map.get(storageKey(
        owner,
        featureId,
        `bounded-counter\u0000${name}\u0000${subject}`
      )) ?? initial;
    };
    return Object.freeze({
      bindingKey,
      async revision() {
        return revisions.get(revisionKey(storeKind, owner, featureId)) ?? 0;
      },
      async get(key) {
        const namespaced = storageKey(owner, featureId, key);
        return map.has(namespaced)
          ? Object.freeze({ found: true, value: freezeJson(map.get(namespaced)) })
          : Object.freeze({ found: false });
      },
      async boundedCounter(name, subject, options = {}) {
        return counterValue(name, subject, options);
      },
      async boundedCounterSubjects(name) {
        const prefix = [storeKind, owner, featureId, name, ""].join("\u0000");
        const subjects = [...counterSubjects.entries()]
          .filter(([key, metadata]) =>
            key.startsWith(prefix) && map.has(metadata.valueKey)
          )
          .map(([, metadata]) => Object.freeze({
            identity: metadata.identity,
            label: metadata.label,
            value: map.get(metadata.valueKey)
          }))
          .sort((left, right) => left.identity.localeCompare(right.identity));
        return Object.freeze({
          subjects: Object.freeze(subjects),
          coverage: Object.freeze({
            complete: true,
            identifiedCount: subjects.length,
            unidentifiedCount: 0
          })
        });
      }
    });
  }

  function sourceRuntime(target, resolveDefaultLink) {
    const group = createPlatformGroupRef({
      platform: target.platform,
      kind: target.platform === "discord" ? "guild" : "channel",
      id: target.groupId
    });
    const sources = new Map();
    return Object.freeze({
      async open(featureId, definition) {
        const cacheKey = `${featureId}\u0000${definition.scope.kind}\u0000` +
          `${definition.scope.namespace ?? ""}`;
        if (sources.has(cacheKey)) return sources.get(cacheKey);
        let source;
        if (definition.scope.kind === "group_local") {
          source = readableSource(
            state,
            "group-local",
            group.key,
            featureId,
            `group-local\u0000${group.key}\u0000${featureId}`
          );
        } else {
          const targetPlatform = group.platform === "discord" ? "twitch" : "discord";
          const link = resolveDefaultLink(group, targetPlatform);
          const owner = link
            ? `integration:${link.integration.id}\u0000${definition.scope.namespace}`
            : `standalone:${group.key}:g1\u0000${definition.scope.namespace}`;
          source = readableSource(
            shareableState,
            "shareable",
            owner,
            featureId,
            [
              "effective-shareable",
              group.key,
              targetPlatform,
              owner,
              featureId,
              definition.scope.namespace
            ].join("\u0000")
          );
        }
        sources.set(cacheKey, source);
        return source;
      }
    });
  }

  return Object.freeze({
    runtime(group, resolveDefaultLink) {
      const resolvedShareableScopes = new WeakSet();
      const shareableOwnerKey = (args) => {
        const scope = args[0];
        if (!resolvedShareableScopes.has(scope)) {
          throw new FeatureTestRuntimeError(
            "Shareable state requires a realm resolved by this invocation."
          );
        }
        return `${scope.ownerKey}\u0000${scope.namespaceId}`;
      };
      return Object.freeze({
        featureServices: Object.freeze({
          config: Object.freeze({
            get: async (featureId, key) => value(
              config,
              storageKey(group.key, featureId, key)
            )
          }),
          state: stateService(state, "group-local", () => group.key),
          integrationState: stateService(
            integrationState,
            "integration",
            (args) => args[0]?.integration?.id,
            { integrationScoped: true }
          ),
          shareableState: Object.freeze({
            async current(featureId, targetPlatform, namespaceId) {
              const declaration = registry.featuresById[featureId]?.shareableState.find(
                (candidate) => candidate.id === namespaceId
              );
              if (!declaration) {
                throw new FeatureTestRuntimeError(
                  "The shareable-state namespace is not declared by an installed feature.",
                  { code: "shareable_state_namespace_not_declared" }
                );
              }
              const link = resolveDefaultLink(targetPlatform);
              const scope = Object.freeze({
                featureId,
                namespaceId,
                ownerKey: link
                  ? `integration:${link.integration.id}`
                  : `standalone:${group.key}:g1`
              });
              resolvedShareableScopes.add(scope);
              return scope;
            },
            ...stateService(
              shareableState,
              "shareable",
              shareableOwnerKey,
              { integrationScoped: true, canonicalReset: true }
            )
          })
        }),
        async claimFeatureCooldown({ featureId, actionKind, scopeKey, seconds }) {
          const key = `${group.key}\u0000${featureId}\u0000${actionKind}\u0000${scopeKey}`;
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
    sourceRuntime,
    subscribe(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    invalidate(reason = "value_changed") {
      for (const listener of changeListeners) listener(reason);
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
        shareableState.clear();
        cooldowns.clear();
        revisions.clear();
        counterSubjects.clear();
        for (const listener of changeListeners) listener("value_changed");
      }
    }),
    integrationState: Object.freeze({
      get(integrationId, featureId, key) {
        return value(
          integrationState,
          storageKey(integrationId, featureId, key)
        );
      }
    }),
    shareableState: Object.freeze({
      getStandalone(group, featureId, namespaceId, key) {
        const normalized = createPlatformGroupRef(group);
        return value(
          shareableState,
          storageKey(
            `standalone:${normalized.key}:g1\u0000${namespaceId}`,
            featureId,
            key
          )
        );
      },
      getIntegration(integrationId, featureId, namespaceId, key) {
        return value(
          shareableState,
          storageKey(
            `integration:${integrationId}\u0000${namespaceId}`,
            featureId,
            key
          )
        );
      }
    })
  });
}

function eventStreamIdentity(definition, featureId) {
  return `${featureId}:${definition.id}:v${definition.version}`;
}

function createMemoryEventStreams({
  clock,
  registry,
  resolveDefaultLink,
  replaceDefaultLink,
  nextSourceId
}) {
  const streams = new Map();

  function declaration(identity) {
    const stream = registry.eventStreams[identity];
    if (!stream) {
      throw new FeatureTestRuntimeError(
        `No durable event stream \`${identity}\` is installed.`,
        { code: "feature_test_event_stream_not_found" }
      );
    }
    return stream;
  }

  function declarationFor(featureId, streamId) {
    const matches = Object.values(registry.eventStreams).filter((entry) =>
      entry.featureId === featureId && entry.definition.id === streamId
    );
    if (matches.length !== 1) {
      throw new FeatureTestRuntimeError(
        `Feature \`${featureId}\` does not declare one event stream named \`${streamId}\`.`,
        { code: "feature_test_event_stream_not_found" }
      );
    }
    return matches[0];
  }

  function normalizedSelector({ group: groupInput, stream: identity }) {
    const group = createPlatformGroupRef(groupInput);
    if (typeof identity !== "string") {
      throw new FeatureTestRuntimeError("A durable event stream identity is required.", {
        code: "feature_test_event_stream_identity_invalid"
      });
    }
    const entry = declaration(identity);
    if (!entry.definition.platforms.includes(group.platform)) {
      throw new FeatureTestRuntimeError(
        `Durable event stream \`${identity}\` does not support ${group.platform}.`,
        { code: "feature_test_event_stream_platform_invalid" }
      );
    }
    return { group, entry, identity };
  }

  function routeFor(group, entry, targetPlatform = null) {
    const { definition, featureId } = entry;
    let owner;
    if (definition.scope.kind === "group_local") {
      owner = `group:${group.key}`;
    } else {
      const target = targetPlatform ?? (group.platform === "discord" ? "twitch" : "discord");
      const link = resolveDefaultLink(group, target);
      owner = link
        ? `integration:${link.integration.id}:g1`
        : `standalone:${group.key}:g1`;
    }
    const identity = eventStreamIdentity(definition, featureId);
    return Object.freeze({
      identity,
      owner,
      key: `${definition.scope.kind}\u0000${owner}\u0000${identity}`,
      stream: Object.freeze({
        feature: featureId,
        stream: definition.id,
        version: definition.version
      })
    });
  }

  function streamFor(group, entry, targetPlatform = null) {
    const route = routeFor(group, entry, targetPlatform);
    if (!streams.has(route.key)) {
      streams.set(route.key, {
        route,
        definition: entry.definition,
        events: [],
        receipts: new Map(),
        acknowledgedCursors: new Set(),
        acceptedTimes: [],
        retainedBytes: 0,
        nextSequence: 1,
        activeConnection: null,
        moved: false,
        gap: false
      });
    }
    return streams.get(route.key);
  }

  function connectionError(code, message) {
    return new FeatureTestRuntimeError(message, { code });
  }

  function terminalError(record) {
    if (record.gap) {
      return connectionError(
        "feature_test_event_stream_retention_gap",
        "The test event stream has a retention gap and requires reset."
      );
    }
    if (record.moved && record.events.length === 0) {
      return connectionError(
        "feature_test_event_stream_moved",
        "The test event stream moved after its retained backlog drained."
      );
    }
    return null;
  }

  function settleWaiting(connection, outcome) {
    if (!connection.waiting) return;
    const { resolve, reject } = connection.waiting;
    connection.waiting = null;
    if (outcome instanceof Error) reject(outcome);
    else resolve(outcome);
  }

  function nextFrame(connection) {
    if (!connection.connected) {
      throw connectionError(
        "feature_test_event_stream_disconnected",
        "The test event-stream consumer is disconnected."
      );
    }
    if (connection.outstanding !== null) return null;
    const event = connection.record.events[0];
    if (!event) {
      const error = terminalError(connection.record);
      if (error) throw error;
      return null;
    }
    connection.outstanding = event.cursor;
    return event.frame;
  }

  function deliver(connection) {
    if (!connection?.connected || !connection.waiting) return;
    try {
      const frame = nextFrame(connection);
      if (frame) settleWaiting(connection, frame);
    } catch (error) {
      settleWaiting(connection, error);
    }
  }

  function disconnectState(connection, code = null) {
    if (!connection.connected) return;
    connection.connected = false;
    if (connection.record.activeConnection === connection) {
      connection.record.activeConnection = null;
    }
    if (connection.waiting) {
      settleWaiting(connection, connectionError(
        code ?? "feature_test_event_stream_disconnected",
        code === "feature_test_event_stream_consumer_replaced"
          ? "The test event-stream consumer was replaced."
          : "The test event-stream consumer disconnected."
      ));
    }
  }

  function attach(record) {
    if (record.activeConnection?.connected) {
      disconnectState(
        record.activeConnection,
        "feature_test_event_stream_consumer_replaced"
      );
    }
    const state = {
      record,
      connected: true,
      outstanding: null,
      waiting: null,
      handle: null
    };
    const handle = Object.freeze({
      stream: record.route.stream,
      receive() {
        if (state.waiting) {
          throw connectionError(
            "feature_test_event_stream_read_pending",
            "Only one pending test event-stream read is supported."
          );
        }
        let frame;
        try {
          frame = nextFrame(state);
        } catch (error) {
          return Promise.reject(error);
        }
        if (frame) return Promise.resolve(frame);
        return new Promise((resolve, reject) => {
          state.waiting = { resolve, reject };
        });
      },
      acknowledge(eventOrCursor) {
        if (!state.connected) {
          throw connectionError(
            "feature_test_event_stream_disconnected",
            "The test event-stream consumer is disconnected."
          );
        }
        const cursor = typeof eventOrCursor === "string"
          ? eventOrCursor
          : eventOrCursor?.cursor;
        if (state.record.acknowledgedCursors.has(cursor)) return false;
        if (typeof cursor !== "string" || cursor !== state.outstanding) {
          throw connectionError(
            "feature_test_event_stream_ack_invalid",
            "The acknowledgement does not select the outstanding event."
          );
        }
        const [event] = state.record.events;
        if (!event || event.cursor !== cursor) {
          throw connectionError(
            "feature_test_event_stream_ack_invalid",
            "The acknowledgement does not select the outstanding event."
          );
        }
        state.record.events.shift();
        state.record.retainedBytes -= event.bytes;
        state.record.acknowledgedCursors.add(cursor);
        state.outstanding = null;
        deliver(state);
        if (state.record.events.length === 0) deliver(state);
        return true;
      },
      disconnect() {
        disconnectState(state);
      }
    });
    state.handle = handle;
    record.activeConnection = state;
    return state;
  }

  function expireRecord(record) {
    const nowMs = clock.now().getTime();
    let expired = 0;
    while (record.events[0]?.expiresAtMs <= nowMs) {
      const event = record.events.shift();
      record.retainedBytes -= event.bytes;
      expired += 1;
    }
    if (expired > 0) {
      record.gap = true;
      if (record.activeConnection) {
        record.activeConnection.outstanding = null;
        deliver(record.activeConnection);
      }
    }
    return expired;
  }

  async function publishTo(record, group, sourceEventId, payload) {
    const normalized = serializeDurableEventPayload(
      payload,
      record.definition.payload.schema
    );
    const eventId = await durableEventId({
      featureId: record.route.stream.feature,
      streamId: record.route.stream.stream,
      version: record.route.stream.version,
      originGroupKey: group.key,
      sourceEventId
    });
    const existing = record.receipts.get(eventId);
    if (existing) {
      if (existing.serialized !== normalized.serialized) {
        throw durableEventError(DURABLE_EVENT_CODES.sourceConflict, { status: 409 });
      }
      return Object.freeze({ accepted: true, eventId: existing.eventId });
    }
    expireRecord(record);
    if (record.gap) {
      throw durableEventError(DURABLE_EVENT_CODES.gapRequiresReset, { status: 409 });
    }
    if (record.moved) {
      throw durableEventError(DURABLE_EVENT_CODES.transition, { status: 409 });
    }
    if (!record.activeConnection?.connected) {
      throw durableEventError(DURABLE_EVENT_CODES.consumerUnavailable, { status: 409 });
    }
    const nowMs = clock.now().getTime();
    record.acceptedTimes = record.acceptedTimes.filter((time) => time > nowMs - 1_000);
    if (
      record.events.length >= DURABLE_EVENT_LIMITS.maxRetainedEvents ||
      record.retainedBytes + normalized.bytes > DURABLE_EVENT_LIMITS.maxRetainedBytes ||
      record.acceptedTimes.length >= DURABLE_EVENT_LIMITS.maxIngressPerSecond
    ) {
      throw durableEventError(DURABLE_EVENT_CODES.streamFull, { status: 429 });
    }
    const sequence = record.nextSequence;
    record.nextSequence += 1;
    const cursor = `dec1.${await sha256Base64Url(JSON.stringify([
      "elmybot.test-durable-event-cursor.v1",
      record.route.key,
      sequence,
      eventId
    ]))}`;
    const acceptedAt = new Date(nowMs).toISOString();
    const expiresAtMs = nowMs + DURABLE_EVENT_LIMITS.retentionMs;
    const frozenPayload = freezeJson(JSON.parse(normalized.serialized));
    const frame = Object.freeze({
      protocol: DURABLE_EVENT_SOCKET_PROTOCOL,
      type: "event",
      stream: record.route.stream,
      eventId,
      sequence,
      cursor,
      acceptedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      payload: frozenPayload
    });
    const event = Object.freeze({
      eventId,
      cursor,
      sequence,
      bytes: normalized.bytes,
      expiresAtMs,
      frame
    });
    record.events.push(event);
    record.receipts.set(eventId, Object.freeze({
      eventId,
      serialized: normalized.serialized
    }));
    record.retainedBytes += normalized.bytes;
    record.acceptedTimes.push(nowMs);
    deliver(record.activeConnection);
    return Object.freeze({ accepted: true, eventId });
  }

  function connect(selector) {
    const { group, entry } = normalizedSelector(selector);
    if (entry.definition.access.kind !== "operator_grant") {
      throw new FeatureTestRuntimeError(
        "The test event stream does not use operator-grant access.",
        { code: "feature_test_event_stream_access_invalid" }
      );
    }
    return attach(streamFor(group, entry)).handle;
  }

  async function directPublish({
    group: groupInput,
    stream: identity,
    payload,
    sourceEventId
  }) {
    const { group, entry } = normalizedSelector({ group: groupInput, stream: identity });
    return await publishTo(
      streamFor(group, entry),
      group,
      sourceEventId ?? nextSourceId(group.platform, "durable-event"),
      payload
    );
  }

  function service(invocation) {
    const group = invocation.origin.group;
    const open = async (featureId, streamId, targetPlatform = null) => {
      const entry = declarationFor(featureId, streamId);
      const expectedScope = targetPlatform === null ? "group_local" : "effective_shareable";
      if (entry.definition.scope.kind !== expectedScope) {
        throw new FeatureTestRuntimeError(
          `Durable event stream \`${featureId}:${streamId}\` has the wrong scope.`,
          { code: "feature_test_event_stream_scope_invalid" }
        );
      }
      const record = streamFor(group, entry, targetPlatform);
      return Object.freeze({
        publish: (payload) => publishTo(
          record,
          group,
          invocation.sourceEventId,
          payload
        )
      });
    };
    return Object.freeze({
      local: (featureId, streamId) => open(featureId, streamId),
      current: (featureId, targetPlatform, streamId) =>
        open(featureId, streamId, targetPlatform)
    });
  }

  function restart(consumer) {
    const state = [...streams.values()]
      .map((record) => record.activeConnection)
      .find((connection) => connection?.handle === consumer);
    if (!state) {
      throw new FeatureTestRuntimeError(
        "The consumer is not the active test event-stream connection.",
        { code: "feature_test_event_stream_consumer_invalid" }
      );
    }
    const record = state.record;
    disconnectState(state);
    return attach(record).handle;
  }

  function expire(selector) {
    const { group, entry } = normalizedSelector(selector);
    return expireRecord(streamFor(group, entry));
  }

  function handoff({ sourceGroup: groupInput, targetPlatform, link = null }) {
    const group = createPlatformGroupRef(groupInput);
    const target = targetPlatform ?? link?.targetGroup?.platform;
    if (!target || target === group.platform) {
      throw new FeatureTestRuntimeError(
        "A binding handoff must target the other supported platform.",
        { code: "feature_test_event_stream_handoff_invalid" }
      );
    }
    const affected = Object.values(registry.eventStreams).filter(({ definition }) =>
      definition.scope.kind === "effective_shareable" &&
      definition.platforms.includes(group.platform)
    );
    const oldRecords = affected.map((entry) => streamFor(group, entry, target));
    replaceDefaultLink(group, target, link);
    for (const record of oldRecords) {
      record.moved = true;
      deliver(record.activeConnection);
    }
    return Object.freeze(oldRecords.map((record) => record.route.stream));
  }

  return Object.freeze({
    connect,
    publish: directPublish,
    restart,
    expire,
    handoff,
    service
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

  function resolveDefaultLink(group, targetPlatform) {
    return configuredDefaultLinks.find((link) =>
      link.sourceGroup.key === group.key &&
      link.targetGroup.platform === targetPlatform
    ) ?? null;
  }

  function replaceDefaultLink(group, targetPlatform, link) {
    const existingIndex = configuredDefaultLinks.findIndex((candidate) =>
      candidate.sourceGroup.key === group.key &&
      candidate.targetGroup.platform === targetPlatform
    );
    let normalized = null;
    if (link !== null) {
      [normalized] = normalizedDefaultLinks([link]);
      if (
        normalized.sourceGroup.key !== group.key ||
        normalized.targetGroup.platform !== targetPlatform
      ) {
        throw new FeatureTestRuntimeError(
          "The replacement default link does not match the handoff direction.",
          { code: "feature_test_event_stream_handoff_invalid" }
        );
      }
    }
    if (existingIndex >= 0) configuredDefaultLinks.splice(existingIndex, 1);
    if (normalized) configuredDefaultLinks.push(normalized);
    memory.invalidate("source_changed");
  }

  const memory = createMemoryServices(clock, registry);
  const eventStreams = createMemoryEventStreams({
    clock,
    registry,
    resolveDefaultLink,
    replaceDefaultLink,
    nextSourceId
  });

  function routeSet(inputRoutes) {
    return inputRoutes === undefined ? configuredRoutes : inputRoutes;
  }

  function runtimeContext(invocation, actor, triggerKind, inputRoutes, onRoute) {
    const resolveInvocationDefaultLink = (targetPlatform) =>
      resolveDefaultLink(invocation.origin.group, targetPlatform);
    const memoryRuntime = memory.runtime(
      invocation.origin.group,
      resolveInvocationDefaultLink
    );
    return {
      ...memoryRuntime,
      featureServices: Object.freeze({
        ...memoryRuntime.featureServices,
        eventStreams: eventStreams.service(invocation),
        links: Object.freeze({
          async default(_featureId, targetPlatform) {
            return resolveInvocationDefaultLink(targetPlatform);
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
    routes: inputRoutes,
    sourceEventId: inputSourceEventId
  } = {}) {
    const definition = commandDefinition(platform, name);
    const group = normalizedGroup(platform, groupInput);
    const sourceEventId = inputSourceEventId ?? nextSourceId(platform, "command");

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

    return await command("twitch", parsed.name, {
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

  async function querySnapshot(query, { reason = "initial" } = {}) {
    return await evaluateStateQuery(registry, query, {
      sourceRuntimeFactory: ({ plan }) => memory.sourceRuntime(
        plan.query.target,
        resolveDefaultLink
      ),
      reason,
      now: clock.now
    });
  }

  async function watchQuery(query) {
    let current = await querySnapshot(query);
    let queued = null;
    let waiting = null;
    let closed = false;
    let evaluating = false;
    let pendingReason = null;

    const deliver = (next) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(next);
      } else {
        queued = next;
      }
    };
    const reevaluate = async () => {
      if (evaluating || closed) return;
      evaluating = true;
      try {
        while (pendingReason !== null && !closed) {
          const reason = pendingReason;
          pendingReason = null;
          const next = await querySnapshot(query, { reason });
          if (next.envelope.resultRevision !== current.envelope.resultRevision) {
            current = next;
            deliver(next);
          }
        }
      } finally {
        evaluating = false;
        if (pendingReason !== null && !closed) void reevaluate();
      }
    };
    const unsubscribe = memory.subscribe((reason) => {
      pendingReason = reason === "source_changed" ? reason : "value_changed";
      void reevaluate();
    });

    return Object.freeze({
      initial: current,
      next() {
        if (closed) {
          throw new FeatureTestRuntimeError("The test query subscription is closed.", {
            code: "feature_test_query_closed"
          });
        }
        if (queued) {
          const next = queued;
          queued = null;
          return Promise.resolve(next);
        }
        if (waiting) {
          throw new FeatureTestRuntimeError(
            "Only one pending test query read is supported.",
            { code: "feature_test_query_read_pending" }
          );
        }
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(null);
        }
        queued = null;
      }
    });
  }

  return Object.freeze({
    registry,
    inputError: (platform, name, error) => formatCommandInputError(
      error, commandDefinition(requirePlatform(platform), name)
    ),
    discord: Object.freeze({ command: (name, input) => command("discord", name, input) }),
    twitch: Object.freeze({
      command: (name, input) => command("twitch", name, input),
      commandText: twitchCommandText
    }),
    event,
    clock,
    eventStreams: Object.freeze({
      connect: eventStreams.connect,
      publish: eventStreams.publish,
      restart: eventStreams.restart,
      expire: eventStreams.expire,
      handoff: eventStreams.handoff
    }),
    query: Object.freeze({
      snapshot: querySnapshot,
      watch: watchQuery
    }),
    links: Object.freeze({
      set(nextLinks) {
        const normalized = normalizedDefaultLinks(nextLinks);
        configuredDefaultLinks.splice(
          0,
          configuredDefaultLinks.length,
          ...normalized
        );
        memory.invalidate("source_changed");
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
    shareableState: memory.shareableState,
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

function requireContract(condition, message) {
  if (!condition) {
    throw new FeatureTestRuntimeError(message, {
      code: "feature_test_event_contract_failed"
    });
  }
}

async function capturedError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return null;
}

// Exercises the stable guarantees every durable-event feature inherits from the
// framework. Feature tests supply only their command invocation and payloads;
// transport identity, replay, bounds, and envelope-leakage checks stay here.
export async function runDurableEventFeatureContract({
  feature,
  stream,
  group: groupInput,
  payload,
  alternatePayload,
  invalidPayload,
  publish,
  authorizedActor,
  unauthorizedActor
}) {
  if (
    !feature ||
    typeof stream !== "string" ||
    typeof publish !== "function" ||
    !authorizedActor ||
    !unauthorizedActor
  ) {
    throw new FeatureTestRuntimeError(
      "A durable-event feature contract requires feature, stream, actors, and publish.",
      { code: "feature_test_event_contract_invalid" }
    );
  }
  const group = createPlatformGroupRef(groupInput);

  const unavailableRuntime = createFeatureTestRuntime(feature);
  const unavailable = await capturedError(() => unavailableRuntime.eventStreams.publish({
    group,
    stream,
    payload,
    sourceEventId: "feature-test-contract:unavailable"
  }));
  requireContract(
    unavailable?.code === DURABLE_EVENT_CODES.consumerUnavailable,
    "Publication without an authorized consumer must be rejected."
  );

  const actionRuntime = createFeatureTestRuntime(feature);
  const definition = actionRuntime.registry.eventStreams[stream]?.definition;
  requireContract(
    definition !== undefined,
    "The durable-event contract stream is not installed."
  );
  const expectedPayload = serializeDurableEventPayload(
    payload,
    definition.payload.schema
  );
  const actionConsumer = actionRuntime.eventStreams.connect({ group, stream });
  const denied = await capturedError(() => publish({
    runtime: actionRuntime,
    group,
    actor: unauthorizedActor
  }));
  requireContract(
    denied?.code === "action_forbidden",
    "The feature command must reject the unauthorized contract actor."
  );
  await publish({ runtime: actionRuntime, group, actor: authorizedActor });
  const actionEvent = await actionConsumer.receive();
  requireContract(
    JSON.stringify(actionEvent.payload) === expectedPayload.serialized,
    "The feature command did not publish the expected payload."
  );
  actionConsumer.acknowledge(actionEvent);
  actionConsumer.disconnect();

  const identityRuntime = createFeatureTestRuntime(feature);
  let identityConsumer = identityRuntime.eventStreams.connect({ group, stream });
  const sourceEventId = "feature-test-contract:stable-source";
  const firstReceipt = await identityRuntime.eventStreams.publish({
    group,
    stream,
    payload,
    sourceEventId
  });
  const firstEvent = await identityConsumer.receive();
  const retryReceipt = await identityRuntime.eventStreams.publish({
    group,
    stream,
    payload,
    sourceEventId
  });
  requireContract(
    retryReceipt.eventId === firstReceipt.eventId &&
      firstEvent.eventId === firstReceipt.eventId,
    "A same-source retry must preserve one event identity."
  );
  const distinctReceipt = await identityRuntime.eventStreams.publish({
    group,
    stream,
    payload,
    sourceEventId: "feature-test-contract:distinct-source"
  });
  requireContract(
    distinctReceipt.eventId !== firstReceipt.eventId,
    "Distinct command sources must receive distinct event identities."
  );
  const conflict = await capturedError(() => identityRuntime.eventStreams.publish({
    group,
    stream,
    payload: alternatePayload,
    sourceEventId
  }));
  requireContract(
    conflict?.code === DURABLE_EVENT_CODES.sourceConflict,
    "A same-source retry with different data must be rejected."
  );
  const invalid = await capturedError(() => identityRuntime.eventStreams.publish({
    group,
    stream,
    payload: invalidPayload,
    sourceEventId: "feature-test-contract:invalid-payload"
  }));
  requireContract(
    invalid?.code === DURABLE_EVENT_CODES.payloadInvalid,
    "The declared durable-event payload schema must reject invalid data."
  );

  const eventKeys = Object.keys(firstEvent).sort();
  requireContract(
    JSON.stringify(eventKeys) === JSON.stringify([
      "acceptedAt",
      "cursor",
      "eventId",
      "expiresAt",
      "payload",
      "protocol",
      "sequence",
      "stream",
      "type"
    ]),
    "The durable-event envelope exposed unexpected fields."
  );
  const serializedEnvelope = JSON.stringify({ ...firstEvent, payload: null });
  requireContract(
    !serializedEnvelope.includes(sourceEventId) && !serializedEnvelope.includes(group.key),
    "The durable-event envelope leaked source or owner identity."
  );

  identityConsumer = identityRuntime.eventStreams.restart(identityConsumer);
  const replayedEvent = await identityConsumer.receive();
  requireContract(
    JSON.stringify(replayedEvent) === JSON.stringify(firstEvent),
    "An unacknowledged event must replay unchanged after restart."
  );
  identityConsumer.acknowledge(replayedEvent);
  identityConsumer.disconnect();

  const capacityRuntime = createFeatureTestRuntime(feature);
  const capacityConsumer = capacityRuntime.eventStreams.connect({ group, stream });
  const retainedCapacity = Math.min(
    DURABLE_EVENT_LIMITS.maxRetainedEvents,
    Math.floor(DURABLE_EVENT_LIMITS.maxRetainedBytes / expectedPayload.bytes)
  );
  for (let index = 0; index < retainedCapacity; index += 1) {
    if (index > 0 && index % DURABLE_EVENT_LIMITS.maxIngressPerSecond === 0) {
      capacityRuntime.clock.advance({ seconds: 1 });
    }
    await capacityRuntime.eventStreams.publish({
      group,
      stream,
      payload,
      sourceEventId: `feature-test-contract:capacity:${index}`
    });
  }
  capacityRuntime.clock.advance({ seconds: 1 });
  const full = await capturedError(() => capacityRuntime.eventStreams.publish({
    group,
    stream,
    payload,
    sourceEventId: "feature-test-contract:capacity:overflow"
  }));
  requireContract(
    full?.code === DURABLE_EVENT_CODES.streamFull,
    "A full durable-event stream must reject new work without evicting retained work."
  );
  capacityConsumer.disconnect();

  return Object.freeze({
    eventId: firstEvent.eventId,
    replayed: true,
    retainedCapacity
  });
}
