import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const EVENT_ACTION_TYPE = "feature-event-action";
const SCHEDULED_ACTION_TYPE = "feature-scheduled-action";
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const PLATFORMS = new Set(["discord", "twitch"]);
const SCHEDULE_TIMINGS = new Set(["timestamp", "daily", "bounded-random"]);

function requireKind(value, name) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !VERSIONED_KIND_PATTERN.test(value)
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

export function defineEventAction({ eventKind, actionKind, mapPayload, ...unknown }) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported event action field: \`${unknownFields[0]}\`.`);
  }
  requireKind(eventKind, "Event action eventKind");
  requireKind(actionKind, "Event action actionKind");
  if (typeof mapPayload !== "function") {
    throw new TypeError("Event action mapPayload must be a function.");
  }
  return markFrameworkDefinition({ eventKind, actionKind, mapPayload }, EVENT_ACTION_TYPE);
}

export function isEventActionDefinition(value) {
  return isFrameworkDefinition(value, EVENT_ACTION_TYPE);
}

export function defineScheduledAction({
  kind,
  sourcePlatform,
  actionKind,
  timing,
  authorization,
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported scheduled action field: \`${unknownFields[0]}\`.`);
  }
  requireKind(kind, "Scheduled action kind");
  requireKind(actionKind, "Scheduled action actionKind");
  if (!PLATFORMS.has(sourcePlatform) || !kind.startsWith(`${sourcePlatform}.`)) {
    throw new TypeError("Scheduled action sourcePlatform is invalid.");
  }
  if (!SCHEDULE_TIMINGS.has(timing)) {
    throw new TypeError("Scheduled action timing is invalid.");
  }
  if (authorization !== "grant-at-creation") {
    throw new TypeError("Scheduled action authorization is invalid.");
  }
  return markFrameworkDefinition({
    kind,
    sourcePlatform,
    actionKind,
    timing,
    authorization
  }, SCHEDULED_ACTION_TYPE);
}

export function isScheduledActionDefinition(value) {
  return isFrameworkDefinition(value, SCHEDULED_ACTION_TYPE);
}
