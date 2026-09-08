import { frameworkApiVersion } from "./api-version.js";

const SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+$/;
const DEFAULT_RECIPE = "minimal";

export const featureScaffoldRecipes = Object.freeze([
  DEFAULT_RECIPE,
  "shared-command",
  "local-counter",
  "shareable-counter"
]);

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

function requireRecipe(template = DEFAULT_RECIPE) {
  if (!featureScaffoldRecipes.includes(template)) {
    throw new FeatureScaffoldError(
      `Feature template must be one of: ${featureScaffoldRecipes.join(", ")}.`,
      { code: "feature_scaffold_template_invalid" }
    );
  }
  return template;
}

function frameworkImport(names, source) {
  return `import {\n${names.map((name) => `  ${name}`).join(",\n")}\n} from "${source}";`;
}

function minimalFeatureTemplate(identity, frameworkSource) {
  return `${frameworkImport([
    "defineAction",
    "defineFeature",
    "discordActionCommand",
    "discordTextResult",
    "frameworkApiVersion",
    "schema"
  ], frameworkSource)}

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

function sharedFeatureTemplate(identity, frameworkSource) {
  return `${frameworkImport([
    "defineAction",
    "defineFeature",
    "discordActionCommand",
    "discordTextResult",
    "frameworkApiVersion",
    "schema",
    "twitchActionCommand",
    "twitchNoArgs",
    "twitchTextResult"
  ], frameworkSource)}

export const ${identity.constantName} = "${identity.actionKind}";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "${identity.featureId}",
  description: "TODO: describe ${identity.featureId}.",
  actions: [
    defineAction({
      kind: ${identity.constantName},
      capability: null,
      supportedOrigins: ["discord", "twitch"],
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
    ],
    twitch: [
      twitchActionCommand({
        name: "${identity.commandName}",
        description: "TODO: describe this command.",
        actionKind: ${identity.constantName},
        parse: twitchNoArgs(),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;
`;
}

function counterFeatureTemplate(identity, frameworkSource, { shareable }) {
  const service = shareable ? "shareableState" : "state";
  const counterLabel = identity.commandName.charAt(0).toUpperCase() +
    identity.commandName.slice(1);
  const stateResolution = shareable
    ? `const otherPlatform = ctx.origin.group.platform === "discord"\n          ? "twitch"\n          : "discord";\n        const state = await ctx.shareableState.current(otherPlatform, "score");\n        const score = state.boundedCounter("score", "shared");`
    : `const score = ctx.state.boundedCounter("score", "shared");`;
  const shareableDeclaration = shareable
    ? `\n  shareableState: [{\n    id: "score",\n    label: "${counterLabel} score",\n    schemaVersion: 1,\n    collisionSummary: { kind: "presence" }\n  }],`
    : "";
  return `${frameworkImport([
    "access",
    "defineAction",
    "defineFeature",
    "discordActionCommand",
    "discordOption",
    "discordTextResult",
    "frameworkApiVersion",
    "schema",
    "twitchActionCommand",
    "twitchTextResult",
    "twitchTokens"
  ], frameworkSource)}

export const ${identity.constantName} = "${identity.actionKind}";

const OPERATIONS = Object.freeze(["show", "plus", "minus", "reset"]);
const UPDATE_DENIED = "Only moderators can change the score.";

export const feature = defineFeature({
  apiVersion: frameworkApiVersion,
  id: "${identity.featureId}",
  description: "Tracks a ${shareable ? "standalone or linked" : "group-local"} score.",${shareableDeclaration}
  actions: [
    defineAction({
      kind: ${identity.constantName},
      capability: null,
      conditionalAccess: [{
        capability: access.moderators,
        when: { argument: "operation", exceptValues: ["show"] }
      }],
      supportedOrigins: ["discord", "twitch"],
      input: schema.object({
        operation: schema.enum(OPERATIONS, { optional: true, default: "show" })
      }),
      uses: { services: ["authorization", "${service}"] },
      async execute(ctx, { operation }) {
        if (
          operation !== "show" &&
          !await ctx.authorization.allows(access.moderators)
        ) {
          return { output: { message: UPDATE_DENIED }, effects: [] };
        }

        ${stateResolution}
        let value;
        if (operation === "plus") value = await score.increment();
        else if (operation === "minus") value = await score.decrement();
        else if (operation === "reset") value = await score.reset();
        else value = await score.get();

        return { output: { message: \`Score: \${value}\` }, effects: [] };
      }
    })
  ],
  commands: {
    discord: [
      discordActionCommand({
        name: "${identity.commandName}",
        description: "Show or update the score.",
        availability: "guild",
        actionKind: ${identity.constantName},
        options: [
          discordOption({
            arg: "operation",
            name: "operation",
            description: "Show, increase, decrease, or reset the score.",
            type: "string",
            required: false
          })
        ],
        render: discordTextResult
      })
    ],
    twitch: [
      twitchActionCommand({
        name: "${identity.commandName}",
        description: "Show or update the score.",
        actionKind: ${identity.constantName},
        parse: twitchTokens([{
          arg: "operation",
          type: "string",
          optional: true,
          default: "show"
        }]),
        render: twitchTextResult
      })
    ]
  }
});

export default feature;
`;
}

function minimalTestTemplate(identity, testingSource, featureSource) {
  return `import { describe, it } from "vitest";
import feature from "${featureSource}";
${frameworkImport([
    "createFeatureTestRuntime",
    "discordTestGroup"
  ], testingSource)}

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

function sharedTestTemplate(identity, testingSource, featureSource) {
  return `import { describe, it } from "vitest";
import feature from "${featureSource}";
${frameworkImport(["createFeatureTestRuntime"], testingSource)}

describe("${identity.featureId}", () => {
  it("executes the same behavior on Discord and Twitch", async () => {
    const runtime = createFeatureTestRuntime(feature);

    (await runtime.discord.command("${identity.commandName}"))
      .toReply("TODO: ${identity.commandName}");
    (await runtime.twitch.commandText("!${identity.commandName}"))
      .toReply("TODO: ${identity.commandName}");
  });
});
`;
}

function localCounterTestTemplate(identity, testingSource, featureSource) {
  return `import { describe, it } from "vitest";
import feature from "${featureSource}";
${frameworkImport([
    "createFeatureTestRuntime",
    "discordTestActor",
    "discordTestGroup",
    "discordTestModerator",
    "twitchTestActor",
    "twitchTestGroup",
    "twitchTestModerator"
  ], testingSource)}

describe("${identity.featureId}", () => {
  it("keeps scores local while protecting updates", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();

    (await runtime.discord.command("${identity.commandName}", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus" }
    })).toReply("Score: 1");
    (await runtime.discord.command("${identity.commandName}", {
      group: discordGroup,
      actor: discordTestActor(),
      args: { operation: "plus" }
    })).toReply("Only moderators can change the score.");
    (await runtime.discord.command("${identity.commandName}", {
      group: discordGroup,
      actor: discordTestActor()
    })).toReply("Score: 1");
    (await runtime.twitch.commandText("!${identity.commandName}", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Score: 0");
    (await runtime.twitch.commandText("!${identity.commandName} minus", {
      group: twitchGroup,
      actor: twitchTestModerator()
    })).toReply("Score: 0");
  });
});
`;
}

function shareableCounterTestTemplate(identity, testingSource, featureSource) {
  return `import { describe, it } from "vitest";
import feature from "${featureSource}";
${frameworkImport([
    "createFeatureTestRuntime",
    "defaultTestLink",
    "discordTestActor",
    "discordTestGroup",
    "discordTestModerator",
    "twitchTestActor",
    "twitchTestGroup"
  ], testingSource)}

describe("${identity.featureId}", () => {
  it("isolates standalone groups and shares through selected links", async () => {
    const discordGroup = discordTestGroup();
    const twitchGroup = twitchTestGroup();
    const standalone = createFeatureTestRuntime(feature);

    (await standalone.discord.command("${identity.commandName}", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus" }
    })).toReply("Score: 1");
    (await standalone.twitch.commandText("!${identity.commandName}", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Score: 0");

    const linked = createFeatureTestRuntime(feature, {
      defaultLinks: [
        defaultTestLink({ sourceGroup: discordGroup, targetGroup: twitchGroup }),
        defaultTestLink({ sourceGroup: twitchGroup, targetGroup: discordGroup })
      ]
    });
    (await linked.discord.command("${identity.commandName}", {
      group: discordGroup,
      actor: discordTestModerator(),
      args: { operation: "plus" }
    })).toReply("Score: 1");
    (await linked.twitch.commandText("!${identity.commandName}", {
      group: twitchGroup,
      actor: twitchTestActor()
    })).toReply("Score: 1");
  });

  it("denies member updates without changing shared state", async () => {
    const runtime = createFeatureTestRuntime(feature);
    const group = discordTestGroup();

    (await runtime.discord.command("${identity.commandName}", {
      group,
      actor: discordTestActor(),
      args: { operation: "plus" }
    })).toReply("Only moderators can change the score.");
    (await runtime.discord.command("${identity.commandName}", {
      group,
      actor: discordTestActor()
    })).toReply("Score: 0");
  });
});
`;
}

function templateSources(identity, template, {
  frameworkSource,
  testingSource,
  featureSource
}) {
  if (template === "minimal") {
    return {
      featureSource: minimalFeatureTemplate(identity, frameworkSource),
      testSource: minimalTestTemplate(identity, testingSource, featureSource)
    };
  }
  if (template === "shared-command") {
    return {
      featureSource: sharedFeatureTemplate(identity, frameworkSource),
      testSource: sharedTestTemplate(identity, testingSource, featureSource)
    };
  }
  const shareable = template === "shareable-counter";
  return {
    featureSource: counterFeatureTemplate(identity, frameworkSource, { shareable }),
    testSource: shareable
      ? shareableCounterTestTemplate(identity, testingSource, featureSource)
      : localCounterTestTemplate(identity, testingSource, featureSource)
  };
}

export function featureScaffoldTemplates(slug, { template = DEFAULT_RECIPE } = {}) {
  const identity = scaffoldIdentity(slug);
  const recipe = requireRecipe(template);
  return Object.freeze({
    identity,
    template: recipe,
    ...templateSources(identity, recipe, {
      frameworkSource: "../../framework/index.js",
      testingSource: "../../src/framework/testing.js",
      featureSource: `../../src/features/${identity.slug}/feature.js`
    })
  });
}

export function workspaceFeatureScaffoldTemplates(
  slug,
  { template = DEFAULT_RECIPE } = {}
) {
  const identity = scaffoldIdentity(slug);
  const recipe = requireRecipe(template);
  const packageName = `@elmybot/feature-${identity.slug}`;
  const sources = templateSources(identity, recipe, {
    frameworkSource: "@elmybot/framework",
    testingSource: "@elmybot/framework/testing",
    featureSource: "../src/feature.js"
  });
  return Object.freeze({
    identity,
    template: recipe,
    packageName,
    ...sources,
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
      `Generated from the \`${recipe}\` recipe. The generated JavaScript and ` +
      "tests are ordinary contributor-owned files.\n\n" +
      "Follow the [first-feature quickstart]" +
      "(../../../docs/feature-quickstart.md) for installation and testing.\n"
  });
}
