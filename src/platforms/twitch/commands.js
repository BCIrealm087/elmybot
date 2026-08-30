import { featureRegistry } from "../../features/index.js";
import { mergeCommandDefinitions } from "../../framework/internal.js";
import { compileTwitchFeatureCommands } from "./feature-commands.js";

export const commands = mergeCommandDefinitions(
	"twitch",
	compileTwitchFeatureCommands(
		featureRegistry.commands.twitch,
		featureRegistry.actions
	)
);
