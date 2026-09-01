function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function pageResponse({ title, body, status = 200, script = "" }) {
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #3b206f 0, #17131f 42%, #0d0b11 100%); color: #f7f4fb; }
    main { width: min(100%, 470px); padding: 38px; border: 1px solid #473b58; border-radius: 22px; background: rgba(27, 23, 34, .94); box-shadow: 0 24px 70px rgba(0, 0, 0, .45); }
    .eyebrow { margin: 0 0 12px; color: #bf94ff; font-size: .78rem; font-weight: 750; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(1.8rem, 7vw, 2.6rem); line-height: 1.08; letter-spacing: -.035em; }
    p { margin: 18px 0 0; color: #d6cfe0; line-height: 1.62; }
    ul { margin: 22px 0 0; padding-left: 1.25rem; color: #d6cfe0; line-height: 1.65; }
    li + li { margin-top: 5px; }
    form { margin-top: 30px; }
    button { width: 100%; min-height: 50px; border: 0; border-radius: 12px; background: #9147ff; color: white; font: inherit; font-weight: 750; cursor: pointer; transition: background .15s ease, transform .15s ease; }
    button:hover:not(:disabled) { background: #a970ff; transform: translateY(-1px); }
    button:focus-visible { outline: 3px solid #d8bdff; outline-offset: 3px; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    .notice { margin-top: 18px; min-height: 1.5em; color: #ffb8c1; font-size: .92rem; }
    .success { color: #78e6b0; }
    .fine-print { margin-top: 22px; color: #91899d; font-size: .8rem; }
    @media (max-width: 520px) { main { padding: 28px 24px; border-radius: 18px; } }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  </style>
</head>
<body>
  <main>${body}</main>
  ${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body>
</html>`;
	return new Response(html, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/html; charset=utf-8",
			// Chrome applies form-action to redirects after a form submission. The
			// connect form posts locally, then redirects to Twitch for OAuth.
			"content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self' https://id.twitch.tv; base-uri 'none'; frame-ancestors 'none'`,
			"cross-origin-opener-policy": "same-origin",
			"cross-origin-resource-policy": "same-origin",
			"permissions-policy": "camera=(), microphone=(), geolocation=()",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
			"x-frame-options": "DENY"
		}
	});
}

export function renderTwitchConnectPage() {
	return pageResponse({
		title: "Connect Elmybot to Twitch",
		body: `
    <p class="eyebrow">Elmybot for Twitch</p>
    <h1>Connect your channel</h1>
    <p>This invitation lets Elmybot listen and respond in your Twitch chat without making the bot a moderator.</p>
    <ul>
      <li>Twitch will request only the <strong>channel:bot</strong> permission.</li>
      <li>The connection can be revoked from Twitch at any time.</li>
      <li>This invitation can be used once.</li>
    </ul>
    <form method="post" action="/twitch/channels/connect">
      <input id="invite" name="invite" type="hidden">
      <button id="connect" type="submit" disabled>Continue with Twitch</button>
    </form>
    <p id="notice" class="notice" role="alert" aria-live="polite"></p>
    <noscript><p class="notice">JavaScript is required to open this invitation securely.</p></noscript>
    <p class="fine-print">The invitation code is removed from the address bar before continuing.</p>`,
		script: `
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("invite");
    const invite = document.getElementById("invite");
    const button = document.getElementById("connect");
    const notice = document.getElementById("notice");
    history.replaceState(null, "", window.location.pathname);
    if (/^[0-9a-f]{64}$/.test(token || "")) {
      invite.value = token;
      button.disabled = false;
    } else {
      notice.textContent = "This invitation link is incomplete or invalid.";
    }`
	});
}

export function renderTwitchIntegrationConnectPage() {
	return pageResponse({
		title: "Link Twitch to Discord",
		body: `
    <p class="eyebrow">Elmybot integration</p>
    <h1>Link Twitch to Discord</h1>
    <p>A Discord server manager invited your Twitch channel to join a cross-platform integration.</p>
    <ul>
      <li>Sign in as the Twitch broadcaster to prove control of the channel.</li>
      <li>Twitch will request only the <strong>channel:bot</strong> permission.</li>
      <li>The link can be revoked from Discord or by disconnecting Elmybot from Twitch.</li>
      <li>This invitation can be used once.</li>
    </ul>
    <form method="post" action="/twitch/integrations/connect">
      <input id="invite" name="invite" type="hidden">
      <button id="connect" type="submit" disabled>Continue with Twitch</button>
    </form>
    <p id="notice" class="notice" role="alert" aria-live="polite"></p>
    <noscript><p class="notice">JavaScript is required to open this invitation securely.</p></noscript>
    <p class="fine-print">The invitation code is removed from the address bar before continuing.</p>`,
		script: `
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("invite");
    const invite = document.getElementById("invite");
    const button = document.getElementById("connect");
    const notice = document.getElementById("notice");
    history.replaceState(null, "", window.location.pathname);
    if (/^[0-9a-f]{64}$/.test(token || "")) {
      invite.value = token;
      button.disabled = false;
    } else {
      notice.textContent = "This invitation link is incomplete or invalid.";
    }`
	});
}

export function renderTwitchOnboardingSuccess(channel) {
	return pageResponse({
		title: "Elmybot connected",
		body: `
    <p class="eyebrow success">Connection complete</p>
    <h1>Elmybot is ready</h1>
    <p>Twitch channel <strong>${escapeHtml(channel)}</strong> is authorized. The chat subscription will be checked automatically, so you can close this tab.</p>`
	});
}

export function renderTwitchIntegrationSuccess(channel, integration, pending = false) {
	return pageResponse({
		title: pending ? "Elmybot link pending" : "Elmybot integration linked",
		body: pending
			? `
    <p class="eyebrow success">Authorization complete</p>
    <h1>The link is being finalized</h1>
    <p>Twitch channel <strong>${escapeHtml(channel)}</strong> is authorized. Elmybot will retry the Discord link automatically, so you can close this tab.</p>`
			: `
    <p class="eyebrow success">Integration complete</p>
    <h1>Twitch and Discord are linked</h1>
    <p>Twitch channel <strong>${escapeHtml(channel)}</strong> joined integration <strong>${escapeHtml(integration?.id)}</strong>. You can close this tab.</p>`
	});
}

export function renderTwitchOnboardingError(message, status = 400) {
	return pageResponse({
		title: "Elmybot connection failed",
		status,
		body: `
    <p class="eyebrow">Connection unavailable</p>
    <h1>We couldn’t connect this channel</h1>
    <p>${escapeHtml(message)}</p>
    <p class="fine-print">Ask the person who invited you to create a new invitation if needed.</p>`
	});
}
