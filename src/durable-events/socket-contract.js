export const DURABLE_EVENT_SOCKET_PROTOCOL = "durable-event-socket/v1";
export const DURABLE_EVENT_SOCKET_PING = "durable-event-ping/v1";
export const DURABLE_EVENT_SOCKET_PONG = "durable-event-pong/v1";

export const DURABLE_EVENT_SOCKET_TYPES = Object.freeze({
  register: "register",
  ready: "ready",
  event: "event",
  acknowledge: "ack",
  status: "status",
  error: "error"
});

export const DURABLE_EVENT_SOCKET_STATUS = Object.freeze({
  grantExpired: "grant_expired",
  grantRevoked: "grant_revoked",
  grantReplaced: "grant_replaced",
  consumerReplaced: "consumer_replaced",
  streamMoved: "stream_moved",
  retentionGap: "retention_gap",
  serviceDisabled: "service_disabled",
  internalError: "internal_error"
});

export const DURABLE_EVENT_SOCKET_CLOSE_CODES = Object.freeze({
  normal: 1000,
  policyViolation: 1008,
  messageTooLarge: 1009,
  internalError: 1011,
  replaced: 1012,
  tryAgainLater: 1013
});

export const DURABLE_EVENT_SOCKET_LIMITS = Object.freeze({
  maxRegistrationFrameBytes: 1_024,
  maxControlFrameBytes: 1_024,
  maxServerEventFrameBytes: 8_192
});
