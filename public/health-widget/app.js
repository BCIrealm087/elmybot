import { createDurableEventClient } from "/event-stream/client.js";
import { createStateQueryClient } from "/state-query/client.js";
import { watchStateEvents } from "/event-stream/state-event.js";
import { createHealthEffectQueue } from "./effects.js";

const STREAM = "fun.health:impacts:v2";
// Temporary operator diagnostics are opt-in and never include values or grants.
const diagnostics = new URL(location.href).searchParams.get("diagnostics") === "1";
let traceWindow = 0, traceCount = 0;
function trace(record) {
  if (!diagnostics) return;
  const atMs = Date.now();
  if (atMs - traceWindow >= 60_000) { traceWindow = atMs; traceCount = 0; }
  if (traceCount++ >= 200) return;
  console.log(JSON.stringify({ event: "health.trace", ...record, atMs }));
}
const events = createDurableEventClient({ onDiagnostic: diagnostics ? trace : undefined }), state = createStateQueryClient();
const access = document.querySelector("#access"), grantInput = document.querySelector("#grant"), readGrantInput = document.querySelector("#read-grant");
const meter = document.querySelector("#meter"), fill = document.querySelector("#fill"), value = document.querySelector("#value"), status = document.querySelector("#status");
let subscription, initialized = false;
const effects = createHealthEffectQueue({ animate: impact, onDiagnostic: trace });
function draw(cell) {
  trace({ stage: "snapshot.receive", scopeToken: cell.stateEvent?.scopeToken,
    sequence: cell.stateEvent?.operationSequence, stateRevision: cell.stateEvent?.stateRevision });
  if (cell.state !== "present" || !Number.isInteger(cell.value) || cell.value < 0 || cell.value > 100) throw Error("Invalid authoritative health snapshot.");
  initialized = true; meter.hidden = false; status.textContent = "Live";
  fill.style.width = `${cell.value}%`; value.textContent = `${cell.value} / 100`;
  meter.setAttribute("aria-valuenow", String(cell.value));
  requestAnimationFrame(() => meter.classList.add("ready"));
}
function impact(effect) {
  // Cosmetic transforms never set health or overwrite a newer snapshot.
  const damage = effect.operation === "damage";
  return meter.animate(damage ? [
    { transform: "translateX(0)" }, { transform: "translateX(-7px)", boxShadow: "0 0 25px #ff4242" }, { transform: "translateX(5px)" }, { transform: "translateX(0)" }
  ] : [{ boxShadow: "0 4px 15px #0009" }, { boxShadow: "0 0 28px #76ff9a" }, { boxShadow: "0 4px 15px #0009" }], { duration: damage ? 450 : 550, easing: "ease-out" });
}
function onStatus(update) {
  if (update.state !== "live") effects.clear(update.state);
  status.textContent = update.state === "live" ? initialized ? "Live" : "Synchronizing health…"
    : `${update.state}${update.code ? `: ${update.code}` : ""}`;
  if (update.state === "ended") access.hidden = false;
}
async function connect() {
  subscription?.unsubscribe(); subscription = null; effects.clear("connect"); initialized = false; meter.hidden = true; value.textContent = "— / 100";
  const catalog = await events.catalog(), stream = catalog.streams?.[0];
  const identity = stream && `${stream.feature}:${stream.stream}:v${stream.version}`;
  if (identity === "fun.health:impacts:v1") throw Error("This is a legacy v1 event grant. Use the legacy backlog view below, or issue a v2 event grant and a current-health read grant.");
  if (identity !== STREAM) throw Error(`This widget needs an event grant for ${STREAM}.`);
  const readable = await state.catalog();
  if (readable.target?.platform !== catalog.target.platform || readable.target?.groupId !== catalog.target.groupId) throw Error("The read and event grants must target the same group.");
  const query = { version: 1, target: catalog.target, bindings: { current: { read: { feature: "fun.health", export: "current", version: 1 } } }, select: { health: { ref: "current" } } };
  access.hidden = true;
  subscription = watchStateEvents({ stateClient: state, eventClient: events, query, selection: "health",
    storageKey: `elmybot.health.impact-ids.v2:${catalog.target.platform}:${catalog.target.groupId}`,
    onSnapshot: draw, onEvent: effects.accept, onStatus });
}
access.addEventListener("submit", async (event) => {
  event.preventDefault();
  const eventGrant = grantInput.value.trim(), readGrant = readGrantInput.value.trim(); grantInput.value = ""; readGrantInput.value = "";
  try {
    subscription?.unsubscribe(); subscription = null; effects.clear("credentials");
    await state.session(readGrant); await events.session(eventGrant); await connect();
  } catch (error) { status.textContent = error.message; access.hidden = false; }
});
connect().catch((error) => { status.textContent = error.message; access.hidden = false; });
document.addEventListener("visibilitychange", effects.visibilityChanged);
window.addEventListener("pagehide", () => { subscription?.unsubscribe(); effects.close(); void events.close(); void state.close(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) location.reload(); });
