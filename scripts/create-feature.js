import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  FeatureScaffoldError,
  featureScaffoldTemplates,
  workspaceFeatureScaffoldTemplates
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

async function writeExclusiveFiles(files) {
  const created = [];
  try {
    for (const file of files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, { encoding: "utf8", flag: "wx" });
      created.push(file.path);
    }
  } catch (cause) {
    await Promise.all(created.map((file) => unlink(file).catch(() => {})));
    if (cause?.code === "EEXIST") {
      throw new FeatureScaffoldError(
        "The feature scaffold would overwrite an existing file.",
        { code: "feature_scaffold_exists" }
      );
    }
    throw cause;
  }
}

export async function scaffoldFeature({
  slug,
  root = process.cwd(),
  workspace = false
}) {
  const projectRoot = path.resolve(root);
  await requireProjectRoot(projectRoot);
  if (workspace) {
    const templates = workspaceFeatureScaffoldTemplates(slug);
    const packageRoot = path.join(
      projectRoot,
      "packages",
      "features",
      templates.identity.slug
    );
    const files = [
      { path: path.join(packageRoot, "package.json"), content: templates.packageSource },
      { path: path.join(packageRoot, "README.md"), content: templates.readmeSource },
      { path: path.join(packageRoot, "src", "feature.js"), content: templates.featureSource },
      { path: path.join(packageRoot, "test", "feature.spec.js"), content: templates.testSource }
    ];
    await writeExclusiveFiles(files);
    return Object.freeze({
      identity: templates.identity,
      workspace: true,
      packageName: templates.packageName,
      featurePath: files[2].path,
      testPath: files[3].path,
      installImport: `import feature from "${templates.packageName}";`
    });
  }

  const { identity, featureSource, testSource } = featureScaffoldTemplates(slug);
  const featureDirectory = path.join(projectRoot, "src", "features", identity.slug);
  const testDirectory = path.join(projectRoot, "test", "features");
  const featurePath = path.join(featureDirectory, "feature.js");
  const testPath = path.join(testDirectory, `${identity.slug}.spec.js`);

  await writeExclusiveFiles([
    { path: featurePath, content: featureSource },
    { path: testPath, content: testSource }
  ]);

  return Object.freeze({
    identity,
    workspace: false,
    featurePath,
    testPath,
    installImport: `import feature from "./${identity.slug}/feature.js";`
  });
}

function parseArguments(argv) {
  let slug = null;
  let root = process.cwd();
  let workspace = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      root = argv[index + 1];
      index += 1;
    } else if (argument === "--workspace") {
      workspace = true;
    } else if (slug === null) {
      slug = argument;
    } else {
      throw new FeatureScaffoldError(`Unexpected argument: ${argument}`);
    }
  }
  return { slug, root, workspace };
}

async function main() {
  try {
    const result = await scaffoldFeature(parseArguments(process.argv.slice(2)));
    const relativeFeature = path.relative(process.cwd(), result.featurePath);
    const relativeTest = path.relative(process.cwd(), result.testPath);
    console.log(`Created ${relativeFeature}`);
    console.log(`Created ${relativeTest}`);
    if (result.workspace) {
      console.log(`Package: ${result.packageName}`);
      console.log("Next: run npm install, add the package to root dependencies, then import it in src/features/index.js.");
    } else {
      console.log("Next: import the feature in src/features/index.js and add it to installedFeatures.");
    }
    console.log("Guide: docs/feature-quickstart.md");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Feature scaffold failed.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
