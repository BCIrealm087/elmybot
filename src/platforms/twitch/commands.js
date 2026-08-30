import {
	ActionRegistryError,
	CORE_ACTION_KINDS,
	INTEGRATION_ACTION_KINDS
} from "../../actions/index.js";
import { featureRegistry } from "../../features/index.js";
import { mergeCommandDefinitions } from "../../framework/index.js";
import { INTEGRATION_ROUTE_KINDS } from "../../integrations/index.js";
import { compileTwitchFeatureCommands } from "./feature-commands.js";
import {
	executeTwitchAction,
	executeTwitchRoutedAction,
	twitchTextActionResponse
} from "./actions.js";

const legacyCommands = Object.freeze({
	"alive": Object.freeze({
		description: "Replies if alive.",
		actionKind: CORE_ACTION_KINDS.ALIVE,
		exec: async (event, env, { messageId }) =>
			twitchTextActionResponse(await executeTwitchAction(
				event,
				messageId,
				CORE_ACTION_KINDS.ALIVE,
				{},
				{ env }
			))
	}),
	"announce": Object.freeze({
		description: "Publishes an announcement to linked Discord channels.",
		actionKind: INTEGRATION_ACTION_KINDS.PUBLISH_ANNOUNCEMENT,
		exec: async (event, env, { messageId, argsText }) => {
			if (argsText.length === 0) return "Usage: !announce <message>";
			if (argsText.length > 2_000) {
				return "Announcements must not exceed 2000 characters.";
			}
			try {
				return twitchTextActionResponse(await executeTwitchRoutedAction(
					event,
					messageId,
					INTEGRATION_ACTION_KINDS.PUBLISH_ANNOUNCEMENT,
					{ message: argsText },
					{
						env,
						routeKind: INTEGRATION_ROUTE_KINDS.TWITCH_ANNOUNCE_TO_DISCORD
					}
				));
			} catch (error) {
				if (error instanceof ActionRegistryError && error.status === 403) {
					return "Only the broadcaster or a moderator can use !announce.";
				}
				throw error;
			}
		}
	})
});

export const commands = mergeCommandDefinitions(
	"twitch",
	legacyCommands,
	compileTwitchFeatureCommands(featureRegistry.commands.twitch)
);
