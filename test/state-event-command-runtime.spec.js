import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryFixture, cleanupDeliveryFixtures } from "./helpers/state-event-delivery-fixture.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { prepareStateEventOperation } from "../src/framework/state-event-operation.js";
import { resolveStateEventSharedRoute } from "../src/state-events/shared-publication.js";
import { env, runInDurableObject } from "cloudflare:test";
afterEach(cleanupDeliveryFixtures);
describe("declared combined command runtime", () => {
  it.each(["foreign feature", "undeclared operation", "wrong scope"])("denies %s before preparing or contacting an owner", async (fault) => {
    const f = await deliveryFixture();
    const input = createCommandInvocation({ kind: "test.delivery.change.v1", sourceEventId: `discord:denied:${f.group.id}`, sourceCreatedAtMs: Date.now(), args: {},
      origin: { group: f.group, actor: { platform: "discord", id: "actor", claims: [] } } });
    const runtime = createFeatureServiceRuntime(f.testEnv, input, f.registry).featureServices.stateEvents;
    const outbound = vi.fn(); f.intercept(outbound);
    const denied = fault === "wrong scope" ? runtime.current("test.delivery", "twitch", "change")
      : runtime.local(fault === "foreign feature" ? "foreign.feature" : "test.delivery", fault === "undeclared operation" ? "other" : "change");
    await expect(denied).rejects.toMatchObject({ code: "state_event_operation_undeclared", status: 422 });
    expect(outbound).not.toHaveBeenCalled();
  });
  it.each(["before invoke", "after commit"])("keeps one authoritative mutation when defaults move %s", async (boundary) => {
    const f = await deliveryFixture({ shared: true });
    const input = createCommandInvocation({ kind: "test.delivery.change.v1", sourceEventId: `discord:moving:${f.group.id}`, sourceCreatedAtMs: Date.now(), args: {},
      origin: { group: f.group, actor: { platform: "discord", id: "actor", claims: [] } } });
    const open = () => createFeatureServiceRuntime(f.testEnv, input, f.registry).featureServices.stateEvents.current("test.delivery", "twitch", "change");
    const prepare = vi.fn(async () => prepareStateEventOperation(f.registry.stateEvents["test.delivery:change"].definition, {}));
    let moved = false, original;
    f.intercept(async (kind, url, _init, send) => {
      if (moved || kind !== "CONFIG" || !String(url).endsWith("command/invoke")) return send();
      moved = true;
      if (boundary === "after commit") original = await (await send()).json();
      expect((await f.move()).status).toBe(200);
      if (boundary === "after commit") throw Error("committed reply lost during movement");
      return send();
    });
    let accepted;
    if (boundary === "after commit") {
      await expect((await open()).commitPrepared(prepare)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
      f.intercept(null); f.testEnv.STATE_EVENT_OPERATIONS_ENABLED = "false";
      accepted = await (await open()).commitPrepared(prepare);
      expect(accepted).toEqual({ accepted: true, ...original.receipt });
    } else accepted = await (await open()).commitPrepared(prepare);
    expect(accepted).toMatchObject({ accepted: true, result: { before: 0, after: 1 }, stateEvent: { operationSequence: 1 } });
    expect(prepare).toHaveBeenCalledTimes(1);
    const route = await resolveStateEventSharedRoute(f.testEnv, { sourceGroup: f.group, targetPlatform: "twitch", featureId: "test.delivery",
      namespaceId: "health", schemaVersion: 1, stream: f.registry.stateEvents["test.delivery:change"].streamDefinition });
    expect(route.key).not.toBe(f.route.key);
    const nextOwner = env.SHAREABLE_STATE_REALM.get(env.SHAREABLE_STATE_REALM.idFromName(route.key));
    const oldValues = await f.rows(f.ownerStub, "shareable_state_realm_values"), newValues = await f.rows(nextOwner, "shareable_state_realm_values");
    expect([...oldValues, ...newValues].map((row) => JSON.parse(row.value_json))).toEqual([1]);
    await runInDurableObject(nextOwner, (_i, state) => state.storage.deleteAlarm());
  });
  const corruptions = {
    missing: () => ({ state: "committed" }),
    null: () => null,
    operation: (value) => ({ ...value, receipt: { ...value.receipt, operationId: "seo1." + "x".repeat(43) } }),
    event: (value) => ({ ...value, receipt: { ...value.receipt, eventId: "dev1." + "x".repeat(43) } }),
    correlation: (value) => ({ ...value, receipt: { ...value.receipt, stateEvent: { ...value.receipt.stateEvent, operationSequence: 0 } } }),
    deadline: (value) => ({ ...value, receipt: { ...value.receipt, expiresAtMs: value.receipt.expiresAtMs + 1 } }),
    oversized: (value) => ({ ...value, receipt: { ...value.receipt, result: "x".repeat(4097) } })
  };
  it.each(["lookup", "invoke"].flatMap((boundary) => Object.keys(corruptions).map((fault) => ({ boundary, fault }))))(
    "rejects a malformed successful reply and recovers the original receipt (%j)", async ({ boundary, fault }) => {
      const f = await deliveryFixture({ suppressLocalCommitAlarm: true });
      const input = createCommandInvocation({ kind: "test.delivery.change.v1", sourceEventId: `discord:fault:${f.group.id}`, sourceCreatedAtMs: Date.now(), args: {},
        origin: { group: f.group, actor: { platform: "discord", id: "actor", claims: [] } } });
      const open = () => createFeatureServiceRuntime(f.testEnv, input, f.registry).featureServices.stateEvents.local("test.delivery", "change");
      const prepare = vi.fn(async () => prepareStateEventOperation(f.registry.stateEvents["test.delivery:change"].definition, {}));
      if (boundary === "lookup") await (await open()).commitPrepared(prepare);
      let original;
      f.intercept(async (kind, url, _init, send) => {
        const response = await send();
        if (kind !== "CONFIG" || !String(url).endsWith(`command/${boundary}`)) return response;
        original = await response.json();
        return Response.json(corruptions[fault](original));
      });
      await expect((await open()).commitPrepared(prepare)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
      f.intercept(null); f.testEnv.STATE_EVENT_OPERATIONS_ENABLED = "false";
      expect(await (await open()).commitPrepared(prepare)).toEqual({ accepted: true, ...original.receipt });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect((await f.rows(f.ownerStub, "state_event_outbox"))[0].operation_sequence).toBe(1);
    });
  it.each([false, true])("recovers an accepted local/shared operation before preparing input again (shared=%s)", async (shared) => {
    const f = await deliveryFixture({ shared, suppressLocalCommitAlarm: true });
    const input = createCommandInvocation({ kind: "test.delivery.change.v1", sourceEventId: `discord:runtime:${f.group.id}`, sourceCreatedAtMs: Date.now(), args: {},
      origin: { group: f.group, actor: { platform: "discord", id: "actor", claims: [] } } });
    const service = () => createFeatureServiceRuntime(f.testEnv, input, f.registry).featureServices.stateEvents;
    const open = () => shared ? service().current("test.delivery", "twitch", "change") : service().local("test.delivery", "change");
    const prepare = vi.fn(async () => prepareStateEventOperation(f.registry.stateEvents["test.delivery:change"].definition, {}));
    const first = await (await open()).commitPrepared(prepare);
    expect(first).toMatchObject({ accepted: true, result: { before: 0, after: 1 }, stateEvent: { operationSequence: 1 } });
    f.testEnv.STATE_EVENT_OPERATIONS_ENABLED = "false";
    const recovered = await (await open()).commitPrepared(async () => { throw Error("Frozen configuration must not be re-read"); });
    expect(recovered).toEqual(first); expect(prepare).toHaveBeenCalledTimes(1);
    expect(await f.rows(f.ownerStub, "state_event_outbox")).toHaveLength(1);
  });
});
