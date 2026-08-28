import { describe, expect, it, vi } from "vitest";
import {
	createTwitchEventSubRegistry,
	eventSubDefinitionForSubscription,
	requireTwitchEventSubDefinition
} from "../src/platforms/twitch/eventsub-registry.js";

function definition(kind, type, overrides = {}) {
	return {
		kind,
		type,
		version: "1",
		condition: vi.fn(({ channel }) => ({
			broadcaster_user_id: channel.broadcasterUserId
		})),
		handleNotification: vi.fn(),
		...overrides
	};
}

describe("Twitch EventSub registry", () => {
	it("indexes immutable definitions by semantic kind and Twitch subscription", () => {
		const streamOnline = definition(
			"twitch.stream.online.v1",
			"stream.online"
		);
		const registry = createTwitchEventSubRegistry({
			[streamOnline.kind]: streamOnline
		});

		expect(registry.kinds).toEqual(["twitch.stream.online.v1"]);
		expect(requireTwitchEventSubDefinition(
			registry,
			"twitch.stream.online.v1"
		)).toBe(eventSubDefinitionForSubscription(registry, "stream.online", "1"));
		expect(Object.isFrozen(registry)).toBe(true);
		expect(Object.isFrozen(registry.byKind)).toBe(true);
		expect(Object.isFrozen(registry.kinds)).toBe(true);
	});

	it("rejects duplicate semantic kinds", () => {
		const first = definition("twitch.stream.online.v1", "stream.online");
		expect(() => createTwitchEventSubRegistry(
			{ [first.kind]: first },
			{ [first.kind]: first }
		)).toThrow(/Duplicate EventSub definition kind/);
	});

	it("rejects two handlers for the same Twitch type and version", () => {
		const online = definition("twitch.stream.online.v1", "stream.online");
		const duplicate = definition(
			"twitch.stream.started.v1",
			"stream.online"
		);
		expect(() => createTwitchEventSubRegistry({
			[online.kind]: online,
			[duplicate.kind]: duplicate
		})).toThrow(/Duplicate EventSub subscription/);
	});

	it("requires a versioned kind and notification handler", () => {
		expect(() => createTwitchEventSubRegistry({
			invalid: definition("invalid", "stream.online")
		})).toThrow(/definition kind is invalid/);
		expect(() => createTwitchEventSubRegistry({
			"twitch.stream.online.v1": definition(
				"twitch.stream.online.v1",
				"stream.online",
				{ handleNotification: null }
			)
		})).toThrow(/notification handler must be a function/);
	});
});
