const CAPABILITY_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;

export const FRAMEWORK_CAPABILITIES = Object.freeze({
  MEMBERS: "framework.members",
  MODERATORS: "framework.moderators",
  MANAGERS: "framework.managers"
});

const registeredCapabilities = new Set([
  ...Object.values(FRAMEWORK_CAPABILITIES),
  "config.manage",
  "integration.announcement.publish",
  "integration.manage",
  "schedule.create",
  "schedule.view",
  "schedule.cancel"
]);

function capability(name) {
  if (
    typeof name !== "string" ||
    name.length > 200 ||
    !CAPABILITY_PATTERN.test(name)
  ) {
    throw new TypeError("Access capability is invalid.");
  }
  return name;
}

export const access = Object.freeze({
  everyone: null,
  members: FRAMEWORK_CAPABILITIES.MEMBERS,
  moderators: FRAMEWORK_CAPABILITIES.MODERATORS,
  managers: FRAMEWORK_CAPABILITIES.MANAGERS,
  capability
});

export function isRegisteredCapability(value) {
  return value === null || registeredCapabilities.has(value);
}
