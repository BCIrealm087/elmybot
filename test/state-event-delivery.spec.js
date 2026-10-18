import { afterEach, describe, expect, it } from "vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { cleanupDeliveryFixtures, deliveryFixture } from "./helpers/state-event-delivery-fixture.js";
afterEach(cleanupDeliveryFixtures);
describe("combined deferred admission and gaps", () => {
  it.each([false, true])("appends offline with owner receipt authority and the original deadline (shared=%s)", async (shared) => {
    const f = await deliveryFixture({ shared }); const accepted = await f.commit();
    const result = await f.source("reconcile", { operationId: accepted.operationId });
    expect(result.status).toBe(200); expect(result.data.state).toBe("appended");
    const events = await f.rows(f.streamStub, "durable_event_stream_events");
    expect(events).toHaveLength(1); expect(events[0].expires_at_ms).toBe(accepted.receipt.expiresAtMs);
    expect(JSON.parse(events[0].state_event_json)).toEqual(accepted.receipt.stateEvent);
    expect(JSON.stringify(events[0].state_event_json)).not.toContain(f.owner.key);
  });
  it("rejects missing source proof and ordinary append cannot enable the combined mode", async () => {
    const f = await deliveryFixture();
    expect((await f.streamCall("combined/append", { operationId: "seo1." + "x".repeat(43) })).status).toBe(503);
    expect((await f.streamCall("append", { eventId: "dev1." + "a".repeat(43), fingerprint: "b".repeat(64),
      featureId: "test.delivery", streamId: "impacts", version: 2,
      route: { routeId: f.route.streamRouteId, bindingRevision: 0 } })).status).toBe(503);
  });
  it("does not let a later operation overtake a blocked head", async () => {
    const f = await deliveryFixture(), a = await f.commit(), b = await f.commit();
    expect((await f.source("reconcile", { operationId: b.operationId })).status).toBe(409);
    expect((await f.source("reconcile", { operationId: a.operationId })).data.sequence).toBe(1);
    expect((await f.source("reconcile", { operationId: b.operationId })).data.sequence).toBe(2);
  });
  it("keeps committed state and source work when destination capacity is full", async () => {
    const f = await deliveryFixture(), a = await f.commit();
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_count = 1000"));
    expect((await f.source("reconcile", { operationId: a.operationId })).status).toBe(429);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].state).toBe("pending");
    expect((await f.rows(f.streamStub, "durable_event_stream_events"))).toEqual([]);
  });
  it("recovers a lost append reply after eviction without extending expiry or appending twice", async () => {
    const f = await deliveryFixture(), a = await f.commit(); let lost = false;
    f.intercept(async (kind, input, _init, send) => {
      const response = await send();
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append") && !lost) { lost = true; throw Error("lost reply"); }
      return response;
    });
    expect((await f.source("reconcile", { operationId: a.operationId })).status).toBe(500);
    f.intercept(null);
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.deleteAlarm());
    await evictDurableObject(f.streamStub);
    const retry = await f.source("reconcile", { operationId: a.operationId });
    expect(retry.data).toMatchObject({ state: "appended", sequence: 1, expiresAtMs: a.receipt.expiresAtMs });
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
  }, 15000);
  it("does not announce ready after an unseen source expiry", async () => {
    const f = await deliveryFixture(), a = await f.commit(), grant = f.grant();
    expect((await f.streamCall("grants/issue", grant)).status).toBe(201);
    await expireIntent(f, a.operationId);
    const socket = await f.openSocket(grant.grantId), message = nextMessage(socket);
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
    expect((await message).type).toBe("error");
    expect((await f.rows(f.streamStub, "durable_event_stream_metadata"))[0].consumer_ready).toBe(0);
  });
  it("sends safe versioned correlation and acknowledgement still removes the event", async () => {
    const f = await deliveryFixture(), a = await f.commit(); await f.source("reconcile", { operationId: a.operationId });
    const grant = f.grant(); expect((await f.streamCall("grants/issue", grant)).status).toBe(201);
    const socket = await f.openSocket(grant.grantId), messages = [];
    const event = new Promise((resolve) => socket.addEventListener("message", ({ data }) => { const parsed = JSON.parse(data); messages.push(parsed); if (parsed.type === "event") resolve(parsed); }));
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
    const frame = await event;
    expect(messages[0].type).toBe("ready"); expect(frame.stateEvent).toEqual(a.receipt.stateEvent);
    expect(JSON.stringify(frame)).not.toContain(f.owner.key);
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: frame.cursor }));
    await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("SELECT 1"));
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("retains unconfirmed destination authority after normal receipt expiry and retries confirmation", async () => {
    const f = await deliveryFixture(), a = await f.commit();
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/confirm")) throw Error("confirmation lost"); return send();
    });
    expect((await f.source("reconcile", { operationId: a.operationId })).data.state).toBe("appended");
    expect((await f.rows(f.streamStub, "state_event_destination_records"))[0].expires_at_ms).toBeNull();
    await runInDurableObject(f.streamStub, async (instance, state) => {
      state.storage.sql.exec("UPDATE durable_event_stream_receipts SET expires_at_ms = 0"); await instance.alarm();
    });
    expect((await f.streamCall("combined/lookup", { operationId: a.operationId })).data.state).toBe("appended");
    f.intercept(null); await f.source("reconcile", { operationId: a.operationId });
    expect((await f.rows(f.streamStub, "state_event_destination_records"))[0].expires_at_ms).not.toBeNull();
  });
  it("rejects a stale proof that resumes after a completed reset", async () => {
    const f = await deliveryFixture(), a = await f.commit();
    const proof = (await f.source("proof", { operationId: a.operationId })).data;
    expect((await f.streamCall("grants/issue", f.grant(true))).status).toBe(201);
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "CONFIG" && String(input).endsWith("delivery/proof")) return new Response(JSON.stringify(proof));
      return send();
    });
    expect((await f.streamCall("combined/append", { operationId: a.operationId })).data.code).toBe("state_event_reset_discarded");
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("creates an idempotent pre-append retention gap without inventing a destination sequence", async () => {
    const f = await deliveryFixture(), a = await f.commit(); await expireIntent(f, a.operationId);
    const result = await f.source("reconcile", { operationId: a.operationId });
    expect(result.data).toMatchObject({ state: "gap", reason: "retention", firstOperationSequence: 1 });
    expect(result.data.sequence).toBeUndefined();
    expect((await f.rows(f.streamStub, "durable_event_stream_metadata"))[0].next_sequence).toBe(1);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    expect((await f.source("reconcile", { operationId: a.operationId })).data).toEqual(result.data);
    expect(await f.rows(f.streamStub, "state_event_destination_records")).toHaveLength(1);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].state).toBe("gap_recorded");
    await expect(f.commit()).rejects.toMatchObject({ code: "state_event_stream_blocked" });
  });
  it.each(["bytes", "rate", "receipts"])("enforces the destination %s budget without losing the accepted source intent", async (limit) => {
    const f = await deliveryFixture(), a = await f.commit();
    if (limit === "bytes") await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE durable_event_stream_metadata SET retained_bytes = 1048576"));
    if (limit === "rate") await runInDurableObject(f.streamStub, (_i, state) => {
      for (let i = 0; i < 10; i++) state.storage.sql.exec("INSERT INTO durable_event_stream_ingress VALUES (?, ?)", `existing-${i}`, Date.now());
    });
    if (limit === "receipts") {
      await f.streamCall("combined/lookup", { operationId: a.operationId });
      await runInDurableObject(f.streamStub, (_i, state) => state.storage.sql.exec("UPDATE state_event_destination_budget SET bytes = 16777216"));
    }
    expect((await f.source("reconcile", { operationId: a.operationId })).status).toBe(429);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].state).toBe("pending");
  });
  it("blocks new acceptance once the source learns the destination requires reset", async () => {
    const f = await deliveryFixture(), a = await f.commit(); await f.source("reconcile", { operationId: a.operationId });
    await runInDurableObject(f.streamStub, async (instance, state) => {
      state.storage.sql.exec("UPDATE durable_event_stream_events SET expires_at_ms = 0"); await instance.alarm();
    });
    const b = await f.commit(); expect((await f.source("reconcile", { operationId: b.operationId })).status).toBe(409);
    await expect(f.commit()).rejects.toMatchObject({ code: "state_event_stream_blocked" });
  });
  it("can reconcile expiry on a frozen shared owner without reopening feature writes", async () => {
    const f = await deliveryFixture({ shared: true }), a = await f.commit(); await expireIntent(f, a.operationId);
    await runInDurableObject(f.ownerStub, (_i, state) => state.storage.sql.exec("UPDATE shareable_state_realm_namespaces SET freeze_id = ?", crypto.randomUUID()));
    expect((await f.source("reconcile", { operationId: a.operationId })).data.state).toBe("gap");
    expect((await f.rows(f.ownerStub, "shareable_state_realm_values"))[0].value_json).toBe("1");
  });
  it("does not append while the event master switch is disabled", async () => {
    const f = await deliveryFixture(), a = await f.commit(); f.testEnv.DURABLE_EVENT_STREAMS_ENABLED = "false";
    expect((await f.source("reconcile", { operationId: a.operationId })).status).toBe(503);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].state).toBe("pending");
  });
  it("records expiry after append through the existing stream gap and keeps the append receipt", async () => {
    const f = await deliveryFixture(), a = await f.commit(); await f.source("reconcile", { operationId: a.operationId });
    await runInDurableObject(f.streamStub, async (instance, state) => {
      state.storage.sql.exec("UPDATE durable_event_stream_events SET expires_at_ms = 0"); await instance.alarm();
    });
    expect((await f.rows(f.streamStub, "durable_event_stream_metadata"))[0]).toMatchObject({ gap_first_sequence: 1, gap_last_sequence: 1 });
    expect((await f.streamCall("combined/lookup", { operationId: a.operationId })).data).toMatchObject({ state: "appended", sequence: 1, expiresAtMs: a.receipt.expiresAtMs });
    expect((await f.streamCall("grants/issue", f.grant())).status).toBe(409);
  });
  it("requires producer authority even when the stream has no retained events", async () => {
    const f = await deliveryFixture(), a = await f.commit(); await expireIntent(f, a.operationId);
    expect((await f.streamCall("grants/issue", f.grant())).status).toBe(409);
    expect((await f.rows(f.streamStub, "durable_event_stream_metadata"))[0].retained_count).toBe(0);
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "CONFIG" && String(input).endsWith("delivery/status")) throw Error("producer unreachable"); return send();
    });
    expect((await f.streamCall("grants/issue", f.grant())).status).toBe(500);
  });
  it("coordinates reset across both owners, fences new acceptance and preserves operation sequence", async () => {
    const f = await deliveryFixture(), a = await f.commit(); await expireIntent(f, a.operationId);
    await f.source("reconcile", { operationId: a.operationId });
    const reset = f.grant(true);
    const response = await f.streamCall("grants/issue", reset); expect(response.status).toBe(201);
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].state).toBe("reset_discarded");
    expect((await f.rows(f.ownerStub, "state_event_source_streams"))[0]).toMatchObject({ reset_id: null, gap_first: null, checkpoint: 1 });
    expect((await f.rows(f.streamStub, "state_event_destination"))[0]).toMatchObject({ gap_first: null, reset_id: null, reset_checkpoint: 1 });
    const b = await f.commit(); expect(b.receipt.stateEvent.operationSequence).toBe(2);
    expect((await f.streamCall("grants/issue", reset)).status).toBe(201);
    expect((await f.rows(f.ownerStub, "state_event_outbox")).find((row) => row.operation_id === b.operationId).state).toBe("pending");
    expect((await f.source("reconcile", { operationId: b.operationId })).data.state).toBe("appended");
    expect(await f.rows(f.streamStub, "state_event_destination_resets")).toHaveLength(1);
  });
  it("keeps reset fenced across a lost release reply and resumes the same checkpoint", async () => {
    const f = await deliveryFixture(), a = await f.commit(), reset = f.grant(true);
    f.intercept(async (kind, input, _init, send) => {
      if (kind === "CONFIG" && String(input).endsWith("reset-release")) throw Error("release unavailable"); return send();
    });
    expect((await f.streamCall("grants/issue", reset)).status).toBe(500);
    await expect(f.commit()).rejects.toMatchObject({ code: "state_event_stream_blocked" });
    expect((await f.rows(f.ownerStub, "state_event_source_streams"))[0].reset_id).toBe(reset.grantId);
    f.intercept(null); expect((await f.streamCall("grants/issue", reset)).status).toBe(201);
    expect((await f.rows(f.ownerStub, "state_event_source_streams"))[0].reset_id).toBeNull();
    expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].operation_id).toBe(a.operationId);
  });
  it("turns an unappended moved binding into a gap on the original stream", async () => {
    const f = await deliveryFixture({ shared: true }), a = await f.commit();
    expect((await f.move()).status).toBe(200);
    expect((await f.source("reconcile", { operationId: a.operationId })).data).toMatchObject({ state: "gap", reason: "lifecycle" });
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("fences a delayed shared append before allowing a default movement", async () => {
    const f = await deliveryFixture({ shared: true }), a = await f.commit(); let delayed;
    f.intercept(async (kind, input, init, send) => {
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append")) {
        delayed = JSON.parse(init.body); throw Error("lost before append");
      }
      return send();
    });
    expect((await f.source("reconcile", { operationId: a.operationId })).status).toBe(500);
    f.intercept(null); expect((await f.move()).status).toBe(200);
    const late = await f.streamCall("combined/append", delayed);
    expect(late.data.code).toBe("state_event_attempt_fenced");
    expect((await f.source("reconcile", { operationId: a.operationId })).data.reason).toBe("lifecycle");
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("returns a proven old append after movement instead of converting it to a lifecycle gap", async () => {
    const f = await deliveryFixture({ shared: true }), a = await f.commit(); let lost = false;
    f.intercept(async (kind, input, _init, send) => {
      const response = await send();
      if (kind === "DURABLE_EVENT_STREAM" && String(input).endsWith("combined/append") && !lost) { lost = true; throw Error("lost committed reply"); }
      return response;
    });
    expect((await f.source("reconcile", { operationId: a.operationId })).status).toBe(500);
    f.intercept(null); expect((await f.move()).status).toBe(200);
    expect((await f.source("reconcile", { operationId: a.operationId })).data).toMatchObject({ state: "appended", sequence: 1 });
    expect((await f.rows(f.streamStub, "state_event_destination"))[0].gap_first).toBeNull();
  });

});

async function expireIntent(f, operationId) {
  await runInDurableObject(f.ownerStub, (_i, state) => {
    const row = state.storage.sql.exec("SELECT intent_json FROM state_event_outbox WHERE operation_id = ?", operationId).one();
    const intent = JSON.parse(row.intent_json); intent.committedAtMs = Date.now() - 1_800_001; intent.expiresAtMs = Date.now() - 1;
    state.storage.sql.exec("UPDATE state_event_outbox SET intent_json = ?, deadline_ms = ?, next_wakeup_at_ms = 0 WHERE operation_id = ?", JSON.stringify(intent), intent.expiresAtMs, operationId);
    const record = state.storage.sql.exec("SELECT metadata_json FROM state_event_records WHERE record_key = ?", `owner:${operationId}`).one();
    const metadata = JSON.parse(record.metadata_json); metadata.receipt.committedAtMs = intent.committedAtMs; metadata.receipt.expiresAtMs = intent.expiresAtMs;
    state.storage.sql.exec("UPDATE state_event_records SET metadata_json = ? WHERE record_key = ?", JSON.stringify(metadata), `owner:${operationId}`);
  });
}

function nextMessage(socket) {
  return new Promise((resolve) => socket.addEventListener("message", ({ data }) => resolve(JSON.parse(data)), { once: true }));
}
