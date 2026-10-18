import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryFixture, cleanupDeliveryFixtures } from "./helpers/state-event-delivery-fixture.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { prepareStateEventOperation } from "../src/framework/state-event-operation.js";
afterEach(cleanupDeliveryFixtures);
describe("declared combined command runtime", () => {
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
