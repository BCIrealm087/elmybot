import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { createStateQueryClient } from "../public/state-query/client.js";
import { createStateQueryTools } from "../public/state-query/query.js";
import { stateQueryBrowserResponse } from "../src/state-querying/browser-pages.js";

const tools = createStateQueryTools();
const target = { platform: "twitch", groupId: "channel" };
const clients = [];
afterEach(() => { clients.splice(0).forEach((client) => client.close()); });

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
}

function harness(options = {}) {
  const connections = [];
  const openWebSocket = vi.fn((url) => {
    const socket = new FakeSocket(url);
    connections.push(socket);
    return socket;
  });
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const client = createStateQueryClient({
    baseUrl: "https://example.com",
    fetch,
    openWebSocket,
    retryMs: 5,
    ...options
  });
  clients.push(client);
  return { client, connections, fetch, openWebSocket };
}
function registration(connection) {
  return JSON.parse(connection.sent.find((message) => message !== "state-query-ping/v1"));
}
function result(queryId, sequence, value) {
  return { queryId, sequence, status: "ready", result: { status: "ready", data: { value: { state: "present", value } } } };
}
function frame(eventType, results, {
  sequence = 1,
  cursor = `sq1.1.${"a".repeat(32)}.${sequence}`,
  subscriptionId = "a".repeat(32)
} = {}) {
  return JSON.stringify({
    protocol: "state-query-socket/v1",
    type: "event",
    event: {
      sequence,
      cursor,
      eventType,
      payload: { protocol: "state-query-stream/v1", subscriptionId, results }
    }
  });
}

describe("browser state query client", () => {
  it("shares one socket, acknowledges events, suppresses old results, and detaches listeners", async () => {
    const { client, connections, openWebSocket } = harness();
    const a = vi.fn(), b = vi.fn(), c = vi.fn();
    const first = client.watch(tools.deaths(target), { onResult: a });
    const duplicate = client.watch(tools.deaths(target), { onResult: b });
    client.watch(tools.deaths(target, "Hades"), { onResult: c });
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    await vi.waitFor(() => expect(connections[0].sent).toHaveLength(1));
    const registrations = registration(connections[0]).queries;
    expect(registrations).toHaveLength(2);
    expect(connections[0].url).toBe("wss://example.com/state-query/socket");
    connections[0].serverMessage(frame("snapshot", [
      result(registrations[0].id, 3, "ゲーム 🐈"),
      result(registrations[1].id, 1, 9)
    ]));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));
    expect(a.mock.calls[0][0].result.data.value.value).toBe("ゲーム 🐈");
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connections[0].sent.at(-1))).toMatchObject({
      protocol: "state-query-socket/v1", type: "ack"
    });
    connections[0].serverMessage(frame("update", [result(registrations[0].id, 2, "old")], { sequence: 2 }));
    connections[0].serverMessage(frame("update", [result(registrations[0].id, 4, "new")], { sequence: 3 }));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(2));
    duplicate.unsubscribe();
    expect(openWebSocket).toHaveBeenCalledTimes(1);
    connections[0].serverMessage(frame("update", [result(registrations[0].id, 5, "last")], { sequence: 4 }));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(3));
    expect(b).toHaveBeenCalledTimes(2);
    first.unsubscribe();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    expect(connections[0].readyState).toBe(3);
    await vi.waitFor(() => expect(registration(connections[1]).queries).toHaveLength(1));
    expect(registration(connections[1])).not.toHaveProperty("cursor");
    expect(registration(connections[1])).not.toHaveProperty("subscriptionId");
  });

  it("reconnects with recovery hints and accepts a fresh snapshot with a lower result sequence", async () => {
    const { client, connections } = harness();
    const receive = vi.fn(), status = vi.fn();
    client.watch(tools.deaths(target), { onResult: receive, onStatus: status });
    await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1));
    const id = registration(connections[0]).queries[0].id;
    const recoveredId = "b".repeat(32);
    connections[0].serverMessage(frame("snapshot", [result(id, 12, 12)], {
      cursor: `sq1.1.${recoveredId}.7`, subscriptionId: recoveredId
    }));
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    connections[0].serverClose(1012, "Restart");
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() => expect(connections[1].sent).toHaveLength(1));
    expect(registration(connections[1])).toMatchObject({
      subscriptionId: recoveredId,
      cursor: `sq1.1.${recoveredId}.7`
    });
    connections[1].serverMessage(frame("snapshot", [result(id, 1, 99)], {
      sequence: 8, cursor: `sq1.1.${recoveredId}.8`, subscriptionId: recoveredId
    }));
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    expect(receive.mock.calls[1][0].result.data.value.value).toBe(99);
    expect(status.mock.calls.some(([value]) => value.state === "reconnecting" && value.stale)).toBe(true);
  });

  it("stops on revoked access and does not replay a cached value to new listeners", async () => {
    const { client, connections, openWebSocket } = harness();
    const status = vi.fn();
    client.watch(tools.deaths(target), { onStatus: status });
    await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1));
    const id = registration(connections[0]).queries[0].id;
    connections[0].serverMessage(frame("snapshot", [result(id, 1, 1)]));
    connections[0].serverMessage(frame("status", [{
      queryId: id, status: "denied", error: { code: "query_grant_revoked" }
    }], { sequence: 2 }));
    await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "ended", code: "query_grant_revoked"
    })));
    const receive = vi.fn();
    client.watch(tools.deaths(target), { onResult: receive });
    expect(receive).not.toHaveBeenCalled();
    expect(openWebSocket).toHaveBeenCalledTimes(1);
  });

  it("bounds malformed frames and stops terminal socket errors", async () => {
    const one = harness();
    const status = vi.fn();
    one.client.watch(tools.deaths(target), { onStatus: status });
    await vi.waitFor(() => expect(one.connections[0]?.sent).toHaveLength(1));
    one.connections[0].serverMessage(JSON.stringify({
      protocol: "state-query-socket/v1",
      type: "error",
      error: { code: "query_grant_expired", message: "Grant expired." }
    }));
    one.connections[0].serverClose(1008, "Policy violation");
    await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "ended", code: "query_grant_expired"
    })));
    expect(one.openWebSocket).toHaveBeenCalledTimes(1);

    const two = harness();
    const secondStatus = vi.fn();
    two.client.watch(tools.deaths(target), { onStatus: secondStatus });
    await vi.waitFor(() => expect(two.connections[0]?.sent).toHaveLength(1));
    two.connections[0].serverMessage("x".repeat(301 * 1024));
    await vi.waitFor(() => expect(secondStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "ended", code: "client_frame_limit"
    })));
  });

  it("recovers a silent socket and closes all work when its last listener leaves", async () => {
    const { client, connections } = harness({ heartbeatMs: 10, heartbeatTimeoutMs: 50 });
    const subscription = client.watch(tools.deaths(target));
    await vi.waitFor(() => expect(connections.length).toBeGreaterThanOrEqual(2));
    subscription.unsubscribe();
    await vi.waitFor(() => expect(connections.every(({ readyState }) => readyState === 3)).toBe(true));
  });

  it("requires a complete replacement snapshot before applying updates", async () => {
    const { client, connections } = harness();
    const status = vi.fn(), receive = vi.fn();
    client.watch(tools.deaths(target), { onStatus: status, onResult: receive });
    await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1));
    const id = registration(connections[0]).queries[0].id;
    connections[0].serverMessage(frame("update", [result(id, 1, 4)]));
    await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "ended", code: "client_protocol_error"
    })));
    expect(receive).not.toHaveBeenCalled();
  });

  it("isolates callback exceptions and bounds distinct queries and listeners", async () => {
    const { client, connections } = harness();
    const receive = vi.fn();
    const query = tools.deaths(target);
    client.watch(query, { onResult() { throw new Error("consumer"); } });
    client.watch(query, { onResult: receive });
    for (let index = 0; index < 98; index++) client.watch(query);
    expect(() => client.watch(query)).toThrow("100 listeners");
    for (let index = 0; index < 19; index++) client.watch(tools.deaths(target, String(index)));
    expect(() => client.watch(tools.deaths(target, "overflow"))).toThrow("20 distinct");
    await vi.waitFor(() => expect(connections[0]?.sent).toHaveLength(1));
    connections[0].serverMessage(frame("snapshot",
      registration(connections[0]).queries.map(({ id }) => result(id, 1, 0))));
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
  });

  it("builds composed literal, projected, and dynamic queries with credential-free widget URLs", () => {
    const query = tools.compose(target, [
      { name: "fixed", read: { feature: "fun.deaths", export: "count", version: 1 }, arguments: { game: { literal: "Hades" } }, path: ["count"] },
      { name: "current", read: { feature: "fun.deaths", export: "count", version: 1 }, arguments: { game: { source: { feature: "fun.deaths", export: "remembered_game", version: 1 } } } }
    ]);
    expect(query.select.fixed.path).toEqual(["count"]);
    expect(query.bindings.b3.arguments.game).toEqual({ ref: "b2" });
    expect(() => tools.compose(target, [{ name: "__proto__", read: {} }])).toThrow();
    const url = tools.widgetUrl("https://example.com", query, { credential: "secret", size: 900, color: "url(evil)" });
    expect(url).not.toContain("secret");
    const configuration = JSON.parse(decodeURIComponent(new URL(url).hash.slice(1)));
    expect(configuration.query).toEqual(query);
    expect(configuration.presentation).toEqual({ title: "Deaths", size: 120, color: "#ffffff" });
  });

  it("serves only public browser assets with a restrictive content security policy", async () => {
    for (const path of ["setup", "widget"]) {
      const response = stateQueryBrowserResponse(new Request(`https://example.com/state-query/${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await response.text()).length).toBeGreaterThan(100);
    }
    expect(stateQueryBrowserResponse(new Request("https://example.com/state-query/catalog"))).toBeNull();
    for (const path of ["app.js", "client.js", "query.js", "ui.js", "browser.css"]) {
      const response = await SELF.fetch(`https://elmybot-worker.cutelmy.workers.dev/state-query/${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(path.endsWith("css") ? "text/css" : "javascript");
      expect((await response.text()).length).toBeGreaterThan(100);
    }
  });
});
