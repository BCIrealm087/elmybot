import {
  ANNOUNCEMENT_ACTION_KIND,
  ANNOUNCEMENT_CAPABILITY
} from "../features/announcements/feature.js";

export const INTEGRATION_ACTION_KINDS = Object.freeze({
  PUBLISH_ANNOUNCEMENT: ANNOUNCEMENT_ACTION_KIND
});

export const INTEGRATION_ACTION_CAPABILITIES = Object.freeze({
  PUBLISH_ANNOUNCEMENT: ANNOUNCEMENT_CAPABILITY
});

// Compatibility surface for imports that predate feature-owned actions.
export const integrationActions = Object.freeze({});
