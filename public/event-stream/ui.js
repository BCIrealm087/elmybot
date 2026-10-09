// Setup and OBS widget behavior shared by the two same-origin pages.
export function mountDurableEventApp(
  window,
  document,
  createDurableEventClient,
  createRecentEventIdDeduplicator
) {
  const client = createDurableEventClient();
  const recent = createRecentEventIdDeduplicator();
  const widget = document.body.dataset.page === "widget";
  const $ = (id) => document.getElementById(id);
  let catalog;
  let subscription;
  let eventCount = 0;
  const report = (message) => { $("message").textContent = message; };
  const stop = () => { subscription?.unsubscribe(); subscription = null; };
  const configuration = (() => {
    if (!widget || !window.location.hash) return {};
    try {
      const value = JSON.parse(decodeURIComponent(window.location.hash.slice(1)));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return value;
    } catch { return {}; }
  })();
  const title = String(configuration.title ?? "Durable events").slice(0, 100);

  function render(event, { duplicate = false } = {}) {
    eventCount += duplicate ? 0 : 1;
    $("event-title").textContent = title;
    $("payload").textContent = typeof event.payload === "string"
      ? event.payload
      : JSON.stringify(event.payload, null, 2);
    $("event-meta").textContent = duplicate
      ? `Duplicate ${event.eventId} acknowledged without repeating the handler.`
      : `Event ${event.sequence} · ${event.eventId} · accepted ${event.acceptedAt}`;
    $("event-count").textContent = `${eventCount} event${eventCount === 1 ? "" : "s"} handled`;
  }

  function describeStatus(status) {
    const labels = {
      connecting: "Connecting…",
      reconnecting: "Reconnecting — an unacknowledged event will replay",
      handling: "Handling event…",
      handler_failed: "Handler failed — reconnecting for replay",
      live: "Live — waiting for the next event",
      ended: "Delivery ended — check the event grant",
      closed: "Stopped"
    };
    $("connection").textContent = labels[status.state] ?? status.state;
    if (status.delivery) {
      $("delivery").textContent =
        `At least once · ${status.delivery.retentionSeconds}s retention · ` +
        `${status.delivery.maxRetainedEvents} events / ${status.delivery.maxRetainedBytes} bytes`;
    }
    if (status.state === "ended") {
      stop();
      $("access").hidden = false;
      report(status.message ?? "Delivery ended.");
    } else if (status.state === "handler_failed") {
      report(status.message);
    } else if (status.state === "live") {
      report("");
    }
  }

  function start() {
    if (subscription) return;
    subscription = client.subscribe(async (event) => {
      const outcome = await recent.handle(event, async (selected) => render(selected));
      if (outcome.duplicate) render(event, outcome);
    }, { onStatus: describeStatus });
  }

  function streamIdentity(entry) {
    return `${entry.feature}:${entry.stream}:v${entry.version}`;
  }

  function widgetUrl() {
    const url = new URL("/event-stream/widget", window.location.origin);
    url.hash = encodeURIComponent(JSON.stringify({ title }));
    return url.href;
  }

  function snippet() {
    const clientUrl = window.location.origin + "/event-stream/client.js";
    return `import { createDurableEventClient, createRecentEventIdDeduplicator } from ${JSON.stringify(clientUrl)};

const client = createDurableEventClient({ baseUrl: ${JSON.stringify(window.location.origin)} });
const recent = createRecentEventIdDeduplicator({ maxEntries: 100 });
const subscription = client.subscribe(async (event) => {
  await recent.handle(event, async ({ payload, eventId, sequence }) => {
    // Apply this event. Returning (or fulfilling a Promise) acknowledges it.
    console.log({ payload, eventId, sequence });
  });
}, {
  onStatus: (status) => console.log(status.state)
});

// On teardown:
// subscription.unsubscribe();
// client.close();`;
  }

  async function load() {
    try {
      catalog = await client.catalog();
    } catch (error) {
      $("access").hidden = false;
      if (!String(error.code).startsWith("http_4") && error.code !== "durable_event_access_denied") {
        report(error.message);
      }
      return;
    }
    const entry = catalog.streams?.[0];
    if (!entry) throw new Error("This grant does not expose an event stream.");
    $("access").hidden = true;
    $("stream").textContent = streamIdentity(entry);
    $("target").textContent = `${catalog.target.platform} · ${catalog.target.groupId}`;
    $("grant-info").textContent = `Grant expires ${catalog.grant.expiresAt}`;
    $("details").hidden = false;
    if (!widget) {
      $("controls").hidden = false;
      $("outputs").hidden = false;
      $("widget-url").value = widgetUrl();
      $("snippet").value = snippet();
    } else start();
  }

  $("grant-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const credential = $("credential").value;
    $("credential").value = "";
    try {
      await client.session(credential);
      await load();
      if (widget) start();
      report("");
    } catch (error) {
      $("access").hidden = false;
      report(error.message);
    }
  });
  $("change-access").addEventListener("click", async () => {
    stop();
    try { await client.logout(); } catch { /* local sign-out still clears the UI */ }
    catalog = null;
    $("details").hidden = true;
    if (!widget) {
      $("controls").hidden = true;
      $("outputs").hidden = true;
    }
    $("payload").textContent = "Waiting for an event.";
    $("event-meta").textContent = "";
    $("connection").textContent = "Disconnected";
    $("access").hidden = false;
    report("Enter an event grant.");
  });
  if (!widget) {
    $("start").addEventListener("click", start);
    $("stop").addEventListener("click", () => {
      stop();
      $("connection").textContent = "Stopped";
    });
    for (const id of ["widget-url", "snippet"]) {
      $(`copy-${id}`).addEventListener("click", async () => {
        try { await window.navigator.clipboard.writeText($(id).value); report("Copied."); }
        catch { $(id).focus(); $(id).select(); report("Select and copy the text above."); }
      });
    }
  }
  window.addEventListener("pagehide", () => client.close(), { once: true });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });
  void load().catch((error) => { report(error.message); $("access").hidden = false; });
}
