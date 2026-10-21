import { validStateEvent } from "./correlation.js";
import { createRecentEventIdDeduplicator } from "./client.js";

function failure(code, message) { return Object.assign(new Error(message), { code, terminal: true }); }

// Values come exclusively from readable cells. Events can animate, never apply
// another delta to a value that may already include that operation.
export function createStateEventCoordinator({ onSnapshot, onEvent, storage, storageKey,
  maxRecentIds = 1000, snapshotTimeoutMs = 10_000 } = {}) {
  if (typeof onSnapshot !== "function" || typeof onEvent !== "function") throw new TypeError("Snapshot and event handlers are required.");
  if (!Number.isSafeInteger(snapshotTimeoutMs) || snapshotTimeoutMs < 1 || snapshotTimeoutMs > 30_000) throw new RangeError("Snapshot timeout must be between 1 and 30000 ms.");
  const recent = createRecentEventIdDeduplicator({ storage, storageKey, maxEntries: maxRecentIds });
  let latest = null, baseline = null, waiting = null, busy = false, closed = null, lastHandled = 0;
  function cell(value) {
    if (!value || !["present", "absent", "unselected"].includes(value.state) || !validStateEvent(value.stateEvent)) {
      throw failure("state_event_correlation_missing", "A correlated readable result is required.");
    }
    return JSON.parse(JSON.stringify(value));
  }
  function checkScope(marker) {
    if (latest && marker.scopeToken !== latest.stateEvent.scopeToken) throw failure("state_event_scope_changed", "State ownership changed. Acquire a fresh snapshot and authorized event stream.");
  }
  function update(value) {
    if (closed) throw closed;
    const next = cell(value); checkScope(next.stateEvent);
    if (latest) {
      if (next.stateEvent.stateRevision < latest.stateEvent.stateRevision) return false;
      if (next.stateEvent.operationSequence < latest.stateEvent.operationSequence) throw failure("state_event_order_invalid", "The operation watermark moved backward.");
    }
    latest = next;
    onSnapshot(JSON.parse(JSON.stringify(next)));
    return true;
  }
  function close(error = failure("state_event_closed", "State/event coordination stopped.")) {
    closed = error; baseline = null;
    waiting?.reject(error); waiting = null;
  }
  return Object.freeze({
    update,
    initialize(value) {
      update(value);
      baseline = { ...latest.stateEvent };
      const pending = waiting; waiting = null; pending?.resolve();
    },
    pause() { if (!closed) baseline = null; },
    close,
    async handle(event) {
      if (closed) throw closed;
      if (busy) throw failure("state_event_backpressure", "Only one unacknowledged event may be buffered.");
      if (!validStateEvent(event?.stateEvent, { event: true })) throw failure("state_event_correlation_missing", "A correlated event is required.");
      busy = true;
      let timer;
      try {
        if (!baseline) await new Promise((resolve, reject) => {
          waiting = { resolve, reject };
          timer = setTimeout(() => { waiting = null; reject(failure("state_event_snapshot_timeout", "A fresh readable snapshot is required.")); }, snapshotTimeoutMs);
        });
        if (closed) throw closed;
        checkScope(event.stateEvent);
        const duplicate = recent.has(event) || event.stateEvent.operationSequence <= lastHandled;
        const historical = event.stateEvent.operationSequence <= baseline.operationSequence;
        if (!duplicate && !historical) await onEvent(event, Object.freeze({
          stateIncluded: event.stateEvent.operationSequence <= latest.stateEvent.operationSequence,
          snapshot: JSON.parse(JSON.stringify(latest))
        }));
        recent.remember(event);
        lastHandled = Math.max(lastHandled, event.stateEvent.operationSequence);
        return Object.freeze({ duplicate, historical });
      } finally { clearTimeout(timer); busy = false; }
    }
  });
}

// Reuse separately authorized clients; this helper never obtains credentials.
// Registration precedes the fresh read, and the watch covers changes during it.
export function watchStateEvents({ stateClient, eventClient, query, selection, onStatus,
  ...options } = {}) {
  if (typeof selection !== "string" || !selection) throw new TypeError("A readable selection alias is required.");
  const coordinator = createStateEventCoordinator(options);
  let watch = null, subscription = null, generation = 0, stopped = false, ready = false, reading = null;
  const notify = (value) => { try { onStatus?.(value); } catch { /* status only */ } };
  function stop(error) {
    if (stopped) return;
    stopped = true; generation++; reading?.abort();
    coordinator.close(error); watch?.unsubscribe(); subscription?.unsubscribe();
  }
  function fail(error) { notify({ state: "ended", stale: true, code: error.code ?? "state_event_snapshot_failed" }); stop(error); }
  function result(envelope) {
    if (envelope?.status !== "ready") throw failure("state_event_snapshot_unavailable", "Readable state is unavailable.");
    return envelope.data?.[selection];
  }
  async function refresh() {
    if (stopped || !ready) return;
    const selected = ++generation; coordinator.pause(); reading?.abort();
    const controller = new AbortController(); reading = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const snapshot = await Promise.race([stateClient.read(query, { signal: controller.signal }), new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(failure("state_event_snapshot_timeout", "A fresh readable snapshot is required.")), { once: true });
      })]);
      if (!stopped && selected === generation) coordinator.initialize(result(snapshot));
    } catch (error) { if (!stopped && selected === generation) fail(error); }
    finally { clearTimeout(timeout); if (reading === controller) reading = null; }
  }
  subscription = eventClient.subscribe(async (event) => {
    try { return await coordinator.handle(event); }
    catch (error) { if (error.terminal) fail(error); throw error; }
  }, { onStatus(status) {
    if (stopped) return;
    notify(status);
    if (["connecting", "reconnecting", "handler_failed"].includes(status.state)) {
      ready = false; generation++; reading?.abort(); coordinator.pause();
    } else if (status.state === "ended" || status.state === "closed") {
      stop(failure(status.code ?? "state_event_closed", "The authorized event stream ended."));
    } else if (status.state === "live" && !ready) {
      ready = true;
      if (!watch) watch = stateClient.watch(query, {
        onResult(update) {
          try { coordinator.update(result(update.result)); } catch (error) { fail(error); }
        },
        onStatus(state) {
          if (stopped) return;
          if (state.state === "ended" || state.state === "closed") fail(failure(state.code ?? "state_event_read_ended", "The read subscription ended."));
          else if (state.stale) { coordinator.pause(); void refresh(); }
        }
      });
      void refresh();
    }
  } });
  return Object.freeze({ unsubscribe() { stop(); } });
}
