const EVENT_KIND_PATTERN =
	/^twitch\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const SUBSCRIPTION_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,199}$/;
const SUBSCRIPTION_VERSION_PATTERN = /^[1-9]\d{0,9}$/;

export class TwitchEventSubRegistryError extends TypeError {
	constructor(message) {
		super(message);
		this.name = "TwitchEventSubRegistryError";
		this.code = "twitch_eventsub_registry_error";
	}
}

function requiredString(value, name, pattern) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!pattern.test(value)
	) {
		throw new TwitchEventSubRegistryError(`${name} is invalid.`);
	}
	return value;
}

function subscriptionKey(type, version) {
	return `${type}:${version}`;
}

export function createTwitchEventSubDefinition({
	kind,
	type,
	version,
	needsBotUserId = false,
	condition,
	handleNotification,
	shouldEnqueueNotification = null,
	handleRevocation = null
}) {
	const normalizedKind = requiredString(kind, "EventSub definition kind", EVENT_KIND_PATTERN);
	const normalizedType = requiredString(
		type,
		"EventSub subscription type",
		SUBSCRIPTION_TYPE_PATTERN
	);
	const normalizedVersion = requiredString(
		version,
		"EventSub subscription version",
		SUBSCRIPTION_VERSION_PATTERN
	);
	if (typeof needsBotUserId !== "boolean") {
		throw new TwitchEventSubRegistryError(
			"EventSub needsBotUserId must be a boolean."
		);
	}
	if (typeof condition !== "function") {
		throw new TwitchEventSubRegistryError(
			"EventSub condition must be a function."
		);
	}
	if (typeof handleNotification !== "function") {
		throw new TwitchEventSubRegistryError(
			"EventSub notification handler must be a function."
		);
	}
	if (
		shouldEnqueueNotification !== null &&
		typeof shouldEnqueueNotification !== "function"
	) {
		throw new TwitchEventSubRegistryError(
			"EventSub notification admission hook must be a function or null."
		);
	}
	if (handleRevocation !== null && typeof handleRevocation !== "function") {
		throw new TwitchEventSubRegistryError(
			"EventSub revocation handler must be a function or null."
		);
	}

	return Object.freeze({
		kind: normalizedKind,
		type: normalizedType,
		version: normalizedVersion,
		needsBotUserId,
		condition,
		handleNotification,
		shouldEnqueueNotification,
		handleRevocation
	});
}

export function createTwitchEventSubRegistry(...definitionSets) {
	const byKind = Object.create(null);
	const bySubscription = Object.create(null);

	for (const definitionSet of definitionSets) {
		for (const [kind, definition] of Object.entries(definitionSet)) {
			if (byKind[kind]) {
				throw new TwitchEventSubRegistryError(
					`Duplicate EventSub definition kind: \`${kind}\`.`
				);
			}
			const normalized = createTwitchEventSubDefinition(definition);
			if (normalized.kind !== kind) {
				throw new TwitchEventSubRegistryError(
					`EventSub registry key \`${kind}\` does not match definition kind ` +
					`\`${normalized.kind}\`.`
				);
			}
			const key = subscriptionKey(normalized.type, normalized.version);
			if (bySubscription[key]) {
				throw new TwitchEventSubRegistryError(
					`Duplicate EventSub subscription: \`${key}\`.`
				);
			}
			byKind[kind] = normalized;
			bySubscription[key] = normalized;
		}
	}

	return Object.freeze({
		byKind: Object.freeze(byKind),
		bySubscription: Object.freeze(bySubscription),
		kinds: Object.freeze(Object.keys(byKind).sort())
	});
}

export function eventSubDefinitionForSubscription(registry, type, version) {
	return registry.bySubscription[subscriptionKey(type, version)] ?? null;
}

export async function shouldEnqueueTwitchEventSubNotification(
	registry,
	context
) {
	const subscription = context.payload?.subscription;
	const definition = eventSubDefinitionForSubscription(
		registry,
		subscription?.type,
		subscription?.version ?? "1"
	);
	if (!definition?.shouldEnqueueNotification) return true;

	const shouldEnqueue = await definition.shouldEnqueueNotification(context);
	if (typeof shouldEnqueue !== "boolean") {
		throw new TwitchEventSubRegistryError(
			"EventSub notification admission hook must return a boolean."
		);
	}
	return shouldEnqueue;
}

export function requireTwitchEventSubDefinition(registry, kind) {
	const definition = registry.byKind[kind];
	if (!definition) {
		throw new TwitchEventSubRegistryError(
			`No EventSub definition is registered for \`${kind}\`.`
		);
	}
	return definition;
}
