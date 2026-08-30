import { ActionRegistryError } from "../../actions/index.js";
import { SchemaValidationError } from "../../framework/index.js";
import {
  createTwitchActionInvocation,
  executeTwitchAction,
  twitchCapabilityAllowed
} from "./actions.js";

function nativeContext(event, messageId) {
  return Object.freeze({
    platform: "twitch",
    origin: Object.freeze({
      group: Object.freeze({
        platform: "twitch",
        kind: "channel",
        id: event.broadcaster_user_id
      }),
      actor: Object.freeze({
        platform: "twitch",
        id: event.chatter_user_id
      })
    }),
    sourceEventId: `twitch:eventsub:${messageId}`,
    response: Object.freeze({
      text(message) {
        if (typeof message !== "string" || message.length === 0 || message.length > 500) {
          throw new TypeError("Twitch response text is invalid.");
        }
        return message;
      }
    })
  });
}

function userFacingError(error, commandName) {
  if (error instanceof SchemaValidationError) return error.message;
  if (error instanceof ActionRegistryError && error.code === "action_arguments_invalid") {
    return error.message;
  }
  if (error instanceof ActionRegistryError && error.code === "action_forbidden") {
    return `You are not authorized to use !${commandName}.`;
  }
  return null;
}

export function compileTwitchFeatureCommands(definitions) {
  const compiled = Object.create(null);
  for (const definition of Object.values(definitions)) {
    compiled[definition.name] = Object.freeze({
      description: definition.description,
      actionKind: definition.actionKind,
      exec: async (event, env, { messageId, argsText }) => {
        try {
          const parsed = definition.parse.parse(argsText);
          if (definition.mode === "action-command") {
            const result = await executeTwitchAction(
              event,
              messageId,
              definition.actionKind,
              parsed,
              {
                env,
                authorize: ({ capability, invocation }) =>
                  twitchCapabilityAllowed(capability, invocation.origin.actor.claims)
              }
            );
            return definition.render(result, Object.freeze({ platform: "twitch" }));
          }
          const invocation = createTwitchActionInvocation(
            event,
            messageId,
            "framework.native.command.v1",
            parsed
          );
          if (!twitchCapabilityAllowed(
            definition.capability,
            invocation.origin.actor.claims
          )) {
            return `You are not authorized to use !${definition.name}.`;
          }
          const args = definition.input.parse(parsed, { path: "arguments" });
          return await definition.execute(nativeContext(event, messageId), args);
        } catch (error) {
          const response = userFacingError(error, definition.name);
          if (response) return response;
          throw error;
        }
      }
    });
  }
  return Object.freeze(compiled);
}
