import { describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { recoverStorageAlarm, runStorageAlarm, scheduleStorageAlarmInTransaction } from "../src/storage-alarm.js";
import { alarmDispatchModel } from "./helpers/state-event-alarm-model.js";

const sources = [
  ["state_query_grant_invalidation_outbox", "next_attempt_at_ms"],
  ["state_query_notification_outbox", "next_attempt_at_ms"],
  ["state_query_source_watchers", "lease_expires_at_ms"],
  ["state_event_outbox", "next_wakeup_at_ms"]
];

// Scheduler-focused tables over native SQL, not full protocol fixtures. No real
// alarm dispatch in model cases; rollback cases below use native alarm storage.
async function withScheduler(operation) {
  const stub = env.CONFIG.get(env.CONFIG.idFromName(`scheduler-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (_instance, native) => {
    const nativeNowMs = Date.now();
    await native.storage.deleteAll();
    let clock;
    try {
      for (const [table, column] of sources) native.storage.sql.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, ${column} INTEGER)`);
      const put = (table, due, id = "work") => {
        const column = sources.find(([name]) => name === table)[1];
        native.storage.sql.exec(`INSERT INTO ${table} VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ${column} = excluded.${column}`, id, due);
      };
      const clear = () => { for (const [table] of sources) native.storage.sql.exec(`DELETE FROM ${table}`); };
      const model = alarmDispatchModel(native);
      clock = vi.spyOn(Date, "now").mockImplementation(() => model.nowMs);
      const schedule = () => recoverStorageAlarm(model.state, { nowMs: model.nowMs });
      return await operation({ native, nativeNowMs, model, put, clear, schedule });
    } finally {
      clock?.mockRestore();
      await native.storage.deleteAll();
    }
  });
}

describe("shared source alarm scheduling", () => {
  it.each(sources)("repairs overdue selection while preserving %s's earlier durable deadline", async (table) => {
    await withScheduler(async ({ model, put, schedule }) => {
      put("state_event_outbox", 32_000, "lease"); put(table, 12_000);
      await model.state.storage.setAlarm(2000); model.advanceTo(8000);
      await schedule(); expect(model.scheduledAtMs).toBe(12_000);
      put("state_event_outbox", 64_000, "lease"); await schedule();
      expect(model.scheduledAtMs).toBe(12_000);
      await runStorageAlarm(model.state, async () => {});
      expect(model.scheduledAtMs).toBe(12_000);
    });
  });

  it("retains an earlier future selection during admission, then recomputes on completion", async () => {
    await withScheduler(async ({ model, put, schedule }) => {
      put("state_event_outbox", 12_000); await model.state.storage.setAlarm(9000);
      await schedule(); expect(model.scheduledAtMs).toBe(9000);
      await runStorageAlarm(model.state, async () => {});
      expect(model.scheduledAtMs).toBe(12_000);
    });
  });

  it.each([false, true])("reconciles a running handler's final durable work even on failure (throws=%s)", async (throws) => {
    await withScheduler(async ({ model, put, schedule }) => {
      put("state_event_outbox", 2000); await schedule(); model.advanceTo(2000);
      const invocation = model.dispatch(() => runStorageAlarm(model.state, async () => {
        expect(await model.state.storage.getAlarm()).toBeNull();
        await schedule(); // Mode observation/maintenance before the claim.
        put("state_event_outbox", 32_000); await schedule();
        expect(model.scheduledAtMs).toBe(32_000);
        // A durable transition after the last scheduler call must be included.
        put("state_event_outbox", 64_000);
        if (throws) throw Error("interrupted handler");
      }));
      if (throws) await expect(invocation).rejects.toThrow("interrupted handler"); else await invocation;
      expect(model.scheduledAtMs).toBe(64_000);
      model.advanceTo(63_999); expect(await model.dispatch(() => {})).toBe(false);
    });
  });

  it("includes a concurrent admission while remote work is waiting and preserves notification progress", async () => {
    await withScheduler(async ({ model, put, schedule }) => {
      put("state_event_outbox", 2000); await schedule(); model.advanceTo(2000);
      let entered, release;
      const enteredWork = new Promise((resolve) => { entered = resolve; });
      const remoteWork = new Promise((resolve) => { release = resolve; });
      const running = model.dispatch(() => runStorageAlarm(model.state, async () => {
        put("state_event_outbox", 32_000); await schedule(); entered(); await remoteWork;
      }));
      await enteredWork;
      put("state_event_outbox", 4000, "new-command"); await schedule();
      put("state_query_notification_outbox", 3000); await schedule();
      expect(model.scheduledAtMs).toBe(3000);
      expect(await model.dispatch(() => {})).toBe(false); // Still running.
      release(); await running; expect(model.scheduledAtMs).toBe(3000);
      model.advanceTo(3000);
      await model.dispatch(() => runStorageAlarm(model.state, async () => {
        put("state_query_notification_outbox", 10_000); await schedule();
      }));
      expect(model.scheduledAtMs).toBe(4000);
    });
  });

  it("clears stale selections after all work completes and leaves idle owners unscheduled", async () => {
    await withScheduler(async ({ model, put, clear, schedule }) => {
      put("state_event_outbox", 2000); await schedule(); model.advanceTo(2000);
      await model.dispatch(() => runStorageAlarm(model.state, async () => {
        await schedule(); clear();
      }));
      expect(model.scheduledAtMs).toBeNull();
      const writes = model.writes.length;
      await runStorageAlarm(model.state, async () => {});
      expect(model.writes).toHaveLength(writes);
      model.advanceTo(100_000); expect(await model.dispatch(() => {})).toBe(false);
    });
  });

  it.each(["before", "after"])("rolls back admission and overdue-alarm repair when storage fails %s writing the alarm", async (when) => {
    await withScheduler(async ({ native, nativeNowMs, put }) => {
      const base = nativeNowMs + 120_000, original = base + 10_000;
      put("state_event_outbox", original); await native.storage.setAlarm(original);
      const failing = { id: native.id, storage: new Proxy(native.storage, { get(target, key) {
        if (key === "setAlarm") return async (due) => {
          if (when === "after") await target.setAlarm(due);
          throw Error("alarm write unavailable");
        };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } }) };
      // Simulate an overdue selection without allowing a real alarm to race the
      // test. The native SQL + alarm transaction must roll back together.
      await expect(native.storage.transaction(async () => {
        put("state_event_outbox", base + 50_000);
        put("state_query_notification_outbox", base + 40_000);
        await scheduleStorageAlarmInTransaction(failing, { nowMs: base + 20_000 });
      })).rejects.toThrow("alarm write unavailable");
      expect(await native.storage.getAlarm()).toBe(original);
      expect(native.storage.sql.exec("SELECT next_wakeup_at_ms FROM state_event_outbox").one().next_wakeup_at_ms).toBe(original);
      expect(native.storage.sql.exec("SELECT COUNT(*) AS total FROM state_query_notification_outbox").one().total).toBe(0);
    });
  });
});
