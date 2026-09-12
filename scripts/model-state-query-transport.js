import {
	compareStateQueryTransports,
	REPRESENTATIVE_STATE_QUERY_SCENARIO
} from "../src/state-querying/transport-cost-model.js";

const comparison = compareStateQueryTransports(REPRESENTATIVE_STATE_QUERY_SCENARIO);
console.log(JSON.stringify(comparison, null, 2));
