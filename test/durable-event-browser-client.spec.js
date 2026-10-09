import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import {
  createDurableEventClient,
  createRecentEventIdDeduplicator
} from "../public/event-stream/client.js";
import { durableEventBrowserResponse } from "../src/durable-events/browser-pages.js";

const clients = [];
const stream = { feature: "widget.data", stream: "updates", version: 1 };
const delivery = {
  kind: "bounded_at_least_once",
  retentionSeconds: 1_800,
  maxRetainedEvents: 1_000,
  maxRetainedBytes: 1_048_576
};
const eventId = (character) => `dev1.${character.repeat(43)}`;
const cursor = (character) => `dec1.${character.repeat(43)}`;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatch("open", {});
    });
  }
  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options.once === true });
    this.listeners.set(type, listeners);
  }
  dispatch(type, event) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter(({ once }) => !once));
    for (const { listener } of listeners) listener(event);
  }
  send(value) { this.sent.push(value); }
  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.dispatch("close", { code, reason });
  }
  serverMessage(value) { this.dispatch("message", { data: value }); }
  serverClose(code = 1012, reason = "") { this.close(code, reason); }
  serverError() { this.dispatch("error", {}); }
}

function harness(options = {}) {
  const connections = [];
  const openWebSocket = vi.fn((url) => {
    const socket = new FakeSocket(url);
    connections.push(socket);
    return socket;
  });
  const fetch = vi.fn(async (url, _init) => {
    if (new URL(url).pathname === "/event-stream/catalog") {
      return Response.json({ target: { platform: "discord", groupId: "1" }, streams: [stream] });
    }
    return new Response(null, { status: 204 });
  });
  const client = createDurableEventClient({
    baseUrl: "https://example.com",
    fetch,
    openWebSocket,
    retryMs: 5,
    heartbeatMs: 10_000,
    heartbeatTimeoutMs: 20_000,
    ...options
  });
  clients.push(client);
  return { client, connections, fetch, openWebSocket };
}

function ready(socket) {
  socket.serverMessage(JSON.stringify({
    protocol: "durable-event-socket/v1",
    type: "ready",
    stream,
    delivery
  }));
}

function event(character = "a", sequence = 1, payload = { data: "play-intro" }) {
  return JSON.stringify({
    protocol: "durable-event-socket/v1",
    type: "event",
    stream,
    eventId: eventId(character),
    sequence,
    cursor: cursor(character),
    acceptedAt: "2026-09-27T00:00:00.000Z",
    expiresAt: "2026-09-27T00:30:00.000Z",
    payload
  });
}

describe("durable-event browser client", () => {
  it("registers without URL credentials and acknowledges only after async handling", async () => {
    const { client, connections } = harness();
    let finish;
    const handled = new Promise((resolve) => { finish = resolve; });
    const handler = vi.fn(() => handled);
    client.subscribe(handler);
    await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1));
    expect(connections[0].url).toBe("wss://example.com/event-stream/socket");
    expect(JSON.parse(connections[0].sent[0])).toEqual({
      protocol: "durable-event-socket/v1",
      type: "register"
    });
    ready(connections[0]);
    connections[0].serverMessage(event());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(connections[0].sent).toHaveLength(1);
    finish();
    await vi.waitFor(() => expect(connections[0].sent).toHaveLength(2));
    expect(JSON.parse(connections[0].sent[1])).toEqual({
      protocol: "durable-event-socket/v1",
      type: "ack",
      cursor: cursor("a")
    });
    expect(handler.mock.calls[0][0]).toMatchObject({
      eventId: eventId("a"),
      sequence: 1,
      payload: { data: "play-intro" }
    });
  });

  it("leaves a rejected event unacknowledged and handles its replay after reconnect", async () => {
    const { client, connections } = harness();
    const statuses = [];
    let attempts = 0;
    const handler = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("animation failed");
    });
    client.subscribe(handler, { onStatus: (status) => statuses.push(status) });
    await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1));
    ready(connections[0]);
    connections[0].serverMessage(event());
    await vi.waitFor(() => expect(statuses.some(({ state }) => state === "handler_failed")).toBe(true));
    expect(connections[0].sent).toHaveLength(1);
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() => expect(connections[1].sent).toHaveLength(1));
    ready(connections[1]);
    connections[1].serverMessage(event());
    await vi.waitFor(() => expect(connections[1].sent).toHaveLength(2));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(JSON.parse(connections[1].sent[1]).cursor).toBe(cursor("a"));
  });

  it("reconnects after offline errors and stops on every terminal stream status", async () => {
    const reconnecting = harness();
    const statuses = [];
    reconnecting.client.subscribe(vi.fn(), { onStatus: (status) => statuses.push(status) });
    await vi.waitFor(() => expect(reconnecting.connections).toHaveLength(1));
    reconnecting.connections[0].serverError();
    await vi.waitFor(() => expect(reconnecting.connections).toHaveLength(2));
    expect(statuses.some(({ state }) => state === "reconnecting")).toBe(true);

    for (const code of [
      "grant_expired",
      "grant_revoked",
      "grant_replaced",
      "consumer_replaced",
      "stream_moved",
      "retention_gap",
      "service_disabled",
      "internal_error"
    ]) {
      const fixture = harness();
      const terminal = vi.fn();
      fixture.client.subscribe(vi.fn(), { onStatus: terminal });
      await vi.waitFor(() => expect(fixture.connections[0]?.sent).toHaveLength(1));
      ready(fixture.connections[0]);
      fixture.connections[0].serverMessage(JSON.stringify({
        protocol: "durable-event-socket/v1",
        type: "status",
        code,
        terminal: true
      }));
      await vi.waitFor(() => expect(terminal).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "ended", code })
      ));
      expect(fixture.openWebSocket).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects malformed and oversized server frames without acknowledging them", async () => {
    const malformed = harness();
    const malformedStatus = vi.fn();
    malformed.client.subscribe(vi.fn(), { onStatus: malformedStatus });
    await vi.waitFor(() => expect(malformed.connections[0]?.sent).toHaveLength(1));
    ready(malformed.connections[0]);
    malformed.connections[0].serverMessage(event("a", 1, undefined).replace(
      '"payload":{"data":"play-intro"}',
      '"missing":true'
    ));
    await vi.waitFor(() => expect(malformedStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "ended", code: "client_protocol_error" })
    ));
    expect(malformed.connections[0].sent).toHaveLength(1);

    const oversized = harness();
    const oversizedStatus = vi.fn();
    oversized.client.subscribe(vi.fn(), { onStatus: oversizedStatus });
    await vi.waitFor(() => expect(oversized.connections[0]?.sent).toHaveLength(1));
    oversized.connections[0].serverMessage("x".repeat(8_193));
    await vi.waitFor(() => expect(oversizedStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "ended", code: "client_frame_limit" })
    ));
  });

  it("keeps a bounded payload-free recent-ID list and skips duplicate handlers", async () => {
    const data = new Map();
    const storage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value)
    };
    const recent = createRecentEventIdDeduplicator({ storage, maxEntries: 2 });
    const handler = vi.fn();
    await expect(recent.handle({ eventId: eventId("a"), payload: "secret" }, handler))
      .resolves.toEqual({ duplicate: false });
    await expect(recent.handle({ eventId: eventId("a"), payload: "changed" }, handler))
      .resolves.toEqual({ duplicate: true });
    recent.remember(eventId("b"));
    recent.remember(eventId("c"));
    expect(recent.values()).toEqual([eventId("b"), eventId("c")]);
    expect(data.get("elmybot.durable-event.recent.v1")).not.toContain("secret");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("uses only the event session and serves separate hardened setup assets", async () => {
    const { client, fetch } = harness();
    await client.session("event-grant");
    await client.catalog();
    await client.logout();
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/event-stream/session",
      "/event-stream/catalog",
      "/event-stream/session"
    ]);
    expect(fetch.mock.calls[0][1].headers.authorization).toBe("Bearer event-grant");

    for (const path of ["setup", "widget"]) {
      const response = durableEventBrowserResponse(
        new Request(`https://example.com/event-stream/${path}`)
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.text()).not.toContain("state-query/app.js");
    }
    for (const path of ["app.js", "client.js", "ui.js", "browser.css"]) {
      const response = await SELF.fetch(
        `https://elmybot-worker.cutelmy.workers.dev/event-stream/${path}`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        path.endsWith("css") ? "text/css" : "javascript"
      );
      expect((await response.text()).length).toBeGreaterThan(100);
    }
  });
});
