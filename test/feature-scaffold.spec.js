import { describe, expect, it } from "vitest";
import {
  FeatureScaffoldError,
  featureScaffoldRecipes,
  featureScaffoldTemplates,
  scaffoldIdentity,
  workspaceFeatureScaffoldTemplates
} from "../src/framework/scaffold.js";
import localCounterFeatureSource from
  "./fixtures/feature-scaffold/local-counter/src/feature.js?raw";
import localCounterTestSource from
  "./fixtures/feature-scaffold/local-counter/test/feature.spec.js?raw";
import minimalFeatureSource from
  "./fixtures/feature-scaffold/minimal/src/feature.js?raw";
import minimalTestSource from
  "./fixtures/feature-scaffold/minimal/test/feature.spec.js?raw";
import shareableCounterFeatureSource from
  "./fixtures/feature-scaffold/shareable-counter/src/feature.js?raw";
import shareableCounterTestSource from
  "./fixtures/feature-scaffold/shareable-counter/test/feature.spec.js?raw";
import sharedCommandFeatureSource from
  "./fixtures/feature-scaffold/shared-command/src/feature.js?raw";
import sharedCommandTestSource from
  "./fixtures/feature-scaffold/shared-command/test/feature.spec.js?raw";

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
    expect(templates.featureSource).toContain("apiVersion: frameworkApiVersion");
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

  it("generates a private workspace feature package", () => {
    const templates = workspaceFeatureScaffoldTemplates("fun-hype");

    expect(templates.packageName).toBe("@elmybot/feature-fun-hype");
    expect(JSON.parse(templates.packageSource)).toMatchObject({
      private: true,
      peerDependencies: { "@elmybot/framework": "^1.0.0" },
      elmybot: { frameworkApiVersion: 1, featureId: "fun.hype" }
    });
    expect(templates.featureSource).toContain('from "@elmybot/framework"');
    expect(templates.testSource).toContain('from "@elmybot/framework/testing"');
    expect(templates.readmeSource).toContain("docs/feature-quickstart.md");
  });

  it("offers explicit recipes without changing the minimal default", () => {
    expect(featureScaffoldRecipes).toEqual([
      "minimal",
      "shared-command",
      "local-counter",
      "shareable-counter"
    ]);
    expect(featureScaffoldTemplates("fun-hype").template).toBe("minimal");
    expect(() => featureScaffoldTemplates("fun-hype", {
      template: "everything-wizard"
    })).toThrow(expect.objectContaining({
      code: "feature_scaffold_template_invalid"
    }));
  });

  it("generates shared and counter recipes with meaningful tests", () => {
    const shared = workspaceFeatureScaffoldTemplates("fun-hype", {
      template: "shared-command"
    });
    const local = workspaceFeatureScaffoldTemplates("fun-score", {
      template: "local-counter"
    });
    const shareable = workspaceFeatureScaffoldTemplates("fun-score", {
      template: "shareable-counter"
    });

    expect(shared.featureSource).toContain('supportedOrigins: ["discord", "twitch"]');
    expect(shared.testSource).toContain('twitch.commandText("!hype")');
    expect(local.featureSource).toContain('services: ["authorization", "state"]');
    expect(local.testSource).toContain("keeps scores local while protecting updates");
    expect(shareable.featureSource).toContain('id: "score"');
    expect(shareable.featureSource).toContain(
      'services: ["authorization", "shareableState"]'
    );
    expect(shareable.featureSource).not.toContain("adoptLegacyIntegrationState");
    expect(shareable.testSource).toContain("defaultTestLink");
    expect(shareable.testSource).toContain(
      "denies member updates without changing shared state"
    );
  });

  it("keeps executable recipe fixtures identical to generated output", () => {
    const minimal = workspaceFeatureScaffoldTemplates(
      "recipe-minimal",
      { template: "minimal" }
    );
    const shared = workspaceFeatureScaffoldTemplates(
      "recipe-shared",
      { template: "shared-command" }
    );
    const local = workspaceFeatureScaffoldTemplates(
      "recipe-local",
      { template: "local-counter" }
    );
    const shareable = workspaceFeatureScaffoldTemplates(
      "recipe-shareable",
      { template: "shareable-counter" }
    );

    expect(minimalFeatureSource.trimEnd()).toBe(minimal.featureSource.trimEnd());
    expect(minimalTestSource.trimEnd()).toBe(minimal.testSource.trimEnd());
    expect(sharedCommandFeatureSource.trimEnd()).toBe(shared.featureSource.trimEnd());
    expect(sharedCommandTestSource.trimEnd()).toBe(shared.testSource.trimEnd());
    expect(localCounterFeatureSource.trimEnd()).toBe(local.featureSource.trimEnd());
    expect(localCounterTestSource.trimEnd()).toBe(local.testSource.trimEnd());
    expect(shareableCounterFeatureSource.trimEnd())
      .toBe(shareable.featureSource.trimEnd());
    expect(shareableCounterTestSource.trimEnd())
      .toBe(shareable.testSource.trimEnd());
  });
});
