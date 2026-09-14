// Public, browser-safe query builders. Authorization remains server-side.
export function createStateQueryTools() {
  const identity = (entry) => `${entry.feature}:${entry.export}:v${entry.version}`;
  function compose(target, fields) {
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > 20) {
      throw new Error("Choose between 1 and 20 fields.");
    }
    const bindings = Object.create(null);
    const select = Object.create(null);
    let serial = 0;
    const addRead = (read, args) => {
      const id = `b${++serial}`;
      if (serial > 20) throw new Error("This query needs more than 20 reads. Remove a field or parameter source.");
      bindings[id] = { read: { feature: read.feature, export: read.export, version: read.version },
        ...(Object.keys(args).length ? { arguments: args } : {}) };
      return id;
    };
    for (const field of fields) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(field.name) || Object.hasOwn(select, field.name)) {
        throw new Error("Field names must be unique, start with a lowercase letter, and contain letters, digits, _ or -.");
      }
      const args = Object.create(null);
      for (const [name, argument] of Object.entries(field.arguments ?? {})) {
        if (argument.source) {
          args[name] = { ref: addRead(argument.source, {}), ...(argument.path?.length ? { path: argument.path } : {}) };
        } else args[name] = { literal: argument.literal };
      }
      select[field.name] = { ref: addRead(field.read, args), ...(field.path?.length ? { path: field.path } : {}) };
    }
    const query = { version: 1, target: { platform: target.platform, groupId: target.groupId }, bindings, select };
    if (new TextEncoder().encode(JSON.stringify(query)).byteLength > 16 * 1024) throw new Error("Query is too large.");
    return query;
  }
  function deaths(target, game = null) {
    const read = { feature: "fun.deaths", export: "count", version: 1 };
    return compose(target, [{ name: "deaths", read, arguments: {
      game: game === null
        ? { source: { feature: "fun.deaths", export: "remembered_game", version: 1 } }
        : { literal: game }
    } }]);
  }
  function widgetUrl(origin, query, presentation = {}) {
    const url = new URL("/state-query/widget", origin);
    // Only these presentation fields are carried. Credentials are never accepted here.
    url.hash = encodeURIComponent(JSON.stringify({ query, presentation: {
      title: String(presentation.title ?? "Deaths").slice(0, 100),
      color: /^#[a-f0-9]{6}$/i.test(presentation.color) ? presentation.color : "#ffffff",
      size: Math.min(120, Math.max(16, Number(presentation.size) || 48))
    } }));
    return url.href;
  }
  return Object.freeze({ identity, compose, deaths, widgetUrl });
}
