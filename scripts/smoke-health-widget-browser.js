// Health UI + shipped clients over real Chromium/HTTP/WebSockets. Durable owner
// acceptance and permission enforcement are covered by health-state-event.spec.js.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
const target = { platform: "discord", groupId: "health-fixture" };
const model = { sequence: 1, value: 85 }, connections = new Set(), errors = [];
let origin, browser, acknowledgements = 0;
const marker = (sequence = model.sequence) => ({ version: 1, scopeToken: "ses1." + "a".repeat(22), operationSequence: sequence, stateRevision: sequence });
const snapshot = () => ({ status: "ready", data: { health: { state: "present", value: model.value, stateEvent: marker() } } });
const id = (prefix, value) => prefix + createHash("sha256").update(String(value)).digest("base64url");
const stream = (version) => ({ feature: "fun.health", stream: "impacts", version });
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, origin).pathname;
    if (path.startsWith("/health-widget/") || ["/event-stream/client.js", "/event-stream/state-event.js", "/event-stream/correlation.js", "/state-query/client.js"].includes(path)) {
      const name = path.endsWith("/") ? path + "index.html" : path;
      assert.ok(["/health-widget/index.html", "/health-widget/app.js", "/health-widget/legacy.html", "/health-widget/legacy.js", "/event-stream/client.js", "/event-stream/state-event.js", "/event-stream/correlation.js", "/state-query/client.js"].includes(name));
      response.writeHead(200, { "content-type": name.endsWith(".js") ? "text/javascript" : "text/html", "cache-control": "no-store" });
      response.end(await readFile(new URL(`../public${name}`, import.meta.url))); return;
    }
    const kind = path.startsWith("/state-query/") ? "read" : "event", cookie = request.headers.cookie ?? "";
    if (path.endsWith("/session")) {
      const credential = request.headers.authorization;
      assert.ok(kind === "read" ? ["Bearer read-health", "Bearer read-other"].includes(credential) : ["Bearer event-v1", "Bearer event-v2"].includes(credential));
      const value = kind === "read" ? credential.endsWith("other") ? "other" : "health" : credential.endsWith("v1") ? "v1" : "v2";
      response.writeHead(204, { "set-cookie": `${kind}=${value}; HttpOnly; SameSite=Strict; Path=/${kind === "read" ? "state-query" : "event-stream"}` }); response.end(); return;
    }
    if (!cookie.includes(`${kind}=`)) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "access_denied", message: "Connect the separate read and event grants." } })); return; }
    response.writeHead(200, { "content-type": "application/json" });
    if (path === "/event-stream/catalog") response.end(JSON.stringify({ target, streams: [stream(cookie.includes("event=v1") ? 1 : 2)] }));
    else if (path === "/state-query/catalog") response.end(JSON.stringify({ target: cookie.includes("read=other") ? { ...target, groupId: "another-group" } : target, exports: [{ feature: "fun.health", export: "current", version: 1 }] }));
    else if (path === "/state-query/snapshot") response.end(JSON.stringify(snapshot()));
    else response.end("{}");
  } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
});
const sockets = new WebSocketServer({ noServer: true });
function sendState(connection, type = "update") {
  connection.sequence++;
  connection.socket.send(JSON.stringify({ protocol: "state-query-socket/v1", type: "event", event: { eventType: type, sequence: connection.sequence,
    cursor: `sq1.health.${connection.sequence}`, payload: { protocol: "state-query-stream/v1", subscriptionId: "health", results: connection.queries.map(({ id }) => ({ queryId: id, sequence: connection.sequence, status: "ready", result: snapshot() })) }
  } }));
}
sockets.on("connection", (socket, request) => {
  const connection = { kind: request.url.startsWith("/state-query/") ? "read" : "event", socket, sequence: 0, version: request.headers.cookie?.includes("event=v1") ? 1 : 2, registered: false };
  connections.add(connection);
  socket.on("message", (data) => {
    try {
      const text = data.toString(); if (text.endsWith("-ping/v1")) { socket.send(text.replace("-ping/v1", "-pong/v1")); return; }
      const message = JSON.parse(text);
      if (message.type === "register") {
        connection.registered = true;
        if (connection.kind === "read") { connection.queries = message.queries; sendState(connection, "snapshot"); }
        else socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ready", stream: stream(connection.version), delivery: { kind: "bounded_at_least_once", retentionSeconds: 1800, maxRetainedEvents: 1000, maxRetainedBytes: 1048576 } }));
      } else { assert.equal(message.type, "ack"); if (connection.kind === "event") acknowledgements++; }
    } catch (error) { errors.push(error); socket.close(1008, "Fixture failed"); }
  });
  socket.on("close", () => connections.delete(connection));
});
server.on("upgrade", (request, socket, head) => {
  const kind = request.url === "/state-query/socket" ? "read" : request.url === "/event-stream/socket" ? "event" : null;
  if (!kind || !request.headers.cookie?.includes(`${kind}=`) || request.headers.origin !== origin) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
  sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket, request));
});
async function wait(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw Error(message); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function update(sequence, value) {
  model.sequence = sequence; model.value = value;
  for (const connection of connections) if (connection.kind === "read" && connection.registered) sendState(connection);
}
async function impact(sequence, payload, version = 2) {
  await wait(() => [...connections].some((value) => value.kind === "event" && value.version === version && value.registered), "Event consumer missing");
  const connection = [...connections].find((value) => value.kind === "event" && value.version === version), previous = acknowledgements;
  connection.socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "event", stream: stream(version), eventId: id("dev1.", `${version}:${sequence}`),
    sequence, cursor: id("dec1.", `${version}:${sequence}`), acceptedAt: "2026-10-18T00:00:00Z", expiresAt: "2026-10-18T00:30:00Z", payload,
    ...(version === 2 ? { stateEvent: { ...marker(sequence), operationId: id("seo1.", sequence) } } : {}) }));
  await wait(() => acknowledgements > previous, "Health widget did not acknowledge after its animation");
}
const payload = (operation, before, after, requestedAmount) => ({ operation, before, after, requestedAmount, appliedAmount: Math.abs(after - before), changed: before !== after });
async function pageFor({ legacyNumber, readGrant = "read-health", eventGrant = "event-v2" } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(({ key, legacyNumber }) => {
    if (legacyNumber !== undefined) localStorage.setItem(key, JSON.stringify({ health: legacyNumber, recentIds: [] }));
    window.impactAnimations = 0; const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) { if (this.id === "meter") window.impactAnimations++; return original.apply(this, args); };
  }, { key: `elmybot.health.v1:${target.platform}:${target.groupId}`, legacyNumber });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error)); await page.goto(`${origin}/health-widget/`);
  await page.locator("#access").waitFor({ state: "visible" });
  // Transparent overlays must retain readable setup text on a white browser
  // canvas. DOM visibility alone does not detect white-on-white labels.
  const contrast = await page.evaluate(() => {
    const luminance = (color) => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    return [".labels", "#status", "#access", "#migration"].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      const foreground = luminance(style.color), background = luminance(style.backgroundColor);
      return { selector, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05), background: style.backgroundColor };
    });
  });
  for (const { selector, ratio, background } of contrast) {
    assert.ok(!background.endsWith(", 0)"), `${selector} needs its own readable background`);
    assert.ok(ratio >= 4.5, `${selector} text contrast must be at least 4.5:1`);
  }
  await page.getByLabel("Current-health read grant:", { exact: true }).fill(readGrant);
  await page.getByLabel("Health v2 event grant:", { exact: true }).fill(eventGrant);
  await page.getByRole("button", { name: "Connect", exact: true }).click(); return { page, context };
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const first = await pageFor({ legacyNumber: 0 }), page = first.page;
  await page.waitForFunction(() => document.getElementById("value").textContent === "85 / 100");
  await impact(1, payload("damage", 100, 85, 15)); assert.equal(await page.evaluate(() => window.impactAnimations), 0);
  update(2, 80); await page.waitForFunction(() => document.getElementById("value").textContent === "80 / 100");
  await impact(2, payload("damage", 85, 80, 5)); assert.equal(await page.locator("#value").textContent(), "80 / 100");
  await impact(3, payload("heal", 80, 90, 10)); assert.equal(await page.locator("#value").textContent(), "80 / 100"); update(3, 90);
  update(4, 100); await impact(4, payload("heal", 90, 100, 10));
  update(5, 100); await impact(5, payload("heal", 100, 100, 10)); await impact(5, payload("heal", 100, 100, 10));
  assert.equal(await page.evaluate(() => window.impactAnimations), 4);
  assert.equal(await page.locator("#value").textContent(), "100 / 100");
  assert.equal(await page.locator("#grant").inputValue(), ""); assert.equal(await page.locator("#read-grant").inputValue(), "");
  assert.ok(!page.url().includes("grant")); await first.context.close(); await wait(() => connections.size === 0, "Widget teardown failed");

  update(6, 73); const fresh = await pageFor();
  await fresh.page.waitForFunction(() => document.getElementById("value").textContent === "73 / 100");
  await impact(6, payload("damage", 100, 73, 27)); assert.equal(await fresh.page.evaluate(() => window.impactAnimations), 0);
  assert.equal(await fresh.page.evaluate(() => localStorage.getItem("elmybot.health.v1:discord:health-fixture")), null);
  await fresh.context.close(); await wait(() => connections.size === 0, "Fresh widget teardown failed");

  const legacy = await pageFor({ legacyNumber: 5, eventGrant: "event-v1" });
  await legacy.page.waitForFunction(() => document.getElementById("status").textContent.includes("legacy v1 event grant"));
  assert.equal(connections.size, 0); assert.equal(await legacy.page.locator("#value").textContent(), "— / 100");
  await legacy.page.getByRole("link", { name: "Legacy v1 backlog view" }).click();
  await legacy.page.waitForFunction(() => document.getElementById("value").textContent === "5 / 100");
  await impact(1, { operation: "heal", amount: 10 }, 1);
  assert.equal(await legacy.page.locator("#value").textContent(), "15 / 100"); assert.equal(model.value, 73);
  await legacy.context.close(); await wait(() => connections.size === 0, "Legacy widget teardown failed");

  const mismatch = await pageFor({ readGrant: "read-other" });
  await mismatch.page.waitForFunction(() => document.getElementById("status").textContent.includes("same group"));
  assert.equal(connections.size, 0); await mismatch.context.close();
  assert.deepEqual(errors, []);
  console.log("Health v2 Chromium smoke passed: readable setup labels/status on transparent pages, authoritative recovery after cleared/legacy storage, separate grants, both arrival orders, one animation per impact including clamping, duplicate suppression, v1 grant rejection and explicit legacy drain.");
} finally {
  await browser?.close(); for (const connection of connections) connection.socket.terminate(); sockets.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
