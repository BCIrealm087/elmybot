function page(widget) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Elmybot · ${widget ? "Durable event widget" : "Durable event setup"}</title><link rel="stylesheet" href="/event-stream/browser.css"><script type="module" src="/event-stream/app.js"></script></head>
<body data-page="${widget ? "widget" : "setup"}"><main><header>${widget ? "" : "<div><h1>Every accepted event, in order</h1><p>Connect one granted stream, test its handler, and create an OBS browser source.</p></div>"}<button id="change-access" type="button">Change access / sign out</button></header>
<p id="message" role="alert"></p>
<section id="access"><h2>Connect an event grant</h2><p>Use a grant issued by a Discord server manager or <a href="/event-stream/operator/twitch">sign in as a Twitch broadcaster</a>. Each grant selects exactly one stream and platform group.</p>
<form id="grant-form"><label for="credential">Event grant</label><input id="credential" type="password" autocomplete="off" spellcheck="false" required maxlength="4096"><button type="submit">Connect securely</button></form>
<p>Your session stays in this browser. In OBS, use “Interact” to enter the grant once. Never add a credential to a URL, fragment, or snippet.</p></section>
<section id="details" hidden><h2>Authorized delivery</h2><div class="grid"><p class="fact">Target<strong id="target"></strong></p><p class="fact">Stream<strong id="stream"></strong></p></div><p id="grant-info"></p><p id="delivery">Connect the handler to read the delivery limits.</p></section>
${widget ? "" : `<section id="controls" hidden><h2>Test the live handler</h2><p>The client acknowledges only after its asynchronous handler fulfills. If it throws, rejects, or the page closes first, the same event remains pending for replay.</p><button id="start" type="button">Start live test</button><button id="stop" type="button">Stop test</button></section>`}
<section id="display" aria-live="polite"><h2 id="event-title">Durable events</h2><p id="connection">Disconnected</p><p id="event-count">0 events handled</p><pre id="payload">Waiting for an event.</pre><p id="event-meta"></p></section>
${widget ? "" : `<section id="outputs" hidden><h2>Use this stream</h2><label for="widget-url">Credential-free OBS browser-source URL</label><textarea id="widget-url" readonly rows="3"></textarea><button id="copy-widget-url" type="button">Copy widget URL</button><p>Paste this URL into an OBS browser source, then use Interact to enter its event grant once. The URL contains presentation data only.</p><label for="snippet">JavaScript integration snippet</label><textarea id="snippet" readonly rows="20"></textarea><button id="copy-snippet" type="button">Copy snippet</button><p>The recent-ID helper stores only a bounded list of opaque event IDs. It reduces duplicate effects but cannot close the crash window between an external side effect and recording its ID.</p></section>`}
</main></body></html>`;
}

export function durableEventBrowserResponse(request) {
  const content = {
    "/event-stream/setup": () => page(false),
    "/event-stream/widget": () => page(true)
  }[new URL(request.url).pathname];
  if (!content) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return new Response(request.method === "HEAD" ? null : content(), { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  } });
}
