import { describe, expect, it } from "vitest";
import { boundedStateEventRequest } from "../src/state-events/relay-client.js";
import { deliverySourceRequest } from "../src/state-events/delivery-source.js";

describe("private state/event transport diagnostics", () => {
  const secret = "private-payload-and-grant-secret";
  const faults = {
    transport: async () => { throw Object.assign(Error(secret), { code: secret }); },
    json: async () => new Response(secret),
    code: async () => Response.json({ code: secret }, { status: 503 }),
    array: async () => Response.json({ code: ["state_event_cooldown"] }, { status: 503 }),
    null: async () => Response.json(null, { status: 503 })
  };
  it.each(Object.keys(faults))("redacts %s failures at both binding boundaries", async (fault) => {
    const call = faults[fault], owner = { kind: "group_local", key: "private-owner" };
    const env = { CONFIG: { idFromName: () => "id", get: () => ({ fetch: call }) } };
    for (const request of [() => boundedStateEventRequest(call), () => deliverySourceRequest(env, owner, "proof", {})]) {
      await expect(request()).rejects.toMatchObject({ code: "state_event_outcome_unknown", message: "state_event_outcome_unknown", status: 503 });
    }
  });
  it("preserves validated cooldown guidance and bounds malformed retry hints", async () => {
    await expect(boundedStateEventRequest(async () => Response.json({ code: "state_event_cooldown", retryAfterSeconds: 86400 }, { status: 429 })))
      .rejects.toMatchObject({ code: "state_event_cooldown", retryAfterSeconds: 86400 });
    const error = await boundedStateEventRequest(async () => Response.json({ code: "durable_event_stream_full", retryAfterMs: 300_001, retryAfterSeconds: -1 }, { status: 429 })).catch((value) => value);
    expect(error).toMatchObject({ code: "durable_event_stream_full", retryAfterMs: undefined, retryAfterSeconds: undefined });
  });
});
