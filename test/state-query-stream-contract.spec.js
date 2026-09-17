import { describe, expect, it } from "vitest";
import { handleStateQueryRequest } from "../src/state-querying/http.js";
import {
  pollStateQueryStream,
  registerPolledStateQueryStream
} from "../src/state-querying/sse.js";
import {
  STATE_QUERY_SOCKET_CLOSE_CODES,
  STATE_QUERY_SOCKET_LIMITS,
  STATE_QUERY_SOCKET_MESSAGE_TYPES,
  STATE_QUERY_SOCKET_PATH,
  STATE_QUERY_SOCKET_PING,
  STATE_QUERY_SOCKET_PONG,
  STATE_QUERY_SOCKET_PROTOCOL,
  STATE_QUERY_STREAM_TRANSPORTS,
  stateQueryStreamTransport
} from "../src/state-querying/stream-contract.js";

describe("state-query stream transport contract", () => {
  it("selects only the two documented transports and preserves the polling default", () => {
    expect(stateQueryStreamTransport({})).toBe("polling_sse");
    expect(stateQueryStreamTransport({ STATE_QUERY_STREAM_TRANSPORT: "polling_sse" }))
      .toBe("polling_sse");
    expect(stateQueryStreamTransport({
      STATE_QUERY_STREAM_TRANSPORT: "hibernating_websocket"
    })).toBe("hibernating_websocket");
    expect(stateQueryStreamTransport({ STATE_QUERY_STREAM_TRANSPORT: "" })).toBeNull();
    expect(stateQueryStreamTransport({ STATE_QUERY_STREAM_TRANSPORT: "POLLING_SSE" }))
      .toBeNull();
    expect(stateQueryStreamTransport({ STATE_QUERY_STREAM_TRANSPORT: true })).toBeNull();
    expect(STATE_QUERY_STREAM_TRANSPORTS).toEqual({
      pollingSse: "polling_sse",
      hibernatingWebSocket: "hibernating_websocket"
    });
    expect(Object.isFrozen(STATE_QUERY_STREAM_TRANSPORTS)).toBe(true);
  });

  it("publishes one bounded versioned socket vocabulary", () => {
    expect(STATE_QUERY_SOCKET_PATH).toBe("/state-query/socket");
    expect(STATE_QUERY_SOCKET_PROTOCOL).toBe("state-query-socket/v1");
    expect(STATE_QUERY_SOCKET_PING).toBe("state-query-ping/v1");
    expect(STATE_QUERY_SOCKET_PONG).toBe("state-query-pong/v1");
    expect(STATE_QUERY_SOCKET_MESSAGE_TYPES).toEqual({
      register: "register",
      acknowledge: "ack",
      event: "event",
      error: "error"
    });
    expect(STATE_QUERY_SOCKET_CLOSE_CODES).toEqual({
      normal: 1000,
      policyViolation: 1008,
      messageTooLarge: 1009,
      internalError: 1011,
      serviceRestart: 1012,
      tryAgainLater: 1013
    });
    expect(STATE_QUERY_SOCKET_LIMITS).toMatchObject({
      maxRegistrationFrameBytes: 384 * 1024,
      maxControlFrameBytes: 1024,
      maxCursorCharacters: 256,
      maxUnacknowledgedEvents: 1
    });
    for (const value of [
      STATE_QUERY_SOCKET_MESSAGE_TYPES,
      STATE_QUERY_SOCKET_CLOSE_CODES,
      STATE_QUERY_SOCKET_LIMITS
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("fails closed before authentication when an unavailable transport is selected", async () => {
    for (const selected of ["hibernating_websocket", "invalid"]) {
      const response = await handleStateQueryRequest(new Request(
        "https://example.com/state-query/stream",
        { method: "POST" }
      ), {
        STATE_QUERY_STREAMS_ENABLED: "true",
        STATE_QUERY_STREAM_TRANSPORT: selected
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "state_query_transport_unavailable",
          message: "The configured state-query subscription transport is unavailable."
        }
      });
    }
  });

  it("also closes the internal polling boundary when socket mode is selected", async () => {
    const socketEnv = {
      STATE_QUERY_STREAMS_ENABLED: "true",
      STATE_QUERY_STREAM_TRANSPORT: "hibernating_websocket"
    };
    for (const operation of [
      () => registerPolledStateQueryStream(null, socketEnv, {}),
      () => pollStateQueryStream(null, socketEnv, {})
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 503,
        code: "state_query_transport_unavailable"
      });
    }
  });

  it("keeps the master subscription switch authoritative", async () => {
    const response = await handleStateQueryRequest(new Request(
      "https://example.com/state-query/stream",
      { method: "POST" }
    ), {
      STATE_QUERY_STREAMS_ENABLED: "false",
      STATE_QUERY_STREAM_TRANSPORT: "invalid"
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("state_query_subscriptions_disabled");
  });
});
