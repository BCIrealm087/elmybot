import { afterEach, describe, expect, it, vi } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { cleanupDeliveryFixtures, deliveryFixture } from "./helpers/state-event-delivery-fixture.js";
import { drainStateEventRelay } from "../src/state-events/delivery-source.js";
import { runStateEventRelay } from "../src/state-events/relay.js";
import { STATE_EVENT_PUBLICATION_BURST } from "../src/state-events/outbox.js";
import { stateEventRequestGuard } from "./helpers/state-event-request-guard.js";

const rows = (f) => f.rows(f.ownerStub, "state_event_outbox");
const edit = (f, sql, ...args) => runInDurableObject(f.ownerStub, (_i, state) => state.storage.sql.exec(sql, ...args).toArray());
function controlled(state) {
  return { id: state.id, storage: new Proxy(state.storage, { get(target, key) {
    if (key === "setAlarm") return async () => {};
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
async function fixture(options = {}) {
  const f = await deliveryFixture({ streams: 8, suppressLocalCommitAlarm: true, ...options });
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  return { ...f, clock };
}
async function commit(f, stream = 0) {
  const receipt = await f.commit(stream);
  await runInDurableObject(f.ownerStub, (_i, state) => state.storage.deleteAlarm());
  f.clock.mockReturnValue(Date.now() + 1100); return receipt;
}
async function pass(f, options = {}, reconcile) {
  return runInDurableObject(f.ownerStub, async (_i, state) => {
    const result = await (reconcile ? runStateEventRelay(controlled(state), f.testEnv, reconcile, options)
      : drainStateEventRelay(controlled(state), f.testEnv, options));
    await state.storage.deleteAlarm(); return result;
  });
}
async function due(f) {
  await edit(f, "UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE lease_until_ms IS NULL OR lease_until_ms <= ?", Date.now());
}
afterEach(async () => { vi.restoreAllMocks(); await cleanupDeliveryFixtures(); });

describe("durable publication/cleanup fairness", () => {
  it.each([false, true])("bounds both lane waits and rotates streams under sustained failures (shared=%s)", async (shared) => {
    const f = await fixture({ shared }), receipts = [];
    for (let index = 0; index < 8; index++) receipts.push(await commit(f, index));
    await edit(f, "UPDATE state_event_outbox SET state = 'appended' WHERE stream_route_id IN (?, ?, ?, ?)", ...f.routes.slice(4).map((r) => r.streamRouteId));
    await edit(f, "UPDATE state_event_source_streams SET registered_epoch = interest_epoch");
    const claims = [], counts = new Map();
    // Scheduler-only failure model: real persisted claims and budgets, no
    // destination protocol replacement in the integration cases below.
    const reject = async (state, _env, _owner, id) => {
      const row = state.storage.sql.exec("SELECT * FROM state_event_outbox WHERE operation_id = ?", id).one();
      claims.push({ id, cleanup: row.state === "appended" }); counts.set(id, (counts.get(id) ?? 0) + 1);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM state_event_outbox WHERE lease_until_ms > ?", Date.now()).one().n).toBeLessThanOrEqual(4);
      throw Object.assign(Error("known temporary rejection"), { code: "durable_event_service_unavailable" });
    };
    for (let index = 0; index < 16; index++) {
      await due(f); const result = await pass(f, { activation: true }, reject); expect(result.attempted).toBeLessThanOrEqual(2);
      if (index === 5) await evictDurableObject(f.ownerStub);
    }
    expect(new Set(claims.filter((r) => r.cleanup).map((r) => r.id)).size).toBe(4);
    expect(new Set(claims.filter((r) => !r.cleanup).map((r) => r.id)).size).toBe(4);
    let publications = 0, cleanups = 0;
    for (const claim of claims) {
      if (claim.cleanup) { cleanups++; publications = 0; expect(cleanups).toBeLessThanOrEqual(1); }
      else { publications++; cleanups = 0; expect(publications).toBeLessThanOrEqual(STATE_EVENT_PUBLICATION_BURST); }
    }
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(3);
    expect((await rows(f)).every((r) => r.lease_token === null)).toBe(true);
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0].rows).toBe(8);
  });

  it.each(["origin", "release"])("publishes during sustained %s failures across streams, then drains charged cleanup", async (fault) => {
    const f = await fixture({ shared: true }), old = [];
    for (let index = 0; index < 3; index++) { old.push(await commit(f, index)); await due(f); await pass(f); }
    f.clock.mockReturnValue(old.at(-1).receipt.expiresAtMs + 1);
    let guard, failures = 0;
    f.intercept((kind, url, _init, send) => {
      const path = new URL(url).pathname;
      const call = async () => {
        if (fault === "origin" && kind === "CONFIG" && path.endsWith("origin/retire") ||
            fault === "release" && path.endsWith("combined/interest-release")) {
          failures++; throw Error("cleanup transport unavailable");
        }
        return send();
      };
      return guard ? guard.request(path, call) : call();
    });
    for (let round = 0; round < 18; round++) {
      // Let the original, finite leases mature; never erase a live lease.
      f.clock.mockReturnValue(Date.now() + 31_000);
      const accepted = await commit(f, 3 + round % 3);
      for (let index = 0; index < 4 && (await rows(f)).find((r) => r.operation_id === accepted.operationId).state !== "appended"; index++) {
        guard = stateEventRequestGuard({ calls: 20, depth: 2 }); await pass(f, { activation: true });
        expect(guard.rejected).toBe(0); expect(guard.total).toBeLessThanOrEqual(20); guard = null;
        f.clock.mockReturnValue(Date.now() + 25);
      }
      expect((await rows(f)).find((r) => r.operation_id === accepted.operationId)).toMatchObject({ state: "appended", attempts: 1 });
      // An independent cleanup pass between commands exercises repeated remote
      // failures as well as the terminal-to-retiring split under mixed traffic.
      guard = stateEventRequestGuard({ calls: 20, depth: 2 }); await pass(f);
      expect(guard.rejected).toBe(0); guard = null;
      for (const receipt of old) expect((await rows(f)).some((r) => r.operation_id === receipt.operationId)).toBe(true);
      const pending = await rows(f), budget = (await f.rows(f.ownerStub, "state_event_outbox_budget"))[0];
      expect(budget).toMatchObject({ rows: pending.length, bytes: pending.reduce((n, r) => n + r.intent_bytes, 0) });
      if (round === 2) await evictDurableObject(f.ownerStub);
    }
    expect(failures).toBeGreaterThanOrEqual(6);
    f.intercept(null);
    f.clock.mockReturnValue(Math.max(...(await rows(f)).map((r) => r.deadline_ms)) + 1);
    for (let index = 0; index < 40 && (await rows(f)).length; index++) { await due(f); await pass(f); f.clock.mockReturnValue(Date.now() + 31_000); }
    expect(await rows(f)).toEqual([]);
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
    for (const stub of f.streamStubs.slice(0, 6)) {
      const interest = await f.rows(stub, "state_event_producer_interest"); expect(interest[0].active).toBe(0);
      expect(await f.rows(stub, "durable_event_stream_events")).toEqual([]);
    }
  }, 20_000);

  it.each([false, true])("shares one pass between cleanup and a terminal publication without inline retirement (lostReply=%s)", async (lostReply) => {
    const f = await fixture({ shared: true }), old = await commit(f);
    await pass(f, { activation: true });
    const next = await commit(f, 1);
    f.clock.mockReturnValue(next.receipt.expiresAtMs + 1); await due(f);
    await edit(f, "UPDATE state_event_relay_schedule SET publication_streak = 3");
    const guard = stateEventRequestGuard({ calls: 20, depth: 2 }); let retirements = 0, lost = false;
    f.intercept((kind, url, _init, send) => guard.request(new URL(url).pathname, async () => {
      if (kind === "CONFIG" && String(url).endsWith("origin/retire")) retirements++;
      const response = await send();
      if (lostReply && String(url).endsWith("combined/append") && !lost) { lost = true; throw Error("terminal append reply lost"); }
      return response;
    }));
    expect((await pass(f)).attempted).toBe(2);
    expect(guard.rejected).toBe(0); expect(guard.total).toBeLessThanOrEqual(20); expect(retirements).toBe(0);
    for (const receipt of [old, next]) expect((await rows(f)).find((r) => r.operation_id === receipt.operationId))
      .toMatchObject({ state: "retiring", lease_token: null, destination_confirmed: 1 });
    expect((await rows(f)).find((r) => r.operation_id === next.operationId).probe_state).toBe(lostReply ? 2 : 0);
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0].rows).toBe(2);
    f.intercept(null); f.clock.mockReturnValue(Date.now() + 25); await pass(f);
    expect(await rows(f)).toEqual([]);
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0]).toMatchObject({ rows: 0, bytes: 0 });
  });

  it("puts new admissions behind an eligible retry instead of repeatedly favoring first attempts", async () => {
    const f = await fixture(), first = await commit(f);
    const claims = [];
    const reject = async (_s, _e, _o, id) => { claims.push(id); throw Object.assign(Error("known"), { code: "durable_event_service_unavailable" }); };
    await due(f); await pass(f, {}, reject);
    const second = await commit(f, 1);
    await due(f); await pass(f, { activation: true }, reject);
    expect(claims.slice(0, 2)).toEqual([first.operationId, first.operationId]);
    await due(f); await pass(f, { activation: true }, reject);
    expect(claims).toContain(second.operationId);
    const schedule = (await f.rows(f.ownerStub, "state_event_relay_schedule"))[0];
    await evictDurableObject(f.ownerStub);
    expect((await f.rows(f.ownerStub, "state_event_relay_schedule"))[0]).toEqual(schedule);
  });

  it("makes an explicit publication request respect an owed cleanup turn without charging an attempt", async () => {
    const f = await fixture(), target = await commit(f), cleanup = await commit(f, 1);
    await edit(f, "UPDATE state_event_outbox SET state = 'appended' WHERE operation_id = ?", cleanup.operationId);
    await edit(f, "UPDATE state_event_source_streams SET registered_epoch = interest_epoch");
    await edit(f, "UPDATE state_event_relay_schedule SET publication_streak = 3"); await due(f);
    await expect(pass(f, { onlyOperationId: target.operationId }, async () => ({}))).rejects.toMatchObject({ code: "state_event_attempt_in_progress" });
    expect((await rows(f)).every((r) => r.attempts === 0 && r.lease_token === null)).toBe(true);
  });

  it("arbitrates concurrent activations with one persisted streak and the four-lease limit", async () => {
    const f = await fixture({ shared: true });
    for (let index = 0; index < 8; index++) await commit(f, index);
    await edit(f, "UPDATE state_event_outbox SET state = 'appended' WHERE stream_route_id IN (?, ?, ?, ?)", ...f.routes.slice(4).map((r) => r.streamRouteId));
    await edit(f, "UPDATE state_event_source_streams SET registered_epoch = interest_epoch"); await due(f);
    const claims = await runInDurableObject(f.ownerStub, async (_i, state) => {
      let release; const gate = new Promise((resolve) => { release = resolve; }), seen = [];
      const reject = async (_s, _e, _o, id) => {
        seen.push(state.storage.sql.exec("SELECT state FROM state_event_outbox WHERE operation_id = ?", id).one().state);
        if (seen.length === 4) {
          expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM state_event_outbox WHERE lease_until_ms > ?", Date.now()).one().n).toBe(4);
          release();
        }
        await gate; throw Object.assign(Error("known"), { code: "durable_event_service_unavailable" });
      };
      await Promise.all(Array.from({ length: 4 }, () => runStateEventRelay(controlled(state), f.testEnv, reject, { activation: true })));
      await state.storage.deleteAlarm(); return seen;
    });
    expect(claims.slice(0, 4)).toEqual(["pending", "pending", "pending", "appended"]);
    expect((await rows(f)).every((r) => r.lease_token === null)).toBe(true);
  });

  it("includes deferred receipt probes in the cleanup turn rather than giving probes unconditional priority", async () => {
    const f = await fixture();
    for (let index = 0; index < 5; index++) await commit(f, index);
    const until = Date.now() + 30_000;
    await edit(f, `UPDATE state_event_outbox SET probe_state = 1, uncertain = 1, lease_token = operation_id,
      lease_until_ms = ?, probe_fallback_ms = ?, next_wakeup_at_ms = 0 WHERE stream_route_id <> ?`, until, until, f.routes[4].streamRouteId);
    await edit(f, "UPDATE state_event_outbox SET state = 'appended', next_wakeup_at_ms = 0 WHERE stream_route_id = ?", f.routes[4].streamRouteId);
    await edit(f, "UPDATE state_event_source_streams SET registered_epoch = interest_epoch");
    // Existing probes can read while all four leases are occupied, spending
    // each marker once and retaining the original lease/fallback on absence.
    await pass(f);
    const spent = (await rows(f)).filter((r) => r.probe_state === 2);
    expect(spent).toHaveLength(2);
    for (const row of spent) expect(row).toMatchObject({ lease_token: row.operation_id, lease_until_ms: until, next_wakeup_at_ms: until, attempts: 0 });
    // Once a slot recovers, an owed cleanup turn precedes another deferred read.
    f.clock.mockReturnValue(until);
    await edit(f, "UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE stream_route_id = ?", f.routes[4].streamRouteId);
    await edit(f, "UPDATE state_event_relay_schedule SET publication_streak = 3");
    let cleanup = false;
    const result = await pass(f, { acceptOutcome: async () => { throw Error("absent receipt must not be accepted"); } }, async (state, _env, _owner, id) => {
      cleanup = state.storage.sql.exec("SELECT state FROM state_event_outbox WHERE operation_id = ?", id).one().state === "appended";
      return { state: "appended" };
    });
    expect(cleanup).toBe(true); expect(result.attempted).toBe(2);
    expect((await rows(f)).filter((r) => r.probe_state === 2)).toHaveLength(3);
    expect((await rows(f)).filter((r) => r.probe_state === 1)).toHaveLength(1);
  });

  it("never bypasses a genuinely uncertain publication head to pay a fairness turn", async () => {
    const f = await fixture(), head = await commit(f), successor = await commit(f), other = await commit(f, 1);
    const token = crypto.randomUUID(), until = Date.now() + 30_000;
    await edit(f, "UPDATE state_event_outbox SET uncertain = 1, lease_token = ?, lease_until_ms = ?, next_wakeup_at_ms = ? WHERE operation_id = ?", token, until, until, head.operationId);
    await edit(f, "UPDATE state_event_outbox SET state = 'appended', next_wakeup_at_ms = 0 WHERE operation_id = ?", other.operationId);
    await edit(f, "UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE operation_id = ?", successor.operationId);
    await edit(f, "UPDATE state_event_source_streams SET registered_epoch = interest_epoch");
    const claims = [];
    await pass(f, { activation: true }, async (_s, _e, _o, id) => { claims.push(id); return { state: "appended" }; });
    expect(claims).toEqual([other.operationId]);
    expect((await rows(f)).find((r) => r.operation_id === head.operationId)).toMatchObject({ lease_token: token, lease_until_ms: until });
    expect((await rows(f)).find((r) => r.operation_id === successor.operationId)).toMatchObject({ attempts: 0, lease_token: null, next_wakeup_at_ms: until });
  });

  it.each([false, true])("recovers four append-to-cleanup leases without inventing a reserved slot (legacy=%s)", async (legacy) => {
    const f = await fixture({ shared: true }), accepted = [];
    f.intercept((_kind, url, _init, send) => {
      if (String(url).endsWith("combined/confirm")) throw Error("confirmation reply unavailable"); return send();
    });
    for (let index = 0; index < 4; index++) { accepted.push(await commit(f, index)); await pass(f, { activation: true }); }
    const before = await rows(f); expect(before).toHaveLength(4);
    expect(before.every((r) => r.state === "appended" && r.uncertain && r.lease_token)).toBe(true);
    const next = await commit(f, 4);
    if (legacy) {
      await edit(f, "ALTER TABLE state_event_outbox DROP COLUMN relay_turn");
      await edit(f, "DROP TABLE state_event_relay_schedule");
    }
    await evictDurableObject(f.ownerStub); f.intercept(null);
    await pass(f, { activation: true });
    for (const row of before) expect((await rows(f)).find((r) => r.operation_id === row.operation_id))
      .toMatchObject({ lease_token: row.lease_token, lease_until_ms: row.lease_until_ms, attempts: 1 });
    expect((await rows(f)).find((r) => r.operation_id === next.operationId).attempts).toBe(0);
    f.clock.mockReturnValue(Math.max(...before.map((r) => r.lease_until_ms)));
    for (let index = 0; index < 4 && (await rows(f)).find((r) => r.operation_id === next.operationId).state !== "appended"; index++) {
      await pass(f, { activation: true }); f.clock.mockReturnValue(Date.now() + 25);
    }
    expect((await rows(f)).find((r) => r.operation_id === next.operationId)).toMatchObject({ state: "appended", attempts: 1 });
    expect((await f.rows(f.ownerStub, "state_event_outbox_budget"))[0].rows).toBe(5);
    for (let index = 0; index < 5; index++) expect(await f.rows(f.streamStubs[index], "durable_event_stream_events")).toHaveLength(1);
  });
});
