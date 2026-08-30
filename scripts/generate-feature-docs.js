import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { featureRegistry } from "../src/features/index.js";
import { generateFeatureCatalogMarkdown } from "../src/framework/catalog-documentation.js";

export const FEATURE_CATALOG_PATH = "docs/feature-catalog.md";

export async function generateFeatureDocs({
  root = process.cwd(),
  check = false
} = {}) {
  const output = generateFeatureCatalogMarkdown(featureRegistry);
  const destination = path.resolve(root, FEATURE_CATALOG_PATH);
  if (check) {
    let existing = null;
    try {
      existing = await readFile(destination, "utf8");
    } catch {
      // The shared mismatch error below also covers a missing generated file.
    }
    if (existing !== output) {
      throw new Error(
        `${FEATURE_CATALOG_PATH} is stale. Run \`npm run feature:docs\`.`
      );
    }
  } else {
    await writeFile(destination, output, "utf8");
  }
  return destination;
}

async function main() {
  const check = process.argv.slice(2).includes("--check");
  try {
    const destination = await generateFeatureDocs({ check });
    if (!check) console.log(`Updated ${path.relative(process.cwd(), destination)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Feature docs generation failed.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
