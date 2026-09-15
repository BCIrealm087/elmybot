import { describe, expect, it } from "vitest";
import {
	STATE_QUERY_SSE_PROOF_LIMITS,
	StateQuerySseTransportProof
} from "../src/state-querying/sse-transport-proof.js";
import {
	compareStateQueryTransports,
	REPRESENTATIVE_STATE_QUERY_SCENARIO
} from "../src/state-querying/transport-cost-model.js";

const decoder = new TextDecoder();

function result(value, overrides = {}) {
	return {
		protocol: "state-query-result/v1",
		query: "sha256:proof-query",
		target: { platform: "twitch", group: "channel:42" },
		status: "ready",
		bindingRevision: "binding-1",
		resultRevision: `result-${value}`,
		data: { deaths: value },
		...overrides
	};
}

async function readChunk(reader) {
	const chunk = await reader.read();
	expect(chunk.done).toBe(false);
	return decoder.decode(chunk.value);
}

function eventData(chunk) {
	const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
	return JSON.parse(dataLine.slice("data: ".length));
}

describe("StateQuerySseTransportProof", () => {
	it("sends a complete initial snapshot using SSE framing", async () => {
		const hub = new StateQuerySseTransportProof(result(3));
		const response = hub.subscribe();
		const reader = response.body.getReader();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store, no-transform");

		const frame = await readChunk(reader);
		expect(frame).toContain("id: 0\n");
		expect(frame).toContain("event: snapshot\n");
		expect(eventData(frame)).toMatchObject({
			status: "ready",
			data: { deaths: 3 },
			reason: "initial"
		});

		await reader.cancel();
		expect(hub.inspect().connections).toBe(0);
	});

	it("delivers the same full replacement to several observers of one source", async () => {
		const hub = new StateQuerySseTransportProof(result(3));
		const first = hub.subscribe().body.getReader();
		const second = hub.subscribe().body.getReader();
		await Promise.all([readChunk(first), readChunk(second)]);

		hub.publish(result(4));
		const [firstUpdate, secondUpdate] = await Promise.all([
			readChunk(first),
			readChunk(second)
		]);

		for (const frame of [firstUpdate, secondUpdate]) {
			expect(frame).toContain("id: 1\n");
			expect(frame).toContain("event: result\n");
			expect(eventData(frame)).toMatchObject({
				data: { deaths: 4 },
				reason: "value_change"
			});
		}

		await Promise.all([first.cancel(), second.cancel()]);
	});

	it("replays bounded full replacements after Last-Event-ID", async () => {
		const hub = new StateQuerySseTransportProof(result(0));
		hub.publish(result(1));
		hub.publish(result(2));

		const reader = hub.subscribe({ lastEventId: "0" }).body.getReader();
		const first = await readChunk(reader);
		const second = await readChunk(reader);

		expect(first).toContain("id: 1\n");
		expect(eventData(first).data).toEqual({ deaths: 1 });
		expect(second).toContain("id: 2\n");
		expect(eventData(second).data).toEqual({ deaths: 2 });

		await reader.cancel();
	});

	it("resynchronizes when a cursor is invalid, current, future, or expired", async () => {
		const hub = new StateQuerySseTransportProof(result(0), { maxHistoryEvents: 2 });
		hub.publish(result(1));
		hub.publish(result(2));
		hub.publish(result(3));

		for (const cursor of ["0", "3", "999", "not-a-cursor"]) {
			const reader = hub.subscribe({ lastEventId: cursor }).body.getReader();
			const frame = await readChunk(reader);
			expect(frame).toContain("id: 3\n");
			expect(frame).toContain("event: snapshot\n");
			expect(eventData(frame)).toMatchObject({
				data: { deaths: 3 },
				reason: "resynchronized"
			});
			await reader.cancel();
		}
	});

	it("does not retain results from a superseded source binding", async () => {
		const hub = new StateQuerySseTransportProof(result(0));
		hub.publish(result(1));
		hub.publish(result(2));
		hub.publish(result(9, {
			bindingRevision: "binding-2",
			resultRevision: "result-9"
		}), "source_change");

		const reader = hub.subscribe({ lastEventId: "0" }).body.getReader();
		const frame = await readChunk(reader);
		expect(frame).toContain("id: 3\n");
		expect(frame).toContain("event: snapshot\n");
		expect(eventData(frame)).toMatchObject({
			bindingRevision: "binding-2",
			data: { deaths: 9 },
			reason: "resynchronized"
		});
		expect(hub.inspect().historyEvents).toBe(1);

		await reader.cancel();
	});

	it("coalesces a slow consumer to the newest committed result", async () => {
		const hub = new StateQuerySseTransportProof(result(0));
		const reader = hub.subscribe().body.getReader();

		hub.publish(result(1));
		hub.publish(result(2));
		hub.publish(result(3));

		expect(eventData(await readChunk(reader)).data).toEqual({ deaths: 0 });
		expect(eventData(await readChunk(reader)).data).toEqual({ deaths: 3 });
		expect(hub.inspect()).toMatchObject({
			pendingConnections: 0,
			metrics: { coalescedUpdates: 2 }
		});

		await reader.cancel();
	});

	it("keeps idle delivery bounded and never replaces state with a heartbeat", async () => {
		const hub = new StateQuerySseTransportProof(result(0));
		const reader = hub.subscribe().body.getReader();
		await readChunk(reader);

		hub.heartbeat();
		expect(await readChunk(reader)).toBe(": keepalive\n\n");
		expect(hub.inspect()).toMatchObject({
			cursor: "0",
			historyEvents: 0,
			metrics: { heartbeatsSent: 1 }
		});

		await reader.cancel();
	});

	it("rejects excess connections and oversized results", async () => {
		const hub = new StateQuerySseTransportProof(result(0), { maxConnections: 1 });
		const first = hub.subscribe();
		const rejected = hub.subscribe();

		expect(rejected.status).toBe(429);
		expect(await rejected.json()).toEqual({ error: "connection_limit", limit: 1 });
		expect(() => hub.publish(result(1, {
			data: { text: "x".repeat(STATE_QUERY_SSE_PROOF_LIMITS.maxResultBytes) }
		}))).toThrow(/result exceeds/);

		await first.body.cancel();
	});

	it("cleans up all connections when the hub closes", async () => {
		const hub = new StateQuerySseTransportProof(result(0));
		const readers = [hub.subscribe().body.getReader(), hub.subscribe().body.getReader()];
		await Promise.all(readers.map((reader) => readChunk(reader)));

		hub.close();
		expect(hub.inspect()).toMatchObject({
			connections: 0,
			metrics: { attached: 2, detached: 2 }
		});
		expect((await readers[0].read()).done).toBe(true);
		expect((await readers[1].read()).done).toBe(true);
	});
});

describe("state-query transport cost model", () => {
	it("reproduces the representative direct-SSE and hibernation comparison", () => {
		const comparison = compareStateQueryTransports(REPRESENTATIVE_STATE_QUERY_SCENARIO);

		expect(comparison.sharedUsage).toEqual({
			connectionRequests: 30_000,
			notificationRequests: 240_000
		});
		expect(comparison.directSse).toMatchObject({
			requests: 270_000,
			durationGbSeconds: 10_800_000,
			requestCostUsd: 0,
			durationCostUsd: 137.50,
			totalIncrementalUsd: 137.50
		});
		expect(comparison.hibernatingWebSocketRelay).toMatchObject({
			requests: 270_000,
			durationGbSeconds: 300,
			requestCostUsd: 0,
			durationCostUsd: 0,
			totalIncrementalUsd: 0
		});
		expect(comparison.durablePolling).toMatchObject({
			pollRequests: 1_728_000_000,
			requests: 1_728_270_000,
			requestCostUsd: 259.20,
			durationGbSeconds: 432_300,
			durationCostUsd: 12.50,
			continuousActivityDurationCostUsd: 137.50
		});
	});
});
