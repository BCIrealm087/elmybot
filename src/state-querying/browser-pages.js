function page(widget) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Elmybot · ${widget ? "Live widget" : "State query setup"}</title><link rel="stylesheet" href="/state-query/browser.css"><script type="module" src="/state-query/app.js"></script></head>
<body data-page="${widget ? "widget" : "setup"}"><main><header>${widget ? "" : "<div><h1>Your bot state, live</h1><p>Choose values, preview changes, and create a browser source.</p></div>"}<button id="change-access" type="button">Change access / sign out</button></header>
<p id="message" role="alert"></p>
<section id="access"><h2>Connect a read grant</h2><p>Use a grant issued by a Discord server manager or <a href="/state-query/operator/twitch">sign in as a Twitch broadcaster</a>. Each grant selects one platform group.</p>
<form id="grant-form"><label for="credential">Read grant</label><input id="credential" type="password" autocomplete="off" spellcheck="false" required maxlength="4096"><button type="submit">Connect securely</button></form>
<p>Your session stays in this browser. In OBS, use “Interact” to enter a grant once. Never add a credential to a URL.</p></section>
${widget ? "" : `<section id="builder" hidden><h2>1. Choose your state</h2><label for="target">Authorized platform group</label><select id="target"></select><p id="grant-info"></p>
<div class="grid"><div><h3>Start with deaths</h3><label for="preset-kind">Deaths view</label><select id="preset-kind"><option value="current">Follow the remembered game</option><option value="fixed">Fixed game</option></select><label for="game">Fixed game name</label><input id="game" value="Hades" maxlength="80"><button id="preset" type="button">Use this preset</button><p>You can add more fields after selecting a preset.</p></div>
<div><h3>Or compose your own</h3><label for="export">Readable state</label><select id="export"></select><p id="description"></p><div id="parameters"></div><label for="projection">Result field</label><select id="projection"></select><label for="field-name">Name in your result</label><input id="field-name" value="value_1" maxlength="64"><button id="add-field" type="button">Add field</button></div></div>
<h3>Selected fields</h3><ol id="field-list"></ol><h2>2. Preview and present</h2><div class="grid"><label>Widget title<input id="title" value="Deaths" maxlength="100"></label><label>Text color<input id="color" type="color" value="#ffffff"></label></div><label>Text size<input id="size" type="number" min="16" max="120" value="48"></label><button id="preview" type="button">Preview live query</button><button id="stop" type="button">Stop preview</button></section>`}
<section id="display" aria-live="polite"><h2 id="widget-title">Deaths</h2><p id="connection">Disconnected</p><div id="values"></div></section>
${widget ? "" : `<section id="outputs" hidden><h2>3. Use your query</h2><label for="widget-url">Browser-source URL</label><textarea id="widget-url" readonly rows="3"></textarea><button id="copy-widget-url" type="button">Copy widget URL</button><p>Paste into an OBS browser source, then use Interact to connect its read grant. The URL contains the query and presentation only.</p><label for="snippet">JavaScript integration snippet</label><textarea id="snippet" readonly rows="12"></textarea><button id="copy-snippet" type="button">Copy snippet</button><p>Run this on the same origin after establishing a read-grant session. Reuse one client for all subscriptions on a page. Cross-origin browser access is not enabled.</p></section>`}
</main></body></html>`;
}

export function stateQueryBrowserResponse(request) {
  const path = new URL(request.url).pathname;
  const content = {
    "/state-query/setup": ["text/html", () => page(false)],
    "/state-query/widget": ["text/html", () => page(true)],
  }[path];
  if (!content) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  return new Response(request.method === "HEAD" ? null : content[1](), { headers: {
    "content-type": `${content[0]}; charset=utf-8`,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  } });
}
