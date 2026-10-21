// Explicit synthetic dispatcher over native SQL. This models a delayed delivery
// and getAlarm's running-handler semantics; it does not reproduce Cloudflare's
// alarm placement/retry machinery. No real alarm or implicit timer is installed.
export function alarmDispatchModel(nativeState, { nowMs = 1000, scheduledAtMs = null } = {}) {
  let now = nowMs, alarm = scheduledAtMs, running = false;
  const writes = [], dispatches = [];
  const state = { id: nativeState.id, storage: new Proxy(nativeState.storage, { get(target, key) {
    if (key === "getAlarm") return async () => alarm;
    if (key === "setAlarm") return async (time) => { alarm = Number(time); writes.push({ atMs: now, scheduledAtMs: alarm }); };
    if (key === "deleteAlarm") return async () => { alarm = null; writes.push({ atMs: now, scheduledAtMs: null }); };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) };
  return {
    state, writes, dispatches,
    get nowMs() { return now; },
    get scheduledAtMs() { return alarm; },
    advanceTo(time) {
      if (!Number.isSafeInteger(time) || time < now) throw Error("The model clock cannot move backward");
      now = time;
    },
    async dispatch(handler) {
      if (running || alarm === null || alarm > now) return false;
      const scheduled = alarm; alarm = null; running = true;
      dispatches.push({ scheduledAtMs: scheduled, startedAtMs: now, lagMs: now - scheduled });
      try { await handler(state); } finally { running = false; }
      return true;
    }
  };
}
