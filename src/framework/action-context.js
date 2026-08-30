export class FeatureContextError extends Error {
  constructor(message, { code = "feature_context_unavailable" } = {}) {
    super(message);
    this.name = "FeatureContextError";
    this.code = code;
  }
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
  return Object.freeze({
    apiVersion: 1,
    featureId: action.featureId,
    trigger: Object.freeze({ kind: "command" }),
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
    routes: Object.freeze({ resolve: unavailable("routes") }),
    effects: Object.freeze({
      routedMessage: unavailable("effects.routedMessage"),
      discord: Object.freeze({ message: unavailable("effects.discord.message") }),
      twitch: Object.freeze({ chat: unavailable("effects.twitch.chat") })
    }),
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
