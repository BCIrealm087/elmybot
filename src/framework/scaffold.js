import { frameworkApiVersion } from "./api-version.js";

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+$/;

export class FeatureScaffoldError extends Error {
  constructor(message, { code = "feature_scaffold_error" } = {}) {
    super(message);
    this.name = "FeatureScaffoldError";
    this.code = code;
  }
}

export function scaffoldIdentity(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new FeatureScaffoldError(
      "Feature name must contain at least two lowercase dash-separated words, " +
      "for example `fun-hype`.",
      { code: "feature_scaffold_name_invalid" }
    );
  }
  const words = slug.split("-");
  const featureId = words.join(".");
  const commandName = words.at(-1);
  if (commandName.length > 32) {
    throw new FeatureScaffoldError("The generated command name is too long.", {
      code: "feature_scaffold_name_invalid"
    });
  }
  return Object.freeze({
    slug,
    featureId,
    commandName,
    actionKind: `${featureId}.run.v1`,
    constantName: `${words.join("_").toUpperCase()}_ACTION_KIND`
  });
}

function featureTemplate(identity) {
  return `import {
  defineAction,
  defineFeature,
  discordActionCommand,
  discordTextResult,
  frameworkApiVersion,
  schema
} from "../../framework/index.js";

export const ${identity.constantName} = "${identity.actionKind}";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "${identity.featureId}",
  description: "TODO: describe ${identity.featureId}.",
  actions: [
    defineAction({
      kind: ${identity.constantName},
      capability: null,
      supportedOrigins: ["discord"],
      input: schema.object({}),
      execute: () => ({
        output: { message: "TODO: ${identity.commandName}" },
        effects: []
      })
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "${identity.commandName}",
        description: "TODO: describe this command.",
        availability: "guild",
        actionKind: ${identity.constantName},
        render: discordTextResult
      })
    ]
  }
});

export default feature;
`;
}

function testTemplate(identity) {
  return `import { describe, it } from "vitest";
import feature from "../../src/features/${identity.slug}/feature.js";
import {
  createFeatureTestRuntime,
  discordTestGroup
} from "../../src/framework/testing.js";

describe("${identity.featureId}", () => {
  it("executes its Discord command", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const result = await runtime.discord.command("${identity.commandName}", {
      group: discordTestGroup()
    });

    result.toReply("TODO: ${identity.commandName}");
  });
});
`;
}

export function featureScaffoldTemplates(slug) {
  const identity = scaffoldIdentity(slug);
  return Object.freeze({
    identity,
    featureSource: featureTemplate(identity),
    testSource: testTemplate(identity)
  });
}

function workspaceFeatureTemplate(identity) {
  return `import {
  defineAction,
  defineFeature,
  discordActionCommand,
  discordTextResult,
  frameworkApiVersion,
  schema
} from "@elmybot/framework";

export const ${identity.constantName} = "${identity.actionKind}";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "${identity.featureId}",
  description: "TODO: describe ${identity.featureId}.",
  actions: [
    defineAction({
      kind: ${identity.constantName},
      capability: null,
      supportedOrigins: ["discord"],
      input: schema.object({}),
      execute: () => ({
        output: { message: "TODO: ${identity.commandName}" },
        effects: []
      })
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "${identity.commandName}",
        description: "TODO: describe this command.",
        availability: "guild",
        actionKind: ${identity.constantName},
        render: discordTextResult
      })
    ]
  }
});

export default feature;
`;
}

function workspaceTestTemplate(identity) {
  return `import { describe, it } from "vitest";
import {
  createFeatureTestRuntime,
  discordTestGroup
} from "@elmybot/framework/testing";
import feature from "../src/feature.js";

describe("${identity.featureId}", () => {
  it("executes its Discord command", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const result = await runtime.discord.command("${identity.commandName}", {
      group: discordTestGroup()
    });

    result.toReply("TODO: ${identity.commandName}");
  });
});
`;
}

export function workspaceFeatureScaffoldTemplates(slug) {
  const identity = scaffoldIdentity(slug);
  const packageName = `@elmybot/feature-${identity.slug}`;
  return Object.freeze({
    identity,
    packageName,
    featureSource: workspaceFeatureTemplate(identity),
    testSource: workspaceTestTemplate(identity),
    packageSource: `${JSON.stringify({
      name: packageName,
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./src/feature.js" },
      peerDependencies: {
        "@elmybot/framework": `^${frameworkApiVersion}.0.0`
      },
      elmybot: {
        kind: "feature",
        frameworkApiVersion,
        featureId: identity.featureId
      }
    }, null, 2)}\n`,
    readmeSource:
      `# \`${packageName}\`\n\n` +
      `TODO: describe the \`${identity.featureId}\` Elmybot feature.\n\n` +
      "Follow the [first-feature quickstart]" +
      "(../../../docs/feature-quickstart.md) for installation and testing.\n"
  });
}
