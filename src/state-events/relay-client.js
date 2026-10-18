import { recoveryError } from "./identity.js";

export async function boundedStateEventRequest(call, deadline = Date.now() + 5000) {
  if (deadline <= Date.now()) throw recoveryError("outcome_unknown", 503);
  let timer;
  try {
    return await Promise.race([(async () => {
      const response = await call(), result = await response.json();
      if (!response.ok) throw Object.assign(recoveryError("outcome_unknown", response.status >= 500 ? 503 : response.status), {
        code: result.code ?? "state_event_outcome_unknown", retryAfterMs: result.retryAfterMs
      });
      return result;
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(recoveryError("outcome_unknown", 503)), deadline - Date.now()); })]);
  } catch (error) {
    if (error?.code) throw error;
    throw recoveryError("outcome_unknown", 503);
  } finally { clearTimeout(timer); }
}
export function relayStreamRequest(env, routeId, operation, input, deadline) {
  return boundedStateEventRequest(() => env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(routeId)).fetch(
    `https://stream/internal/events/combined/${operation}`, {
      method: "POST", headers: { "x-elmybot-durable-event-internal": "v1", "x-elmybot-state-event-delivery": "v1" },
      body: JSON.stringify({ ...input, routeId })
    }), deadline);
}

export function stateEventRetryDelay(attempt) {
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60_000, 120_000, 240_000, 300_000];
  return delays[Math.min(delays.length - 1, Math.max(0, attempt - 1))];
}
