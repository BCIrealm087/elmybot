import { describe, expect, it } from "vitest";
import { access } from "../src/framework/index.js";
import { discordTestActor, runCapabilityCases } from "../src/framework/testing.js";

describe("Capability-case evidence helper", () => {
  it("changes only the target capability, snapshots mutations, and records thrown denials", async () => {
    const actor = discordTestActor({ id: "same-actor", claims: ["test.claim"],
      capabilities: [access.members, access.managers, access.moderators] });
    const actors = [];
    const state = { count: 2 };
    const denial = new Error("denied");
    const cases = await runCapabilityCases({ actor, capability: access.moderators,
      readState: () => state,
      invoke: (caseActor) => {
        actors.push(caseActor);
        if (!caseActor.capabilities.includes(access.moderators)) {
          state.count += 1; // Deliberately broken guard: evidence must expose it.
          throw denial;
        }
        state.count += 1;
        return "allowed";
      }
    });
    expect(actors[0]).toMatchObject({ id: actor.id, claims: actor.claims,
      capabilities: [access.members, access.managers] });
    expect(actors[1]).toEqual(actor);
    expect(cases.withoutCapability).toMatchObject({ result: null, error: denial,
      stateBefore: { count: 2 }, stateAfter: { count: 3 } });
    expect(cases.withCapability).toMatchObject({ result: "allowed", error: null,
      stateBefore: { count: 3 }, stateAfter: { count: 4 } });
    expect(Object.isFrozen(cases.withoutCapability.stateBefore)).toBe(true);
    expect(actor.capabilities).toContain(access.moderators);
  });

  it("requires explicit capability and observation callbacks", async () => {
    const options = { actor: discordTestActor(), capability: access.moderators,
      invoke: () => null, readState: () => null };
    for (const override of [{ capability: null }, { capability: "unknown.capability" },
      { actor: null }, { invoke: null }, { readState: null }]) {
      await expect(runCapabilityCases({ ...options, ...override })).rejects.toThrow();
    }
    await expect(runCapabilityCases({ ...options, readState: () => undefined }))
      .rejects.toMatchObject({ code: "feature_test_json_invalid" });
  });
});
