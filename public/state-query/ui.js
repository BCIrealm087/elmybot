// Query setup and widget behavior, shared by the two same-origin pages.
export function mountStateQueryApp(window, document, createStateQueryClient, createStateQueryTools) {
  const client = createStateQueryClient();
  const tools = createStateQueryTools();
  const widget = document.body.dataset.page === "widget";
  const $ = (id) => document.getElementById(id);
  let catalog;
  let subscription;
  let fields = [];
  let query;
  let requestVersion = 0;
  let presentation = {};
  let parameterReaders = [];
  let authenticating = false;
  const report = (message) => { $("message").textContent = message; };
  const option = (select, label, value) => {
    const node = document.createElement("option");
    node.textContent = label; node.value = value; select.append(node);
  };
  function halt() { subscription?.unsubscribe(); subscription = null; }
  function render(result) {
    const envelope = result.result ?? result;
    if (envelope.status !== "ready") {
      $("values").textContent = "State is temporarily unavailable.";
      return;
    }
    const nodes = [];
    for (const [name, cell] of Object.entries(envelope.data ?? {})) {
      const row = document.createElement("div");
      row.className = "value-row";
      const label = document.createElement("span");
      const value = document.createElement("strong");
      label.textContent = name;
      if (cell.state === "unselected" || cell.state === "blocked" && cell.reason === "unselected") value.textContent = "Choose a game with the deaths command";
      else if (cell.state !== "present") value.textContent = `No value (${cell.state})`;
      else if (cell.value && typeof cell.value === "object" && "count" in cell.value && "game" in cell.value) {
        label.textContent = String(cell.value.game); value.textContent = String(cell.value.count);
      } else value.textContent = typeof cell.value === "object" ? JSON.stringify(cell.value) : String(cell.value);
      row.append(label, value); nodes.push(row);
    }
    $("values").replaceChildren(...nodes);
  }
  function watch() {
    halt();
    subscription = client.watch(query, {
      onResult: render,
      onStatus(status) {
        $("connection").textContent = ({ live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting — values may be stale",
          ended: "Access ended — enter a valid read grant", closed: "Stopped" })[status.state] ?? status.state;
        $("values").classList.toggle("stale", status.stale);
        if (status.state === "ended") {
          $("values").replaceChildren();
          $("access").hidden = false; report(status.message ?? "Subscription ended.");
        }
      }
    });
  }
  function setPresentation() {
    if (!widget) presentation = { title: $("title").value, color: $("color").value, size: Number($("size").value) };
    $("widget-title").textContent = String(presentation.title ?? "Deaths").slice(0, 100);
    const color = /^#[a-f0-9]{6}$/i.test(presentation.color) ? presentation.color : "#ffffff";
    $("values").style.color = color;
    $("values").style.fontSize = `${Math.min(120, Math.max(16, Number(presentation.size) || 48))}px`;
  }
  function invalidate() {
    requestVersion += 1; halt(); query = null;
    $("connection").textContent = "Preview to connect";
    $("values").replaceChildren();
    $("outputs").hidden = true;
    $("field-list").replaceChildren();
    fields.forEach((field, index) => {
      const row = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = `${field.name} · ${field.read.label ?? field.read.export}`;
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "Remove";
      remove.addEventListener("click", () => { fields.splice(index, 1); invalidate(); });
      row.append(text, remove); $("field-list").append(row);
    });
  }
  function projections(schema, prefix = [], depth = 0) {
    const result = [{ path: prefix, schema }];
    if (schema?.type === "object" && depth < 10) {
      for (const [key, value] of Object.entries(schema.properties ?? {})) result.push(...projections(value, [...prefix, key], depth + 1));
    }
    return result;
  }
  function selectExport() {
    const entry = catalog.exports[Number($("export").value)];
    $("parameters").replaceChildren(); $("projection").replaceChildren(); parameterReaders = [];
    if (!entry) return;
    $("description").textContent = entry.description;
    projections(entry.resultSchema).forEach(({ path }) => option($("projection"), path.join(" → ") || "Whole value", JSON.stringify(path)));
    for (const [name, parameter] of Object.entries(entry.parameters)) {
      const fieldset = document.createElement("fieldset");
      const legend = document.createElement("legend"); legend.textContent = parameter.label;
      const mode = document.createElement("select"); mode.setAttribute("aria-label", `${parameter.label} source`);
      option(mode, "Enter a literal value", "literal");
      const sources = [];
      const permission = entry.grantScope.arguments[name];
      for (const candidate of catalog.exports) {
        if (Object.keys(candidate.parameters).length || !permission?.dynamicFrom?.some((read) => tools.identity(read) === tools.identity(candidate))) continue;
        for (const projection of projections(candidate.resultSchema)) {
          if (projection.schema.type !== parameter.schema.type) continue;
          sources.push({ source: candidate, path: projection.path });
          option(mode, `${candidate.label}${projection.path.length ? ` · ${projection.path.join(" → ")}` : ""}`, String(sources.length - 1));
        }
      }
      const input = document.createElement("input"); input.setAttribute("aria-label", parameter.label);
      input.type = "text"; input.maxLength = parameter.schema.maxLength ?? 2048;
      input.placeholder = parameter.schema.type === "string" ? "e.g. Hades" : `JSON ${parameter.schema.type}`;
      const hint = document.createElement("small");
      hint.textContent = permission?.values?.kind === "any" ? "Allowed subjects are checked when you preview."
        : permission?.values?.kind === "exact" ? `Allowed values: ${permission.values.values.join(", ")}`
          : "Literal subjects are not allowed by this grant.";
      mode.addEventListener("change", () => { input.hidden = mode.value !== "literal"; });
      parameterReaders.push(() => [name, mode.value === "literal"
        ? { literal: parameter.schema.type === "string" ? input.value : JSON.parse(input.value) }
        : sources[Number(mode.value)]]);
      fieldset.append(legend, mode, input, hint); $("parameters").append(fieldset);
    }
  }
  async function load() {
    const version = ++requestVersion;
    halt(); $("values").replaceChildren();
    const nextCatalog = await client.catalog();
    if (version !== requestVersion) return;
    catalog = nextCatalog;
    $("access").hidden = true;
    report("");
    if (widget) {
      if (!query || query.target.platform !== catalog.target.platform || query.target.groupId !== catalog.target.groupId) {
        throw new Error("This widget needs a grant for its selected platform group.");
      }
      setPresentation(); watch(); return;
    }
    $("builder").hidden = false;
    fields = []; invalidate();
    $("target").replaceChildren();
    option($("target"), `${catalog.target.platform === "discord" ? "Discord server" : "Twitch channel"} · ${catalog.target.groupId}`, catalog.target.groupId);
    $("grant-info").textContent = `Access expires ${new Date(catalog.grant.expiresAt).toLocaleString()}. To choose another group, use its read grant.`;
    $("export").replaceChildren();
    catalog.exports.forEach((entry, index) => option($("export"), `${entry.label} · ${entry.feature}`, String(index)));
    selectExport();
  }
  $("grant-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authenticating) return;
    authenticating = true;
    $("change-access").disabled = true;
    const credential = $("credential").value.trim(); $("credential").value = "";
    try { halt(); await client.session(credential); await load(); } catch (error) { report(error.message); $("access").hidden = false; }
    finally { authenticating = false; $("change-access").disabled = false; }
  });
  $("change-access").addEventListener("click", async () => {
    requestVersion += 1; halt(); $("values").replaceChildren();
    if (!widget) { $("builder").hidden = true; $("outputs").hidden = true; }
    $("access").hidden = false;
    $("connection").textContent = "Disconnected";
    try { await client.logout(); } catch (error) { report(error.message); }
  });
  if (widget) {
    try {
      if (window.location.hash.length > 100_000) throw new Error("Widget configuration is too large.");
      const configuration = JSON.parse(decodeURIComponent(window.location.hash.slice(1)));
      query = configuration.query; presentation = configuration.presentation ?? {};
      if (new TextEncoder().encode(JSON.stringify(query)).byteLength > 16 * 1024) throw new Error("Query is too large.");
      setPresentation();
    } catch (error) { report(`Open a widget URL copied from setup. ${error.message}`); return; }
  } else {
    $("export").addEventListener("change", selectExport);
    $("add-field").addEventListener("click", () => {
      try {
        if (fields.length >= 20) throw new Error("At most 20 fields can be selected.");
        const entry = catalog.exports[Number($("export").value)];
        if (!entry) throw new Error("No exports are allowed by this grant.");
        const field = { name: $("field-name").value, read: entry,
          arguments: Object.fromEntries(parameterReaders.map((read) => read())), path: JSON.parse($("projection").value) };
        tools.compose(catalog.target, [...fields, field]);
        fields.push(field); invalidate(); report("");
        $("field-name").value = `value_${fields.length + 1}`;
      } catch (error) { report(error.message); }
    });
    $("preset").addEventListener("click", () => {
      const count = catalog.exports.find((entry) => tools.identity(entry) === "fun.deaths:count:v1");
      const remembered = catalog.exports.find((entry) => tools.identity(entry) === "fun.deaths:remembered_game:v1");
      const current = $("preset-kind").value === "current";
      if (!count || (current && (!remembered || !count.grantScope.arguments.game.dynamicFrom.some((entry) => tools.identity(entry) === tools.identity(remembered))))) {
        report("This grant does not allow the selected deaths preset."); return;
      }
      fields = [{ name: "deaths", read: count, arguments: { game: current ? { source: remembered } : { literal: $("game").value } } }];
      invalidate(); report("");
    });
    $("preview").addEventListener("click", async () => {
      const version = ++requestVersion;
      try {
        halt(); query = tools.compose(catalog.target, fields);
        const result = await client.read(query);
        if (version !== requestVersion) return;
        render(result); setPresentation(); watch();
        $("outputs").hidden = false;
        $("widget-url").value = tools.widgetUrl(window.location.origin, query, presentation);
        $("snippet").value = `import { createStateQueryClient } from ${JSON.stringify(window.location.origin + "/state-query/client.js")};\nconst client = createStateQueryClient({ baseUrl: ${JSON.stringify(window.location.origin)} });\nconst subscription = client.watch(${JSON.stringify(query, null, 2)}, {\n  onResult: ({ result }) => console.log(result.data),\n  onStatus: (status) => console.log(status.state)\n});\n// On teardown:\n// subscription.unsubscribe();\n// client.close();`;
        report("");
      } catch (error) { if (version === requestVersion) report(error.message); }
    });
    for (const id of ["title", "color", "size"]) $(id).addEventListener("input", () => {
      setPresentation(); if (query) $("widget-url").value = tools.widgetUrl(window.location.origin, query, presentation);
    });
    for (const id of ["widget-url", "snippet"]) $(`copy-${id}`).addEventListener("click", async () => {
      try { await window.navigator.clipboard.writeText($(id).value); report("Copied."); }
      catch { $(id).focus(); $(id).select(); report("Select and copy the text above."); }
    });
    $("stop").addEventListener("click", () => { halt(); $("connection").textContent = "Stopped"; $("values").classList.add("stale"); });
  }
  window.addEventListener("pagehide", () => client.close(), { once: true });
  window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
  void load().catch((error) => { report(error.message); $("access").hidden = false; });
}
