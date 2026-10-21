// Opaque owner-partition markers. Event transport sequences/cursors are separate.
export function validStateEvent(value, { event = false } = {}) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    value.version === 1 && /^ses1\.[A-Za-z0-9_-]{22}$/.test(value.scopeToken ?? "") &&
    Number.isSafeInteger(value.operationSequence) && value.operationSequence >= (event ? 1 : 0) &&
    Number.isSafeInteger(value.stateRevision) && value.stateRevision >= 0 &&
    (!event || /^seo1\.[A-Za-z0-9_-]{43}$/.test(value.operationId ?? ""));
}
