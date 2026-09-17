export const STATE_QUERY_STREAM_TRANSPORTS = Object.freeze({
  pollingSse: "polling_sse",
  hibernatingWebSocket: "hibernating_websocket"
});

const configuredTransports = new Set(Object.values(STATE_QUERY_STREAM_TRANSPORTS));

// An omitted selector preserves the already-deployed Step 9 behavior. Invalid
// values are deliberately distinct from the default so callers can fail closed.
export function stateQueryStreamTransport(env) {
  const selected = env?.STATE_QUERY_STREAM_TRANSPORT;
  if (selected === undefined) return STATE_QUERY_STREAM_TRANSPORTS.pollingSse;
  return configuredTransports.has(selected) ? selected : null;
}

export const STATE_QUERY_SOCKET_PATH = "/state-query/socket";
export const STATE_QUERY_SOCKET_PROTOCOL = "state-query-socket/v1";
export const STATE_QUERY_SOCKET_PING = "state-query-ping/v1";
export const STATE_QUERY_SOCKET_PONG = "state-query-pong/v1";

export const STATE_QUERY_SOCKET_MESSAGE_TYPES = Object.freeze({
  register: "register",
  acknowledge: "ack",
  event: "event",
  error: "error"
});

export const STATE_QUERY_SOCKET_CLOSE_CODES = Object.freeze({
  normal: 1000,
  policyViolation: 1008,
  messageTooLarge: 1009,
  internalError: 1011,
  serviceRestart: 1012,
  tryAgainLater: 1013
});

export const STATE_QUERY_SOCKET_LIMITS = Object.freeze({
  // Twenty 16-KiB query documents plus their registration envelope fit while
  // retaining a fixed bound below the platform message limit.
  maxRegistrationFrameBytes: 384 * 1024,
  maxControlFrameBytes: 1024,
  maxCursorCharacters: 256,
  maxUnacknowledgedEvents: 1,
  heartbeatMs: 30 * 1000,
  staleAfterMs: 90 * 1000
});
