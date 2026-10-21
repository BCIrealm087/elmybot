import { traceStateEvent } from "./diagnostics.js";

const runners = new WeakMap();

// Best effort only: callers must persist work and its recovery alarm BEFORE
// requesting activation, outside the mutation transaction. waitUntil neither
// detaches the request context nor grants another remote-work budget. Never
// await this work from a command/authority queue, and never loop/restart it here.
export function requestStateEventActivation(state, env, lane, run) {
  if (env.STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED === "false" || typeof state.waitUntil !== "function") return false;
  let active = runners.get(state);
  if (!active) { active = new Set(); runners.set(state, active); }
  if (active.has(lane)) {
    traceStateEvent(env, "activation.skipped", { lane, reason: "runner_active" });
    return false;
  }
  active.add(lane);
  const task = Promise.resolve().then(async () => {
    traceStateEvent(env, "activation.start", { lane });
    try { await run(); }
    catch { traceStateEvent(env, "activation.failed", { lane, code: "state_event_outcome_unknown" }); }
    finally { active.delete(lane); }
  });
  try { state.waitUntil(task); }
  catch {
    // Registration failure must not turn an already committed command into an
    // error. The queued pass may still run; durable claims arbitrate with alarms.
    traceStateEvent(env, "activation.failed", { lane, reason: "registration_failed" });
  }
  return true;
}
