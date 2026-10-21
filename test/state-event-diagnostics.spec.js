import { afterEach, describe, expect, it, vi } from "vitest";
import { configureStateEventDiagnostics, STATE_EVENT_DIAGNOSTIC_LIMIT, traceStateEvent, traceStateEventForOwner, traceStateEventRow } from "../src/state-events/diagnostics.js";
import { boundedStateEventRequest } from "../src/state-events/relay-client.js";

afterEach(() => vi.restoreAllMocks());
describe("bounded private state-event diagnostics", () => {
  it("defaults off and omits private fields and unsafe error text", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    traceStateEvent({}, "commit", { payload: "secret" });
    traceStateEvent({ STATE_EVENT_DIAGNOSTICS: true }, "commit", {});
    expect(log).not.toHaveBeenCalled();
    traceStateEvent({ STATE_EVENT_DIAGNOSTICS: "true" }, "commit", {
      operationId: "seo1." + "a".repeat(43), payload: "private-payload", grant: "private-grant",
      ownerId: "discord:guild:private", code: "transport secret text", durationMs: 4, stateRevision: 2
    });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ stage: "commit", durationMs: 4, stateRevision: 2 });
    expect(log.mock.calls[0][0]).not.toMatch(/private|secret|payload|grant|ownerId|code/);
  });
  it("caps output without timers and reports dropped records in the next window", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), env = { STATE_EVENT_DIAGNOSTICS: "true" };
    for (let i = 0; i < STATE_EVENT_DIAGNOSTIC_LIMIT + 3; i++) traceStateEvent(env, "relay.start");
    expect(log).toHaveBeenCalledTimes(STATE_EVENT_DIAGNOSTIC_LIMIT);
    clock.mockReturnValue(61_000); traceStateEvent(env, "relay.start");
    expect(JSON.parse(log.mock.calls.at(-1)[0]).dropped).toBe(3);
  });
  it("survives broken log sinks and malformed rows without changing RPC results", async () => {
    vi.spyOn(console, "log").mockImplementation(() => { throw Error("log unavailable"); });
    const env = { STATE_EVENT_DIAGNOSTICS: "true" };
    expect(() => traceStateEventRow(env, "relay.claim", { intent_json: "invalid" })).not.toThrow();
    await expect(boundedStateEventRequest(async () => Response.json({ accepted: true }), undefined, { env, rpc: "test" })).resolves.toEqual({ accepted: true });
    await expect(boundedStateEventRequest(async () => { throw Error("secret"); }, undefined, { env, rpc: "test" })).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
  });
  it("reports only known alarm times and clears the observation when disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), env = { STATE_EVENT_DIAGNOSTICS: "true" };
    const state = { id: { toString: () => "a".repeat(64) } };
    const clock = vi.spyOn(Date, "now").mockReturnValue(5000);
    configureStateEventDiagnostics(state, env); traceStateEventForOwner(state, "alarm.start");
    expect(JSON.parse(log.mock.calls.at(-1)[0]).scheduledAtMs).toBeUndefined();
    traceStateEventForOwner(state, "alarm.schedule", { scheduledAtMs: 6000 });
    clock.mockReturnValue(6015); traceStateEventForOwner(state, "alarm.start");
    expect(JSON.parse(log.mock.calls.at(-1)[0])).toMatchObject({ scheduledAtMs: 6000, lagMs: 15 });
    configureStateEventDiagnostics(state, {}); traceStateEventForOwner(state, "alarm.start");
    expect(log).toHaveBeenCalledTimes(3);
  });
});
