// Health-only cosmetic policy. Authoritative values and event deduplication
// belong to the readable client/coordinator, never to this in-memory queue.
export const MAX_PENDING_HEALTH_EFFECTS = 8;

function validateImpact(event) {
  const payload = event?.payload;
  const health = (value) => Number.isInteger(value) && value >= 0 && value <= 100;
  if (!payload || !["damage", "heal"].includes(payload.operation) ||
      !Number.isInteger(payload.requestedAmount) || payload.requestedAmount < 1 || payload.requestedAmount > 100 ||
      !health(payload.appliedAmount) || !health(payload.before) || !health(payload.after) || typeof payload.changed !== "boolean") {
    throw Error("Invalid v2 health impact.");
  }
  // Retain only what the effect needs, not payloads or historical health values.
  return { operation: payload.operation, eventId: event.eventId, operationId: event.stateEvent?.operationId };
}

export function createHealthEffectQueue({ animate, isHidden = () => document.visibilityState === "hidden", onDiagnostic } = {}) {
  if (typeof animate !== "function") throw new TypeError("An animation starter is required.");
  const pending = [];
  let running = null, closed = false;
  function trace(stage, effect, reason) {
    try { onDiagnostic?.({ stage: `animation.${stage}`, eventId: effect.eventId, operationId: effect.operationId,
      pendingEffects: pending.length, runningEffects: running ? 1 : 0, ...(reason ? { reason } : {}) }); } catch { /* Cosmetic diagnostics only. */ }
  }
  function cancel(run, reason) {
    try { run.animation?.cancel(); } catch { /* Broken effects cannot own delivery. */ }
    trace("cancel", run.effect, reason);
  }
  function clear(reason = "obsolete") {
    pending.length = 0;
    const previous = running; running = null;
    if (previous) cancel(previous, reason);
  }
  function pump() {
    if (closed || running || isHidden()) return;
    while (pending.length) {
      const run = { effect: pending.shift(), animation: null }; running = run;
      trace("start", run.effect);
      try {
        run.animation = animate(run.effect);
        Promise.resolve(run.animation.finished).then(() => complete(run), () => complete(run, "failed"));
        return;
      } catch {
        running = null; cancel(run, "failed"); trace("error", run.effect);
        // At most eight pending effects can fail synchronously in this pass.
      }
    }
  }
  function complete(run, reason) {
    // A cancelled effect may settle after a new scope/session has started.
    if (running !== run) return;
    running = null;
    if (reason) cancel(run, reason);
    trace(reason ? "error" : "finish", run.effect, reason);
    pump();
  }
  return Object.freeze({
    accept(event) {
      const effect = validateImpact(event);
      if (closed) throw Error("Health effects are closed.");
      if (isHidden()) { clear("hidden"); trace("skip", effect, "hidden"); return; }
      if (pending.length === MAX_PENDING_HEALTH_EFFECTS) trace("drop", pending.shift(), "overflow");
      pending.push(effect); trace("queued", effect); pump();
      // Returning acknowledges acceptance. Never return animation.finished.
    },
    clear,
    // A suspended page may resume without having run its hidden notification.
    // Clear on either transition rather than replaying stale pending effects.
    visibilityChanged() { clear(isHidden() ? "hidden" : "visible"); },
    close() { closed = true; clear("closed"); },
    get pendingCount() { return pending.length; },
    get runningCount() { return running ? 1 : 0; }
  });
}
