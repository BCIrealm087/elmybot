import { createFeatureServiceRuntime } from "../framework/service-runtime.js";
import { createPlatformGroupRef } from "../integrations/contracts.js";
import { getStateQueryBinding } from "../integrations/registry-client.js";
import { shareableStateRealmObjectName } from "../shareable-state/index.js";

function counterpart(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

export function createStateQuerySourceRuntime(env, {
  target,
  correlationId = crypto.randomUUID()
}) {
  const group = createPlatformGroupRef({
    platform: target.platform,
    kind: target.platform === "discord" ? "guild" : "channel",
    id: target.groupId
  });
  const services = createFeatureServiceRuntime(env, {
    origin: Object.freeze({ group, actor: null }),
    correlationId
  }).featureServices;
  const sources = new Map();

  return Object.freeze({
    async open(featureId, definition) {
      const cacheKey = definition.scope.kind === "group_local"
        ? `local\u0000${featureId}`
        : `shareable\u0000${featureId}\u0000${definition.scope.namespace}`;
      if (sources.has(cacheKey)) return sources.get(cacheKey);

      let source;
      if (definition.scope.kind === "group_local") {
        source = Object.freeze({
          bindingKey: `group-local\u0000${group.key}\u0000${featureId}`,
          async revision() {
            return await services.state.revision(featureId);
          },
          async get(key) {
            return await services.state.queryRead(featureId, key);
          },
          async boundedCounter(name, subject, options = {}) {
            return await services.state.boundedCounter(
              featureId,
              { name, subject, ...options },
              "get"
            );
          },
          async boundedCounterSubjects(name) {
            return await services.state.boundedCounterSubjects(featureId, name);
          }
        });
      } else {
        const scope = await services.shareableState.current(
          featureId,
          counterpart(target.platform),
          definition.scope.namespace
        );
        const physicalSourceKey = shareableStateRealmObjectName(scope.realm);
        source = Object.freeze({
          bindingKey: [
            "effective-shareable",
            group.key,
            counterpart(target.platform),
            `binding-${scope.bindingRevision}`,
            physicalSourceKey,
            featureId,
            definition.scope.namespace
          ].join("\u0000"),
          lifecycleRevision: scope.bindingRevision,
          physicalSourceKey,
          async lifecycle() {
            const result = await getStateQueryBinding(env, {
              sourceGroup: group,
              targetPlatform: counterpart(target.platform)
            });
            return result.binding;
          },
          async revision() {
            return await services.shareableState.revision(featureId, scope);
          },
          async get(key) {
            return await services.shareableState.queryRead(featureId, scope, key);
          },
          async boundedCounter(name, subject, options = {}) {
            return await services.shareableState.boundedCounter(
              featureId,
              scope,
              { name, subject, ...options },
              "get"
            );
          },
          async boundedCounterSubjects(name) {
            return await services.shareableState.boundedCounterSubjects(
              featureId,
              scope,
              name
            );
          }
        });
      }
      sources.set(cacheKey, source);
      return source;
    }
  });
}
