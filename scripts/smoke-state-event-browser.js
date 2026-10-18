// Real Chromium + both shipped clients against deterministic HTTP/WebSocket
// fixtures. Owner SQLite atomicity and grant enforcement are tested in Vitest.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

let origin, browser, heldRead = null, hold = true, reads = 0, acknowledgements = 0;
const errors = [], connections = new Set();
const model = { sequence: 0, value: 100, token: "ses1." + "a".repeat(22) };
const identity = (prefix, value) => prefix + createHash("sha256").update(String(value)).digest("base64url");
const marker = () => ({ version: 1, scopeToken: model.token, operationSequence: model.sequence, stateRevision: model.sequence });
const snapshot = () => ({ status: "ready", data: { health: { state: "present", value: model.value, stateEvent: marker() } } });
const stream = { feature: "test.health", stream: "impacts", version: 2 };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><div id="value"></div>'); return; }
    if (["/event-stream/client.js", "/event-stream/correlation.js", "/event-stream/state-event.js", "/state-query/client.js"].includes(url.pathname)) {
      response.writeHead(200, { "content-type": "text/javascript" }); response.end(await readFile(new URL(`../public${url.pathname}`, import.meta.url))); return;
    }
    const kind = url.pathname.startsWith("/state-query/") ? "read" : "event";
    if (url.pathname.endsWith("/session")) {
      assert.equal(request.headers.authorization, `Bearer ${kind}-grant`);
      response.writeHead(204, { "set-cookie": `${kind}=yes; HttpOnly; SameSite=Strict; Path=/${kind === "read" ? "state-query" : "event-stream"}` }); response.end(); return;
    }
    if (url.pathname === "/state-query/snapshot") {
      assert.ok(request.headers.cookie?.includes("read=yes")); reads++;
      const captured = snapshot();
      if (hold) await new Promise((resolve) => { heldRead = resolve; });
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(captured)); return;
    }
    response.writeHead(404); response.end();
  } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
});
const sockets = new WebSocketServer({ noServer: true });
function sendState(connection, type = "update") {
  connection.sequence++;
  connection.socket.send(JSON.stringify({ protocol: "state-query-socket/v1", type: "event", event: {
    sequence: connection.sequence, cursor: `sq1.fixture.${connection.sequence}`, eventType: type,
    payload: { protocol: "state-query-stream/v1", subscriptionId: "fixture", results: connection.queries.map(({ id }) => ({
      queryId: id, sequence: connection.sequence, status: "ready", result: snapshot()
    })) }
  } }));
}
function eventConnection() { return [...connections].find((value) => value.kind === "event" && value.registered); }
function update(sequence, value = 100 - sequence) {
  model.sequence = sequence; model.value = value;
  for (const connection of connections) if (connection.kind === "read" && connection.registered) sendState(connection);
}
async function wait(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw Error(message); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function sendImpact(sequence, { historical = false, changed = true } = {}) {
  await wait(eventConnection, "Event registration missing");
  const count = acknowledgements;
  eventConnection().socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "event", stream,
    eventId: identity("dev1.", sequence), sequence, cursor: identity("dec1.", sequence),
    acceptedAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-10-18T00:30:00.000Z",
    stateEvent: { ...marker(), operationSequence: sequence, stateRevision: sequence, operationId: identity("seo1.", sequence) },
    payload: { after: model.value, changed, historical }
  }));
  await wait(() => acknowledgements > count, "Event was not acknowledged after handling");
}
sockets.on("connection", (socket, request) => {
  const connection = { kind: request.url.startsWith("/state-query/") ? "read" : "event", socket, sequence: 0, registered: false };
  connections.add(connection);
  socket.on("message", (data) => {
    try {
      const text = data.toString();
      if (text.endsWith("-ping/v1")) { socket.send(text.replace("-ping/v1", "-pong/v1")); return; }
      const message = JSON.parse(text);
      if (message.type === "register") {
        assert.equal(connection.registered, false); connection.registered = true;
        if (connection.kind === "read") { connection.queries = message.queries; sendState(connection, "snapshot"); }
        else socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "ready", stream,
          delivery: { kind: "bounded_at_least_once", retentionSeconds: 1800, maxRetainedEvents: 1000, maxRetainedBytes: 1048576 } }));
      } else {
        assert.equal(message.type, "ack"); if (connection.kind === "event") acknowledgements++;
      }
    } catch (error) { errors.push(error); socket.close(1008, "Fixture failure"); }
  });
  socket.on("close", () => connections.delete(connection));
});
server.on("upgrade", (request, socket, head) => {
  const kind = request.url === "/state-query/socket" ? "read" : request.url === "/event-stream/socket" ? "event" : null;
  if (!kind || !request.headers.cookie?.includes(`${kind}=yes`) || request.headers.origin !== origin) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket, request));
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error)); await page.goto(origin);
  await page.evaluate(async () => {
    const { createStateQueryClient } = await import("/state-query/client.js");
    const { createDurableEventClient } = await import("/event-stream/client.js");
    const { watchStateEvents } = await import("/event-stream/state-event.js");
    const stateClient = createStateQueryClient({ retryMs: 10 }), eventClient = createDurableEventClient({ retryMs: 10 });
    await stateClient.session("read-grant"); await eventClient.session("event-grant");
    window.snapshots = []; window.impacts = []; window.statuses = [];
    window.start = () => watchStateEvents({ stateClient, eventClient,
      query: { version: 1, target: { platform: "discord", groupId: "fixture" }, bindings: { current: { read: { feature: "test.health", export: "current", version: 1 } } }, select: { health: { ref: "current" } } },
      selection: "health", storage: null,
      onSnapshot(cell) { window.snapshots.push(cell); document.getElementById("value").textContent = String(cell.value); },
      onEvent(event, metadata) { window.impacts.push({ sequence: event.stateEvent.operationSequence, included: metadata.stateIncluded }); },
      onStatus(status) { window.statuses.push(status); }
    });
    window.subscription = window.start(); window.clients = { stateClient, eventClient };
  });
  await wait(() => heldRead && [...connections].some((value) => value.kind === "read" && value.registered), "Snapshot/watch did not start");
  update(2);
  const before = acknowledgements, pending = sendImpact(1, { historical: true });
  await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(acknowledgements, before);
  hold = false; heldRead(); await pending;
  assert.equal(await page.locator("#value").textContent(), "98"); assert.equal(await page.evaluate(() => window.impacts.length), 0);

  await sendImpact(3); assert.equal(await page.locator("#value").textContent(), "98"); update(3);
  await page.waitForFunction(() => document.getElementById("value").textContent === "97");
  update(5); await page.waitForFunction(() => document.getElementById("value").textContent === "95");
  await sendImpact(4); await sendImpact(5); assert.equal(await page.locator("#value").textContent(), "95");
  update(8); await page.waitForFunction(() => document.getElementById("value").textContent === "92");
  for (const sequence of [6, 7, 8]) await sendImpact(sequence);
  update(9, 92); await sendImpact(9, { changed: false }); await sendImpact(9, { changed: false });
  assert.deepEqual(await page.evaluate(() => window.impacts.map((value) => value.sequence)), [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(await page.locator("#value").textContent(), "92");
  assert.equal(await page.evaluate(() => window.impacts[0].included), false);
  assert.equal(await page.evaluate(() => window.impacts[1].included), true);

  const previousReads = reads; update(10); eventConnection().socket.close(1012, "Fixture restart");
  await wait(() => reads > previousReads && eventConnection(), "Reconnect did not reacquire a snapshot");
  await sendImpact(10, { historical: true });
  assert.equal(await page.evaluate(() => window.impacts.length), 7);
  eventConnection().socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "status", code: "retention_gap", terminal: true }));
  await page.waitForFunction(() => window.statuses.some((status) => status.code === "retention_gap"));
  await wait(() => connections.size === 0, "Gap did not detach both subscriptions");
  // Simulate the operator's reset/reissued grant and a newly authorized owner.
  model.token = "ses1." + "b".repeat(22); model.sequence = 11; model.value = 89;
  await page.evaluate(async () => { await window.clients.eventClient.session("event-grant"); window.subscription = window.start(); });
  await page.waitForFunction(() => document.getElementById("value").textContent === "89");
  await sendImpact(11, { historical: true }); update(12); await sendImpact(12);
  assert.deepEqual(await page.evaluate(() => window.impacts.map((value) => value.sequence)), [3, 4, 5, 6, 7, 8, 9, 12]);
  await page.evaluate(async () => { window.subscription.unsubscribe(); await window.clients.stateClient.close(); await window.clients.eventClient.close(); });
  assert.deepEqual(errors, []);
  console.log("State/event Chromium smoke passed: setup buffering, both arrival orders, rapid updates, clamped no-op, duplicate suppression, reconnect, gap teardown and fresh-owner resynchronization with separate sessions.");
} finally {
  hold = false; heldRead?.(); await browser?.close();
  for (const connection of connections) connection.socket.terminate(); sockets.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
