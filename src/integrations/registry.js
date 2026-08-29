import { jsonResponse, logError } from "../common.js";
import {
  createPlatformActorRef,
  createPlatformGroupRef,
  IntegrationContractError
} from "./contracts.js";

export const INTEGRATION_REGISTRY_NAME = "integration:registry";
export const INTEGRATION_INVITATION_TTL_MS = 15 * 60 * 1000;

const MAX_OAUTH_RESERVATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 25;
const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_ID_PATTERN = /^[^\s:]{1,200}$/;
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_INVITATION_ROUTES = 25;
const MAX_ROUTE_FANOUT = 25;
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

function noStoreJson(value, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function initializeRegistryTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS integration_invitations (
      invitation_id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE,
      discord_group_key TEXT NOT NULL,
      discord_group_id TEXT NOT NULL,
      discord_group_label TEXT,
      discord_actor_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reservation_id TEXT,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      reserved_at_ms INTEGER,
      reservation_expires_at_ms INTEGER,
      completed_at_ms INTEGER,
      completed_integration_id TEXT
    );

    CREATE INDEX IF NOT EXISTS integration_invitations_expiry
      ON integration_invitations(status, expires_at_ms, reservation_expires_at_ms);

    CREATE TABLE IF NOT EXISTS integration_invitation_routes (
      invitation_id TEXT NOT NULL,
      route_kind TEXT NOT NULL,
      source_platform TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      destination_json TEXT NOT NULL,
      PRIMARY KEY (invitation_id, route_kind)
    );

    CREATE TABLE IF NOT EXISTS integrations (
      integration_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      activated_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      revoked_reason TEXT,
      created_by_platform TEXT NOT NULL,
      created_by_actor_id TEXT NOT NULL,
      completed_by_platform TEXT NOT NULL,
      completed_by_actor_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_members (
      integration_id TEXT NOT NULL,
      group_key TEXT NOT NULL,
      platform TEXT NOT NULL,
      group_kind TEXT NOT NULL,
      group_id TEXT NOT NULL,
      label TEXT,
      joined_at_ms INTEGER NOT NULL,
      PRIMARY KEY (integration_id, group_key)
    );

    CREATE INDEX IF NOT EXISTS integration_members_group
      ON integration_members(group_key, integration_id);

    CREATE TABLE IF NOT EXISTS integration_routes (
      integration_id TEXT NOT NULL,
      route_kind TEXT NOT NULL,
      source_group_key TEXT NOT NULL,
      target_group_key TEXT NOT NULL,
      destination_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (integration_id, route_kind)
    );

    CREATE INDEX IF NOT EXISTS integration_routes_source
      ON integration_routes(source_group_key, route_kind, enabled, integration_id);

    CREATE TABLE IF NOT EXISTS integration_audit (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      integration_id TEXT,
      invitation_id TEXT,
      event TEXT NOT NULL,
      actor_platform TEXT,
      actor_id TEXT,
      group_key TEXT,
      occurred_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS integration_audit_integration
      ON integration_audit(integration_id, occurred_at_ms);
  `);
}

function registryErrorFromContract(error, subject) {
  if (error instanceof IntegrationContractError) {
    throw new IntegrationRegistryError(`${subject} is invalid.`, {
      code: "integration_identity_invalid"
    });
  }
  throw error;
}

function validatedGroup(value, {
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

function validatedActor(value, platform, subject = "Integration actor") {
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

function validatedOpaqueId(value, subject) {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new IntegrationRegistryError(`${subject} is invalid.`);
  }
  return value;
}

function validatedRouteKind(value) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !VERSIONED_KIND_PATTERN.test(value)
  ) {
    throw new IntegrationRegistryError("Integration route kind is invalid.");
  }
  return value;
}

function validatedRoutePlatform(value) {
  if (typeof value !== "string" || !PLATFORM_PATTERN.test(value)) {
    throw new IntegrationRegistryError("Integration route platform is invalid.");
  }
  return value;
}

function validatedRouteDestination(value) {
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

function validatedInvitationRoutes(value) {
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

function boundedLabel(value) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, 128)
    : null;
}

function validatedConnectUrl(value) {
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

function randomInvitationToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function invitationTokenHash(token) {
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

function parseGroupKey(value) {
  if (typeof value !== "string") {
    throw new IntegrationRegistryError("Integration group key is invalid.");
  }
  const [platform, kind, id, ...extra] = value.split(":");
  if (extra.length > 0) {
    throw new IntegrationRegistryError("Integration group key is invalid.");
  }
  return validatedGroup({ platform, kind, id });
}

function audit(sql, {
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

function invitationExpiry(row) {
  return row.status === "reserved"
    ? row.reservation_expires_at_ms
    : row.expires_at_ms;
}

function publicMember(row) {
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

export function integrationRegistryStub(env) {
  if (!env.INTEGRATION_REGISTRY) {
    throw new IntegrationRegistryError("The integration registry is not configured.", {
      status: 503,
      code: "integration_registry_not_configured"
    });
  }
  return env.INTEGRATION_REGISTRY.get(
    env.INTEGRATION_REGISTRY.idFromName(INTEGRATION_REGISTRY_NAME)
  );
}

async function checkedRegistryResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw new IntegrationRegistryError(
      result?.error || "The integration registry request failed.",
      {
        status: response.status,
        code: result?.code || "integration_registry_request_failed"
      }
    );
  }
  return result;
}

export async function createIntegrationInvitation(env, input) {
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    "https://integration-registry/invitations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  ));
}

export async function reserveIntegrationInvitation(env, input) {
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    "https://integration-registry/invitations/reserve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  ));
}

export async function completeIntegrationInvitation(env, input) {
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    "https://integration-registry/invitations/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  ));
}

export async function listIntegrationsForGroup(env, group, { limit } = {}) {
  group = validatedGroup(group);
  const url = new URL("https://integration-registry/integrations");
  url.searchParams.set("groupKey", group.key);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(url));
}

export async function getIntegrationById(env, integrationId) {
  integrationId = validatedOpaqueId(integrationId, "Integration ID");
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    `https://integration-registry/integrations/${encodeURIComponent(integrationId)}`
  ));
}

export async function revokeIntegration(env, input) {
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    "https://integration-registry/integrations/revoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  ));
}

export async function revokeIntegrationsForGroup(env, input) {
  if (!env.INTEGRATION_REGISTRY) return { revoked: 0 };
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    "https://integration-registry/groups/revoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  ));
}

export async function resolveIntegrationRoutes(env, input) {
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    "https://integration-registry/routes/resolve",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  ));
}

export class IntegrationRegistry {
  constructor(state) {
    this.state = state;
    initializeRegistryTables(state);
  }

  async armNextExpiration() {
    const rows = this.state.storage.sql.exec(
      `SELECT status, expires_at_ms, reservation_expires_at_ms
       FROM integration_invitations
       WHERE status IN ('pending', 'reserved')`
    ).toArray();
    const nextExpiry = rows.reduce((next, row) => {
      const expiry = invitationExpiry(row);
      if (!Number.isFinite(expiry)) return next;
      return next === null || expiry < next ? expiry : next;
    }, null);
    if (nextExpiry === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(Math.max(Date.now(), nextExpiry));
  }

  async createInvitation(input) {
    const group = validatedGroup(input?.group, {
      platform: "discord",
      kind: "guild",
      subject: "Discord integration group"
    });
    const actor = validatedActor(input?.actor, "discord", "Discord integration actor");
    const connectUrl = validatedConnectUrl(input?.connectUrl);
    const routes = validatedInvitationRoutes(input?.routes);
    const invitationId = crypto.randomUUID();
    const token = randomInvitationToken();
    const tokenHash = await invitationTokenHash(token);
    const nowMs = Date.now();
    const expiresAtMs = nowMs + INTEGRATION_INVITATION_TTL_MS;

    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO integration_invitations
          (invitation_id, token_hash, discord_group_key, discord_group_id,
           discord_group_label, discord_actor_id, status, created_at_ms,
           expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        invitationId,
        tokenHash,
        group.key,
        group.id,
        boundedLabel(input?.groupLabel),
        actor.id,
        nowMs,
        expiresAtMs
      );
      for (const route of routes) {
        this.state.storage.sql.exec(
          `INSERT INTO integration_invitation_routes
            (invitation_id, route_kind, source_platform, target_platform,
             destination_json)
           VALUES (?, ?, ?, ?, ?)`,
          invitationId,
          route.kind,
          route.sourcePlatform,
          route.targetPlatform,
          route.serialized
        );
      }
      audit(this.state.storage.sql, {
        invitationId,
        event: "integration.invitation.created.v1",
        actor,
        groupKey: group.key,
        occurredAtMs: nowMs
      });
    });
    await this.armNextExpiration();

    return {
      invitationId,
      invitationUrl: `${connectUrl}#invite=${token}`,
      expiresAtMs
    };
  }

  async reserveInvitation(input) {
    const tokenHash = await invitationTokenHash(input?.token);
    const reservationId = validatedOpaqueId(input?.reservationId, "OAuth reservation ID");
    const reservationExpiresAtMs = input?.reservationExpiresAtMs;
    const nowMs = Date.now();
    if (
      !Number.isSafeInteger(reservationExpiresAtMs) ||
      reservationExpiresAtMs <= nowMs ||
      reservationExpiresAtMs > nowMs + MAX_OAUTH_RESERVATION_TTL_MS
    ) {
      throw new IntegrationRegistryError("The OAuth reservation expiry is invalid.");
    }

    const reserved = this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql.exec(
        `SELECT invitation_id, status, expires_at_ms
         FROM integration_invitations WHERE token_hash = ?`,
        tokenHash
      ).toArray()[0];
      if (!row || row.status !== "pending" || row.expires_at_ms <= nowMs) {
        throw new IntegrationRegistryError(
          "The integration invitation is invalid, expired, or has already been used.",
          { code: "integration_invitation_invalid" }
        );
      }
      this.state.storage.sql.exec(
        `UPDATE integration_invitations
         SET token_hash = NULL, status = 'reserved', reservation_id = ?,
             reserved_at_ms = ?, reservation_expires_at_ms = ?
         WHERE invitation_id = ?`,
        reservationId,
        nowMs,
        reservationExpiresAtMs,
        row.invitation_id
      );
      audit(this.state.storage.sql, {
        invitationId: row.invitation_id,
        event: "integration.invitation.reserved.v1",
        occurredAtMs: nowMs
      });
      return {
        invitationId: row.invitation_id,
        reservationId,
        expiresAtMs: reservationExpiresAtMs
      };
    });
    await this.armNextExpiration();
    return reserved;
  }

  findExistingIntegration(firstGroupKey, secondGroupKey) {
    return this.state.storage.sql.exec(
      `SELECT i.integration_id
       FROM integrations i
       WHERE i.status = 'active'
         AND EXISTS (
           SELECT 1 FROM integration_members first_member
           WHERE first_member.integration_id = i.integration_id
             AND first_member.group_key = ?
         )
         AND EXISTS (
           SELECT 1 FROM integration_members second_member
           WHERE second_member.integration_id = i.integration_id
             AND second_member.group_key = ?
         )
       ORDER BY i.created_at_ms ASC
       LIMIT 1`,
      firstGroupKey,
      secondGroupKey
    ).toArray()[0]?.integration_id ?? null;
  }

  getIntegration(integrationId) {
    const row = this.state.storage.sql.exec(
      `SELECT integration_id, status, created_at_ms, updated_at_ms,
              activated_at_ms, revoked_at_ms, revoked_reason
       FROM integrations WHERE integration_id = ?`,
      validatedOpaqueId(integrationId, "Integration ID")
    ).toArray()[0];
    if (!row) return null;
    const members = this.state.storage.sql.exec(
      `SELECT group_key, platform, group_kind, group_id, label, joined_at_ms
       FROM integration_members
       WHERE integration_id = ?
       ORDER BY platform ASC, group_key ASC`,
      integrationId
    ).toArray();
    return {
      id: row.integration_id,
      key: `integration:${row.integration_id}`,
      status: row.status,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      activatedAtMs: row.activated_at_ms,
      revokedAtMs: row.revoked_at_ms,
      revokedReason: row.revoked_reason,
      members: members.map(publicMember)
    };
  }

  async completeInvitation(input) {
    const invitationId = validatedOpaqueId(input?.invitationId, "Integration invitation ID");
    const reservationId = validatedOpaqueId(input?.reservationId, "OAuth reservation ID");
    const twitchGroup = validatedGroup(input?.group, {
      platform: "twitch",
      kind: "channel",
      subject: "Twitch integration group"
    });
    const twitchActor = validatedActor(
      input?.actor,
      "twitch",
      "Twitch integration actor"
    );
    if (twitchActor.id !== twitchGroup.id) {
      throw new IntegrationRegistryError(
        "Only the Twitch broadcaster can complete an integration invitation.",
        { status: 403, code: "integration_twitch_broadcaster_required" }
      );
    }
    const nowMs = Date.now();

    const completion = this.state.storage.transactionSync(() => {
      const invitation = this.state.storage.sql.exec(
        `SELECT invitation_id, discord_group_key, discord_group_id,
                discord_group_label, discord_actor_id, status, reservation_id,
                reservation_expires_at_ms, completed_integration_id
         FROM integration_invitations WHERE invitation_id = ?`,
        invitationId
      ).toArray()[0];
      if (
        invitation?.status === "completed" &&
        invitation.reservation_id === reservationId &&
        invitation.completed_integration_id
      ) {
        const matchingMember = this.state.storage.sql.exec(
          `SELECT 1 AS present FROM integration_members
           WHERE integration_id = ? AND group_key = ?`,
          invitation.completed_integration_id,
          twitchGroup.key
        ).toArray()[0];
        if (!matchingMember) {
          throw new IntegrationRegistryError(
            "The integration invitation completion identity does not match.",
            { status: 403, code: "integration_completion_identity_mismatch" }
          );
        }
        return {
          integrationId: invitation.completed_integration_id,
          alreadyLinked: false,
          replayed: true
        };
      }
      if (
        !invitation ||
        invitation.status !== "reserved" ||
        invitation.reservation_id !== reservationId ||
        invitation.reservation_expires_at_ms <= nowMs
      ) {
        throw new IntegrationRegistryError(
          "The integration invitation reservation is invalid or expired.",
          { code: "integration_invitation_reservation_invalid" }
        );
      }

      let integrationId = this.findExistingIntegration(
        invitation.discord_group_key,
        twitchGroup.key
      );
      const alreadyLinked = integrationId !== null;
      if (!integrationId) {
        integrationId = crypto.randomUUID();
        this.state.storage.sql.exec(
          `INSERT INTO integrations
            (integration_id, status, created_at_ms, updated_at_ms,
             activated_at_ms, created_by_platform, created_by_actor_id,
             completed_by_platform, completed_by_actor_id)
           VALUES (?, 'active', ?, ?, ?, 'discord', ?, 'twitch', ?)`,
          integrationId,
          nowMs,
          nowMs,
          nowMs,
          invitation.discord_actor_id,
          twitchActor.id
        );
        this.state.storage.sql.exec(
          `INSERT INTO integration_members
            (integration_id, group_key, platform, group_kind, group_id, label,
             joined_at_ms)
           VALUES (?, ?, 'discord', 'guild', ?, ?, ?)`,
          integrationId,
          invitation.discord_group_key,
          invitation.discord_group_id,
          invitation.discord_group_label,
          nowMs
        );
        this.state.storage.sql.exec(
          `INSERT INTO integration_members
            (integration_id, group_key, platform, group_kind, group_id, label,
             joined_at_ms)
           VALUES (?, ?, 'twitch', 'channel', ?, ?, ?)`,
          integrationId,
          twitchGroup.key,
          twitchGroup.id,
          boundedLabel(input?.groupLabel),
          nowMs
        );
        audit(this.state.storage.sql, {
          integrationId,
          invitationId,
          event: "integration.activated.v1",
          actor: twitchActor,
          groupKey: twitchGroup.key,
          occurredAtMs: nowMs
        });
      }

      const routes = this.state.storage.sql.exec(
        `SELECT route_kind, source_platform, target_platform, destination_json
         FROM integration_invitation_routes
         WHERE invitation_id = ?
         ORDER BY route_kind`,
        invitationId
      ).toArray();
      for (const route of routes) {
        if (
          route.source_platform === route.target_platform ||
          ![route.source_platform, route.target_platform].includes("twitch") ||
          ![route.source_platform, route.target_platform].includes("discord")
        ) {
          throw new IntegrationRegistryError("The invitation route is invalid.");
        }
        const sourceGroupKey = route.source_platform === "twitch"
          ? twitchGroup.key
          : invitation.discord_group_key;
        const targetGroupKey = route.target_platform === "twitch"
          ? twitchGroup.key
          : invitation.discord_group_key;
        this.state.storage.sql.exec(
          `INSERT INTO integration_routes
            (integration_id, route_kind, source_group_key, target_group_key,
             destination_json, enabled, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(integration_id, route_kind) DO UPDATE SET
             source_group_key = excluded.source_group_key,
             target_group_key = excluded.target_group_key,
             destination_json = excluded.destination_json,
             enabled = 1,
             updated_at_ms = excluded.updated_at_ms`,
          integrationId,
          route.route_kind,
          sourceGroupKey,
          targetGroupKey,
          route.destination_json,
          nowMs,
          nowMs
        );
      }

      this.state.storage.sql.exec(
        `UPDATE integration_invitations
         SET status = 'completed', completed_at_ms = ?,
             completed_integration_id = ?
         WHERE invitation_id = ?`,
        nowMs,
        integrationId,
        invitationId
      );
      audit(this.state.storage.sql, {
        integrationId,
        invitationId,
        event: alreadyLinked
          ? "integration.invitation.completed_existing.v1"
          : "integration.invitation.completed.v1",
        actor: twitchActor,
        groupKey: twitchGroup.key,
        occurredAtMs: nowMs
      });
      return { integrationId, alreadyLinked, replayed: false };
    });

    await this.armNextExpiration();
    return {
      integration: this.getIntegration(completion.integrationId),
      alreadyLinked: completion.alreadyLinked,
      replayed: completion.replayed
    };
  }

  listIntegrations(url) {
    const group = parseGroupKey(url.searchParams.get("groupKey"));
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new IntegrationRegistryError(
        `limit must be between 1 and ${MAX_PAGE_SIZE}.`
      );
    }
    const rows = this.state.storage.sql.exec(
      `SELECT i.integration_id
       FROM integrations i
       JOIN integration_members member
         ON member.integration_id = i.integration_id
       WHERE member.group_key = ? AND i.status = 'active'
       ORDER BY i.created_at_ms ASC
       LIMIT ?`,
      group.key,
      limit
    ).toArray();
    const total = this.state.storage.sql.exec(
      `SELECT COUNT(*) AS total
       FROM integrations i
       JOIN integration_members member
         ON member.integration_id = i.integration_id
       WHERE member.group_key = ? AND i.status = 'active'`,
      group.key
    ).toArray()[0].total;
    return {
      total,
      integrations: rows.map((row) => this.getIntegration(row.integration_id))
    };
  }

  resolveRoutes(input) {
    const sourceGroup = validatedGroup(input?.sourceGroup);
    const routeKind = validatedRouteKind(input?.routeKind);
    const rows = this.state.storage.sql.exec(
      `SELECT route.integration_id, route.route_kind, route.source_group_key,
              route.target_group_key, route.destination_json
       FROM integration_routes route
       JOIN integrations integration
         ON integration.integration_id = route.integration_id
       WHERE route.source_group_key = ?
         AND route.route_kind = ?
         AND route.enabled = 1
         AND integration.status = 'active'
       ORDER BY route.integration_id
       LIMIT ?`,
      sourceGroup.key,
      routeKind,
      MAX_ROUTE_FANOUT + 1
    ).toArray();
    if (rows.length > MAX_ROUTE_FANOUT) {
      throw new IntegrationRegistryError(
        `A single event may target at most ${MAX_ROUTE_FANOUT} integration routes.`,
        { status: 409, code: "integration_route_fanout_exceeded" }
      );
    }
    return {
      routes: rows.map((row) => ({
        kind: row.route_kind,
        integration: {
          id: row.integration_id,
          key: `integration:${row.integration_id}`
        },
        sourceGroup: parseGroupKey(row.source_group_key),
        targetGroup: parseGroupKey(row.target_group_key),
        destination: validatedRouteDestination(
          JSON.parse(row.destination_json)
        ).destination
      }))
    };
  }

  revokeIntegration(input) {
    const integrationId = validatedOpaqueId(input?.integrationId, "Integration ID");
    const group = validatedGroup(input?.group);
    const actor = validatedActor(input?.actor, group.platform);
    const reason = typeof input?.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 100)
      : "unlinked";
    const nowMs = Date.now();

    return this.state.storage.transactionSync(() => {
      const integration = this.getIntegration(integrationId);
      if (!integration) {
        throw new IntegrationRegistryError("The integration was not found.", {
          status: 404,
          code: "integration_not_found"
        });
      }
      if (!integration.members.some((member) => member.group.key === group.key)) {
        throw new IntegrationRegistryError(
          "The requesting group does not belong to this integration.",
          { status: 403, code: "integration_group_not_member" }
        );
      }
      if (integration.status !== "active") {
        return { revoked: false, alreadyRevoked: true, integration };
      }
      this.state.storage.sql.exec(
        `UPDATE integrations
         SET status = 'revoked', updated_at_ms = ?, revoked_at_ms = ?,
             revoked_reason = ?
         WHERE integration_id = ?`,
        nowMs,
        nowMs,
        reason,
        integrationId
      );
      audit(this.state.storage.sql, {
        integrationId,
        event: "integration.revoked.v1",
        actor,
        groupKey: group.key,
        occurredAtMs: nowMs
      });
      return {
        revoked: true,
        alreadyRevoked: false,
        integration: this.getIntegration(integrationId)
      };
    });
  }

  revokeForGroup(input) {
    const group = validatedGroup(input?.group);
    const actor = input?.actor === null || input?.actor === undefined
      ? null
      : validatedActor(input.actor, group.platform);
    const reason = typeof input?.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 100)
      : "group_authorization_revoked";
    const nowMs = Date.now();

    return this.state.storage.transactionSync(() => {
      const rows = this.state.storage.sql.exec(
        `SELECT i.integration_id
         FROM integrations i
         JOIN integration_members member
           ON member.integration_id = i.integration_id
         WHERE member.group_key = ? AND i.status = 'active'`,
        group.key
      ).toArray();
      for (const row of rows) {
        this.state.storage.sql.exec(
          `UPDATE integrations
           SET status = 'revoked', updated_at_ms = ?, revoked_at_ms = ?,
               revoked_reason = ?
           WHERE integration_id = ?`,
          nowMs,
          nowMs,
          reason,
          row.integration_id
        );
        audit(this.state.storage.sql, {
          integrationId: row.integration_id,
          event: "integration.revoked.v1",
          actor,
          groupKey: group.key,
          occurredAtMs: nowMs
        });
      }
      return { revoked: rows.length };
    });
  }

  async expireInvitations() {
    const nowMs = Date.now();
    this.state.storage.transactionSync(() => {
      const rows = this.state.storage.sql.exec(
        `SELECT invitation_id, status
         FROM integration_invitations
         WHERE (status = 'pending' AND expires_at_ms <= ?)
            OR (status = 'reserved' AND reservation_expires_at_ms <= ?)`,
        nowMs,
        nowMs
      ).toArray();
      for (const row of rows) {
        this.state.storage.sql.exec(
          `UPDATE integration_invitations
           SET token_hash = NULL, status = 'expired'
           WHERE invitation_id = ?`,
          row.invitation_id
        );
        audit(this.state.storage.sql, {
          invitationId: row.invitation_id,
          event: row.status === "reserved"
            ? "integration.invitation.reservation_expired.v1"
            : "integration.invitation.expired.v1",
          occurredAtMs: nowMs
        });
      }
    });
    await this.armNextExpiration();
  }

  async alarm() {
    await this.expireInvitations();
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/invitations") {
        return noStoreJson(await this.createInvitation(await request.json()), 201);
      }
      if (request.method === "POST" && url.pathname === "/invitations/reserve") {
        return noStoreJson(await this.reserveInvitation(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/invitations/complete") {
        return noStoreJson(await this.completeInvitation(await request.json()), 201);
      }
      if (request.method === "GET" && url.pathname === "/integrations") {
        return noStoreJson(this.listIntegrations(url));
      }
      if (request.method === "POST" && url.pathname === "/routes/resolve") {
        return noStoreJson(this.resolveRoutes(await request.json()));
      }
      if (request.method === "GET" && url.pathname.startsWith("/integrations/")) {
        const integrationId = decodeURIComponent(
          url.pathname.slice("/integrations/".length)
        );
        const integration = this.getIntegration(integrationId);
        if (!integration) {
          throw new IntegrationRegistryError("The integration was not found.", {
            status: 404,
            code: "integration_not_found"
          });
        }
        return noStoreJson({ integration });
      }
      if (request.method === "POST" && url.pathname === "/integrations/revoke") {
        return noStoreJson(this.revokeIntegration(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/groups/revoke") {
        return noStoreJson(this.revokeForGroup(await request.json()));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof IntegrationRegistryError) {
        return noStoreJson({ error: error.message, code: error.code }, error.status);
      }
      logError("integration.registry_failed", {
        platform: "shared",
        correlationId: request.headers.get("x-correlation-id") ?? crypto.randomUUID(),
        groupId: null,
        method: request.method,
        route: url.pathname
      }, error);
      return noStoreJson({ error: "The integration registry failed." }, 500);
    }
  }
}
