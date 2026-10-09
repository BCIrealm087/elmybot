import { createDurableEventClient } from "/event-stream/client.js";

const STREAM = "fun.health:impacts:v1";
const MAX_HEALTH = 100;
const MAX_RECENT_IDS = 1_000;

const client = createDurableEventClient();
const access = document.querySelector("#access");
const grantInput = document.querySelector("#grant");
const meter = document.querySelector("#meter");
const fill = document.querySelector("#fill");
const value = document.querySelector("#value");
const status = document.querySelector("#status");

let subscription;
let storageKey;

function readSaved() {
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
  return {
    health: Number.isInteger(saved.health) &&
      saved.health >= 0 && saved.health <= MAX_HEALTH
      ? saved.health
      : MAX_HEALTH,
    recentIds: Array.isArray(saved.recentIds)
      ? saved.recentIds.filter((id) => typeof id === "string")
        .slice(-MAX_RECENT_IDS)
      : []
  };
}

function draw(health) {
  fill.style.width = `${health}%`;
  value.textContent = `${health} / ${MAX_HEALTH}`;
  meter.setAttribute("aria-valuenow", String(health));
}

function impact(operation) {
  meter.classList.remove("damage", "heal");
  requestAnimationFrame(() => meter.classList.add(operation));
}

async function handleImpact(event) {
  const { operation, amount } = event.payload ?? {};
  if (
    !["damage", "heal"].includes(operation) ||
    !Number.isInteger(amount) ||
    amount < 1 || amount > 100
  ) {
    throw new Error("Invalid health impact.");
  }

  const saved = readSaved();
  if (saved.recentIds.includes(event.eventId)) {
    draw(saved.health);
    return; // Replay: acknowledge without applying damage twice.
  }

  const change = operation === "damage" ? -amount : amount;
  const health = Math.max(0, Math.min(MAX_HEALTH, saved.health + change));
  const next = {
    health,
    recentIds: [...saved.recentIds, event.eventId].slice(-MAX_RECENT_IDS)
  };

  // Save health and its event ID in one localStorage write before the
  // handler finishes and the client acknowledges the event.
  localStorage.setItem(storageKey, JSON.stringify(next));
  draw(health);
  impact(operation);
}

function onStatus(update) {
  status.textContent = update.state === "live"
    ? "Live"
    : `${update.state}${update.code ? `: ${update.code}` : ""}`;
  if (update.state === "ended") access.hidden = false;
}

async function connect() {
  const catalog = await client.catalog();
  const stream = catalog.streams?.[0];
  const identity = stream &&
    `${stream.feature}:${stream.stream}:v${stream.version}`;

  if (identity !== STREAM) {
    throw new Error(`This widget needs a grant for ${STREAM}.`);
  }

  const { platform, groupId } = catalog.target;
  storageKey = `elmybot.health.v1:${platform}:${groupId}`;
  draw(readSaved().health);
  requestAnimationFrame(() => meter.classList.add("ready"));

  subscription?.unsubscribe();
  access.hidden = true;
  subscription = client.subscribe(handleImpact, { onStatus });
}

access.addEventListener("submit", async (event) => {
  event.preventDefault();
  const credential = grantInput.value.trim();
  grantInput.value = "";

  try {
    subscription?.unsubscribe();
    subscription = null;
    await client.session(credential);
    await connect();
  } catch (error) {
    status.textContent = error.message;
    access.hidden = false;
  }
});

connect().catch((error) => {
  status.textContent = error.message;
  access.hidden = false;
});

window.addEventListener("pagehide", () => {
  subscription?.unsubscribe();
  void client.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});