import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FeatureScaffoldError,
  featureScaffoldTemplates
} from "../src/framework/scaffold.js";

export { FeatureScaffoldError } from "../src/framework/scaffold.js";

async function requireProjectRoot(root) {
  try {
    await access(path.join(root, "package.json"));
    await access(path.join(root, "src", "features"));
  } catch (cause) {
    throw new FeatureScaffoldError(
      "Run the scaffold from the Elmybot repository root.",
      { code: "feature_scaffold_root_invalid", cause }
    );
  }
}

export async function scaffoldFeature({ slug, root = process.cwd() }) {
  const { identity, featureSource, testSource } = featureScaffoldTemplates(slug);
  const projectRoot = path.resolve(root);
  await requireProjectRoot(projectRoot);
  const featureDirectory = path.join(projectRoot, "src", "features", identity.slug);
  const testDirectory = path.join(projectRoot, "test", "features");
  const featurePath = path.join(featureDirectory, "feature.js");
  const testPath = path.join(testDirectory, `${identity.slug}.spec.js`);

  await mkdir(featureDirectory, { recursive: true });
  await mkdir(testDirectory, { recursive: true });
  try {
    await writeFile(featurePath, featureSource, {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      throw new FeatureScaffoldError(
        `Feature file already exists: ${path.relative(projectRoot, featurePath)}`,
        { code: "feature_scaffold_exists" }
      );
    }
    throw cause;
  }
  try {
    await writeFile(testPath, testSource, {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (cause) {
    await unlink(featurePath).catch(() => {});
    if (cause?.code === "EEXIST") {
      throw new FeatureScaffoldError(
        `Test file already exists: ${path.relative(projectRoot, testPath)}`,
        { code: "feature_scaffold_exists" }
      );
    }
    throw cause;
  }

  return Object.freeze({
    identity,
    featurePath,
    testPath,
    installImport: `import feature from "./${identity.slug}/feature.js";`
  });
}

function parseArguments(argv) {
  let slug = null;
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      root = argv[index + 1];
      index += 1;
    } else if (slug === null) {
      slug = argument;
    } else {
      throw new FeatureScaffoldError(`Unexpected argument: ${argument}`);
    }
  }
  return { slug, root };
}

async function main() {
  try {
    const result = await scaffoldFeature(parseArguments(process.argv.slice(2)));
    const relativeFeature = path.relative(process.cwd(), result.featurePath);
    const relativeTest = path.relative(process.cwd(), result.testPath);
    console.log(`Created ${relativeFeature}`);
    console.log(`Created ${relativeTest}`);
    console.log("Next: import the feature in src/features/index.js and add it to installedFeatures.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Feature scaffold failed.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
