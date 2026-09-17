// Browser-only client: no Worker, feature, or storage imports.
export function createStateQueryClient({
  baseUrl = globalThis.location?.origin,
  fetch: request = globalThis.fetch.bind(globalThis),
  openWebSocket = (url) => new globalThis.WebSocket(url),
  retryMs = 1000,
  heartbeatMs = 30_000,
  heartbeatTimeoutMs = 90_000
} = {}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || !/^https?:$/.test(base.protocol)) {
    throw new Error("A valid HTTP origin is required.");
  }
  const socketUrl = new URL("/state-query/socket", base.origin);
  socketUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const entries = new Map();
  let serial = 0;
  let epoch = 0;
  let activeSocket = null;
  let timer = null;
  let cursor = null;
  let subscriptionId = null;
  let closed = false;
  let scheduled = false;
  let running = Promise.resolve();
  const encoder = new TextEncoder();
  const maxFrameBytes = 300 * 1024;
  const protocol = "state-query-socket/v1";
  const ping = "state-query-ping/v1";
  const pong = "state-query-pong/v1";
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  const notify = (entry, kind, value) => {
    for (const listener of entry.listeners) {
      try { listener[kind]?.(value); } catch { /* A consumer cannot interrupt other subscriptions. */ }
    }
  };
  const status = (value) => {
    for (const entry of entries.values()) {
      entry.status = value;
      notify(entry, "onStatus", value);
    }
  };
  const failure = (message, code, terminal = true) => Object.assign(new Error(message), { code, terminal });
  async function http(path, init = {}) {
    const response = await request(new URL(`/state-query/${path}`, base.origin), {
      credentials: "same-origin", cache: "no-store", ...init
    });
    if (!response.ok) {
      let error;
      try { error = (await response.json()).error; } catch { /* generic HTTP failure */ }
      throw failure(error?.message ?? `State query request failed (${response.status}).`,
        error?.code ?? `http_${response.status}`,
        response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status));
    }
    return response;
  }
  function stop() {
    epoch += 1;
    const socket = activeSocket;
    activeSocket = null;
    clearTimeout(timer);
    timer = null;
    if (socket && socket.readyState < 2) {
      try { socket.close(1000, "Client reconfigured"); } catch { /* already disconnected */ }
    }
  }
  function restart() {
    stop();
    cursor = null;
    subscriptionId = null;
    if (scheduled || closed || entries.size === 0) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!closed && entries.size) running = connect(epoch, 0);
    });
  }
  async function connect(generation, attempt) {
    if (closed || generation !== epoch || entries.size === 0) return;
    status({ state: attempt ? "reconnecting" : "connecting", stale: true });
    let socket;
    let watchdog;
    let heartbeat;
    let receivedSnapshot = false;
    let lastEventSequence = 0;
    let serverError = null;
    const sequences = new Map();
    const armWatchdog = (reject) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try { socket?.close(1012, "Peer became stale"); } catch { /* already disconnected */ }
        reject(failure("Socket became stale.", "disconnected", false));
      }, heartbeatTimeoutMs);
    };
    const send = (value) => {
      if (socket?.readyState !== 1) throw failure("Socket disconnected.", "disconnected", false);
      socket.send(typeof value === "string" ? value : JSON.stringify(value));
    };
    const acknowledge = (event) => send({ protocol, type: "ack", cursor: event.cursor });
    const acceptEvent = (message) => {
      if (!message.event || typeof message.event !== "object" || Array.isArray(message.event)) {
        throw failure("Invalid socket event.", "client_protocol_error");
      }
      const event = message.event;
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
          typeof event.cursor !== "string" || !event.cursor || event.cursor.length > 256 ||
          !["snapshot", "update", "status"].includes(event.eventType)) {
        throw failure("Invalid socket event.", "client_protocol_error");
      }
      const payload = event.payload;
      if (!payload || typeof payload !== "object" ||
          payload.protocol !== "state-query-stream/v1" ||
          typeof payload.subscriptionId !== "string" || !payload.subscriptionId ||
          !Array.isArray(payload.results)) {
        throw failure("Invalid socket result.", "client_protocol_error");
      }
      if (!receivedSnapshot && event.eventType !== "snapshot" && event.eventType !== "status") {
        throw failure("A replacement snapshot is required.", "client_protocol_error");
      }
      if (event.sequence <= lastEventSequence) {
        acknowledge(event);
        return;
      }
      if (event.eventType !== "snapshot" && subscriptionId &&
          payload.subscriptionId !== subscriptionId) {
        throw failure("Socket subscription changed without a snapshot.", "client_protocol_error");
      }
      if (event.eventType === "snapshot") {
        const ids = new Set(payload.results.map((result) => result?.queryId));
        if ([...entries.values()].some((entry) => !ids.has(entry.id))) {
          throw failure("Incomplete replacement snapshot.", "client_protocol_error");
        }
        receivedSnapshot = true;
        sequences.clear();
        attempt = 0;
      }
      for (const result of payload.results) {
        if (!result || typeof result !== "object" || typeof result.queryId !== "string") {
          throw failure("Invalid socket result.", "client_protocol_error");
        }
        const entry = [...entries.values()].find((candidate) => candidate.id === result.queryId);
        if (!entry) continue;
        if (event.eventType !== "status" &&
            (!Number.isSafeInteger(result.sequence) || result.sequence < 1)) {
          throw failure("Invalid result sequence.", "client_protocol_error");
        }
        if (event.eventType !== "status" && result.sequence <= (sequences.get(entry.id) ?? 0)) continue;
        if (event.eventType !== "status") sequences.set(entry.id, result.sequence);
        entry.result = result;
        notify(entry, "onResult", result);
      }
      lastEventSequence = event.sequence;
      cursor = event.cursor;
      subscriptionId = payload.subscriptionId;
      acknowledge(event);
      if (event.eventType === "status") {
        throw failure("Subscription ended. Check or replace the read grant.",
          payload.results.find((result) => result.error)?.error.code ?? "subscription_ended");
      }
      status({ state: "live", stale: false });
    };
    try {
      socket = await openWebSocket(socketUrl.href);
      if (!socket || typeof socket.addEventListener !== "function") {
        throw failure("A WebSocket connection is unavailable.", "client_protocol_error");
      }
      if (closed || generation !== epoch) {
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
        const onOpen = () => {
          if (opened || settled) return;
          opened = true;
          try {
            send({
              protocol,
              type: "register",
              queries: [...entries.values()].map(({ id, query }) => ({ id, query })),
              ...(subscriptionId ? { subscriptionId } : {}),
              ...(cursor ? { cursor } : {})
            });
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
          try {
            if (typeof event.data !== "string" || encoder.encode(event.data).byteLength > maxFrameBytes) {
              throw failure("Socket frame exceeds the limit.", "client_frame_limit");
            }
            const message = JSON.parse(event.data);
            if (!message || typeof message !== "object" || message.protocol !== protocol) {
              throw failure("Invalid socket protocol.", "client_protocol_error");
            }
            if (message.type === "error") {
              serverError = message.error;
              return;
            }
            if (message.type !== "event") {
              throw failure("Unknown socket message.", "client_protocol_error");
            }
            acceptEvent(message);
          } catch (error) {
            const acceptedError = error instanceof SyntaxError
              ? failure("Invalid socket message.", "client_protocol_error")
              : error;
            settle(reject, acceptedError);
            try {
              const closeCode = acceptedError.code === "client_frame_limit"
                ? 1009
                : acceptedError.code === "client_protocol_error" ? 1002 : 1000;
              socket.close(closeCode, closeCode === 1009
                ? "Message too large"
                : closeCode === 1002 ? "Protocol error" : "Subscription ended");
            } catch { /* disconnected */ }
          }
        };
        const onClose = (event) => {
          if (closed || generation !== epoch) return settle(resolve);
          const terminal = [1002, 1008, 1009].includes(event.code);
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
      if (closed || generation !== epoch) return;
      if (error.terminal || error instanceof SyntaxError) {
        for (const entry of entries.values()) entry.result = null;
        status({ state: "ended", stale: true, code: error.code ?? "client_protocol_error", message: error.message });
      } else {
        status({ state: "reconnecting", stale: true });
        timer = setTimeout(() => { running = connect(generation, attempt + 1); },
          Math.min(30_000, retryMs * 2 ** Math.min(attempt, 5)));
      }
    } finally {
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      if (activeSocket === socket) activeSocket = null;
      if (socket?.readyState < 2) {
        try { socket.close(1000, "Connection finished"); } catch { /* disconnected */ }
      }
    }
  }
  return Object.freeze({
    async catalog() { return (await http("catalog")).json(); },
    async read(query) {
      return (await http("snapshot", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(query) })).json();
    },
    async session(credential) {
      if (typeof credential !== "string" || !credential || /\s/.test(credential)) throw new Error("Enter a read grant.");
      await http("session", { method: "POST", headers: { authorization: `Bearer ${credential}` } });
      // A new identity must not receive values cached under the previous grant.
      for (const entry of entries.values()) entry.result = null;
      restart();
    },
    async logout() { stop(); entries.clear(); await http("session", { method: "DELETE" }); },
    watch(document, listener = {}) {
      if (closed) throw new Error("This query client is closed.");
      const key = JSON.stringify(canonical(document));
      if (!key || encoder.encode(key).byteLength > 16 * 1024) throw new Error("Query exceeds the document limit.");
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= 20) throw new Error("A client supports at most 20 distinct queries.");
        entry = { id: `q${++serial}`, query: JSON.parse(key), listeners: new Set(), result: null };
        entries.set(key, entry);
      }
      if (entry.listeners.size >= 100) throw new Error("At most 100 listeners may share a query.");
      listener = { onResult: listener.onResult, onStatus: listener.onStatus };
      entry.listeners.add(listener);
      if (entry.result) { try { listener.onResult?.(entry.result); } catch { /* consumer */ } }
      if (entry.status) { try { listener.onStatus?.(entry.status); } catch { /* consumer */ } }
      if (entry.listeners.size === 1) restart();
      let removed = false;
      return Object.freeze({ unsubscribe() {
        if (removed) return;
        removed = true;
        entry.listeners.delete(listener);
        if (!entry.listeners.size && entries.get(key) === entry) { entries.delete(key); restart(); }
      } });
    },
    close() { closed = true; stop(); status({ state: "closed", stale: true }); entries.clear(); return running; }
  });
}
