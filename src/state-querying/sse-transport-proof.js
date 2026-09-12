const DEFAULT_LIMITS = Object.freeze({
	maxConnections: 20,
	maxHistoryEvents: 64,
	maxResultBytes: 64 * 1024,
	maxReplayBytes: 256 * 1024
});

const encoder = new TextEncoder();

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function assertResultEnvelope(result, maxResultBytes) {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new TypeError("result must be an object");
	}

	const bytes = encoder.encode(JSON.stringify(result)).byteLength;
	if (bytes > maxResultBytes) {
		throw new RangeError(`result exceeds the ${maxResultBytes}-byte proof limit`);
	}
}

function encodeEvent({ id, event, data }) {
	return encoder.encode(
		`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
	);
}

function parseCursor(value) {
	if (value === undefined || value === null || value === "") {
		return null;
	}

	if (!/^\d+$/.test(String(value))) {
		return Number.NaN;
	}

	return Number(value);
}

/**
 * A bounded, in-memory proof of the state-query SSE delivery contract.
 *
 * This deliberately is not a production registry, persistence layer, route, or
 * authorization boundary. It exists to exercise Web Streams behavior in the
 * Cloudflare Vitest runtime before step 9 connects the real query engine.
 */
export class StateQuerySseTransportProof {
	constructor(initialResult, options = {}) {
		this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options });
		assertResultEnvelope(initialResult, this.limits.maxResultBytes);

		this.currentResult = clone(initialResult);
		this.cursor = 0;
		this.nextConnectionId = 1;
		this.connections = new Map();
		this.history = [];
		this.metrics = {
			attached: 0,
			detached: 0,
			coalescedUpdates: 0,
			heartbeatsSent: 0,
			heartbeatsSkipped: 0,
			resynchronizations: 0
		};
	}

	subscribe({ lastEventId } = {}) {
		if (this.connections.size >= this.limits.maxConnections) {
			return new Response(JSON.stringify({
				error: "connection_limit",
				limit: this.limits.maxConnections
			}), {
				status: 429,
				headers: { "content-type": "application/json; charset=utf-8" }
			});
		}

		const connectionId = this.nextConnectionId++;
		const initialEvents = this.#eventsForAttachment(lastEventId);
		let connection;

		const body = new ReadableStream({
			start: (controller) => {
				connection = {
					controller,
					pending: null,
					closed: false
				};
				this.connections.set(connectionId, connection);
				this.metrics.attached += 1;

				for (const event of initialEvents) {
					controller.enqueue(event.bytes);
				}
			},
			pull: () => {
				this.#flushPending(connection);
			},
			cancel: () => {
				this.#detach(connectionId);
			}
		});

		return new Response(body, {
			status: 200,
			headers: {
				"cache-control": "no-store, no-transform",
				"content-type": "text/event-stream; charset=utf-8"
			}
		});
	}

	publish(nextResult, reason = "value_change") {
		assertResultEnvelope(nextResult, this.limits.maxResultBytes);
		this.currentResult = clone(nextResult);
		this.cursor += 1;

		const event = this.#makeEvent("result", reason);
		if (reason === "source_change") {
			this.history = [];
		}
		this.history.push(event);
		while (this.history.length > this.limits.maxHistoryEvents) {
			this.history.shift();
		}

		for (const connection of this.connections.values()) {
			this.#sendOrCoalesce(connection, event);
		}

		return String(this.cursor);
	}

	heartbeat() {
		const heartbeat = encoder.encode(": keepalive\n\n");
		for (const connection of this.connections.values()) {
			if (!connection.closed && !connection.pending && connection.controller.desiredSize > 0) {
				connection.controller.enqueue(heartbeat);
				this.metrics.heartbeatsSent += 1;
			} else {
				this.metrics.heartbeatsSkipped += 1;
			}
		}
	}

	close() {
		for (const [connectionId, connection] of this.connections) {
			if (!connection.closed) {
				connection.closed = true;
				connection.controller.close();
			}
			this.connections.delete(connectionId);
			this.metrics.detached += 1;
		}
	}

	inspect() {
		return {
			connections: this.connections.size,
			cursor: String(this.cursor),
			historyEvents: this.history.length,
			pendingConnections: [...this.connections.values()]
				.filter((connection) => connection.pending !== null).length,
			metrics: { ...this.metrics }
		};
	}

	#eventsForAttachment(lastEventId) {
		const requestedCursor = parseCursor(lastEventId);
		if (requestedCursor === null) {
			return [this.#makeEvent("snapshot", "initial")];
		}

		const earliestReplayable = this.history.length > 0
			? this.history[0].cursor - 1
			: this.cursor;
		const canReplay = Number.isSafeInteger(requestedCursor)
			&& requestedCursor >= earliestReplayable
			&& requestedCursor < this.cursor;

		if (canReplay) {
			const replay = this.history.filter((event) => event.cursor > requestedCursor);
			const replayBytes = replay.reduce((total, event) => total + event.bytes.byteLength, 0);
			if (replay.length > 0 && replayBytes <= this.limits.maxReplayBytes) {
				return replay;
			}
		}

		this.metrics.resynchronizations += 1;
		return [this.#makeEvent("snapshot", "resynchronized")];
	}

	#makeEvent(event, reason) {
		const data = {
			...clone(this.currentResult),
			reason
		};

		return {
			cursor: this.cursor,
			bytes: encodeEvent({
				id: String(this.cursor),
				event,
				data
			})
		};
	}

	#sendOrCoalesce(connection, event) {
		if (connection.closed) {
			return;
		}

		if (connection.pending === null && connection.controller.desiredSize > 0) {
			connection.controller.enqueue(event.bytes);
			return;
		}

		if (connection.pending !== null) {
			this.metrics.coalescedUpdates += 1;
		}
		connection.pending = event.bytes;
	}

	#flushPending(connection) {
		if (!connection || connection.closed || connection.pending === null) {
			return;
		}

		const pending = connection.pending;
		connection.pending = null;
		connection.controller.enqueue(pending);
	}

	#detach(connectionId) {
		const connection = this.connections.get(connectionId);
		if (!connection) {
			return;
		}

		connection.closed = true;
		connection.pending = null;
		this.connections.delete(connectionId);
		this.metrics.detached += 1;
	}
}

export const STATE_QUERY_SSE_PROOF_LIMITS = DEFAULT_LIMITS;
