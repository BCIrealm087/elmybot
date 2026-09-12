export const DURABLE_OBJECT_PRICING = Object.freeze({
	memoryGb: 128 / 1024,
	includedRequests: 1_000_000,
	requestBillingUnit: 1_000_000,
	requestUnitUsd: 0.15,
	includedDurationGbSeconds: 400_000,
	durationBillingUnit: 1_000_000,
	durationUnitUsd: 12.50
});

function billedUnits(usage, included, unit) {
	return Math.ceil(Math.max(0, usage - included) / unit);
}

function pricedDurableObjectUsage({ requests, activeSeconds }) {
	const durationGbSeconds = activeSeconds * DURABLE_OBJECT_PRICING.memoryGb;
	const requestUnits = billedUnits(
		requests,
		DURABLE_OBJECT_PRICING.includedRequests,
		DURABLE_OBJECT_PRICING.requestBillingUnit
	);
	const durationUnits = billedUnits(
		durationGbSeconds,
		DURABLE_OBJECT_PRICING.includedDurationGbSeconds,
		DURABLE_OBJECT_PRICING.durationBillingUnit
	);

	return {
		requests,
		durationGbSeconds,
		requestCostUsd: requestUnits * DURABLE_OBJECT_PRICING.requestUnitUsd,
		durationCostUsd: durationUnits * DURABLE_OBJECT_PRICING.durationUnitUsd,
		totalIncrementalUsd:
			(requestUnits * DURABLE_OBJECT_PRICING.requestUnitUsd)
			+ (durationUnits * DURABLE_OBJECT_PRICING.durationUnitUsd)
	};
}

export function compareStateQueryTransports({
	groups,
	connectionsPerGroup,
	hoursActivePerDay,
	days,
	connectionsPerClientPerDay = 1,
	stateChangesPerGroupPerHour,
	handlerMillisecondsPerChange
}) {
	const connectionRequests = groups
		* connectionsPerGroup
		* connectionsPerClientPerDay
		* days;
	const notificationRequests = groups
		* stateChangesPerGroupPerHour
		* hoursActivePerDay
		* days;
	const requests = connectionRequests + notificationRequests;

	const directSse = pricedDurableObjectUsage({
		requests,
		activeSeconds: groups * hoursActivePerDay * 60 * 60 * days
	});

	const hibernatingWebSocketRelay = pricedDurableObjectUsage({
		requests,
		activeSeconds: notificationRequests * handlerMillisecondsPerChange / 1000
	});

	return {
		assumptions: {
			groups,
			connectionsPerGroup,
			hoursActivePerDay,
			days,
			connectionsPerClientPerDay,
			stateChangesPerGroupPerHour,
			handlerMillisecondsPerChange
		},
		sharedUsage: {
			connectionRequests,
			notificationRequests
		},
		directSse,
		hibernatingWebSocketRelay
	};
}

export const REPRESENTATIVE_STATE_QUERY_SCENARIO = Object.freeze({
	groups: 100,
	connectionsPerGroup: 10,
	hoursActivePerDay: 8,
	days: 30,
	connectionsPerClientPerDay: 1,
	stateChangesPerGroupPerHour: 10,
	handlerMillisecondsPerChange: 10
});
