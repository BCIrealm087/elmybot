import { afterEach, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { createStateQueryClient } from "../public/state-query/client.js";
import { createStateQueryTools } from "../public/state-query/query.js";
import { stateQueryBrowserResponse } from "../src/state-querying/browser-pages.js";

const tools = createStateQueryTools();
const target = { platform: "twitch", groupId: "channel" };
const clients = [];
afterEach(() => { clients.splice(0).forEach((client) => client.close()); });

function harness(options = {}) {
  const connections = [];
  const fetch = vi.fn(async (_url, init) => {
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    init.signal.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } });
    connections.push({ controller, init });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  });
  const client = createStateQueryClient({ baseUrl: "https://example.com", fetch, retryMs: 5, ...options });
  clients.push(client);
  return { client, connections, fetch };
}
function result(queryId, sequence, value) {
  return { queryId, sequence, status: "ready", result: { status: "ready", data: { value: { state: "present", value } } } };
}
function frame(event, results, id = "cursor-1") {
  return `id: ${id}\r\nevent: ${event}\r\ndata: ${JSON.stringify({ protocol: "state-query-stream/v1", results })}\r\n\r\n`;
}
function send(connection, text) { connection.controller.enqueue(new TextEncoder().encode(text)); }

describe("browser state query client", () => {
  it("shares a stream, parses split UTF-8/CRLF, suppresses old results, and detaches listeners", async () => {
    const { client, connections, fetch } = harness();
    const a = vi.fn(), b = vi.fn(), c = vi.fn();
    const first = client.watch(tools.deaths(target), { onResult: a });
    const duplicate = client.watch(tools.deaths(target), { onResult: b });
    client.watch(tools.deaths(target, "Hades"), { onResult: c });
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    const registrations = JSON.parse(connections[0].init.body).queries;
    expect(registrations).toHaveLength(2);
    const text = frame("snapshot", [result(registrations[0].id, 3, "ゲーム 🐈"), result(registrations[1].id, 1, 9)]);
    const bytes = new TextEncoder().encode(text);
    for (let index = 0; index < bytes.length; index += 3) connections[0].controller.enqueue(bytes.slice(index, index + 3));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(1));
    expect(a.mock.calls[0][0].result.data.value.value).toBe("ゲーム 🐈");
    expect(b).toHaveBeenCalledTimes(1); expect(c).toHaveBeenCalledTimes(1);
    send(connections[0], frame("update", [result(registrations[0].id, 2, "old")]));
    send(connections[0], frame("update", [result(registrations[0].id, 4, "new")]));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(2));
    duplicate.unsubscribe();
    expect(fetch).toHaveBeenCalledTimes(1);
    send(connections[0], frame("update", [result(registrations[0].id, 5, "last")]));
    await vi.waitFor(() => expect(a).toHaveBeenCalledTimes(3));
    expect(b).toHaveBeenCalledTimes(2);
    first.unsubscribe();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    expect(connections[0].init.signal.aborted).toBe(true);
    expect(JSON.parse(connections[1].init.body).queries).toHaveLength(1);
  });

  it("reconnects with the cursor and accepts a fresh snapshot with a lower result sequence", async () => {
    const { client, connections } = harness();
    const receive = vi.fn(), status = vi.fn();
    client.watch(tools.deaths(target), { onResult: receive, onStatus: status });
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    const id = JSON.parse(connections[0].init.body).queries[0].id;
    send(connections[0], frame("snapshot", [result(id, 12, 12)], "old-cursor"));
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    connections[0].controller.close();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    expect(connections[1].init.headers["Last-Event-ID"]).toBe("old-cursor");
    send(connections[1], frame("snapshot", [result(id, 1, 99)], "new-cursor"));
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    expect(receive.mock.calls[1][0].result.data.value.value).toBe(99);
    expect(status.mock.calls.some(([value]) => value.state === "reconnecting" && value.stale)).toBe(true);
  });

  it("stops on revoked access and does not replay a cached value to new listeners", async () => {
    const { client, connections, fetch } = harness();
    const status = vi.fn();
    client.watch(tools.deaths(target), { onStatus: status });
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    const id = JSON.parse(connections[0].init.body).queries[0].id;
    send(connections[0], frame("snapshot", [result(id, 1, 1)]));
    send(connections[0], frame("status", [{ queryId: id, status: "denied", error: { code: "query_grant_revoked" } }]));
    await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ended", code: "query_grant_revoked" })));
    const receive = vi.fn(); client.watch(tools.deaths(target), { onResult: receive });
    expect(receive).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds malformed frames and stops unauthorized HTTP retry loops", async () => {
    const unauthorized = vi.fn(async () => new Response(JSON.stringify({ error: { code: "query_grant_expired" } }), { status: 401 }));
    const one = harness({ fetch: unauthorized });
    const status = vi.fn(); one.client.watch(tools.deaths(target), { onStatus: status });
    await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ended", code: "query_grant_expired" })));
    expect(unauthorized).toHaveBeenCalledTimes(1);
    const two = harness(); const secondStatus = vi.fn();
    two.client.watch(tools.deaths(target), { onStatus: secondStatus });
    await vi.waitFor(() => expect(two.connections).toHaveLength(1));
    send(two.connections[0], "data: " + "x".repeat(301 * 1024));
    await vi.waitFor(() => expect(secondStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: "ended", code: "client_frame_limit" })));
  });

  it("recovers a silent stream and aborts all work when its last listener leaves", async () => {
    const { client, connections } = harness({ heartbeatTimeoutMs: 50 });
    const subscription = client.watch(tools.deaths(target));
    await vi.waitFor(() => expect(connections.length).toBeGreaterThanOrEqual(2));
    subscription.unsubscribe();
    await vi.waitFor(() => expect(connections.every(({ init }) => init.signal.aborted)).toBe(true));
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
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    send(connections[0], frame("snapshot", JSON.parse(connections[0].init.body).queries.map(({ id }) => result(id, 1, 0))));
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
