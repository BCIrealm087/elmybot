// Browser-only durable-event client: no Worker, feature, or storage imports.
const protocol = "durable-event-socket/v1";
const ping = "durable-event-ping/v1";
const pong = "durable-event-pong/v1";
const eventIdPattern = /^dev1\.[A-Za-z0-9_-]{43}$/;
const cursorPattern = /^dec1\.[A-Za-z0-9_-]{43}$/;

function failure(message, code, terminal = true) {
  return Object.assign(new Error(message), { code, terminal });
}

function validStream(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof value.feature === "string" && value.feature.length > 0 &&
    typeof value.stream === "string" && value.stream.length > 0 &&
    Number.isSafeInteger(value.version) && value.version > 0;
}

function validDelivery(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    value.kind === "bounded_at_least_once" &&
    Number.isSafeInteger(value.retentionSeconds) && value.retentionSeconds > 0 &&
    Number.isSafeInteger(value.maxRetainedEvents) && value.maxRetainedEvents > 0 &&
    Number.isSafeInteger(value.maxRetainedBytes) && value.maxRetainedBytes > 0;
}

function eventFrame(message, expectedStream) {
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      message.protocol !== protocol || message.type !== "event" ||
      !validStream(message.stream) ||
      message.stream.feature !== expectedStream.feature ||
      message.stream.stream !== expectedStream.stream ||
      message.stream.version !== expectedStream.version ||
      !eventIdPattern.test(message.eventId ?? "") ||
      !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
      !cursorPattern.test(message.cursor ?? "") ||
      typeof message.acceptedAt !== "string" ||
      !Number.isFinite(Date.parse(message.acceptedAt)) ||
      typeof message.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(message.expiresAt)) ||
      !("payload" in message)) {
    throw failure("Invalid durable-event frame.", "client_protocol_error");
  }
  return message;
}

function terminalMessage(code) {
  return ({
    grant_expired: "The event grant expired.",
    grant_revoked: "The event grant was revoked.",
    grant_replaced: "The event grant was replaced.",
    consumer_replaced: "Another consumer replaced this browser.",
    stream_moved: "The event stream moved. Create a new grant for its current owner.",
    retention_gap: "An unacknowledged event expired. An operator must reset the backlog.",
    service_disabled: "Durable event delivery is disabled.",
    internal_error: "Durable event delivery ended unexpectedly."
  })[code] ?? "Durable event delivery ended.";
}

export function createRecentEventIdDeduplicator({
  storage,
  storageKey = "elmybot.durable-event.recent.v1",
  maxEntries = 100
} = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000) {
    throw new Error("Recent event-ID capacity must be between 1 and 1000.");
  }
  if (typeof storageKey !== "string" || storageKey.length < 1 || storageKey.length > 200) {
    throw new Error("Recent event-ID storage key is invalid.");
  }
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  let recent = [];
  try {
    const parsed = JSON.parse(storage?.getItem(storageKey) ?? "[]");
    if (Array.isArray(parsed)) {
      recent = [...new Set(parsed.filter((value) => eventIdPattern.test(value)))].slice(-maxEntries);
    }
  } catch { /* Storage is optional; keep an in-memory bounded list. */ }
  const persist = () => {
    try { storage?.setItem(storageKey, JSON.stringify(recent)); } catch { /* optional */ }
  };
  const requireEventId = (value) => {
    const eventId = typeof value === "string" ? value : value?.eventId;
    if (!eventIdPattern.test(eventId ?? "")) throw new Error("A valid durable event ID is required.");
    return eventId;
  };
  const remember = (value) => {
    const eventId = requireEventId(value);
    recent = [...recent.filter((candidate) => candidate !== eventId), eventId]
      .slice(-maxEntries);
    persist();
  };
  return Object.freeze({
    has(value) { return recent.includes(requireEventId(value)); },
    remember,
    clear() { recent = []; persist(); },
    values() { return Object.freeze([...recent]); },
    async handle(event, handler) {
      if (typeof handler !== "function") throw new TypeError("An event handler is required.");
      if (recent.includes(requireEventId(event))) return Object.freeze({ duplicate: true });
      await handler(event);
      remember(event);
      return Object.freeze({ duplicate: false });
    }
  });
}

export function createDurableEventClient({
  baseUrl = globalThis.location?.origin,
  fetch: request = globalThis.fetch.bind(globalThis),
  openWebSocket = (url) => new globalThis.WebSocket(url),
  retryMs = 1_000,
  heartbeatMs = 30_000,
  heartbeatTimeoutMs = 90_000
} = {}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || !/^https?:$/.test(base.protocol)) {
    throw new Error("A valid HTTP origin is required.");
  }
  for (const [name, value] of Object.entries({ retryMs, heartbeatMs, heartbeatTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  }
  const socketUrl = new URL("/event-stream/socket", base.origin);
  socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const encoder = new TextEncoder();
  let listener = null;
  let activeSocket = null;
  let retryTimer = null;
  let generation = 0;
  let scheduled = false;
  let closed = false;
  let cancelConnection = null;
  let running = Promise.resolve();

  const notify = (value) => {
    try { listener?.onStatus?.(value); } catch { /* Status callbacks do not own delivery. */ }
  };
  async function http(path, init = {}) {
    const response = await request(new URL(`/event-stream/${path}`, base.origin), {
      credentials: "same-origin",
      cache: "no-store",
      ...init
    });
    if (!response.ok) {
      let error;
      try { error = (await response.json()).error; } catch { /* generic HTTP failure */ }
      throw failure(
        error?.message ?? `Durable event request failed (${response.status}).`,
        error?.code ?? `http_${response.status}`,
        response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)
      );
    }
    return response;
  }
  function stopSocket(reason = "Client reconfigured") {
    clearTimeout(retryTimer);
    retryTimer = null;
    const cancel = cancelConnection;
    cancelConnection = null;
    cancel?.();
    const socket = activeSocket;
    activeSocket = null;
    if (socket && socket.readyState < 2) {
      try { socket.close(1000, reason); } catch { /* already disconnected */ }
    }
  }
  function restart() {
    generation += 1;
    stopSocket();
    if (scheduled || closed || !listener) return;
    scheduled = true;
    const selectedGeneration = generation;
    queueMicrotask(() => {
      scheduled = false;
      if (!closed && listener && selectedGeneration === generation) {
        running = connect(selectedGeneration, 0);
      }
    });
  }
  async function connect(selectedGeneration, attempt) {
    if (closed || !listener || selectedGeneration !== generation) return;
    notify({ state: attempt ? "reconnecting" : "connecting", stale: true });
    let socket;
    let watchdog;
    let heartbeat;
    let ready = null;
    let processing = false;
    let serverError = null;
    let currentCancellation = null;
    const current = () => !closed && listener && selectedGeneration === generation;
    const armWatchdog = (reject) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try { socket?.close(1012, "Peer became stale"); } catch { /* disconnected */ }
        reject(failure("Socket became stale.", "disconnected", false));
      }, heartbeatTimeoutMs);
    };
    const send = (value) => {
      if (socket?.readyState !== 1) throw failure("Socket disconnected.", "disconnected", false);
      socket.send(typeof value === "string" ? value : JSON.stringify(value));
    };
    try {
      socket = await openWebSocket(socketUrl.href);
      if (!socket || typeof socket.addEventListener !== "function") {
        throw failure("A WebSocket connection is unavailable.", "client_protocol_error");
      }
      if (!current()) {
        try { socket.close(1000, "Obsolete connection"); } catch { /* disconnected */ }
        return;
      }
      activeSocket = socket;
      await new Promise((resolve, reject) => {
        let settled = false;
        let opened = false;
        const settle = (operation, value) => {
          if (settled) return;
          settled = true;
          operation(value);
        };
        currentCancellation = () => settle(resolve);
        cancelConnection = currentCancellation;
        const protocolFailure = (message) => {
          const error = failure(message, "client_protocol_error");
          settle(reject, error);
          try { socket.close(1002, "Protocol error"); } catch { /* disconnected */ }
        };
        const onOpen = () => {
          if (opened || settled) return;
          opened = true;
          try {
            send({ protocol, type: "register" });
            armWatchdog((error) => settle(reject, error));
            heartbeat = setInterval(() => {
              try { send(ping); } catch (error) { settle(reject, error); }
            }, heartbeatMs);
          } catch (error) { settle(reject, error); }
        };
        const onMessage = (event) => {
          if (settled) return;
          armWatchdog((error) => settle(reject, error));
          if (event.data === pong) return;
          if (typeof event.data !== "string" ||
              encoder.encode(event.data).byteLength > 8_192) {
            settle(reject, failure("Socket frame exceeds the limit.", "client_frame_limit"));
            try { socket.close(1009, "Message too large"); } catch { /* disconnected */ }
            return;
          }
          let message;
          try { message = JSON.parse(event.data); } catch {
            protocolFailure("Invalid durable-event message.");
            return;
          }
          if (!message || typeof message !== "object" || Array.isArray(message) ||
              message.protocol !== protocol) {
            protocolFailure("Invalid durable-event protocol.");
            return;
          }
          if (message.type === "error") {
            serverError = {
              code: typeof message.code === "string" ? message.code : "socket_policy_violation",
              message: typeof message.message === "string"
                ? message.message
                : "Durable event socket was rejected."
            };
            return;
          }
          if (message.type === "ready") {
            if (ready || !validStream(message.stream) || !validDelivery(message.delivery)) {
              protocolFailure("Invalid durable-event ready frame.");
              return;
            }
            ready = { stream: message.stream, delivery: message.delivery };
            attempt = 0;
            notify({ state: "live", stale: false, ...ready });
            return;
          }
          if (message.type === "status") {
            if (message.terminal !== true || typeof message.code !== "string") {
              protocolFailure("Invalid durable-event status frame.");
              return;
            }
            const error = failure(terminalMessage(message.code), message.code);
            settle(reject, error);
            try { socket.close(1000, "Stream ended"); } catch { /* disconnected */ }
            return;
          }
          if (message.type !== "event" || !ready || processing) {
            protocolFailure("Unexpected durable-event message.");
            return;
          }
          let accepted;
          try { accepted = eventFrame(message, ready.stream); } catch (error) {
            settle(reject, error);
            try { socket.close(1002, "Protocol error"); } catch { /* disconnected */ }
            return;
          }
          processing = true;
          const handler = listener.handler;
          notify({ state: "handling", stale: false, ...ready, eventId: accepted.eventId });
          Promise.resolve().then(() => handler(accepted)).then(() => {
            if (!settled && current()) {
              send({ protocol, type: "ack", cursor: accepted.cursor });
              notify({ state: "live", stale: false, ...ready });
            }
          }).catch(() => {
            settle(reject, failure(
              "The event handler failed. The event will be replayed.",
              "handler_failed",
              false
            ));
            try { socket.close(1012, "Handler failed"); } catch { /* disconnected */ }
          }).finally(() => { processing = false; });
        };
        const onClose = (event) => {
          if (!current()) return settle(resolve);
          const terminal = serverError !== null || [1002, 1008, 1009].includes(event.code);
          settle(reject, failure(
            serverError?.message ?? "Socket disconnected.",
            serverError?.code ?? (terminal ? "socket_policy_violation" : "disconnected"),
            terminal
          ));
        };
        const onError = () => {
          settle(reject, failure("Socket disconnected.", "disconnected", false));
          try { socket.close(); } catch { /* disconnected */ }
        };
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose, { once: true });
        socket.addEventListener("error", onError, { once: true });
        armWatchdog((error) => settle(reject, error));
        if (socket.readyState === 1) queueMicrotask(onOpen);
      });
    } catch (error) {
      if (!current()) return;
      if (error.terminal || error instanceof SyntaxError) {
        notify({
          state: "ended",
          stale: true,
          code: error.code ?? "client_protocol_error",
          message: error.message
        });
      } else {
        notify({
          state: error.code === "handler_failed" ? "handler_failed" : "reconnecting",
          stale: true,
          code: error.code,
          message: error.message
        });
        retryTimer = setTimeout(() => {
          running = connect(selectedGeneration, attempt + 1);
        }, Math.min(30_000, retryMs * 2 ** Math.min(attempt, 5)));
      }
    } finally {
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      if (cancelConnection === currentCancellation) cancelConnection = null;
      if (activeSocket === socket) activeSocket = null;
      if (socket?.readyState < 2) {
        try { socket.close(1000, "Connection finished"); } catch { /* disconnected */ }
      }
    }
  }
  return Object.freeze({
    async catalog() { return (await http("catalog")).json(); },
    async session(credential) {
      if (typeof credential !== "string" || !credential || /\s/.test(credential)) {
        throw new Error("Enter an event grant.");
      }
      await http("session", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}` }
      });
      if (listener) restart();
    },
    async logout() {
      generation += 1;
      listener = null;
      stopSocket("Signed out");
      await http("session", { method: "DELETE" });
    },
    subscribe(handler, { onStatus } = {}) {
      if (closed) throw new Error("This durable-event client is closed.");
      if (listener) throw new Error("A durable-event client supports one active handler.");
      if (typeof handler !== "function") throw new TypeError("An event handler is required.");
      listener = { handler, onStatus };
      restart();
      let removed = false;
      return Object.freeze({ unsubscribe() {
        if (removed) return;
        removed = true;
        generation += 1;
        listener = null;
        stopSocket("Consumer stopped");
      } });
    },
    close() {
      if (closed) return running;
      closed = true;
      generation += 1;
      notify({ state: "closed", stale: true });
      listener = null;
      stopSocket("Client closed");
      return running;
    }
  });
}
