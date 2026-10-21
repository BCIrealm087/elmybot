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
      assert.ok(["/health-widget/index.html", "/health-widget/app.js", "/health-widget/effects.js", "/health-widget/legacy.html", "/health-widget/legacy.js", "/event-stream/client.js", "/event-stream/state-event.js", "/event-stream/correlation.js", "/state-query/client.js"].includes(name));
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
  const connection = { kind: request.url.startsWith("/state-query/") ? "read" : "event", socket, sequence: 0, version: request.headers.cookie?.includes("event=v1") ? 1 : 2, registered: false, acknowledged: [] };
  connections.add(connection);
  socket.on("message", (data) => {
    try {
      const text = data.toString(); if (text.endsWith("-ping/v1")) { socket.send(text.replace("-ping/v1", "-pong/v1")); return; }
      const message = JSON.parse(text);
      if (message.type === "register") {
        connection.registered = true;
        if (connection.kind === "read") { connection.queries = message.queries; sendState(connection, "snapshot"); }
        else socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ready", stream: stream(connection.version), delivery: { kind: "bounded_at_least_once", retentionSeconds: 1800, maxRetainedEvents: 1000, maxRetainedBytes: 1048576 } }));
      } else { assert.equal(message.type, "ack"); if (connection.kind === "event") { acknowledgements++; connection.acknowledged.push(message.cursor); } }
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
async function sendImpact(sequence, payload, version = 2) {
  await wait(() => [...connections].some((value) => value.kind === "event" && value.version === version && value.registered), "Event consumer missing");
  const connection = [...connections].find((value) => value.kind === "event" && value.version === version), previous = connection.acknowledged.length;
  const cursor = id("dec1.", `${version}:${sequence}`);
  connection.socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "event", stream: stream(version), eventId: id("dev1.", `${version}:${sequence}`),
    sequence, cursor, acceptedAt: "2026-10-18T00:00:00Z", expiresAt: "2026-10-18T00:30:00Z", payload,
    ...(version === 2 ? { stateEvent: { ...marker(sequence), operationId: id("seo1.", sequence) } } : {}) }));
  return { connection, previous, cursor };
}
async function impact(sequence, payload, version = 2) {
  const { connection, previous, cursor } = await sendImpact(sequence, payload, version);
  await wait(() => connection.acknowledged.length > previous && connection.acknowledged.at(-1) === cursor, "Health widget did not acknowledge accepted handling");
}
const payload = (operation, before, after, requestedAmount) => ({ operation, before, after, requestedAmount, appliedAmount: Math.abs(after - before), changed: before !== after });
async function pageFor({ legacyNumber, readGrant = "read-health", eventGrant = "event-v2", diagnostics = false, stallAnimation = false } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(({ key, legacyNumber, stallAnimation }) => {
    if (legacyNumber !== undefined) localStorage.setItem(key, JSON.stringify({ health: legacyNumber, recentIds: [] }));
    window.impactAnimations = 0; window.impactCancels = 0; window.effectControls = [];
    // Deterministic visibility events test policy, not vendor background timers.
    window.healthHidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.healthHidden ? "hidden" : "visible" });
    window.setHealthHidden = (value) => { window.healthHidden = value; document.dispatchEvent(new Event("visibilitychange")); };
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args);
      if (this.id === "meter") {
        window.impactAnimations++;
        const cancel = animation.cancel.bind(animation);
        animation.cancel = () => { window.impactCancels++; cancel(); };
        if (stallAnimation) {
          animation.pause();
          let finish;
          Object.defineProperty(animation, "finished", { value: new Promise((resolve) => { finish = resolve; }) });
          window.effectControls.push(() => { if (animation.playState !== "idle") animation.finish(); finish(); });
        }
      }
      return animation;
    };
    window.completeHealthEffect = (index) => window.effectControls[index]();
  }, { key: `elmybot.health.v1:${target.platform}:${target.groupId}`, legacyNumber, stallAnimation });
  const page = await context.newPage(), diagnosticRecords = [];
  page.on("pageerror", (error) => errors.push(error));
  page.on("console", (message) => {
    try { const record = JSON.parse(message.text()); if (record.event === "health.trace") diagnosticRecords.push(record); } catch { /* unrelated browser output */ }
  });
  await page.goto(`${origin}/health-widget/${diagnostics ? "?diagnostics=1" : ""}`);
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
  await page.getByRole("button", { name: "Connect", exact: true }).click(); return { page, context, diagnosticRecords };
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const first = await pageFor({ legacyNumber: 0, diagnostics: true }), page = first.page;
  await page.waitForFunction(() => document.getElementById("value").textContent === "85 / 100");
  await impact(1, payload("damage", 100, 85, 15)); assert.equal(await page.evaluate(() => window.impactAnimations), 0);
  update(2, 80); await page.waitForFunction(() => document.getElementById("value").textContent === "80 / 100");
  await impact(2, payload("damage", 85, 80, 5)); assert.equal(await page.locator("#value").textContent(), "80 / 100");
  await impact(3, payload("heal", 80, 90, 10)); assert.equal(await page.locator("#value").textContent(), "80 / 100"); update(3, 90);
  update(4, 100); await impact(4, payload("heal", 90, 100, 10));
  update(5, 100); await impact(5, payload("heal", 100, 100, 10)); await impact(5, payload("heal", 100, 100, 10));
  await page.waitForFunction(() => window.impactAnimations === 4);
  try {
    await wait(() => first.diagnosticRecords.filter((r) => r.stage === "animation.finish").length === 4, "Cosmetic queue did not drain");
  } catch (error) {
    console.error("Health cosmetic completion failure", JSON.stringify({
      effects: first.diagnosticRecords.filter((r) => r.stage.startsWith("animation.")),
      browser: await page.evaluate(() => ({ starts: window.impactAnimations, cancels: window.impactCancels,
        active: document.getElementById("meter").getAnimations().map((a) => ({ playState: a.playState, currentTime: a.currentTime })) })),
      errors: errors.map((e) => e.message)
    }));
    throw error;
  }
  assert.equal(await page.locator("#value").textContent(), "100 / 100");
  assert.equal(await page.locator("#grant").inputValue(), ""); assert.equal(await page.locator("#read-grant").inputValue(), "");
  for (const stage of ["snapshot.receive", "event.receive", "event.handled", "event.ack", "animation.start", "animation.finish"]) {
    assert.ok(first.diagnosticRecords.some((record) => record.stage === stage), `Missing ${stage} diagnostic`);
  }
  assert.ok(!JSON.stringify(first.diagnosticRecords).match(/read-health|event-v2|payload|requestedAmount|appliedAmount/));
  assert.ok(!page.url().includes("grant")); await first.context.close(); await wait(() => connections.size === 0, "Widget teardown failed");

  update(6, 73); const fresh = await pageFor();
  await fresh.page.waitForFunction(() => document.getElementById("value").textContent === "73 / 100");
  await impact(6, payload("damage", 100, 73, 27)); assert.equal(await fresh.page.evaluate(() => window.impactAnimations), 0);
  assert.equal(await fresh.page.evaluate(() => localStorage.getItem("elmybot.health.v1:discord:health-fixture")), null);
  assert.equal(fresh.diagnosticRecords.length, 0, "Health diagnostics must default off");
  await fresh.context.close(); await wait(() => connections.size === 0, "Fresh widget teardown failed");

  const stalled = await pageFor({ diagnostics: true, stallAnimation: true }), stalledPage = stalled.page;
  await stalledPage.waitForFunction(() => document.getElementById("value").textContent === "73 / 100");
  const priorAcks = acknowledgements;
  await impact(7, payload("damage", 73, 70, 3));
  assert.equal(acknowledgements, priorAcks + 1, "A never-resolving animation must not hold ACK");
  assert.equal(await stalledPage.evaluate(() => window.impactAnimations), 1);
  assert.ok(!stalled.diagnosticRecords.some((r) => r.stage === "animation.finish"));
  update(7, 70); await stalledPage.waitForFunction(() => document.getElementById("value").textContent === "70 / 100");
  for (let sequence = 8; sequence <= 27; sequence++) await impact(sequence, payload("heal", 100, 100, 10));
  await impact(27, payload("heal", 100, 100, 10)); // Accepted duplicate cannot evict another effect.
  assert.equal(await stalledPage.evaluate(() => window.impactAnimations), 1);
  await wait(() => stalled.diagnosticRecords.filter((r) => r.stage === "animation.drop").length === 12, "Overflow diagnostics missing");
  const dropped = stalled.diagnosticRecords.filter((r) => r.stage === "animation.drop");
  assert.deepEqual(dropped.map((r) => r.eventId), Array.from({ length: 12 }, (_, index) => id("dev1.", `2:${8 + index}`)));
  assert.ok(stalled.diagnosticRecords.every((r) => (r.pendingEffects ?? 0) <= 8 && (r.runningEffects ?? 0) <= 1));
  update(27, 30); await stalledPage.waitForFunction(() => document.getElementById("value").textContent === "30 / 100");
  for (let index = 0; index < 9; index++) {
    await stalledPage.waitForFunction((count) => window.effectControls.length === count, index + 1);
    await stalledPage.evaluate((n) => window.completeHealthEffect(n), index);
  }
  await wait(() => stalled.diagnosticRecords.filter((r) => r.stage === "animation.finish").length === 9, "Bounded retained effects did not finish");
  assert.deepEqual(stalled.diagnosticRecords.filter((r) => r.stage === "animation.start").map((r) => r.eventId),
    [7, ...Array.from({ length: 8 }, (_, index) => 20 + index)].map((n) => id("dev1.", `2:${n}`)));
  assert.equal(await stalledPage.locator("#value").textContent(), "30 / 100");

  await impact(28, payload("damage", 30, 29, 1)); await impact(29, payload("damage", 29, 28, 1));
  await stalledPage.evaluate(() => window.setHealthHidden(true));
  assert.equal(await stalledPage.evaluate(() => window.impactCancels), 1);
  for (let sequence = 30; sequence <= 33; sequence++) await impact(sequence, payload("damage", 30, 29, 1));
  update(33, 45); await stalledPage.waitForFunction(() => document.getElementById("value").textContent === "45 / 100");
  assert.equal(await stalledPage.evaluate(() => window.impactAnimations), 10);
  await stalledPage.evaluate(() => window.setHealthHidden(false));
  await impact(34, payload("heal", 45, 46, 1)); await impact(35, payload("heal", 46, 47, 1));
  await stalledPage.evaluate(() => window.completeHealthEffect(9)); // Obsolete completion cannot start pending 35.
  assert.equal(await stalledPage.evaluate(() => window.impactAnimations), 11);

  update(35, 44);
  const oldConnection = [...connections].find((c) => c.kind === "event"); oldConnection.socket.close(1012, "Synthetic reconnect");
  await wait(() => [...connections].some((c) => c.kind === "event" && c !== oldConnection && c.registered), "Health consumer did not reconnect");
  await stalledPage.waitForFunction(() => document.getElementById("value").textContent === "44 / 100");
  await impact(35, payload("heal", 46, 47, 1)); assert.equal(await stalledPage.evaluate(() => window.impactAnimations), 11);
  await impact(36, payload("heal", 44, 45, 1)); await impact(37, payload("heal", 45, 46, 1)); update(37, 42);
  await stalledPage.reload(); await stalledPage.waitForFunction(() => document.getElementById("value").textContent === "42 / 100");
  await impact(37, payload("heal", 45, 46, 1)); assert.equal(await stalledPage.evaluate(() => window.impactAnimations), 0);
  await impact(38, payload("heal", 42, 43, 1));
  const ending = [...connections].find((c) => c.kind === "event");
  ending.socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "status", code: "retention_gap", terminal: true }));
  await stalledPage.waitForFunction(() => document.getElementById("status").textContent.includes("retention_gap"));
  assert.equal(await stalledPage.evaluate(() => window.impactCancels), 1);
  await wait(() => connections.size === 0, "Ended health coordination did not tear down both transports");
  await stalled.context.close();

  update(40, 40);
  const invalid = await pageFor({ stallAnimation: true });
  await invalid.page.waitForFunction(() => document.getElementById("value").textContent === "40 / 100");
  const malformed = await sendImpact(41, { ...payload("damage", 40, 39, 1), before: "invalid" });
  await wait(() => malformed.connection.socket.readyState === 3, "Invalid impact did not fail handling");
  assert.ok(!malformed.connection.acknowledged.includes(malformed.cursor), "Invalid health must not be ACKed");
  assert.equal(await invalid.page.evaluate(() => window.impactAnimations), 0);
  await invalid.context.close(); await wait(() => connections.size === 0, "Invalid widget teardown failed");
  update(6, 73); // Restore the unrelated legacy/mismatched-grant scenario baseline.

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
  console.log("Health v2 Chromium smoke passed: ACK before cosmetic completion, bounded oldest-pending overflow, hidden/reconnect/reload/terminal cancellation, invalid-event rejection, opt-in payload-free receipt/snapshot/animation/ACK traces, readable setup labels/status on transparent pages, authoritative recovery after cleared/legacy storage, separate grants, both arrival orders, one effect per retained live impact including clamping, duplicate suppression, v1 grant rejection and explicit legacy drain.");
} finally {
  await browser?.close(); for (const connection of connections) connection.socket.terminate(); sockets.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
