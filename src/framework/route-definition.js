import {
  isFrameworkDefinition,
  markFrameworkDefinition
} from "./definition-brand.js";

const ROUTE_TYPE = "feature-route";
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const PLATFORMS = new Set(["discord", "twitch"]);
const DESTINATIONS = new Set(["none", "link-channel"]);
const ENABLEMENT = new Set(["enabled", "disabled"]);

export function defineRoute({
  kind,
  sourcePlatform,
  targetPlatform,
  destination,
  newIntegration = "enabled",
  existingIntegration = "disabled",
  ...unknown
}) {
  const unknownFields = Object.keys(unknown);
  if (unknownFields.length > 0) {
    throw new TypeError(`Unsupported route field: \`${unknownFields[0]}\`.`);
  }
  if (
    typeof kind !== "string" ||
    kind.length > 200 ||
    !VERSIONED_KIND_PATTERN.test(kind)
  ) {
    throw new TypeError("Route kind is invalid.");
  }
  if (!PLATFORMS.has(sourcePlatform) || !PLATFORMS.has(targetPlatform)) {
    throw new TypeError("Route platforms are invalid.");
  }
  if (sourcePlatform === targetPlatform) {
    throw new TypeError("Route platforms must be different.");
  }
  if (!kind.startsWith(`${sourcePlatform}.`)) {
    throw new TypeError("Route kind must be namespaced to its source platform.");
  }
  if (!DESTINATIONS.has(destination)) {
    throw new TypeError("Route destination is invalid.");
  }
  if (!ENABLEMENT.has(newIntegration) || existingIntegration !== "disabled") {
    throw new TypeError("Route enablement policy is invalid.");
  }

  return markFrameworkDefinition({
    kind,
    sourcePlatform,
    targetPlatform,
    destination,
    newIntegration,
    existingIntegration
  }, ROUTE_TYPE);
}

export function isRouteDefinition(value) {
  return isFrameworkDefinition(value, ROUTE_TYPE);
}
