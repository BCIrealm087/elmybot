import { traceStateEvent } from "./diagnostics.js";
import { recoveryError, StateEventRecoveryError } from "./identity.js";
import { sourceSnapshotHeaders } from "./delivery-snapshot.js";

export async function boundedStateEventRequest(call, deadline = Date.now() + 5000, diagnostics = {}) {
  const started = Date.now();
  const { env, ...context } = diagnostics;
  let resultCode = "ok";
  traceStateEvent(env, "rpc.start", context);
  if (deadline <= Date.now()) {
    traceStateEvent(env, "rpc.finish", { ...context, code: "state_event_outcome_unknown", durationMs: 0 });
    throw recoveryError("outcome_unknown", 503);
  }
  let timer;
  try {
    return await Promise.race([(async () => {
      const response = await call(), result = await response.json();
      if (!response.ok) {
        const code = typeof result?.code === "string" && /^(state_event|durable_event)_[a-z_]{1,64}$/.test(result.code) ? result.code : "state_event_outcome_unknown";
        throw Object.assign(recoveryError("outcome_unknown", response.status >= 500 ? 503 : response.status), {
          code, retryAfterMs: Number.isSafeInteger(result?.retryAfterMs) && result.retryAfterMs > 0 && result.retryAfterMs <= 300_000 ? result.retryAfterMs : undefined,
          retryAfterSeconds: Number.isSafeInteger(result?.retryAfterSeconds) && result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 86400 ? result.retryAfterSeconds : undefined
        });
      }
      return result;
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(recoveryError("outcome_unknown", 503)), deadline - Date.now()); })]);
  } catch (error) {
    resultCode = error?.code ?? "state_event_outcome_unknown";
    if (error instanceof StateEventRecoveryError) throw error;
    throw recoveryError("outcome_unknown", 503);
  } finally {
    clearTimeout(timer);
    traceStateEvent(env, "rpc.finish", { ...context, code: resultCode, durationMs: Math.max(0, Date.now() - started) });
  }
}
export function relayStreamRequest(env, routeId, operation, input, deadline, work) {
  work?.take(operation);
  return boundedStateEventRequest(() => env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(routeId)).fetch(
    `https://stream/internal/events/combined/${operation}`, {
      method: "POST", headers: { "x-elmybot-durable-event-internal": "v1", "x-elmybot-state-event-delivery": "v1", ...sourceSnapshotHeaders(input.sourceSnapshot) },
      body: JSON.stringify({ ...input, routeId })
    }), deadline, { env, operationId: input.operationId, routeId, rpc: operation });
}

export function stateEventRetryDelay(attempt) {
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60_000, 120_000, 240_000, 300_000];
  return delays[Math.min(delays.length - 1, Math.max(0, attempt - 1))];
}
