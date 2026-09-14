// Browser-only client: no Worker, feature, or storage imports.
export function createStateQueryClient({
  baseUrl = globalThis.location?.origin,
  fetch: request = globalThis.fetch.bind(globalThis),
  retryMs = 1000,
  heartbeatTimeoutMs = 60_000
} = {}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || !/^https?:$/.test(base.protocol)) {
    throw new Error("A valid HTTP origin is required.");
  }
  const entries = new Map();
  let serial = 0;
  let epoch = 0;
  let controller = null;
  let activeReader = null;
  let timer = null;
  let cursor = null;
  let closed = false;
  let scheduled = false;
  let running = Promise.resolve();
  const encoder = new TextEncoder();
  const maxFrameBytes = 300 * 1024;
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
    const previousController = controller;
    const previousReader = activeReader;
    activeReader = null;
    controller = null;
    if (previousReader) {
      void previousReader.cancel().catch(() => {}).then(() => previousController?.abort());
    } else previousController?.abort();
    clearTimeout(timer);
    timer = null;
  }
  function restart() {
    stop();
    cursor = null;
    if (scheduled || closed || entries.size === 0) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!closed && entries.size) running = connect(epoch, 0);
    });
  }
  async function connect(generation, attempt) {
    if (closed || generation !== epoch || entries.size === 0) return;
    const active = new AbortController();
    controller = active;
    status({ state: attempt ? "reconnecting" : "connecting", stale: true });
    let reader;
    let watchdog;
    let receivedSnapshot = false;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => active.abort(), heartbeatTimeoutMs);
    };
    try {
      armWatchdog();
      const response = await http("stream", {
        method: "POST", signal: active.signal,
        headers: { "content-type": "application/json", ...(cursor ? { "Last-Event-ID": cursor } : {}) },
        body: JSON.stringify({ queries: [...entries.values()].map(({ id, query }) => ({ id, query })) })
      });
      if (generation !== epoch) { await response.body?.cancel(); return; }
      if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
        throw failure("Expected an SSE response.", "client_protocol_error");
      }
      reader = response.body.getReader();
      activeReader = reader;
      // Some stream implementations report cancellation through closed as well as read().
      void reader.closed.catch(() => {});
      const decoder = new TextDecoder();
      let buffer = "";
      let line = "";
      let eventType = "message";
      let eventId = "";
      let data = [];
      let frameBytes = 0;
      let pendingCR = false;
      const sequences = new Map();
      const acceptLine = () => {
        if (line === "") {
          if (data.length) {
            if (!["snapshot", "update", "status"].includes(eventType)) {
              throw failure("Unknown stream event.", "client_protocol_error");
            }
            const payload = JSON.parse(data.join("\n"));
            if (payload.protocol !== "state-query-stream/v1" || !Array.isArray(payload.results)) {
              throw failure("Invalid stream result.", "client_protocol_error");
            }
            if (!receivedSnapshot && eventType !== "snapshot" && eventType !== "status") {
              throw failure("A replacement snapshot is required.", "client_protocol_error");
            }
            if (eventType === "snapshot") {
              const ids = new Set(payload.results.map((result) => result.queryId));
              if ([...entries.values()].some((entry) => !ids.has(entry.id))) {
                throw failure("Incomplete replacement snapshot.", "client_protocol_error");
              }
              receivedSnapshot = true;
              sequences.clear();
              attempt = 0;
            }
            for (const result of payload.results) {
              const entry = [...entries.values()].find((candidate) => candidate.id === result.queryId);
              if (!entry) continue;
              if (eventType !== "status" && (!Number.isSafeInteger(result.sequence) || result.sequence < 1)) {
                throw failure("Invalid result sequence.", "client_protocol_error");
              }
              if (result.sequence <= (sequences.get(entry.id) ?? 0)) continue;
              sequences.set(entry.id, result.sequence);
              entry.result = result;
              notify(entry, "onResult", result);
            }
            if (eventId.length <= 256) cursor = eventId || cursor;
            if (eventType === "status") {
              throw failure("Subscription ended. Check or replace the read grant.",
                payload.results.find((result) => result.error)?.error.code ?? "subscription_ended");
            }
            status({ state: "live", stale: false });
          }
          data = []; eventType = "message"; eventId = ""; frameBytes = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const raw = colon < 0 ? "" : line.slice(colon + 1);
          const value = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (field === "data") data.push(value);
          if (field === "event") eventType = value;
          if (field === "id" && !value.includes("\0")) eventId = value;
        }
        line = "";
      };
      while (!closed && generation === epoch) {
        const chunk = await reader.read();
        if (generation !== epoch) return;
        if (chunk.done) throw failure("Stream disconnected.", "disconnected", false);
        armWatchdog();
        buffer = decoder.decode(chunk.value, { stream: true });
        // Process incrementally: neither an unterminated line nor a frame can grow without a bound.
        for (const character of buffer) {
          if (pendingCR && character === "\n") { pendingCR = false; continue; }
          pendingCR = false;
          frameBytes += encoder.encode(character).byteLength;
          if (frameBytes > maxFrameBytes) throw failure("Stream frame exceeds the limit.", "client_frame_limit");
          if (character === "\r" || character === "\n") {
            acceptLine();
            pendingCR = character === "\r";
            if (generation !== epoch) return;
          } else line += character;
        }
      }
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
      try { await reader?.cancel(); } catch { /* disconnected */ }
      active.abort();
      try { reader?.releaseLock(); } catch { /* cancellation already released the reader */ }
      if (activeReader === reader) activeReader = null;
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
