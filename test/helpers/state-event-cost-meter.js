// Test-only instrumentation. No telemetry, query wrapping or timers are added
// to the Worker bundle. Cursors execute against the real workerd SQLite engine.
import { env, runInDurableObject } from "cloudflare:test";
import { deliveryFixture } from "./state-event-delivery-fixture.js";
import { createFeatureServiceRuntime } from "../../src/framework/service-runtime.js";
import { createCommandInvocation } from "../../src/integrations/contracts.js";
import { prepareStateEventOperation } from "../../src/framework/state-event-operation.js";
import { drainStateEventRelay } from "../../src/state-events/delivery-source.js";
import { runStorageAlarm } from "../../src/storage-alarm.js";
import { createFeatureRegistry } from "../../src/framework/feature-registry.js";
import { durableEventRouteId } from "../../src/durable-events/contract.js";

const fixtures = [];
let serial = 0;
// SqlStorageCursor counters cover the last statement of a batch. Execute each
// top-level statement synchronously to count the entire batch. Keep trigger
// bodies, CASE expressions, quoted semicolons and comments intact.
function sqlStatements(query) {
  const statements = []; let start = 0, quote = null, lineComment = false, blockComment = false;
  let firstWord = null, trigger = false, depth = 0;
  for (let index = 0; index < query.length; index++) {
    const char = query[index], next = query[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index++; } continue; }
    if (quote) {
      if (char === quote) { if (next === quote) index++; else quote = null; }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; index++; continue; }
    if (char === "/" && next === "*") { blockComment = true; index++; continue; }
    if (["'", '"', "`", "["].includes(char)) { quote = char === "[" ? "]" : char; continue; }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(index))[0].toUpperCase();
      firstWord ??= match;
      if (firstWord === "CREATE" && match === "TRIGGER") trigger = true;
      if (trigger && ["BEGIN", "CASE"].includes(match)) depth++;
      if (trigger && match === "END") depth--;
      index += match.length - 1; continue;
    }
    if (char === ";" && (!trigger || depth === 0)) {
      const statement = query.slice(start, index + 1).trim(); if (statement) statements.push(statement);
      start = index + 1; firstWord = null; trigger = false; depth = 0;
    }
  }
  if (query.slice(start).trim()) statements.push(query.slice(start).trim());
  return statements;
}
export function costMeter() {
  const objects = new Map();
  const sockets = [];
  const background = new Set();
  let active = false, cursors = [], rpc = [], alarms = { reads: 0, writes: 0, deletes: 0, invocations: 0 }, handlers = [], incomingMessages = 0, appends = 0, peakAppends = 0;
  const databaseBytes = async () => (await Promise.all([...objects.values()].map(({ role, id }) =>
    runInDurableObject(env[role].get(id), (_i, state) => state.storage.sql.databaseSize)))).reduce((sum, value) => sum + value, 0);
  return {
    objects,
    async install(stub, role) {
      const key = `${role}:${stub.id}`;
      if (objects.has(key)) return;
      await runInDurableObject(stub, async (instance, state) => {
        let alarm = await state.storage.getAlarm();
        await state.storage.deleteAlarm();
        const sql = new Proxy(state.storage.sql, { get(target, property) {
          if (property === "exec") return (query, ...args) => {
            const statements = sqlStatements(query); let last;
            // Production batches have no bound parameters. Passing bindings to
            // an earlier statement would change semantics, so reject that case.
            if (statements.length > 1 && args.length) throw Error("Meter cannot split a parameterized SQL batch");
            for (let index = 0; index < statements.length; index++) {
              last = target.exec(statements[index], ...args);
              if (active) cursors.push({ role, query: statements[index].replace(/\s+/g, " ").trim(), cursor: last });
              if (index < statements.length - 1) last.toArray();
            }
            return last;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        const storage = new Proxy(state.storage, { get(target, property) {
          if (property === "sql") return sql;
          if (property === "getAlarm") return async () => { if (active) alarms.reads++; return alarm; };
          if (property === "setAlarm") return async (due) => { if (active) alarms.writes++; alarm = Number(due); };
          if (property === "deleteAlarm") return async () => { if (active) alarms.deletes++; alarm = null; };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        const wrapped = new Proxy(state, { get(target, property) {
          if (property === "storage") return storage;
          if (property === "waitUntil") return (task) => {
            const tracked = Promise.resolve(task).finally(() => background.delete(tracked));
            background.add(tracked);
            return target.waitUntil(tracked);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        instance.state = wrapped;
        objects.set(key, { id: stub.id, role, due: () => alarm, clearAlarm: () => { alarm = null; } });
      });
    },
    async request(role, path, send) {
      const started = performance.now();
      if (active) rpc.push({ role, path });
      const append = active && role === "DURABLE_EVENT_STREAM" && path.endsWith("combined/append");
      if (append) { appends++; peakAppends = Math.max(peakAppends, appends); }
      try { return await send(); }
      finally { if (append) appends--; if (active) handlers.push({ role, ms: performance.now() - started }); }
    },
    async handler(stub, role, kind, run) {
      if (kind === "alarm") { objects.get(`${role}:${stub.id}`).clearAlarm(); if (active) alarms.invocations++; }
      if (kind === "ack" && active) incomingMessages++;
      const started = performance.now();
      try { return await run(); }
      finally { if (active) handlers.push({ role, ms: performance.now() - started }); }
    },
    due(stub, role) { return objects.get(`${role}:${stub.id}`).due(); },
    async runUntil(targetMs, clock) {
      for (let count = 0; count < 100; count++) {
        const next = [...objects.values()].filter((item) => item.due() !== null && item.due() <= targetMs).sort((a, b) => a.due() - b.due())[0];
        if (!next) { clock.mockReturnValue(targetMs); return; }
        clock.mockReturnValue(Math.max(Date.now(), next.due()));
        const stub = env[next.role].get(next.id);
        await this.handler(stub, next.role, "alarm", () => runInDurableObject(stub, (instance) => instance.alarm()));
      }
      throw Error("Virtual alarm budget exceeded; possible idle scheduling loop");
    },
    trackSocket(socket) { sockets.push(socket); },
    async settle() {
      // Include finite immediate activation and its completion scheduling in
      // the phase that started it, rather than leaking work into the next one.
      for (let count = 0; background.size && count < 100; count++) await Promise.all([...background]);
      if (background.size) throw Error("Background work did not settle within the measurement budget");
    },
    async phase(run) {
      await this.settle();
      const beforeBytes = await databaseBytes();
      cursors = []; rpc = []; handlers = []; alarms = { reads: 0, writes: 0, deletes: 0, invocations: 0 }; incomingMessages = 0; appends = 0; peakAppends = 0;
      active = true;
      try { await run(); await this.settle(); }
      finally { active = false; }
      const afterBytes = await databaseBytes();
      const byRole = {}, bySubsystem = {}, byQuery = new Map();
      let deleteRowsWritten = 0;
      for (const { role, query, cursor } of cursors) {
        const rows = { read: cursor.rowsRead, written: cursor.rowsWritten };
        const total = byRole[role] ??= { sqlCalls: 0, rowsRead: 0, rowsWritten: 0 };
        total.sqlCalls++; total.rowsRead += rows.read; total.rowsWritten += rows.written;
        const subsystem = /state_query_/.test(query) ? "stateQuery" : /state_event_/.test(query) ? "combined"
          : /durable_event_/.test(query) ? "event" : /framework_feature_|shareable_state_realm_/.test(query) ? "existingState" : "schemaAndOther";
        const group = bySubsystem[subsystem] ??= { rowsRead: 0, rowsWritten: 0 };
        group.rowsRead += rows.read; group.rowsWritten += rows.written;
        if (/^DELETE\b/.test(query)) deleteRowsWritten += rows.written;
        const entry = byQuery.get(query) ?? { query, calls: 0, rowsRead: 0, rowsWritten: 0 };
        entry.calls++; entry.rowsRead += rows.read; entry.rowsWritten += rows.written; byQuery.set(query, entry);
      }
      return {
        sqlCalls: cursors.length, rowsRead: Object.values(byRole).reduce((sum, row) => sum + row.rowsRead, 0),
        rowsWritten: Object.values(byRole).reduce((sum, row) => sum + row.rowsWritten, 0),
        alarms, deleteRowsWritten, incomingMessages, peakAppends, requests: rpc.length, requestPaths: Object.fromEntries([...new Set(rpc.map(({ path }) => path))].map((path) => [path, rpc.filter((row) => row.path === path).length])),
        databaseBytes: afterBytes, databaseBytesDelta: afterBytes - beforeBytes,
        handlerSpanMs: Math.round(handlers.reduce((sum, row) => sum + row.ms, 0) * 100) / 100,
        byRole, bySubsystem, topQueries: [...byQuery.values()].sort((a, b) => b.rowsRead + b.rowsWritten - a.rowsRead - a.rowsWritten).slice(0, 3)
          .map((entry) => ({ ...entry, query: entry.query.slice(0, 240) }))
      };
    },
    async close() {
      for (const socket of sockets) socket.close();
      for (const { role, id } of objects.values()) await runInDurableObject(env[role].get(id), (instance, state) => {
        instance.state = state; return state.storage.deleteAlarm();
      });
      objects.clear();
    }
  };
}

export async function measuredDeliveryFixture(options = {}) {
  const base = await deliveryFixture(options), f = { ...base }, meter = costMeter(); fixtures.push(meter);
  const registry = options.extraFeatures ? createFeatureRegistry([...f.registry.features, ...options.extraFeatures], { availableServices: ["stateEvents", "eventStreams"] }) : f.registry;
  if (options.featureStream) {
    const stream = options.featureStream, descriptor = { ...base.grant().grant.route.descriptor, ...stream };
    const streamRouteId = await durableEventRouteId(descriptor);
    f.route = { ...base.route, namespace: { ...base.route.namespace, featureId: stream.featureId }, streamRouteId };
    f.streamStub = env.DURABLE_EVENT_STREAM.get(env.DURABLE_EVENT_STREAM.idFromName(streamRouteId));
    f.grant = () => {
      const grant = base.grant();
      return { ...grant, grant: { ...grant.grant, stream: { feature: stream.featureId, stream: stream.streamId, version: stream.version },
        route: { ...grant.grant.route, routeId: streamRouteId, descriptor } } };
    };
  }
  let interception = null;
  const testEnv = { ...f.testEnv };
  if (options.immediate) delete testEnv.STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED;
  for (const role of ["CONFIG", "SHAREABLE_STATE_REALM", "DURABLE_EVENT_STREAM", "INTEGRATION_REGISTRY", "STATE_QUERY_OBSERVER"]) {
    const names = f.testEnv[role];
    testEnv[role] = { idFromName: (key) => names.idFromName(key), get: (id) => ({ fetch: async (url, init) => {
      const stub = env[role].get(id);
      await meter.install(stub, role);
      await runInDurableObject(stub, (instance) => { instance.env = testEnv; instance.featureRegistry = registry; instance.registry = registry; });
      return meter.request(role, new URL(url).pathname, () => interception ? interception(role, url, init, () => env[role].get(id).fetch(url, init)) : env[role].get(id).fetch(url, init));
    } }) };
  }
  // Install existing owners before any measured call. Constructor/fixture work
  // is excluded; first-use lazy combined schema work remains included.
  const origin = env.CONFIG.get(env.CONFIG.idFromName(f.group.key));
  for (const [stub, role] of [[origin, "CONFIG"], [f.ownerStub, f.owner.kind === "group_local" ? "CONFIG" : "SHAREABLE_STATE_REALM"],
    [f.streamStub, "DURABLE_EVENT_STREAM"], [f.registryStub, "INTEGRATION_REGISTRY"]]) {
    await meter.install(stub, role);
    await runInDurableObject(stub, (instance) => { instance.env = testEnv; });
  }
  function invocation(index = 0) {
    return createCommandInvocation({ kind: `test.delivery.change${index ? `-${index}` : ""}.v1`, args: {}, sourceCreatedAtMs: Date.now(), sourceEventId: `discord:cost:${++serial}`,
      origin: { group: f.group, actor: { platform: "discord", id: "cost-actor", claims: [] } } });
  }
  const commit = async (input = invocation()) => {
    const service = createFeatureServiceRuntime(testEnv, input, registry).featureServices.stateEvents;
    const operation = registry.actions[input.kind].uses.stateEvents[0];
    const handle = f.owner.kind === "group_local" ? await service.local("test.delivery", operation) : await service.current("test.delivery", "twitch", operation);
    return handle.commitPrepared(() => prepareStateEventOperation(registry.stateEvents[`test.delivery:${operation}`].definition, {}));
  };
  const ownerRole = f.owner.kind === "group_local" ? "CONFIG" : "SHAREABLE_STATE_REALM";
  const drain = (due = true) => meter.handler(f.ownerStub, ownerRole, "alarm", () => runInDurableObject(f.ownerStub, async (instance, state) => {
    if (due) state.storage.sql.exec("UPDATE state_event_outbox SET next_wakeup_at_ms = 0 WHERE lease_token IS NULL AND state <> 'appended'");
    // Include source-handler completion scheduling while keeping independent
    // notification delivery costs in their dedicated measurement profile.
    return runStorageAlarm(instance.state, () => drainStateEventRelay(instance.state, testEnv));
  }));
  const streamCall = async (operation, body = {}) => {
    const response = await testEnv.DURABLE_EVENT_STREAM.get(testEnv.DURABLE_EVENT_STREAM.idFromName(f.route.streamRouteId)).fetch(`https://stream/internal/events/${operation}`, {
      method: "POST", headers: { "x-elmybot-durable-event-internal": "v1", "x-elmybot-state-event-delivery": "v1" }, body: JSON.stringify({ owner: f.owner, routeId: f.route.streamRouteId, ...body }) });
    return { status: response.status, data: await response.json() };
  };
  const streamAlarm = () => meter.handler(f.streamStub, "DURABLE_EVENT_STREAM", "alarm", () => runInDurableObject(f.streamStub, (instance) => instance.alarm()));
  async function connect(route = f.route, grant = f.grant()) {
    const stub = testEnv.DURABLE_EVENT_STREAM.get(testEnv.DURABLE_EVENT_STREAM.idFromName(route.streamRouteId));
    const issued = await stub.fetch("https://stream/internal/events/grants/issue", { method: "POST", headers: { "x-elmybot-durable-event-internal": "v1" }, body: JSON.stringify(grant) });
    if (issued.status !== 201) throw Error(`Grant failed: ${issued.status} ${await issued.text()}`);
    const response = await stub.fetch("https://stream/internal/events/socket", { headers: { "x-elmybot-durable-event-internal": "v1", upgrade: "websocket",
      "x-elmybot-durable-event-grant": grant.grantId, "x-elmybot-durable-event-platform": f.group.platform,
      "x-elmybot-durable-event-group": f.group.id, "x-elmybot-durable-event-route": route.streamRouteId } });
    if (response.status !== 101) throw Error(`Socket failed: ${response.status}`);
    const socket = response.webSocket; socket.accept(); meter.trackSocket(socket);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Consumer registration timed out")), 2000);
      socket.addEventListener("message", ({ data }) => { const frame = JSON.parse(data); if (["ready", "error"].includes(frame.type)) { clearTimeout(timer); resolve(frame); } });
    });
    socket.send(JSON.stringify({ protocol: "durable-event-socket/v1", type: "register" }));
    const frame = await ready;
    if (frame.type !== "ready") throw Error(`Registration failed: ${JSON.stringify(frame)}`);
    return socket;
  }
  const ack = () => meter.handler(f.streamStub, "DURABLE_EVENT_STREAM", "ack", () => runInDurableObject(f.streamStub, (instance, state) => {
    const event = state.storage.sql.exec("SELECT cursor FROM durable_event_stream_events ORDER BY sequence LIMIT 1").one();
    return instance.webSocketMessage(state.getWebSockets()[0], JSON.stringify({ protocol: "durable-event-socket/v1", type: "ack", cursor: event.cursor }));
  }));
  return { ...f, registry, testEnv, meter, origin, ownerRole, invocation, commit, drain, streamCall, connect, ack, streamAlarm, intercept(value) { interception = value; } };
}
export async function closeCostMeters() { for (const meter of fixtures) await meter.close(); fixtures.length = 0; }
