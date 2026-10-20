// Explicit fault controls around native bindings. Healthy native tests do not
// install this wrapper. It models lost/delayed calls, never platform depth or
// placement. Long boundaries dispatch real handlers at persisted alarm times.
import { env, runInDurableObject } from "cloudflare:test";

export async function installedHealthFaults(f, clock) {
  let interceptor = null;
  const calls = [], dispatches = [];
  const bindings = Object.fromEntries(["CONFIG", "SHAREABLE_STATE_REALM", "DURABLE_EVENT_STREAM", "INTEGRATION_REGISTRY"].map((kind) => [kind, {
    idFromName: (key) => env[kind].idFromName(key),
    get: (id) => ({ fetch: (url, init) => {
      calls.push({ kind, path: new URL(url).pathname });
      const send = () => env[kind].get(id).fetch(url, init);
      return interceptor ? interceptor(kind, url, init, send) : send();
    } })
  }]));
  const faultEnv = { ...env, ...bindings, STATE_EVENT_IMMEDIATE_DELIVERY_ENABLED: "false" };
  const objects = [...new Map(f.nativeObjects.map(([stub, kind]) => [`${kind}:${stub.id}`, [stub, kind]])).values()];
  const install = async () => {
    for (const [stub] of objects) await runInDurableObject(stub, (instance) => { instance.env = faultEnv; });
  };
  await install();
  return {
    calls, dispatches, install,
    intercept(value) { interceptor = value; },
    async restore() {
      for (const [stub] of objects) await runInDurableObject(stub, (instance) => { instance.env = env; });
    },
    async runUntil(targetMs) {
      if (!Number.isSafeInteger(targetMs) || targetMs < Date.now()) throw RangeError("The fault clock cannot move backward");
      for (let pass = 0; pass < 80; pass++) {
        const alarms = await Promise.all(objects.map(async ([stub, kind]) => ({ stub, kind,
          due: await runInDurableObject(stub, (instance, state) => {
            // Reading the alarm can wake an evicted object. Restore fault
            // bindings here so its next handler cannot silently bypass them.
            instance.env = faultEnv; return state.storage.getAlarm();
          }) })));
        const next = alarms.filter((item) => item.due !== null && item.due <= targetMs).sort((a, b) => a.due - b.due)[0];
        if (!next) { clock.mockReturnValue(Math.max(Date.now(), targetMs)); return; }
        clock.mockReturnValue(Math.max(Date.now(), next.due));
        dispatches.push({ kind: next.kind, dueMs: next.due, startedAtMs: Date.now() });
        await runInDurableObject(next.stub, async (instance, state) => {
          instance.env = faultEnv;
          await state.storage.deleteAlarm(); // The synthetic dispatcher consumes it.
          await instance.alarm();
        });
      }
      throw Error("Installed-health alarm budget exceeded; possible idle loop");
    }
  };
}
