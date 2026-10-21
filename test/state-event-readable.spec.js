import { afterEach, describe, expect, it } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { deliveryFixture, cleanupDeliveryFixtures } from "./helpers/state-event-delivery-fixture.js";
import { evaluateStateQuery } from "../src/state-querying/evaluator.js";

const fixtures = [];
afterEach(async () => { fixtures.length = 0; await cleanupDeliveryFixtures(); });
async function setup(shared, options = {}) {
  const f = await deliveryFixture({ shared, suppressLocalCommitAlarm: true, ...options }); fixtures.push(f);
  const query = { version: 1, target: { platform: "discord", groupId: f.group.id },
    bindings: { current: { read: { feature: "test.delivery", export: "current", version: 1 } } },
    select: { value: { ref: "current" } } };
  return { ...f, query, read: async () => (await evaluateStateQuery(f.registry, query, { env: f.testEnv })).envelope };
}
describe("readable combined-operation watermarks", () => {
  it.each([false, true])("reads the value and owner-partition watermark together (shared=%s)", async (shared) => {
    const f = await setup(shared), first = await f.read();
    expect(first).toMatchObject({ status: "ready", data: { value: { value: 0, stateEvent: { version: 1, operationSequence: 0 } } } });
    const marker = first.data.value.stateEvent;
    expect(marker.scopeToken).toMatch(/^ses1\.[\w-]{22}$/);
    const accepted = await f.commit(), second = await f.read();
    expect(second.data.value).toMatchObject({ value: 1, stateEvent: { ...marker, operationSequence: 1, stateRevision: accepted.receipt.stateEvent.stateRevision } });
    expect(second.resultRevision).not.toBe(first.resultRevision);
    await evictDurableObject(f.ownerStub);
    expect((await f.read()).data).toEqual(second.data);
    expect(JSON.stringify(second)).not.toContain(f.route.key);
    expect(JSON.stringify(second)).not.toContain(accepted.operationId);
  });
  it.each([false, true])("observes accepted clamped no-ops as new snapshots (shared=%s)", async (shared) => {
    const f = await setup(shared, { bounded: true }), first = await f.read();
    const accepted = await f.commit(), next = await f.read();
    expect(next.status).toBe("ready");
    expect(next.data.value.value).toBe(first.data.value.value);
    expect(accepted.receipt.result.changed).toBe(false);
    expect(next.resultRevision).not.toBe(first.resultRevision);
    expect(next.data.value.stateEvent).toMatchObject({ operationSequence: 1, stateRevision: accepted.receipt.stateEvent.stateRevision });
    expect(next.data.value.stateEvent.stateRevision).toBeGreaterThan(first.data.value.stateEvent.stateRevision);
  });
  it("retries the whole query if an operation commits between reading its value and checking its revision", async () => {
    const f = await setup(false); await f.read(); let injected = false;
    f.intercept(async (kind, input, _init, send) => {
      const response = await send();
      if (!injected && kind === "CONFIG" && String(input).endsWith("state/query-read")) { injected = true; await f.commit(); }
      return response;
    });
    const next = await f.read(); expect(next.data.value).toMatchObject({ value: 1, stateEvent: { operationSequence: 1 } });
  });
  it("uses a fresh partition token after shared binding movement without copying old operation watermarks", async () => {
    const f = await setup(true); await f.commit(); const before = await f.read();
    expect((await f.move()).status).toBe(200);
    const after = await f.read(); expect(after.status).toBe("ready");
    expect(after.data.value.stateEvent.scopeToken).not.toBe(before.data.value.stateEvent.scopeToken);
    expect(after.data.value.stateEvent.operationSequence).toBe(0);
  });
  it("preserves the watermark after outbox cleanup and allocates no idle alarm on a fresh read", async () => {
    const f = await setup(false); await f.read();
    expect(await runInDurableObject(f.ownerStub, (_i, state) => state.storage.getAlarm())).toBeNull();
    const first = await f.commit(), before = await f.read();
    await runInDurableObject(f.ownerStub, (_i, state) => {
      state.storage.sql.exec("DELETE FROM state_event_outbox");
      state.storage.sql.exec("UPDATE state_event_outbox_budget SET rows = 0, bytes = 0");
    });
    expect((await f.read()).data).toEqual(before.data);
    expect(before.data.value.stateEvent.operationSequence).toBe(first.receipt.stateEvent.operationSequence);
  });
});
