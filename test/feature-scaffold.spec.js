import { describe, expect, it } from "vitest";
import {
  FeatureScaffoldError,
  featureScaffoldTemplates,
  scaffoldIdentity
} from "../src/framework/scaffold.js";

describe("Feature scaffold templates", () => {
  it("derives stable framework identities from a contributor-friendly slug", () => {
    expect(scaffoldIdentity("fun-hype")).toEqual({
      slug: "fun-hype",
      featureId: "fun.hype",
      commandName: "hype",
      actionKind: "fun.hype.run.v1",
      constantName: "FUN_HYPE_ACTION_KIND"
    });
  });

  it("generates one feature module and one deployment-free test skeleton", () => {
    const templates = featureScaffoldTemplates("fun-hype");

    expect(templates.featureSource).toContain('id: "fun.hype"');
    expect(templates.featureSource).toContain('name: "hype"');
    expect(templates.featureSource).toContain('"fun.hype.run.v1"');
    expect(templates.testSource).toContain("createFeatureTestRuntime(feature)");
    expect(templates.testSource).toContain('runtime.discord.command("hype"');
  });

  it("rejects unsafe or ambiguous names", () => {
    for (const name of ["unqualified", "Fun-Hype", "fun_hype", "../fun-hype"]) {
      expect(() => scaffoldIdentity(name)).toThrow(FeatureScaffoldError);
    }
  });
});
