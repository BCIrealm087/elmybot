import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { cleanupDeliveryFixtures, deliveryFixture } from "./helpers/state-event-delivery-fixture.js";
import { sourceDeliverySnapshot, sourceSnapshotHeaders } from "../src/state-events/delivery-snapshot.js";
import worker from "../src/index.js";
import { nativeHealthFixture, cleanupNativeHealthFixtures } from "./helpers/installed-health-native-fixture.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanupDeliveryFixtures(); await cleanupNativeHealthFixtures(); });
async function snapshot(f, operationId, owner = f.owner) {
  return runInDurableObject(f.ownerStub, (_instance, state) => sourceDeliverySnapshot(state, f.testEnv, owner, operationId, f.route.streamRouteId));
}
function input(f, accepted, sourceSnapshot) { return { owner: f.owner, routeId: f.route.streamRouteId, operationId: accepted.operationId, sourceSnapshot }; }

describe("private owner-validated delivery snapshots", () => {
  it("rejects unmarked snapshots and exposes no public snapshot delivery route", async () => {
    const f = await deliveryFixture(), accepted = await f.commit(), bundle = await snapshot(f, accepted.operationId);
    expect((await f.streamCall("combined/append", input(f, accepted, bundle))).status).toBe(403);
    const response = await worker.fetch(new Request("https://worker/internal/events/combined/append", {
      method: "POST", headers: { "x-elmybot-durable-event-internal": "v1", "x-elmybot-state-event-delivery": "v1", ...sourceSnapshotHeaders(bundle) },
      body: JSON.stringify(input(f, accepted, bundle))
    }), env, { waitUntil() {} });
    expect(response.status).toBe(404);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("constructs snapshots only at the actual physical owner", async () => {
    const f = await deliveryFixture(), accepted = await f.commit();
    await expect(snapshot(f, accepted.operationId, { kind: f.owner.kind, key: "another-owner" })).rejects.toMatchObject({ code: "state_event_wrong_owner" });
  });
  it.each(["version", "owner", "operation", "route"])("rejects a mismatched snapshot %s", async (field) => {
    const f = await deliveryFixture(), accepted = await f.commit(), bundle = await snapshot(f, accepted.operationId);
    if (field === "version") bundle.version = 2;
    if (field === "owner") bundle.owner.key = "another-owner";
    if (field === "operation") bundle.proof.intent.operationId = "seo1." + "x".repeat(43);
    if (field === "route") bundle.routeId = "des1." + "x".repeat(43);
    expect((await f.streamCall("combined/append", input(f, accepted, bundle), sourceSnapshotHeaders(bundle))).status).toBe(422);
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("retains the ordered-head check on a forwarded snapshot", async () => {
    const f = await deliveryFixture(); await f.commit(); const second = await f.commit(), bundle = await snapshot(f, second.operationId);
    expect((await f.streamCall("combined/append", input(f, second, bundle), sourceSnapshotHeaders(bundle))).data.code).toBe("state_event_delivery_order");
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("carries a near-limit payload transiently without persisting it in registry barriers", async () => {
    const padding = "x".repeat(3900), f = await deliveryFixture({ shared: true, payloadPadding: padding }), accepted = await f.commit();
    let bodyBytes = 0;
    f.intercept(async (kind, url, init, send) => {
      // Keep this regression on the lease/fencing fallback path.
      if (String(url).endsWith("/probe")) throw Error("receipt probe unavailable");
      if (kind === "DURABLE_EVENT_STREAM" && String(url).endsWith("combined/append")) {
        bodyBytes = new TextEncoder().encode(init.body).byteLength;
        await send(); throw Error("Synthetic reply loss for near-limit append");
      }
      return send();
    });
    const reply = await f.source("reconcile", { operationId: accepted.operationId });
    expect(reply).toMatchObject({ status: 503, data: { code: "state_event_outcome_unknown" } });
    expect(bodyBytes).toBeLessThanOrEqual(24 * 1024);
    const barriers = await f.rows(f.registryStub, "state_event_commit_barriers");
    expect(barriers).toHaveLength(1);
    expect(barriers[0].attempt_json).not.toContain("sourceSnapshot");
    expect(barriers[0].attempt_json).not.toContain(padding);
    const event = (await f.rows(f.streamStub, "durable_event_stream_events"))[0];
    expect(JSON.parse(event.payload_json).padding).toBe(padding);
    f.intercept(null);
    await runInDurableObject(f.ownerStub, (_instance, state) => state.storage.sql.exec("UPDATE state_event_outbox SET lease_until_ms = 0, next_wakeup_at_ms = 0"));
    expect((await f.source("reconcile", { operationId: accepted.operationId })).data.state).toBe("appended");
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toHaveLength(1);
  });
  it("checks the destination reset checkpoint after a valid snapshot was captured", async () => {
    const f = await deliveryFixture(), accepted = await f.commit(), bundle = await snapshot(f, accepted.operationId);
    expect((await f.streamCall("grants/issue", f.grant(true))).status).toBe(201);
    expect((await f.streamCall("combined/append", input(f, accepted, bundle), sourceSnapshotHeaders(bundle))).data.code).toBe("state_event_reset_discarded");
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("uses current expiry rather than snapshot creation time", async () => {
    const f = await deliveryFixture(), accepted = await f.commit(), bundle = await snapshot(f, accepted.operationId);
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1);
    const result = await f.streamCall("combined/append", input(f, accepted, bundle), sourceSnapshotHeaders(bundle));
    expect(result.data).toMatchObject({ state: "gap", reason: "retention", operationId: accepted.operationId });
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
  });
  it("keeps registry revocation authoritative for an installed linked owner's queued publication", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    const f = await nativeHealthFixture({ linked: true }), invocation = f.invocation();
    expect((await f.command(invocation)).output.message).toBe("Health saved and impact queued.");
    const revoked = await f.registryStub.fetch("https://registry/groups/revoke", { method: "POST", body: JSON.stringify({
      group: f.discord, actor: { platform: "discord", id: "operator", claims: [] }
    }) });
    expect(revoked.ok).toBe(true);
    await runInDurableObject(f.ownerStub, async (instance, state) => {
      state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = ?", Date.now());
      await instance.alarm();
    });
    expect(await f.rows(f.streamStub, "durable_event_stream_events")).toEqual([]);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    const row = (await f.rows(f.ownerStub, "state_event_records")).find((item) => item.record_key.startsWith("owner:"));
    expect(JSON.parse(row.metadata_json)).toMatchObject({ pendingDelivery: false,
      receipt: { result: { after: 99 } }, deliveryOutcome: { state: "gap", reason: "lifecycle" } });
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
    expect((await f.command(invocation)).output.message).toBe("Health saved and impact queued.");
    expect((await f.rows(f.ownerStub, "state_event_partitions"))[0].operation_sequence).toBe(1);
  });
  it.each([false, true])("retires the confirmed original cache directly and retains recovery for old unconfirmed origins (confirmed=%s)", async (confirmed) => {
    const f = await deliveryFixture({ shared: true }), accepted = await f.commit();
    expect((await f.source("reconcile", { operationId: accepted.operationId })).data.state).toBe("appended");
    const origin = env.CONFIG.get(env.CONFIG.idFromName(f.group.key));
    await runInDurableObject(origin, (_instance, state) => {
      const row = state.storage.sql.exec("SELECT record_key, metadata_json FROM state_event_records WHERE record_key LIKE 'origin:%'").one();
      const metadata = JSON.parse(row.metadata_json); metadata.ownerConfirmed = confirmed;
      state.storage.sql.exec("UPDATE state_event_records SET metadata_json = ? WHERE record_key = ?", JSON.stringify(metadata), row.record_key);
    });
    let lookups = 0;
    f.intercept((kind, url, _init, send) => { if (kind === "SHAREABLE_STATE_REALM" && String(url).endsWith("state-event-lookup")) lookups++; return send(); });
    vi.spyOn(Date, "now").mockReturnValue(accepted.receipt.expiresAtMs + 1);
    expect((await f.source("reconcile", { operationId: accepted.operationId })).data.terminal).toBe("retention");
    expect(lookups).toBe(confirmed ? 0 : 1);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toEqual([]);
    const originRow = (await f.rows(origin, "state_event_records")).find((row) => row.record_key.startsWith("origin:"));
    expect(JSON.parse(originRow.metadata_json).receipt).toEqual(accepted.receipt);
    expect(originRow.prune_at_ms).not.toBeNull();
  });
});
