function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function pageResponse({ title, body, status = 200, script = "", wide = false }) {
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
    main.wide { width: min(100%, 760px); }
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
    h2 { margin: 0; font-size: 1.2rem; }
    fieldset { margin: 18px 0 0; padding: 0; border: 0; }
    legend { padding: 0; font-weight: 700; }
    .feature-card { margin-top: 24px; padding: 22px; border: 1px solid #473b58; border-radius: 16px; background: #211b2a; }
    .choice { display: flex; gap: 12px; align-items: flex-start; margin-top: 12px; padding: 14px; border: 1px solid #574866; border-radius: 12px; cursor: pointer; }
    .choice:has(input:checked) { border-color: #ad7aff; background: #30213f; }
    .choice input { margin-top: 3px; accent-color: #9147ff; }
    .choice strong, .choice span { display: block; }
    .choice span { margin-top: 3px; color: #bdb4c9; font-size: .88rem; }
    .apply-all { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 18px; }
    .apply-all button { min-height: 42px; padding: 8px; background: #3a3047; font-size: .86rem; }
    .apply-all button:hover:not(:disabled) { background: #514061; }
    .secondary button { background: transparent; border: 1px solid #675879; }
    .secondary button:hover:not(:disabled) { background: #30283a; }
    .notice { margin-top: 18px; min-height: 1.5em; color: #ffb8c1; font-size: .92rem; }
    .success { color: #78e6b0; }
    .fine-print { margin-top: 22px; color: #91899d; font-size: .8rem; }
    @media (max-width: 520px) { main { padding: 28px 24px; border-radius: 18px; } .apply-all { grid-template-columns: 1fr; } }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  </style>
</head>
<body>
  <main${wide ? ' class="wide"' : ""}>${body}</main>
  ${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body>
</html>`;
	return new Response(html, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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

export function renderTwitchOAuthTransition(authorizationUrl) {
	let url;
	try {
		url = new URL(authorizationUrl);
	} catch {
		return renderTwitchOnboardingError("Twitch authorization is temporarily unavailable.", 503);
	}
	if (url.origin !== "https://id.twitch.tv" || url.pathname !== "/oauth2/authorize") {
		return renderTwitchOnboardingError("Twitch authorization is temporarily unavailable.", 503);
	}
	return pageResponse({
		title: "Continue to Twitch",
		body: `
    <p class="eyebrow">Elmybot for Twitch</p>
    <h1>Continue to Twitch</h1>
    <p>You are being redirected to Twitch to authorize your channel.</p>
    <p>If the redirect does not start, <a id="oauth-continue" href="${escapeHtml(url.href)}">continue with Twitch</a>.</p>`,
		script: `
    window.location.replace(document.getElementById("oauth-continue").href);`
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

function collisionSummaryText(summary) {
	if (
		summary?.kind === "entry_count" &&
		Number.isSafeInteger(summary.entryCount) &&
		summary.entryCount >= 0
	) {
		return summary.entryCount === 1
			? "1 stored entry"
			: `${summary.entryCount} stored entries`;
	}
	if (summary?.kind === "presence" && typeof summary.used === "boolean") {
		return summary.used ? "Stored state is present" : "No stored state";
	}
	return "Stored state was detected";
}

function collisionResolutionBody(pendingIntegration, error) {
	const discovery = pendingIntegration.stateDiscovery;
	const collisions = discovery.namespaces.filter(
		(namespace) => namespace.outcome === "collision"
	);
	const features = new Map();
	for (const [index, namespace] of collisions.entries()) {
		const feature = features.get(namespace.featureId) ?? {
			label: namespace.featureLabel,
			namespaces: []
		};
		feature.namespaces.push({ ...namespace, index });
		features.set(namespace.featureId, feature);
	}
	const featureCards = [...features.values()].map((feature) => `
    <section class="feature-card">
      <h2>${escapeHtml(feature.label)}</h2>
      ${feature.namespaces.map((namespace) => `
      <fieldset>
        <legend>${escapeHtml(namespace.namespaceLabel)}</legend>
        <label class="choice">
          <input type="radio" name="choice_${namespace.index}" value="discord" required>
          <span><strong>Use Discord state</strong><span>${escapeHtml(
				collisionSummaryText(namespace.discordSummary)
			)}</span></span>
        </label>
        <label class="choice">
          <input type="radio" name="choice_${namespace.index}" value="twitch" required>
          <span><strong>Use Twitch state</strong><span>${escapeHtml(
				collisionSummaryText(namespace.twitchSummary)
			)}</span></span>
        </label>
        <label class="choice">
          <input type="radio" name="choice_${namespace.index}" value="reset" required>
          <span><strong>Reset shared state</strong><span>Start this feature namespace empty in the new link</span></span>
        </label>
      </fieldset>`).join("")}
    </section>`).join("");
	return {
		body: `
    <p class="eyebrow">State choice required</p>
    <h1>Choose what the new link should use</h1>
    <p>Both platforms have different saved state for the features below. Choose one source for each feature namespace, or reset only the new shared copy.</p>
    <div class="apply-all" aria-label="Apply one choice to every collision">
      <button type="button" data-apply-choice="discord">Discord for all</button>
      <button type="button" data-apply-choice="twitch">Twitch for all</button>
      <button type="button" data-apply-choice="reset">Reset all</button>
    </div>
    <form method="post" action="/twitch/integrations/resolve-state">
      <input type="hidden" name="discovery_version" value="${discovery.version}">
      ${featureCards}
      ${error ? `<p class="notice" role="alert">${escapeHtml(error)}</p>` : ""}
      <button type="submit">Save choices and continue</button>
    </form>
    <form class="secondary" method="post" action="/twitch/integrations/cancel">
      <button type="submit">Cancel linking</button>
    </form>
    <p class="fine-print">Only feature-approved summaries are shown. Choosing a source or reset does not alter either platform's existing state.</p>`,
		script: `
    for (const button of document.querySelectorAll("[data-apply-choice]")) {
      button.addEventListener("click", () => {
        const choice = button.dataset.applyChoice;
        for (const input of document.querySelectorAll('input[type="radio"][value="' + choice + '"]')) {
          input.checked = true;
        }
      });
    }`
	};
}

export function renderTwitchIntegrationPending(
	pendingIntegration,
	{ error = "", status = error ? 422 : 200 } = {}
) {
	const channel = pendingIntegration?.twitchLabel ??
		pendingIntegration?.twitchGroup?.id ??
		"your Twitch channel";
	const verificationPending =
		pendingIntegration?.status === "twitch_verification_pending";
	const discovery = pendingIntegration?.stateDiscovery;
	const resolution = pendingIntegration?.stateResolution;
	if (discovery?.requiresResolution && !resolution) {
		const resolutionPage = collisionResolutionBody(pendingIntegration, error);
		return pageResponse({
			title: "Resolve Elmybot state",
			body: resolutionPage.body,
			script: resolutionPage.script,
			status,
			wide: true
		});
	}
	const stateMessage = resolution
		? "Your state choices are recorded. Elmybot will use them while finalizing the link."
		: discovery
			? "No conflicting shareable state needs your input. The link is ready for finalization."
			: "Elmybot is waiting for shareable-state discovery. You can safely refresh or return to this page.";
	const readyToFinalize = Boolean(
		resolution || (discovery && !discovery.requiresResolution)
	);
	return pageResponse({
		title: "Elmybot link pending",
		status,
		body: `
    <p class="eyebrow success">${resolution
			? "Choices recorded"
			: verificationPending
			? "Authorization recorded"
			: "Twitch verified"}</p>
    <h1>${resolution
			? "State review is complete"
			: verificationPending
			? "Verification is continuing"
			: "State review is next"}</h1>
    <p>Twitch channel <strong>${escapeHtml(channel)}</strong> is authorized, but the Discord integration is not active yet.</p>
    <p>${verificationPending
			? "Elmybot is retrying the verified-channel handoff. Refresh this page to check again."
			: stateMessage}</p>
    ${error ? `<p class="notice" role="alert">${escapeHtml(error)}</p>` : ""}
    ${readyToFinalize ? `
    <form method="post" action="/twitch/integrations/finalize">
      <button type="submit">Finish linking</button>
    </form>` : ""}
    <form method="post" action="/twitch/integrations/cancel">
      <button type="submit">Cancel linking</button>
    </form>
    <p class="fine-print">Cancelling leaves Twitch authorized for the bot and does not change existing integrations.</p>`
	});
}

export function renderTwitchIntegrationCancelled() {
	return pageResponse({
		title: "Elmybot link cancelled",
		body: `
    <p class="eyebrow">Link cancelled</p>
    <h1>No integration was created</h1>
    <p>The pending Twitch–Discord link was cancelled. Existing links and Twitch authorization were not changed.</p>`
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
