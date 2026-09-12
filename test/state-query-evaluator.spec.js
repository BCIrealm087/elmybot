import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { featureRegistry } from "../src/features/index.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import {
  evaluateStateQuery,
  prepareStateQuery
} from "../src/state-querying/index.js";

let idCounter = 0;

function target(platform = "twitch") {
  idCounter += 1;
  return {
    platform,
    groupId: `${platform}-state-query-${idCounter}`
  };
}

function read(exportId, args) {
  return {
    read: { feature: "fun.deaths", export: exportId, version: 1 },
    ...(args ? { arguments: args } : {})
  };
}

function literal(game) {
  return { game: { literal: game } };
}

function query(targetGroup, bindings, select) {
  return { version: 1, target: targetGroup, bindings, select };
}

function fakeSources({
  remembered = "Hades",
  counts = { hades: 7, "dark souls": 2 },
  labels = { hades: "Hades", "dark souls": "Dark Souls" },
  complete = true,
  localRevisions = [1, 1],
  shareableRevisions = [2, 2]
} = {}) {
  const calls = {
    get: vi.fn(),
    boundedCounter: vi.fn(),
    boundedCounterSubjects: vi.fn()
  };
  const source = (kind) => {
    const revisions = kind === "local" ? localRevisions : shareableRevisions;
    let revisionIndex = 0;
    return {
      bindingKey: `${kind}:source`,
      async revision() {
        const value = revisions[Math.min(revisionIndex, revisions.length - 1)];
        revisionIndex += 1;
        return value;
      },
      async get(key) {
        calls.get(key);
        return remembered === null ? { found: false } : { found: true, value: remembered };
      },
      async boundedCounter(name, subject) {
        calls.boundedCounter(name, subject);
        return counts[subject] ?? 0;
      },
      async boundedCounterSubjects(name) {
        calls.boundedCounterSubjects(name);
        const subjects = Object.keys(labels).sort().filter((identity) =>
          Object.prototype.hasOwnProperty.call(counts, identity)
        ).map((identity) => ({
          identity,
          label: labels[identity],
          value: counts[identity]
        }));
        return {
          subjects,
          coverage: {
            complete,
            identifiedCount: subjects.length,
            unidentifiedCount: complete ? 0 : 1
          }
        };
      }
    };
  };
  const local = source("local");
  const shareable = source("shareable");
  return {
    calls,
    runtime: {
      async open(_featureId, definition) {
        return definition.scope.kind === "group_local" ? local : shareable;
      }
    }
  };
}

describe("state-query evaluator", () => {
  it("normalizes equivalent literal queries to one immutable digest", async () => {
    const selectedTarget = target();
    const first = await prepareStateQuery(featureRegistry, query(
      selectedTarget,
      { count: read("count", literal("  DARK   Souls  ")) },
      { deaths: { ref: "count", path: ["count"] } }
    ));
    const second = await prepareStateQuery(featureRegistry, query(
      selectedTarget,
      { count: read("count", literal("dark souls")) },
      { deaths: { ref: "count", path: ["count"] } }
    ));

    expect(first.query).toEqual(second.query);
    expect(first.digest).toBe(second.digest);
    expect(first.query.bindings.count.arguments.game.literal).toBe("dark souls");
    expect(Object.isFrozen(first.query)).toBe(true);
    expect(Object.isFrozen(first.query.bindings)).toBe(true);
  });

  it("composes direct, literal, dynamic, repeated, and collection reads", async () => {
    const sources = fakeSources();
    const result = await evaluateStateQuery(featureRegistry, query(
      target(),
      {
        remembered: read("remembered_game"),
        current: read("count", {
          game: { ref: "remembered", path: [] }
        }),
        dark: read("count", literal("Dark Souls")),
        dark_again: read("count", literal(" dark souls ")),
        known: read("counts")
      },
      {
        remembered: { ref: "remembered" },
        current: { ref: "current", path: ["count"] },
        dark: { ref: "dark", path: ["count"] },
        dark_again: { ref: "dark_again", path: ["count"] },
        games: { ref: "known" }
      }
    ), {
      sourceRuntime: sources.runtime,
      now: () => new Date("2026-09-12T12:00:00.000Z")
    });

    expect(result.envelope).toMatchObject({
      protocolVersion: 1,
      status: "ready",
      reason: "initial",
      observedAt: "2026-09-12T12:00:00.000Z",
      data: {
        remembered: { state: "present", value: "Hades" },
        current: { state: "present", value: 7 },
        dark: { state: "present", value: 2 },
        dark_again: { state: "present", value: 2 },
        games: {
          state: "present",
          value: [
            { game: "Dark Souls", count: 2 },
            { game: "Hades", count: 7 }
          ]
        }
      }
    });
    expect(sources.calls.boundedCounter).toHaveBeenCalledTimes(2);
    expect(result.observation.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "value", key: "last_game" }),
      expect.objectContaining({ kind: "bounded_counter", subject: "hades" }),
      expect.objectContaining({ kind: "collection", name: "game" })
    ]));
  });

  it("blocks a dynamic read when its remembered-game dependency is unselected", async () => {
    const sources = fakeSources({ remembered: null, counts: {}, labels: {} });
    const result = await evaluateStateQuery(featureRegistry, query(
      target(),
      {
        remembered: read("remembered_game"),
        current: read("count", { game: { ref: "remembered" } })
      },
      { deaths: { ref: "current", path: ["count"] } }
    ), { sourceRuntime: sources.runtime });

    expect(result.envelope.data.deaths).toEqual({
      state: "blocked",
      reason: "unselected",
      binding: "remembered"
    });
    expect(sources.calls.boundedCounter).not.toHaveBeenCalled();
  });

  it("preserves exact legacy lookup while rejecting an incomplete collection", async () => {
    const sources = fakeSources({
      counts: { hades: 11 },
      labels: {},
      complete: false
    });
    const exact = await evaluateStateQuery(featureRegistry, query(
      target(),
      { count: read("count", literal("Hades")) },
      { deaths: { ref: "count", path: ["count"] } }
    ), { sourceRuntime: sources.runtime });
    expect(exact.envelope.data.deaths).toEqual({ state: "present", value: 11 });

    await expect(evaluateStateQuery(featureRegistry, query(
      target(),
      { known: read("counts") },
      { games: { ref: "known" } }
    ), { sourceRuntime: fakeSources({ complete: false }).runtime }))
      .rejects.toMatchObject({ code: "query_collection_incomplete" });
  });

  it("rejects cycles, invalid projections, type mismatches, and excessive queries", async () => {
    const selectedTarget = target();
    await expect(prepareStateQuery(featureRegistry, query(
      selectedTarget,
      {
        first: read("count", { game: { ref: "second", path: ["game"] } }),
        second: read("count", { game: { ref: "first", path: ["game"] } })
      },
      { value: { ref: "first" } }
    ))).rejects.toMatchObject({ code: "query_cycle" });

    await expect(prepareStateQuery(featureRegistry, query(
      selectedTarget,
      { count: read("count", literal("Hades")) },
      { value: { ref: "count", path: ["missing"] } }
    ))).rejects.toMatchObject({ code: "query_reference_invalid" });

    await expect(prepareStateQuery(featureRegistry, query(
      selectedTarget,
      {
        source: read("count", literal("Hades")),
        destination: read("count", { game: { ref: "source", path: ["count"] } })
      },
      { value: { ref: "destination" } }
    ))).rejects.toMatchObject({ code: "query_type_mismatch" });

    await expect(prepareStateQuery(featureRegistry, query(
      selectedTarget,
      { count: read("count", { game: { literal: 1.5 } }) },
      { value: { ref: "count" } }
    ))).rejects.toMatchObject({ code: "query_argument_invalid" });

    const bindings = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
      `value_${index}`,
      read("remembered_game")
    ]));
    await expect(prepareStateQuery(featureRegistry, query(
      selectedTarget,
      bindings,
      { value: { ref: "value_0" } }
    ))).rejects.toMatchObject({ code: "query_limit_exceeded" });
  });

  it("retries changed source revisions and reports bounded instability", async () => {
    let attempts = 0;
    const unstable = await evaluateStateQuery(featureRegistry, query(
      target(),
      { remembered: read("remembered_game") },
      { game: { ref: "remembered" } }
    ), {
      maxAttempts: 2,
      sourceRuntimeFactory: () => {
        attempts += 1;
        return fakeSources({ localRevisions: [attempts, attempts + 1] }).runtime;
      }
    });
    expect(attempts).toBe(2);
    expect(unstable.envelope).toMatchObject({
      status: "unavailable",
      error: { code: "query_evaluation_unstable" }
    });

    attempts = 0;
    const recovered = await evaluateStateQuery(featureRegistry, query(
      target(),
      { remembered: read("remembered_game") },
      { game: { ref: "remembered" } }
    ), {
      maxAttempts: 2,
      sourceRuntimeFactory: () => {
        attempts += 1;
        return fakeSources({
          localRevisions: attempts === 1 ? [1, 2] : [2, 2]
        }).runtime;
      }
    });
    expect(attempts).toBe(2);
    expect(recovered.envelope.status).toBe("ready");
  });

  it("reads real deaths state without changing local or shareable revisions", async () => {
    const selectedTarget = target("discord");
    const group = {
      platform: "discord",
      kind: "guild",
      id: selectedTarget.groupId,
      key: `discord:guild:${selectedTarget.groupId}`
    };
    const invocation = createCommandInvocation({
      kind: "fun.deaths.manage.v1",
      origin: {
        group,
        actor: { platform: "discord", id: "query-test-user", claims: [] }
      },
      sourceEventId: `discord:query-test:${selectedTarget.groupId}`
    });
    const services = createFeatureServiceRuntime(env, invocation).featureServices;
    await services.state.set("fun.deaths", "last_game", "Hades");
    const scope = await services.shareableState.current(
      "fun.deaths",
      "twitch",
      "game_deaths"
    );
    await services.shareableState.boundedCounter(
      "fun.deaths",
      scope,
      {
        name: "game",
        subject: "hades",
        subjectLabel: "Hades",
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        initial: 0
      },
      "set",
      9
    );
    const localRevision = await services.state.revision("fun.deaths");
    const sharedRevision = await services.shareableState.revision("fun.deaths", scope);

    const result = await evaluateStateQuery(featureRegistry, query(
      selectedTarget,
      {
        remembered: read("remembered_game"),
        current: read("count", { game: { ref: "remembered" } })
      },
      {
        game: { ref: "remembered" },
        deaths: { ref: "current", path: ["count"] }
      }
    ), { env });

    expect(result.envelope).toMatchObject({
      status: "ready",
      data: {
        game: { state: "present", value: "Hades" },
        deaths: { state: "present", value: 9 }
      }
    });
    expect(await services.state.revision("fun.deaths")).toBe(localRevision);
    expect(await services.shareableState.revision("fun.deaths", scope))
      .toBe(sharedRevision);
  });
});
