import path from "node:path";

const sourceRoot = path.resolve("src");
const featuresRoot = path.join(sourceRoot, "features");
const publicFrameworkEntry = path.join(sourceRoot, "framework", "index.js");

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sourceValue(node) {
  return typeof node?.source?.value === "string" ? node.source.value : null;
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
        "from `src/framework/index.js`, or import another feature module.",
      dynamicImport:
        "Feature modules must use literal dynamic imports so the API boundary can be checked."
    }
  },
  create(context) {
    const filename = path.resolve(context.filename ?? context.getFilename());
    if (!isWithin(featuresRoot, filename) || filename === path.join(featuresRoot, "index.js")) {
      return {};
    }

    function check(node, specifier) {
      if (typeof specifier !== "string" || !specifier.startsWith(".")) return;
      const target = path.resolve(path.dirname(filename), specifier);
      if (target === publicFrameworkEntry || isWithin(featuresRoot, target)) return;
      if (isWithin(sourceRoot, target)) {
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
