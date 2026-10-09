// Chromium UI smoke against a deterministic durable-event HTTP/WebSocket fixture.
// Stream persistence and grant lifecycle are separately exercised by Miniflare.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { durableEventBrowserResponse } from "../src/durable-events/browser-pages.js";

const target = { platform: "discord", groupId: "123456789" };
const stream = {
  feature: "widget.data",
  stream: "updates",
  version: 1,
  label: "Widget updates",
  description: "Every accepted widget update.",
  platforms: ["discord", "twitch"],
  scope: { kind: "effective_shareable" },
  access: { kind: "operator_grant" },
  payload: { schema: { type: "object" } }
};
const delivery = {
  kind: "bounded_at_least_once",
  retentionSeconds: 1_800,
  maxRetainedEvents: 1_000,
  maxRetainedBytes: 1_048_576
};
const streams = new Set();
const errors = [];
let sequence = 0;
let acknowledgementCount = 0;

async function waitUntil(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function sendEvent(connection, payload) {
  sequence += 1;
  const character = sequence % 2 ? "a" : "b";
  connection.socket.send(JSON.stringify({
    protocol: "durable-event-socket/v1",
    type: "event",
    stream: { feature: stream.feature, stream: stream.stream, version: stream.version },
    eventId: `dev1.${character.repeat(43)}`,
    sequence,
    cursor: `dec1.${character.repeat(43)}`,
    acceptedAt: "2026-09-27T00:00:00.000Z",
    expiresAt: "2026-09-27T00:30:00.000Z",
    payload
  }));
}

let origin;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    const page = durableEventBrowserResponse(new Request(url));
    if (page) {
      response.writeHead(page.status, Object.fromEntries(page.headers));
      response.end(await page.text());
      return;
    }
    if (["app.js", "client.js", "ui.js", "browser.css"].some(
      (name) => url.pathname === `/event-stream/${name}`
    )) {
      response.writeHead(200, {
        "content-type": url.pathname.endsWith("css") ? "text/css" : "text/javascript",
        "cache-control": "no-store"
      });
      response.end(await readFile(new URL(`../public${url.pathname}`, import.meta.url)));
      return;
    }
    if (url.pathname === "/event-stream/session") {
      if (request.method === "POST") {
        assert.equal(request.headers.authorization, "Bearer smoke-event-grant");
      }
      response.writeHead(204, {
        "set-cookie": `event_session=${request.method === "DELETE" ? "" : "yes"}; ` +
          "HttpOnly; SameSite=Strict; Path=/event-stream"
      });
      response.end();
      return;
    }
    if (!request.headers.cookie?.includes("event_session=yes")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { code: "durable_event_access_denied", message: "Connect an event grant." }
      }));
      return;
    }
    if (url.pathname === "/event-stream/catalog") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: 1,
        target,
        grant: { id: "grant", expiresAt: "2099-01-01T00:00:00.000Z" },
        streams: [stream]
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    errors.push(error);
    response.writeHead(500);
    response.end("Fixture error");
  }
});

const sockets = new WebSocketServer({ noServer: true });
sockets.on("connection", (socket) => {
  const connection = { socket, registered: false };
  socket.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("The fixture accepts text messages only.");
      const text = data.toString();
      if (text === "durable-event-ping/v1") {
        socket.send("durable-event-pong/v1");
        return;
      }
      const message = JSON.parse(text);
      assert.equal(message.protocol, "durable-event-socket/v1");
      if (message.type === "register") {
        assert.equal(connection.registered, false);
        assert.deepEqual(Object.keys(message).sort(), ["protocol", "type"]);
        connection.registered = true;
        streams.add(connection);
        socket.send(JSON.stringify({
          protocol: "durable-event-socket/v1",
          type: "ready",
          stream: { feature: stream.feature, stream: stream.stream, version: stream.version },
          delivery
        }));
        return;
      }
      assert.equal(message.type, "ack");
      assert.match(message.cursor, /^dec1\.[A-Za-z0-9_-]{43}$/);
      acknowledgementCount += 1;
    } catch (error) {
      errors.push(error);
      socket.close(1008, "Fixture protocol error");
    }
  });
  socket.on("close", () => streams.delete(connection));
  socket.on("error", (error) => errors.push(error));
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname !== "/event-stream/socket" || url.search ||
        !request.headers.cookie?.includes("event_session=yes") ||
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

let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`${origin}/event-stream/setup`);
  await page.locator("#credential").fill("smoke-event-grant");
  await page.getByRole("button", { name: "Connect securely" }).click();
  await page.locator("#details").waitFor({ state: "visible" });
  assert.equal(await page.locator("#stream").textContent(), "widget.data:updates:v1");
  const widgetUrl = await page.locator("#widget-url").inputValue();
  assert.ok(!widgetUrl.includes("smoke-event-grant"));
  assert.ok((await page.locator("#snippet").inputValue()).includes("recent.handle(event"));
  await page.getByRole("button", { name: "Start live test" }).click();
  await page.waitForFunction(() => document.getElementById("connection").textContent.startsWith("Live"));
  assert.equal(streams.size, 1);
  sendEvent([...streams][0], {
    data: '<img src=x onerror="window.injected=true">',
    origin: "twitch"
  });
  await page.waitForFunction(() => document.getElementById("payload").textContent.includes("<img"));
  assert.equal(await page.locator("#payload img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await waitUntil(() => acknowledgementCount === 1, "Setup preview did not acknowledge.");
  await page.getByRole("button", { name: "Stop test" }).click();
  await waitUntil(() => streams.size === 0, "Setup preview did not disconnect.");

  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const widget = await context.newPage();
  widget.on("pageerror", (error) => errors.push(error));
  await widget.goto(widgetUrl);
  await widget.locator("#credential").fill("smoke-event-grant");
  await widget.getByRole("button", { name: "Connect securely" }).click();
  await widget.waitForFunction(() => document.getElementById("connection").textContent.startsWith("Live"));
  sendEvent([...streams][0], { data: "play-intro", origin: "discord" });
  await widget.waitForFunction(() => document.getElementById("payload").textContent.includes("play-intro"));
  await widget.waitForFunction(() => document.getElementById("event-count").textContent === "1 event handled");
  await waitUntil(() => acknowledgementCount === 2, "OBS widget did not acknowledge.");

  for (const connection of [...streams]) connection.socket.close(1012, "Fixture restart");
  await widget.waitForFunction(() => document.getElementById("connection").textContent.includes("Reconnecting"));
  await widget.waitForFunction(() => document.getElementById("connection").textContent.startsWith("Live"));
  for (const connection of [...streams]) {
    connection.socket.send(JSON.stringify({
      protocol: "durable-event-socket/v1",
      type: "status",
      code: "grant_revoked",
      terminal: true
    }));
    connection.socket.close(1008, "Grant revoked");
  }
  await widget.waitForFunction(() => document.getElementById("connection").textContent.startsWith("Delivery ended"));
  assert.deepEqual(errors, []);
  console.log("Durable-event Chromium smoke passed: isolated session, credential-free OBS URL, safe payload rendering, async acknowledgement, reconnect, terminal revocation, and teardown.");
} finally {
  await browser?.close();
  for (const connection of streams) connection.socket.terminate();
  sockets.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
