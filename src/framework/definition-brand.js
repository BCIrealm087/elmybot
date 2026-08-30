const definitionTypes = new WeakMap();

export function markFrameworkDefinition(value, type) {
  definitionTypes.set(value, type);
  return Object.freeze(value);
}

export function frameworkDefinitionType(value) {
  return definitionTypes.get(value) ?? null;
}

export function isFrameworkDefinition(value, type) {
  return definitionTypes.get(value) === type;
}
