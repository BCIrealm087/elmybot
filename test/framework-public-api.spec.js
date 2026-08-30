import { describe, expect, it } from "vitest";
import * as framework from "../src/framework/index.js";
import {
  defineFeature,
  FEATURE_FRAMEWORK_API_VERSION,
  FeatureDefinitionError,
  frameworkApiVersion,
  supportedFrameworkApiVersions
} from "../src/framework/index.js";

const PUBLIC_EXPORTS_V1 = Object.freeze([
  "FEATURE_FRAMEWORK_API_VERSION",
  "FRAMEWORK_CAPABILITIES",
  "FeatureDefinitionError",
  "SchemaValidationError",
  "access",
  "defineAction",
  "defineEventAction",
  "defineFeature",
  "defineRoute",
  "defineScheduledAction",
  "discordActionCommand",
  "discordNativeCommand",
  "discordOption",
  "discordScheduledActionCommand",
  "discordTextResult",
  "frameworkApiVersion",
  "isFeatureDefinition",
  "schema",
  "supportedFrameworkApiVersions",
  "twitchActionCommand",
  "twitchNativeCommand",
  "twitchNoArgs",
  "twitchRestText",
  "twitchTextResult",
  "twitchTokens"
]);

describe("Framework public API v1", () => {
  it("publishes a deliberate, versioned contributor surface", () => {
    expect(frameworkApiVersion).toBe(1);
    expect(FEATURE_FRAMEWORK_API_VERSION).toBe(frameworkApiVersion);
    expect(supportedFrameworkApiVersions).toEqual([frameworkApiVersion]);
    expect(Object.isFrozen(supportedFrameworkApiVersions)).toBe(true);
    expect(Object.keys(framework).sort()).toEqual([...PUBLIC_EXPORTS_V1].sort());
  });

  it("does not leak registry, adapter, or storage composition helpers", () => {
    expect(framework).not.toHaveProperty("createFeatureRegistry");
    expect(framework).not.toHaveProperty("mergeCommandDefinitions");
    expect(framework).not.toHaveProperty("discordOptionDescriptor");
    expect(framework).not.toHaveProperty("createFeatureServiceRuntime");
  });

  it("rejects incompatible feature manifests with machine-readable details", () => {
    let failure;
    try {
      defineFeature({
        apiVersion: 2,
        id: "test.incompatible",
        description: "An incompatible test feature."
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(FeatureDefinitionError);
    expect(failure).toMatchObject({
      code: "unsupported_framework_api_version",
      path: "Feature definition.apiVersion",
      details: {
        received: 2,
        supported: [1]
      }
    });
  });
});
