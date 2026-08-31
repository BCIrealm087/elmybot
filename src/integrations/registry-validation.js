import {
  createPlatformActorRef,
  createPlatformGroupRef,
  IntegrationContractError
} from "./contracts.js";

const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[^\s:]{1,200}$/;
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_INVITATION_ROUTES = 25;
const MAX_ROUTE_DESTINATION_BYTES = 8 * 1024;

export class IntegrationRegistryError extends Error {
  constructor(message, {
    status = 400,
    code = "integration_registry_error"
  } = {}) {
    super(message);
    this.name = "IntegrationRegistryError";
    this.status = status;
    this.code = code;
  }
}

function registryErrorFromContract(error, subject) {
  if (error instanceof IntegrationContractError) {
    throw new IntegrationRegistryError(`${subject} is invalid.`, {
      code: "integration_identity_invalid"
    });
  }
  throw error;
}

export function validatedGroup(value, {
  platform = null,
  kind = null,
  subject = "Integration group"
} = {}) {
  let group;
  try {
    group = createPlatformGroupRef(value);
  } catch (error) {
    registryErrorFromContract(error, subject);
  }
  if (
    (platform !== null && group.platform !== platform) ||
    (kind !== null && group.kind !== kind)
  ) {
    throw new IntegrationRegistryError(`${subject} is invalid.`, {
      code: "integration_identity_invalid"
    });
  }
  return group;
}

export function validatedActor(value, platform, subject = "Integration actor") {
  let actor;
  try {
    actor = createPlatformActorRef(value);
  } catch (error) {
    registryErrorFromContract(error, subject);
  }
  if (actor.platform !== platform) {
    throw new IntegrationRegistryError(`${subject} does not match its group.`, {
      status: 403,
      code: "integration_actor_platform_mismatch"
    });
  }
  return actor;
}

export function validatedOpaqueId(value, subject) {
  if (!isValidOpaqueId(value)) {
    throw new IntegrationRegistryError(`${subject} is invalid.`);
  }
  return value;
}

export function isValidOpaqueId(value) {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

export function validatedRouteKind(value) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !VERSIONED_KIND_PATTERN.test(value)
  ) {
    throw new IntegrationRegistryError("Integration route kind is invalid.");
  }
  return value;
}

export function validatedPlatform(value, subject = "Integration platform") {
  if (typeof value !== "string" || !PLATFORM_PATTERN.test(value)) {
    throw new IntegrationRegistryError(`${subject} is invalid.`, {
      code: "integration_platform_invalid"
    });
  }
  return value;
}

function validatedRoutePlatform(value) {
  return validatedPlatform(value, "Integration route platform");
}

export function validatedRouteDestination(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IntegrationRegistryError("Integration route destination is invalid.");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new IntegrationRegistryError("Integration route destination is invalid.");
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > MAX_ROUTE_DESTINATION_BYTES
  ) {
    throw new IntegrationRegistryError("Integration route destination is invalid.");
  }
  const destination = JSON.parse(serialized);
  if (typeof destination !== "object" || destination === null || Array.isArray(destination)) {
    throw new IntegrationRegistryError("Integration route destination is invalid.");
  }
  return { destination, serialized };
}

export function validatedInvitationRoutes(value) {
  const routes = value ?? [];
  if (!Array.isArray(routes) || routes.length > MAX_INVITATION_ROUTES) {
    throw new IntegrationRegistryError(
      `Integration invitations may contain at most ${MAX_INVITATION_ROUTES} routes.`
    );
  }
  const normalized = routes.map((route) => {
    const kind = validatedRouteKind(route?.kind);
    const sourcePlatform = validatedRoutePlatform(route?.sourcePlatform);
    const targetPlatform = validatedRoutePlatform(route?.targetPlatform);
    if (
      sourcePlatform === targetPlatform ||
      ![sourcePlatform, targetPlatform].includes("twitch") ||
      ![sourcePlatform, targetPlatform].includes("discord") ||
      !kind.startsWith(`${sourcePlatform}.`)
    ) {
      throw new IntegrationRegistryError(
        "This invitation only supports routes between Twitch and Discord."
      );
    }
    const { destination, serialized } = validatedRouteDestination(route?.destination);
    if (targetPlatform === "discord" && (
      typeof destination.channelId !== "string" ||
      !OPAQUE_ID_PATTERN.test(destination.channelId)
    )) {
      throw new IntegrationRegistryError(
        "Discord integration routes require a valid destination channel."
      );
    }
    if (targetPlatform === "twitch" && Object.keys(destination).length !== 0) {
      throw new IntegrationRegistryError(
        "Twitch integration routes do not accept a separate destination."
      );
    }
    return { kind, sourcePlatform, targetPlatform, destination, serialized };
  });
  if (new Set(normalized.map(({ kind }) => kind)).size !== normalized.length) {
    throw new IntegrationRegistryError("Integration invitation route kinds must be unique.");
  }
  return normalized;
}

export function boundedLabel(value) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, 128)
    : null;
}

export function validatedConnectUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationRegistryError("The integration invitation URL is invalid.");
  }
  if (url.protocol !== "https:" || url.pathname !== "/twitch/integrations/connect") {
    throw new IntegrationRegistryError("The integration invitation URL is invalid.");
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

export function randomInvitationToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function invitationTokenHash(token) {
  if (typeof token !== "string" || !INVITATION_TOKEN_PATTERN.test(token)) {
    throw new IntegrationRegistryError("The integration invitation is invalid or expired.", {
      code: "integration_invitation_invalid"
    });
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function parseGroupKey(value) {
  if (typeof value !== "string") {
    throw new IntegrationRegistryError("Integration group key is invalid.");
  }
  const [platform, kind, id, ...extra] = value.split(":");
  if (extra.length > 0) {
    throw new IntegrationRegistryError("Integration group key is invalid.");
  }
  return validatedGroup({ platform, kind, id });
}

export function audit(sql, {
  integrationId = null,
  invitationId = null,
  event,
  actor = null,
  groupKey = null,
  occurredAtMs = Date.now()
}) {
  sql.exec(
    `INSERT INTO integration_audit
      (integration_id, invitation_id, event, actor_platform, actor_id,
       group_key, occurred_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    integrationId,
    invitationId,
    event,
    actor?.platform ?? null,
    actor?.id ?? null,
    groupKey,
    occurredAtMs
  );
}

export function publicMember(row) {
  return {
    group: {
      platform: row.platform,
      kind: row.group_kind,
      id: row.group_id,
      key: row.group_key
    },
    label: row.label ?? null,
    joinedAtMs: row.joined_at_ms
  };
}

export function publicRoute(row) {
  return {
    kind: row.route_kind,
    integration: {
      id: row.integration_id,
      key: `integration:${row.integration_id}`
    },
    sourceGroup: parseGroupKey(row.source_group_key),
    targetGroup: parseGroupKey(row.target_group_key),
    destination: validatedRouteDestination(JSON.parse(row.destination_json)).destination,
    enabled: Boolean(row.enabled),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  };
}

export function publicDefaultLink(row) {
  return {
    sourceGroup: parseGroupKey(row.source_group_key),
    targetPlatform: validatedPlatform(
      row.target_platform,
      "Integration default-link target platform"
    ),
    integration: {
      id: validatedOpaqueId(row.integration_id, "Integration ID"),
      key: `integration:${row.integration_id}`
    },
    targetGroup: parseGroupKey(row.target_group_key),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  };
}
