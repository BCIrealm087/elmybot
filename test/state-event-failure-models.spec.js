import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { scheduleStorageAlarmInTransaction } from "../src/storage-alarm.js";
import { initializeStateEventOutbox } from "../src/state-events/outbox.js";
import { drainStateEventRelay } from "../src/state-events/delivery-source.js";
import { cleanupDeliveryFixtures, deliveryFixture } from "./helpers/state-event-delivery-fixture.js";
import capture from "./fixtures/state-event-latency/production-2026-10-19.json";
import { alarmDispatchModel } from "./helpers/state-event-alarm-model.js";

const modelObjects = new Set();
afterEach(async () => {
  vi.restoreAllMocks(); await cleanupDeliveryFixtures();
  for (const stub of modelObjects) await runInDurableObject(stub, (_i, state) => state.storage.deleteAll());
  modelObjects.clear();
});

async function withAlarmModel(operation) {
  const stub = env.CONFIG.get(env.CONFIG.idFromName(`alarm-model-${crypto.randomUUID()}`)); modelObjects.add(stub);
  return runInDurableObject(stub, async (_i, native) => {
    initializeStateEventOutbox(native);
    const insert = (id, due) => native.storage.sql.exec(`INSERT INTO state_event_outbox
      (operation_id, partition_key, operation_sequence, state, deadline_ms, next_wakeup_at_ms, intent_json, intent_bytes)
      VALUES (?, 'model', ?, 'pending', 999999, ?, '{}', 2)`, id, Number(id), due);
    const model = alarmDispatchModel(native);
    const schedule = () => scheduleStorageAlarmInTransaction(model.state, { nowMs: model.nowMs });
    return operation({ native, model, schedule, insert });
  });
}

describe("explicit state-event latency failure models", () => {
  it("separates a deliberately late dispatch from execution time without an earlier attempt", async () => {
    await withAlarmModel(async ({ model, insert, schedule }) => {
      const observed = capture.lateAlarmObservations[0];
      insert("1", observed.selectedOffsetMs); await schedule();
      model.advanceTo(observed.selectedOffsetMs - 1); expect(await model.dispatch(() => {})).toBe(false);
      model.advanceTo(observed.startedOffsetMs); // Deliberate dispatcher fault, not a platform claim.
      let attempts = 0;
      expect(attempts).toBe(0); expect(model.writes).toHaveLength(1);
      await model.dispatch(() => { attempts++; });
      expect(attempts).toBe(1);
      expect(model.dispatches).toEqual([{ scheduledAtMs: observed.selectedOffsetMs, startedAtMs: observed.startedOffsetMs, lagMs: observed.lagMs }]);
    });
  });
  it("repairs an overdue alarm across a new admission", async () => {
    await withAlarmModel(async ({ model, insert, schedule }) => {
      insert("1", 2000); await schedule(); model.advanceTo(8000);
      insert("2", 9000); await schedule();
      expect(model.scheduledAtMs).toBe(8000);
      expect(model.writes).toHaveLength(2);
      await model.dispatch(() => {});
      expect(model.dispatches[0].lagMs).toBe(0);
    });
  });
  it("replaces a due-work alarm with the future claim deadline", async () => {
    await withAlarmModel(async ({ native, model, insert, schedule }) => {
      insert("1", 2000); await schedule(); model.advanceTo(2000);
      await model.dispatch(async () => {
        // Relay mode observation/maintenance schedules before claim. Claim then
        // moves the durable wakeup to its lease, but the prior alarm is retained.
        await schedule();
        native.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 32_000");
        await schedule();
        expect(model.scheduledAtMs).toBe(32_000);
        expect(native.storage.sql.exec("SELECT MIN(next_wakeup_at_ms) AS due FROM state_event_outbox").one().due).toBe(32_000);
      });
      expect(model.writes.map((r) => r.scheduledAtMs)).toEqual([2000, 2000, 32_000]);
    });
  });
  it("models running-handler rearming and admission while interruption retains SQL work", async () => {
    await withAlarmModel(async ({ native, model, insert, schedule }) => {
      insert("1", 2000); await schedule(); model.advanceTo(2000);
      await expect(model.dispatch(async () => {
        expect(await model.state.storage.getAlarm()).toBeNull();
        native.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 32_000 WHERE operation_id = '1'");
        await schedule(); expect(await model.state.storage.getAlarm()).toBe(32_000);
        insert("2", 3000); await schedule();
        expect(model.scheduledAtMs).toBe(3000);
        throw Error("handler interrupted after durable rearm");
      })).rejects.toThrow("interrupted");
      model.advanceTo(3000);
      await model.dispatch(() => {
        expect(native.storage.sql.exec("SELECT COUNT(*) AS total FROM state_event_outbox").one().total).toBe(2);
      });
      expect(model.dispatches.map((r) => r.startedAtMs)).toEqual([2000, 3000]);
    });
  });
  it.each([false, true])("retains uncertainty for pre-append depth rejection and post-append reply loss (afterAppend=%s)", async (afterAppend) => {
    // Fault fixture deliberately uses forwarding/injection. It tests recovery
    // state, not Cloudflare's actual depth counter or its numeric threshold.
    const f = await deliveryFixture({ shared: true }), accepted = await f.commit();
    await runInDurableObject(f.ownerStub, (_i, state) => state.storage.deleteAlarm());
    let rejected = 0;
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append") && rejected++ === 0) {
        if (afterAppend) await send();
        throw Error(afterAppend ? "Synthetic reply lost after append" : "Subrequest depth limit exceeded. Synthetic fault.");
      }
      return send();
    });
    const pass = () => runInDurableObject(f.ownerStub, async (_i, state) => {
      const model = alarmDispatchModel(state, { nowMs: Date.now() });
      state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE lease_token IS NULL");
      const result = await drainStateEventRelay(model.state, f.testEnv);
      await state.storage.deleteAlarm(); return { ...result, scheduledAtMs: model.scheduledAtMs };
    });
    const firstPass = await pass();
    const row = (await f.rows(f.ownerStub, "state_event_outbox"))[0];
    expect(row).toMatchObject({ state: "pending", uncertain: 1, attempts: 1, last_error: "state_event_outcome_unknown" });
    expect(row.lease_token).not.toBeNull(); expect(row.next_wakeup_at_ms).toBe(row.lease_until_ms);
    expect(firstPass.scheduledAtMs).toBeGreaterThanOrEqual(row.lease_until_ms);
    const receipts = await f.rows(f.streamStub, "state_event_destination_records");
    expect(receipts).toHaveLength(afterAppend ? 1 : 0);
    f.intercept(null);
    expect((await pass()).attempted).toBe(0);
    const clock = vi.spyOn(Date, "now").mockReturnValue(row.lease_until_ms + 1);
    await pass(); clock.mockRestore();
    const events = await f.rows(f.streamStub, "durable_event_stream_events");
    expect(events).toHaveLength(1); expect(events[0].event_id).toBe(accepted.receipt.eventId);
    const owner = (await f.rows(f.ownerStub, "state_event_partitions"))[0]; expect(owner.operation_sequence).toBe(1);
  });
});
