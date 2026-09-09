import { describe, expect, it } from "vitest";
import {
  FeatureCheckError,
  installedFeatureIssue,
  parseFeatureCheckArguments,
  workspaceDependencyIssue
} from "../scripts/feature-check-contract.js";

function linkedWorkspace(overrides = {}) {
  return {
    packageName: "@elmybot/feature-fun-hype",
    packageVersion: "0.1.0",
    workspacePath: "packages/features/fun-hype",
    rootDependency: "0.1.0",
    lockWorkspaceVersion: "0.1.0",
    lockLink: {
      link: true,
      resolved: "packages/features/fun-hype"
    },
    linkedWorkspacePath: "packages/features/fun-hype",
    ...overrides
  };
}

describe("Feature check contract", () => {
  it("uses a focused fast check unless readiness is explicit", () => {
    expect(parseFeatureCheckArguments(["fun-hype"])).toEqual({
      slug: "fun-hype",
      mode: "fast"
    });
    expect(parseFeatureCheckArguments(["--ready", "fun-hype"])).toEqual({
      slug: "fun-hype",
      mode: "ready"
    });
    expect(parseFeatureCheckArguments(["fun-hype", "--fast"])).toEqual({
      slug: "fun-hype",
      mode: "fast"
    });
  });

  it("rejects unclear feature selections and modes", () => {
    for (const argumentsList of [
      [],
      ["../fun-hype"],
      ["fun-hype", "other-feature"],
      ["fun-hype", "--unknown"],
      ["fun-hype", "--fast", "--ready"]
    ]) {
      expect(() => parseFeatureCheckArguments(argumentsList))
        .toThrow(FeatureCheckError);
    }
  });

  it("explains an absent root dependency before later link checks", () => {
    expect(workspaceDependencyIssue(linkedWorkspace({
      rootDependency: undefined,
      lockWorkspaceVersion: undefined,
      lockLink: undefined,
      linkedWorkspacePath: null
    }))).toEqual({
      message: "@elmybot/feature-fun-hype is not an exact root dependency.",
      next:
        'Add "@elmybot/feature-fun-hype": "0.1.0" to root dependencies, ' +
        "then run npm install."
    });
  });

  it("distinguishes dependency, lockfile, and node_modules drift", () => {
    expect(workspaceDependencyIssue(linkedWorkspace({
      rootDependency: "^0.1.0"
    }))).toMatchObject({
      message: expect.stringContaining('expected "0.1.0"'),
      next: expect.stringContaining("root dependencies")
    });
    expect(workspaceDependencyIssue(linkedWorkspace({
      lockLink: undefined
    }))).toEqual({
      message:
        "package-lock.json does not contain the current " +
        "@elmybot/feature-fun-hype workspace link.",
      next: "Run npm install to update the lockfile and workspace links."
    });
    expect(workspaceDependencyIssue(linkedWorkspace({
      linkedWorkspacePath: null
    }))).toEqual({
      message: "@elmybot/feature-fun-hype is not linked in node_modules.",
      next: "Run npm install to create the workspace link."
    });
    expect(workspaceDependencyIssue(linkedWorkspace())).toBeNull();
  });

  it("requires exactly one explicit registry installation", () => {
    expect(installedFeatureIssue({ featureId: "fun.hype", count: 0 })).toEqual({
      message: "fun.hype is not present in installedFeatures.",
      next:
        "Import the feature in src/features/index.js and add it once to " +
        "installedFeatures."
    });
    expect(installedFeatureIssue({ featureId: "fun.hype", count: 1 })).toBeNull();
    expect(installedFeatureIssue({ featureId: "fun.hype", count: 2 })).toEqual({
      message: "fun.hype appears 2 times in installedFeatures.",
      next: "Keep exactly one installedFeatures entry for this feature."
    });
  });
});
