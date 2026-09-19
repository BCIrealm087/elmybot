import { describe, expect, it } from "vitest";
import {
  defineFeature,
  defineReadableStateExport,
  frameworkApiVersion,
  ReadableStateDefinitionError
} from "../src/framework/index.js";
import {
  createFeatureRegistry,
  createReadableStateReference,
  normalizeReadableStateArguments
} from "../src/framework/internal.js";

function scoreExport(overrides = {}) {
  return defineReadableStateExport({
    id: "score",
    version: 1,
    label: " Score ",
    description: "A readable score.",
    kind: "lookup",
    platforms: ["twitch", "discord"],
    scope: { kind: "effective_shareable", namespace: "scores" },
    access: { kind: "operator_grant" },
    parameters: {
      game: {
        label: "Game",
        schema: { type: "string", minLength: 1, maxLength: 80 },
        normalize(value) {
          const label = value.trim().replace(/\s+/g, " ");
          return { value: label.normalize("NFKC").toLowerCase(), label };
        }
      }
    },
    result: {
      schema: {
        type: "object",
        properties: {
          game: { type: "string", minLength: 1, maxLength: 80 },
          count: { type: "integer", minimum: 0, maximum: 100 }
        },
        required: ["game", "count"]
      },
      absence: { kind: "default" }
    },
    resolve: async () => ({ state: "present", value: { game: "game", count: 0 } }),
    ...overrides
  });
}

function registryWith(readableState = [scoreExport()]) {
  return createFeatureRegistry([
    defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.score",
      description: "Tracks readable scores.",
      shareableState: [{
        id: "scores",
        label: "Scores",
        schemaVersion: 1
      }],
      readableState
    })
  ]);
}

describe("readable state declarations", () => {
  it("normalizes and freezes an optional contributor declaration", () => {
    const definition = scoreExport();
    expect(definition).toMatchObject({
      id: "score",
      version: 1,
      label: "Score",
      kind: "lookup",
      platforms: ["discord", "twitch"],
      scope: { kind: "effective_shareable", namespace: "scores" },
      access: { kind: "operator_grant" },
      result: { absence: { kind: "default" } }
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.parameters)).toBe(true);
    expect(Object.isFrozen(definition.result.schema.properties)).toBe(true);

    const withoutExports = defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.empty",
      description: "Has no readable state."
    });
    expect(withoutExports.readableState).toEqual([]);
    expect(Object.isFrozen(withoutExports.readableState)).toBe(true);
  });

  it("rejects raw, duplicate, malformed, and ambiguous declarations", () => {
    expect(() => defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.raw",
      description: "Uses a raw declaration.",
      readableState: [{ id: "score" }]
    })).toThrow(/defineReadableStateExport/);
    expect(() => defineFeature({
      apiVersion: frameworkApiVersion,
      id: "test.duplicate",
      description: "Duplicates a declaration.",
      readableState: [scoreExport(), scoreExport()]
    })).toThrow(/duplicates an export ID and version/);

    const invalid = [
      { id: "Score" },
      { platforms: [] },
      { access: { kind: "public" } },
      { resolve: null },
      { kind: "value" },
      { scope: { kind: "effective_shareable" } },
      {
        parameters: {
          game: { schema: { type: "string", minLength: 1, maxLength: 80 } }
        }
      },
      { result: { schema: { type: "unknown" }, absence: { kind: "default" } } },
      {
        kind: "collection",
        parameters: {},
        collection: {},
        result: {
          schema: { type: "string", minLength: 0, maxLength: 10 },
          absence: { kind: "default" }
        }
      }
    ];
    for (const override of invalid) {
      expect(() => scoreExport(override)).toThrow(ReadableStateDefinitionError);
    }
  });

  it("builds a public catalog without normalizers or namespace internals", () => {
    const registry = registryWith();
    expect(registry.readableCatalog).toEqual([{
      feature: "test.score",
      export: "score",
      version: 1,
      label: "Score",
      description: "A readable score.",
      kind: "lookup",
      scope: "effective_shareable",
      supportedPlatforms: ["discord", "twitch"],
      parameters: {
        game: {
          label: "Game",
          schema: { type: "string", minLength: 1, maxLength: 80 }
        }
      },
      resultSchema: {
        type: "object",
        properties: {
          game: { type: "string", minLength: 1, maxLength: 80 },
          count: { type: "integer", minimum: 0, maximum: 100 }
        },
        required: ["game", "count"]
      },
      absence: { kind: "default" }
    }]);
    expect(JSON.stringify(registry.readableCatalog)).not.toContain("normalize");
    expect(JSON.stringify(registry.readableCatalog)).not.toContain("scores");
    expect(JSON.stringify(registry.readableCatalog)).not.toContain("operator_grant");
  });

  it("requires effective-shareable exports to name a declared namespace", () => {
    const definition = scoreExport({
      scope: { kind: "effective_shareable", namespace: "missing" }
    });
    expect(() => registryWith([definition])).toThrow(/undeclared shareable namespace/);
  });

  it("canonicalizes logical references using feature domain normalization", () => {
    const registry = registryWith();
    const registered = registry.readableState["test.score:score:v1"].definition;
    expect(normalizeReadableStateArguments(registered, {
      game: "  DARK   Souls  "
    })).toEqual({
      values: { game: "dark souls" },
      subjects: {
        game: { identity: "dark souls", label: "DARK Souls" }
      }
    });

    const first = createReadableStateReference(registry, {
      target: { platform: "twitch", groupId: "42" },
      read: { feature: "test.score", export: "score", version: 1 },
      arguments: { game: "  DARK   Souls  " }
    });
    const second = createReadableStateReference(registry, {
      target: { platform: "twitch", groupId: "42" },
      read: { feature: "test.score", export: "score", version: 1 },
      arguments: { game: "dark souls" }
    });
    expect(first).toEqual(second);
    expect(first.arguments).toEqual({ game: "dark souls" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.arguments)).toBe(true);
  });

  it("rejects invalid parameters, targets, versions, and normalizer output", () => {
    const registry = registryWith();
    const base = {
      target: { platform: "twitch", groupId: "42" },
      read: { feature: "test.score", export: "score", version: 1 },
      arguments: { game: "Hades" }
    };
    expect(() => createReadableStateReference(registry, {
      ...base,
      arguments: {}
    })).toThrow(/is required/);
    expect(() => createReadableStateReference(registry, {
      ...base,
      target: { platform: "youtube", groupId: "42" }
    })).toThrow(/unsupported/);
    expect(() => createReadableStateReference(registry, {
      ...base,
      read: { ...base.read, version: 2 }
    })).toThrow(/installed readable export/);

    const broken = registryWith([scoreExport({
      parameters: {
        game: {
          label: "Game",
          schema: { type: "string", minLength: 1, maxLength: 80 },
          normalize: () => ({ value: "", label: "Game" })
        }
      }
    })]);
    expect(() => createReadableStateReference(broken, base))
      .toThrow(/normalizer returned an invalid value/);

    const nonIdempotent = registryWith([scoreExport({
      parameters: {
        game: {
          label: "Game",
          schema: { type: "string", minLength: 1, maxLength: 80 },
          normalize: (value) => `${value}x`
        }
      }
    })]);
    expect(() => createReadableStateReference(nonIdempotent, base))
      .toThrow(/must be idempotent/);
  });
});
