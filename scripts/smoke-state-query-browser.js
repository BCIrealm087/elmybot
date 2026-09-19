// Chromium UI smoke against a deterministic HTTP/WebSocket contract fixture.
// Real grants, Durable Objects, and lifecycle changes are separately exercised by Vitest.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { stateQueryBrowserResponse } from "../src/state-querying/browser-pages.js";

const target = { platform: "discord", groupId: "smoke-guild" };
const read = (name) => ({ feature: "fun.deaths", export: name, version: 1 });
const stringSchema = { type: "string", maxLength: 80 };
const exports = [
  { ...read("remembered_game"), label: "Remembered game", parameters: {}, resultSchema: stringSchema, grantScope: { arguments: {} } },
  { ...read("count"), label: "Death count", parameters: { game: { label: "Game", schema: stringSchema } },
    resultSchema: { type: "object", properties: { game: stringSchema, count: { type: "integer" } } },
    grantScope: { arguments: { game: { values: { kind: "any" }, dynamicFrom: [read("remembered_game")] } } } }
];
const model = { game: "Hades", counts: { Hades: 3, Sekiro: 8 }, realm: "standalone" };
const streams = new Set();
const errors = [];
let socketSerial = 0;
let acknowledgementCount = 0;
function evaluate(query) {
  const cells = new Map();
  function binding(id) {
    if (cells.has(id)) return cells.get(id);
    const node = query.bindings[id];
    let cell;
    if (node.read.export === "remembered_game") cell = model.game === null ? { state: "unselected" } : { state: "present", value: model.game };
    else {
      const argument = node.arguments.game;
      const source = argument.ref ? binding(argument.ref) : { state: "present", value: argument.literal };
      cell = source.state !== "present" ? { state: "blocked", reason: "unselected" }
        : { state: "present", value: { game: source.value, count: model.counts[source.value] ?? 0 } };
    }
    cells.set(id, cell); return cell;
  }
  return { status: "ready", data: Object.fromEntries(Object.entries(query.select).map(([name, selection]) => {
    const cell = binding(selection.ref);
    return [name, cell.state === "present" ? { ...cell, value: (selection.path ?? []).reduce((value, key) => value[key], cell.value) } : cell];
  })) };
}
function send(stream, event = "update", reason = "value_change") {
  stream.sequence += 1;
  const results = stream.queries.map(({ id, query }) => event === "status"
    ? { queryId: id, status: "denied", error: { code: "query_grant_revoked" } }
    : { queryId: id, sequence: stream.sequence, status: "ready", reason, result: evaluate(query) });
  stream.socket.send(JSON.stringify({
    protocol: "state-query-socket/v1",
    type: "event",
    event: {
      sequence: stream.sequence,
      cursor: `sq1.1.${stream.subscriptionId}.${stream.sequence}`,
      eventType: event,
      payload: {
        protocol: "state-query-stream/v1",
        subscriptionId: stream.subscriptionId,
        results
      }
    }
  }));
}
const broadcast = (reason) => { for (const stream of streams) send(stream, "update", reason); };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    const page = stateQueryBrowserResponse(new Request(url));
    if (page) { response.writeHead(page.status, Object.fromEntries(page.headers)); response.end(await page.text()); return; }
    if (["app.js", "client.js", "query.js", "ui.js", "browser.css"].some((name) => url.pathname === `/state-query/${name}`)) {
      response.writeHead(200, { "content-type": url.pathname.endsWith("css") ? "text/css" : "text/javascript", "cache-control": "no-store" });
      response.end(await readFile(new URL(`../public${url.pathname}`, import.meta.url))); return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    if (url.pathname === "/state-query/session") {
      if (request.method === "POST") assert.equal(request.headers.authorization, "Bearer smoke-read-grant");
      response.writeHead(204, { "set-cookie": `smoke_session=${request.method === "DELETE" ? "" : "yes"}; HttpOnly; SameSite=Strict; Path=/state-query` }); response.end(); return;
    }
    if (!request.headers.cookie?.includes("smoke_session=yes")) {
      response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: "query_grant_required", message: "Connect a read grant." } })); return;
    }
    if (url.pathname === "/state-query/catalog") {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ target, grant: { expiresAt: "2099-01-01T00:00:00Z" }, exports })); return;
    }
    if (url.pathname === "/state-query/snapshot") {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(evaluate(JSON.parse(body)))); return;
    }
    response.writeHead(404); response.end();
  } catch (error) { errors.push(error); response.writeHead(500); response.end("Fixture error"); }
});
const sockets = new WebSocketServer({ noServer: true });
sockets.on("connection", (socket) => {
  const stream = {
    socket,
    queries: null,
    sequence: 0,
    subscriptionId: (++socketSerial).toString(16).padStart(32, "0"),
    acknowledgements: []
  };
  socket.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("The fixture accepts text messages only.");
      const text = data.toString();
      if (text === "state-query-ping/v1") {
        socket.send("state-query-pong/v1");
        return;
      }
      const message = JSON.parse(text);
      assert.equal(message.protocol, "state-query-socket/v1");
      if (message.type === "register") {
        assert.equal(stream.queries, null);
        stream.queries = message.queries;
        if (message.subscriptionId) stream.subscriptionId = message.subscriptionId;
        streams.add(stream);
        send(stream, "snapshot", "initial");
        return;
      }
      assert.equal(message.type, "ack");
      stream.acknowledgements.push(message.cursor);
      acknowledgementCount += 1;
    } catch (error) {
      errors.push(error);
      socket.close(1008, "Fixture protocol error");
    }
  });
  socket.on("close", () => streams.delete(stream));
  socket.on("error", (error) => errors.push(error));
});
server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname !== "/state-query/socket" || url.search ||
        !request.headers.cookie?.includes("smoke_session=yes") ||
        request.headers.origin !== origin) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit("connection", webSocket, request);
    });
  } catch (error) {
    errors.push(error);
    socket.destroy();
  }
});
let origin;
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`${origin}/state-query/setup`);
  await page.locator("#credential").fill("smoke-read-grant");
  await page.getByRole("button", { name: "Connect securely" }).click();
  await page.locator("#builder").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Use this preset" }).click();
  await page.locator("#export").selectOption("1");
  await page.getByRole("textbox", { name: "Game", exact: true }).fill("Hades");
  await page.locator("#projection").selectOption('["count"]');
  await page.locator("#field-name").fill("fixed_count");
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.locator("#export").selectOption("0");
  await page.locator("#field-name").fill("game");
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByRole("button", { name: "Preview live query" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#values .value-row").length === 3 && document.getElementById("connection").textContent === "Live");
  assert.equal(streams.size, 1);
  const url = await page.locator("#widget-url").inputValue();
  assert.ok(!url.includes("smoke-read-grant"));
  assert.ok((await page.locator("#snippet").inputValue()).includes("subscription.unsubscribe()"));
  if (process.env.BROWSER_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.BROWSER_SMOKE_SCREENSHOT, fullPage: true });
  await page.getByRole("button", { name: "Stop preview" }).click();
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const widget = await context.newPage(); widget.on("pageerror", (error) => errors.push(error));
  await widget.goto(url);
  await widget.locator("#credential").fill("smoke-read-grant");
  await widget.getByRole("button", { name: "Connect securely" }).click();
  await widget.waitForFunction(() => document.getElementById("connection").textContent === "Live");
  model.counts.Hades = 4; broadcast("value_change");
  await widget.waitForFunction(() => document.querySelector("#values strong").textContent === "4");
  model.game = "Sekiro"; broadcast("dependency_change");
  await widget.waitForFunction(() => document.querySelector("#values strong").textContent === "8");
  model.realm = "linked"; model.counts = { Sekiro: 17, Hades: 5 }; broadcast("source_change");
  await widget.waitForFunction(() => document.querySelector("#values strong").textContent === "17");
  model.game = null; broadcast("dependency_change");
  await widget.waitForFunction(() => document.querySelector("#values strong").textContent.includes("Choose a game"));
  model.game = '<img src=x onerror="window.injected=true">'; model.counts[model.game] = 6; broadcast("dependency_change");
  await widget.waitForFunction(() => document.querySelector("#values span").textContent.startsWith("<img"));
  assert.equal(await widget.locator("#values img").count(), 0);
  assert.equal(await widget.evaluate(() => window.injected), undefined);
  for (const stream of streams) stream.socket.close(1012, "Fixture restart");
  await widget.waitForFunction(() => document.getElementById("connection").textContent.includes("Reconnecting"));
  await widget.waitForFunction(() => document.getElementById("connection").textContent === "Live");
  for (const stream of streams) {
    send(stream, "status", "access_change");
    stream.socket.close(1008, "Grant revoked");
  }
  await widget.waitForFunction(() => document.getElementById("connection").textContent.startsWith("Access ended"));
  assert.equal(await widget.locator("#values .value-row").count(), 0);
  assert.ok(acknowledgementCount > 0);
  assert.deepEqual(errors, []);
  console.log("Chromium smoke passed over WebSockets: custom composition, isolated session, widget count/game/source updates, unselected state, text safety, acknowledgements, reconnect, revocation, and teardown.");
} finally {
  await browser?.close();
  for (const stream of streams) stream.socket.terminate();
  sockets.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
