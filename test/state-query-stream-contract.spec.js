import { describe, expect, it } from "vitest";
import { handleStateQueryRequest } from "../src/state-querying/http.js";
import {
  STATE_QUERY_SOCKET_CLOSE_CODES,
  STATE_QUERY_SOCKET_LIMITS,
  STATE_QUERY_SOCKET_MESSAGE_TYPES,
  STATE_QUERY_SOCKET_PATH,
  STATE_QUERY_SOCKET_PING,
  STATE_QUERY_SOCKET_PONG,
  STATE_QUERY_SOCKET_PROTOCOL
} from "../src/state-querying/stream-contract.js";

describe("state-query stream contract", () => {
  it("publishes one bounded versioned WebSocket vocabulary", () => {
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

  it("removes the retired public polling endpoint", async () => {
    const response = await handleStateQueryRequest(new Request(
      "https://example.com/state-query/stream",
      { method: "POST" }
    ), { STATE_QUERY_STREAMS_ENABLED: "true" });
    expect(response.status).toBe(404);
  });

  it("keeps the master subscription switch authoritative", async () => {
    const response = await handleStateQueryRequest(new Request(
      "https://example.com/state-query/socket",
      { method: "GET", headers: { upgrade: "websocket" } }
    ), { STATE_QUERY_STREAMS_ENABLED: "false" });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("state_query_subscriptions_disabled");
  });
});
