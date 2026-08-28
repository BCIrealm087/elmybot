import { CORE_ACTION_KINDS } from "../../actions/index.js";
import {
	executeTwitchAction,
	twitchTextActionResponse
} from "./actions.js";

export const commands = Object.freeze({
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
	})
});
