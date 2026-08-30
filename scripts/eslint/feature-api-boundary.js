import path from "node:path";

const projectRoot = path.resolve(".");
const sourceRoot = path.resolve("src");
const featuresRoot = path.join(sourceRoot, "features");
const workspaceFeaturesRoot = path.resolve("packages", "features");
const publicFrameworkEntry = path.join(sourceRoot, "framework", "index.js");
const publicFrameworkPackage = "@elmybot/framework";

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sourceValue(node) {
  return typeof node?.source?.value === "string" ? node.source.value : null;
}

function featureBoundary(filename) {
  if (isWithin(featuresRoot, filename) && filename !== path.join(featuresRoot, "index.js")) {
    return Object.freeze({
      relativeRoot: featuresRoot,
      allowSourceFrameworkEntry: true
    });
  }
  if (!isWithin(workspaceFeaturesRoot, filename)) return null;
  const relative = path.relative(workspaceFeaturesRoot, filename);
  const [workspaceName, sourceDirectory] = relative.split(path.sep);
  if (!workspaceName || sourceDirectory !== "src") return null;
  return Object.freeze({
    relativeRoot: path.join(workspaceFeaturesRoot, workspaceName),
    allowSourceFrameworkEntry: false
  });
}

export const featureApiBoundaryRule = Object.freeze({
  meta: {
    type: "problem",
    docs: {
      description: "Keep contributor features behind the stable framework API."
    },
    schema: [],
    messages: {
      internalImport:
        "Feature modules must not import project internals. Import contributor APIs " +
        "from the stable framework entry, or import feature-owned code.",
      dynamicImport:
        "Feature modules must use literal dynamic imports so the API boundary can be checked."
    }
  },
  create(context) {
    const filename = path.resolve(context.filename ?? context.getFilename());
    const boundary = featureBoundary(filename);
    if (boundary === null) return {};

    function check(node, specifier) {
      if (typeof specifier !== "string") return;
      if (specifier === publicFrameworkPackage) return;
      if (specifier.startsWith(`${publicFrameworkPackage}/`)) {
        context.report({ node, messageId: "internalImport" });
        return;
      }
      if (!specifier.startsWith(".")) return;
      const target = path.resolve(path.dirname(filename), specifier);
      if (
        (boundary.allowSourceFrameworkEntry && target === publicFrameworkEntry) ||
        isWithin(boundary.relativeRoot, target)
      ) return;
      if (isWithin(projectRoot, target)) {
        context.report({ node, messageId: "internalImport" });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node.source, sourceValue(node));
      },
      ExportNamedDeclaration(node) {
        check(node.source, sourceValue(node));
      },
      ExportAllDeclaration(node) {
        check(node.source, sourceValue(node));
      },
      ImportExpression(node) {
        const specifier = typeof node.source?.value === "string"
          ? node.source.value
          : null;
        if (specifier === null) {
          context.report({ node: node.source, messageId: "dynamicImport" });
          return;
        }
        check(node.source, specifier);
      }
    };
  }
});

export default Object.freeze({
  rules: Object.freeze({
    "public-api-only": featureApiBoundaryRule
  })
});
