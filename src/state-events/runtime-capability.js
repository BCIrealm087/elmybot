// Private framework provenance: an injected service/flag cannot bypass the
// action boundary. Production and the opt-in contributor simulator register here.
const implementations = new WeakSet();
export function registerStateEventRuntime(service) { implementations.add(service); return Object.freeze(service); }
export function isStateEventRuntime(service) { return Boolean(service && implementations.has(service)); }
