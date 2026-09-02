import { jsonResponse, logError } from "../common.js";
import { initializeRegistryTables } from "./registry-schema.js";
import {
  audit,
  boundedLabel,
  IntegrationRegistryError,
  invitationTokenHash,
  isValidOpaqueId,
  parseGroupKey,
  publicDefaultLink,
  publicMember,
  publicRoute,
  randomInvitationToken,
  validatedActor,
  validatedConnectUrl,
  validatedGroup,
  validatedInvitationRoutes,
  validatedOpaqueId,
  validatedPlatform,
  validatedRouteDestination,
  validatedRouteKind
} from "./registry-validation.js";

export {
  activatePendingIntegration,
  cancelPendingIntegration,
  createIntegrationInvitation,
  getIntegrationById,
  getIntegrationDefaultLink,
  getIntegrationManagementStatus,
  INTEGRATION_REGISTRY_NAME,
  integrationRegistryStub,
  listIntegrationAudit,
  listIntegrationsForGroup,
  reserveIntegrationInvitation,
  resumePendingIntegration,
  resolveIntegrationRoutes,
  revokeIntegration,
  revokeIntegrationsForGroup,
  setIntegrationDefaultLink,
  updateIntegrationRoute,
  verifyIntegrationInvitation
} from "./registry-client.js";
export { IntegrationRegistryError } from "./registry-validation.js";

export const INTEGRATION_INVITATION_TTL_MS = 15 * 60 * 1000;
export const INTEGRATION_INVITATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const INTEGRATION_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_OAUTH_RESERVATION_TTL_MS = 15 * 60 * 1000;
const REGISTRY_MAINTENANCE_BATCH_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 25;
const MAX_ROUTE_FANOUT = 25;

function noStoreJson(value, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

export class IntegrationRegistry {
  constructor(state) {
    this.state = state;
    initializeRegistryTables(state);
  }

  async armNextExpiration() {
    const nextMaintenance = this.state.storage.sql.exec(
      `WITH next_maintenance(next_at_ms) AS (VALUES
         ((SELECT MIN(expires_at_ms)
           FROM integration_invitations WHERE status IN ('invited', 'pending'))),
         ((SELECT MIN(reservation_expires_at_ms)
           FROM integration_invitations WHERE status = 'reserved')),
         ((SELECT MIN(COALESCE(
             completed_at_ms,
             reservation_expires_at_ms,
             expires_at_ms
           )) + ?
           FROM integration_invitations
           WHERE status IN ('active', 'completed', 'cancelled', 'expired'))),
         ((SELECT MIN(expires_at_ms)
           FROM integration_pending_links
           WHERE status IN ('twitch_verified', 'awaiting_state_resolution'))),
         ((SELECT MIN(requested_at_ms) FROM integration_group_revocations))
       )
       SELECT MIN(next_at_ms) AS next_at_ms FROM next_maintenance`,
      INTEGRATION_INVITATION_RETENTION_MS
    ).one().next_at_ms;
    if (nextMaintenance === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(Math.max(Date.now(), nextMaintenance));
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
         VALUES (?, ?, ?, ?, ?, ?, 'invited', ?, ?)`,
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
      if (
        !row ||
        !new Set(["invited", "pending"]).has(row.status) ||
        row.expires_at_ms <= nowMs
      ) {
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
      `SELECT first_member.integration_id
       FROM integration_members first_member
       JOIN integration_members second_member
         ON second_member.integration_id = first_member.integration_id
        AND second_member.group_key = ?
       JOIN integrations i
         ON i.integration_id = first_member.integration_id
        AND i.status = 'active'
       WHERE first_member.group_key = ?
       ORDER BY i.created_at_ms ASC
       LIMIT 1`,
      secondGroupKey,
      firstGroupKey
    ).toArray()[0]?.integration_id ?? null;
  }

  integrationsWithMembers(rows) {
    if (rows.length === 0) return [];
    const integrationIds = rows.map((row) => row.integration_id);
    const placeholders = integrationIds.map(() => "?").join(", ");
    const members = this.state.storage.sql.exec(
      `SELECT integration_id, group_key, platform, group_kind, group_id, label,
              joined_at_ms
       FROM integration_members
       WHERE integration_id IN (${placeholders})
       ORDER BY integration_id ASC, platform ASC, group_key ASC`,
      ...integrationIds
    ).toArray();
    const membersByIntegration = new Map();
    for (const member of members) {
      const grouped = membersByIntegration.get(member.integration_id) ?? [];
      grouped.push(publicMember(member));
      membersByIntegration.set(member.integration_id, grouped);
    }
    return rows.map((row) => ({
      id: row.integration_id,
      key: `integration:${row.integration_id}`,
      status: row.status,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      activatedAtMs: row.activated_at_ms,
      revokedAtMs: row.revoked_at_ms,
      revokedReason: row.revoked_reason,
      members: membersByIntegration.get(row.integration_id) ?? []
    }));
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

  requireIntegrationMember(integrationId, group) {
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
    return integration;
  }

  getDefaultLink(sourceGroupInput, targetPlatformInput) {
    const sourceGroup = validatedGroup(sourceGroupInput);
    const targetPlatform = validatedPlatform(
      targetPlatformInput,
      "Integration default-link target platform"
    );
    if (sourceGroup.platform === targetPlatform) {
      throw new IntegrationRegistryError(
        "An integration default link must target another platform.",
        { status: 422, code: "integration_default_platform_invalid" }
      );
    }
    const row = this.state.storage.sql.exec(
      `SELECT default_link.source_group_key, default_link.target_platform,
              default_link.integration_id, default_link.target_group_key,
              default_link.created_at_ms, default_link.updated_at_ms
       FROM integration_default_links default_link
       JOIN integrations integration
         ON integration.integration_id = default_link.integration_id
        AND integration.status = 'active'
       JOIN integration_members source_member
         ON source_member.integration_id = default_link.integration_id
        AND source_member.group_key = default_link.source_group_key
       JOIN integration_members target_member
         ON target_member.integration_id = default_link.integration_id
        AND target_member.group_key = default_link.target_group_key
        AND target_member.platform = default_link.target_platform
       WHERE default_link.source_group_key = ?
         AND default_link.target_platform = ?`,
      sourceGroup.key,
      targetPlatform
    ).toArray()[0];
    return row ? publicDefaultLink(row) : null;
  }

  requireDefaultLinkTarget({
    sourceGroup: sourceGroupInput,
    targetGroup: targetGroupInput,
    integrationId: integrationIdInput
  }) {
    const sourceGroup = validatedGroup(sourceGroupInput);
    const targetGroup = validatedGroup(targetGroupInput);
    const integrationId = validatedOpaqueId(integrationIdInput, "Integration ID");
    if (sourceGroup.platform === targetGroup.platform) {
      throw new IntegrationRegistryError(
        "An integration default link must target another platform.",
        { status: 422, code: "integration_default_platform_invalid" }
      );
    }
    const integration = this.requireIntegrationMember(integrationId, sourceGroup);
    if (integration.status !== "active") {
      throw new IntegrationRegistryError("The integration is not active.", {
        status: 409,
        code: "integration_inactive"
      });
    }
    if (!integration.members.some((member) => member.group.key === targetGroup.key)) {
      throw new IntegrationRegistryError(
        "The default-link target group does not belong to this integration.",
        { status: 422, code: "integration_default_target_not_member" }
      );
    }
    return { sourceGroup, targetGroup, integrationId };
  }

  assignDefaultLinkIfAbsent({
    sourceGroup: sourceGroupInput,
    targetGroup: targetGroupInput,
    integrationId: integrationIdInput,
    nowMs = Date.now()
  }) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new IntegrationRegistryError("Integration default-link time is invalid.", {
        status: 422,
        code: "integration_default_time_invalid"
      });
    }
    const { sourceGroup, targetGroup, integrationId } = this.requireDefaultLinkTarget({
      sourceGroup: sourceGroupInput,
      targetGroup: targetGroupInput,
      integrationId: integrationIdInput
    });
    const existing = this.state.storage.sql.exec(
      `SELECT integration_id
       FROM integration_default_links
       WHERE source_group_key = ? AND target_platform = ?`,
      sourceGroup.key,
      targetGroup.platform
    ).toArray()[0];

    this.state.storage.sql.exec(
      `INSERT INTO integration_default_links
        (source_group_key, target_platform, integration_id, target_group_key,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_group_key, target_platform) DO NOTHING`,
      sourceGroup.key,
      targetGroup.platform,
      integrationId,
      targetGroup.key,
      nowMs,
      nowMs
    );
    if (!existing) {
      audit(this.state.storage.sql, {
        integrationId,
        event: "integration.default.assigned.v1",
        groupKey: sourceGroup.key,
        occurredAtMs: nowMs
      });
    }
    return this.getDefaultLink(sourceGroup, targetGroup.platform);
  }

  setDefaultLink(input) {
    const { sourceGroup, targetGroup, integrationId } = this.requireDefaultLinkTarget({
      sourceGroup: input?.sourceGroup,
      targetGroup: input?.targetGroup,
      integrationId: input?.integrationId
    });
    const actor = validatedActor(
      input?.actor,
      sourceGroup.platform,
      "Integration default-link actor"
    );
    const nowMs = Date.now();

    return this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec(
        `SELECT integration_id, target_group_key
         FROM integration_default_links
         WHERE source_group_key = ? AND target_platform = ?`,
        sourceGroup.key,
        targetGroup.platform
      ).toArray()[0];
      if (
        existing?.integration_id === integrationId &&
        existing.target_group_key === targetGroup.key
      ) {
        return {
          changed: false,
          defaultLink: this.getDefaultLink(sourceGroup, targetGroup.platform)
        };
      }

      this.state.storage.sql.exec(
        `INSERT INTO integration_default_links
          (source_group_key, target_platform, integration_id, target_group_key,
           created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_group_key, target_platform) DO UPDATE SET
           integration_id = excluded.integration_id,
           target_group_key = excluded.target_group_key,
           updated_at_ms = excluded.updated_at_ms`,
        sourceGroup.key,
        targetGroup.platform,
        integrationId,
        targetGroup.key,
        nowMs,
        nowMs
      );
      audit(this.state.storage.sql, {
        integrationId,
        event: "integration.default.updated.v1",
        actor,
        groupKey: sourceGroup.key,
        occurredAtMs: nowMs
      });
      return {
        changed: true,
        defaultLink: this.getDefaultLink(sourceGroup, targetGroup.platform)
      };
    });
  }

  repairDefaultLinksForRevokedIntegration(integrationIdInput, nowMs = Date.now()) {
    const integrationId = validatedOpaqueId(integrationIdInput, "Integration ID");
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new IntegrationRegistryError("Integration default-link time is invalid.", {
        status: 422,
        code: "integration_default_time_invalid"
      });
    }
    const affected = this.state.storage.sql.exec(
      `SELECT source_group_key, target_platform
       FROM integration_default_links
       WHERE integration_id = ?
       ORDER BY source_group_key, target_platform`,
      integrationId
    ).toArray();
    let reassigned = 0;
    let unavailable = 0;

    for (const edge of affected) {
      const fallback = this.state.storage.sql.exec(
        `SELECT integration.integration_id,
                target_member.group_key AS target_group_key
         FROM integrations integration
         JOIN integration_members source_member
           ON source_member.integration_id = integration.integration_id
          AND source_member.group_key = ?
         JOIN integration_members target_member
           ON target_member.integration_id = integration.integration_id
          AND target_member.platform = ?
         WHERE integration.status = 'active'
         ORDER BY integration.created_at_ms, integration.integration_id,
                  target_member.group_key
         LIMIT 1`,
        edge.source_group_key,
        edge.target_platform
      ).toArray()[0];

      if (fallback) {
        this.state.storage.sql.exec(
          `UPDATE integration_default_links
           SET integration_id = ?, target_group_key = ?, updated_at_ms = ?
           WHERE source_group_key = ? AND target_platform = ?
             AND integration_id = ?`,
          fallback.integration_id,
          fallback.target_group_key,
          nowMs,
          edge.source_group_key,
          edge.target_platform,
          integrationId
        );
        audit(this.state.storage.sql, {
          integrationId: fallback.integration_id,
          event: "integration.default.fallback.v1",
          groupKey: edge.source_group_key,
          occurredAtMs: nowMs
        });
        reassigned += 1;
        continue;
      }

      this.state.storage.sql.exec(
        `DELETE FROM integration_default_links
         WHERE source_group_key = ? AND target_platform = ?
           AND integration_id = ?`,
        edge.source_group_key,
        edge.target_platform,
        integrationId
      );
      audit(this.state.storage.sql, {
        integrationId,
        event: "integration.default.unavailable.v1",
        groupKey: edge.source_group_key,
        occurredAtMs: nowMs
      });
      unavailable += 1;
    }
    return { reassigned, unavailable };
  }

  managementStatus(input) {
    const integrationId = validatedOpaqueId(input?.integrationId, "Integration ID");
    const group = validatedGroup(input?.group);
    const integration = this.requireIntegrationMember(integrationId, group);
    const routes = this.state.storage.sql.exec(
      `SELECT integration_id, route_kind, source_group_key, target_group_key,
              destination_json, enabled, created_at_ms, updated_at_ms
       FROM integration_routes
       WHERE integration_id = ?
       ORDER BY route_kind`,
      integrationId
    ).toArray();
    return { integration, routes: routes.map(publicRoute) };
  }

  updateRoute(input) {
    const integrationId = validatedOpaqueId(input?.integrationId, "Integration ID");
    const group = validatedGroup(input?.group);
    const actor = validatedActor(input?.actor, group.platform);
    const routeKind = validatedRouteKind(input?.routeKind);
    if (typeof input?.enabled !== "boolean") {
      throw new IntegrationRegistryError("The route enabled value must be boolean.", {
        status: 422,
        code: "integration_route_enabled_invalid"
      });
    }
    const integration = this.requireIntegrationMember(integrationId, group);
    if (integration.status !== "active") {
      throw new IntegrationRegistryError("The integration is not active.", {
        status: 409,
        code: "integration_inactive"
      });
    }
    const row = this.state.storage.sql.exec(
      `SELECT integration_id, route_kind, source_group_key, target_group_key,
              destination_json, enabled, created_at_ms, updated_at_ms
       FROM integration_routes
       WHERE integration_id = ? AND route_kind = ?`,
      integrationId,
      routeKind
    ).toArray()[0];
    if (!row) {
      throw new IntegrationRegistryError("The integration route was not found.", {
        status: 404,
        code: "integration_route_not_found"
      });
    }

    let destinationJson = row.destination_json;
    if (input.destination !== undefined) {
      const targetGroup = parseGroupKey(row.target_group_key);
      const { destination, serialized } = validatedRouteDestination(input.destination);
      if (targetGroup.platform === "discord" && (
        typeof destination.channelId !== "string" ||
        !isValidOpaqueId(destination.channelId)
      )) {
        throw new IntegrationRegistryError(
          "Discord integration routes require a valid destination channel."
        );
      }
      if (targetGroup.platform === "twitch" && Object.keys(destination).length !== 0) {
        throw new IntegrationRegistryError(
          "Twitch integration routes do not accept a separate destination."
        );
      }
      destinationJson = serialized;
    }

    const nowMs = Date.now();
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE integration_routes
         SET destination_json = ?, enabled = ?, updated_at_ms = ?
         WHERE integration_id = ? AND route_kind = ?`,
        destinationJson,
        input.enabled ? 1 : 0,
        nowMs,
        integrationId,
        routeKind
      );
      this.state.storage.sql.exec(
        "UPDATE integrations SET updated_at_ms = ? WHERE integration_id = ?",
        nowMs,
        integrationId
      );
      audit(this.state.storage.sql, {
        integrationId,
        event: "integration.route.updated.v1",
        actor,
        groupKey: group.key,
        occurredAtMs: nowMs
      });
      const updated = this.state.storage.sql.exec(
        `SELECT integration_id, route_kind, source_group_key, target_group_key,
                destination_json, enabled, created_at_ms, updated_at_ms
         FROM integration_routes
         WHERE integration_id = ? AND route_kind = ?`,
        integrationId,
        routeKind
      ).toArray()[0];
      return { route: publicRoute(updated) };
    });
  }

  listAudit(input) {
    const integrationId = validatedOpaqueId(input?.integrationId, "Integration ID");
    const group = validatedGroup(input?.group);
    this.requireIntegrationMember(integrationId, group);
    const limit = input?.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new IntegrationRegistryError(
        `limit must be between 1 and ${MAX_PAGE_SIZE}.`,
        { status: 422, code: "integration_audit_limit_invalid" }
      );
    }
    const total = this.state.storage.sql.exec(
      "SELECT COUNT(*) AS total FROM integration_audit WHERE integration_id = ?",
      integrationId
    ).one().total;
    const entries = this.state.storage.sql.exec(
      `SELECT audit_id, event, actor_platform, actor_id, group_key, occurred_at_ms
       FROM integration_audit
       WHERE integration_id = ?
       ORDER BY occurred_at_ms DESC, audit_id DESC
       LIMIT ?`,
      integrationId,
      limit
    ).toArray().map((row) => ({
      id: row.audit_id,
      event: row.event,
      actor: row.actor_platform && row.actor_id
        ? { platform: row.actor_platform, id: row.actor_id }
        : null,
      group: row.group_key ? parseGroupKey(row.group_key) : null,
      occurredAtMs: row.occurred_at_ms
    }));
    return { total, entries };
  }

  pendingInvitationByReservation(reservationId) {
    return this.state.storage.sql.exec(
      `SELECT invitation.invitation_id, invitation.discord_group_key,
              invitation.discord_group_id, invitation.discord_group_label,
              invitation.discord_actor_id, invitation.status AS invitation_status,
              invitation.reservation_id, invitation.reservation_expires_at_ms,
              invitation.completed_integration_id,
              pending.integration_id AS pending_integration_id,
              pending.status AS pending_status,
              pending.twitch_group_key, pending.twitch_group_id,
              pending.twitch_group_label, pending.twitch_actor_id,
              pending.verified_at_ms, pending.awaiting_resolution_at_ms,
              pending.expires_at_ms AS pending_expires_at_ms,
              pending.cancelled_at_ms, pending.activated_at_ms
       FROM integration_invitations invitation
       LEFT JOIN integration_pending_links pending
         ON pending.invitation_id = invitation.invitation_id
       WHERE invitation.reservation_id = ?`,
      reservationId
    ).toArray()[0] ?? null;
  }

  publicPendingInvitation(row) {
    const status = row.pending_status ?? (
      row.invitation_status === "reserved"
        ? "twitch_verification_pending"
        : row.invitation_status
    );
    return {
      invitationId: row.invitation_id,
      integrationId: row.completed_integration_id ?? row.pending_integration_id ?? null,
      status: status === "completed" ? "active" : status,
      expiresAtMs: row.pending_expires_at_ms ?? row.reservation_expires_at_ms ?? null,
      discordGroup: parseGroupKey(row.discord_group_key),
      discordLabel: row.discord_group_label ?? null,
      twitchGroup: row.twitch_group_key
        ? parseGroupKey(row.twitch_group_key)
        : null,
      twitchLabel: row.twitch_group_label ?? null,
      verifiedAtMs: row.verified_at_ms ?? null,
      awaitingStateResolutionAtMs: row.awaiting_resolution_at_ms ?? null,
      cancelledAtMs: row.cancelled_at_ms ?? null,
      activatedAtMs: row.activated_at_ms ?? null
    };
  }

  expirePendingRow(row, nowMs) {
    this.state.storage.sql.exec(
      `UPDATE integration_invitations
       SET token_hash = NULL, status = 'expired', completed_at_ms = ?
       WHERE invitation_id = ?`,
      nowMs,
      row.invitation_id
    );
    if (row.pending_status) {
      this.state.storage.sql.exec(
        `UPDATE integration_pending_links SET status = 'expired'
         WHERE invitation_id = ?`,
        row.invitation_id
      );
    }
    audit(this.state.storage.sql, {
      invitationId: row.invitation_id,
      event: "integration.invitation.expired.v1",
      occurredAtMs: nowMs
    });
  }

  async verifyInvitation(input) {
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
        "Only the Twitch broadcaster can verify an integration invitation.",
        { status: 403, code: "integration_twitch_broadcaster_required" }
      );
    }
    const nowMs = Date.now();

    const result = this.state.storage.transactionSync(() => {
      const invitation = this.state.storage.sql.exec(
        `SELECT invitation_id, discord_group_key, discord_group_id,
                discord_group_label, discord_actor_id, status, reservation_id,
                reservation_expires_at_ms, completed_integration_id
         FROM integration_invitations WHERE invitation_id = ?`,
        invitationId
      ).toArray()[0];
      if (
        new Set(["active", "completed"]).has(invitation?.status) &&
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
            "The integration invitation verification identity does not match.",
            { status: 403, code: "integration_completion_identity_mismatch" }
          );
        }
        return {
          status: "active",
          integrationId: invitation.completed_integration_id,
          replayed: true
        };
      }
      const existing = this.pendingInvitationByReservation(reservationId);
      if (existing?.pending_status) {
        if (
          existing.invitation_id !== invitationId ||
          existing.twitch_group_key !== twitchGroup.key ||
          existing.twitch_actor_id !== twitchActor.id
        ) {
          throw new IntegrationRegistryError(
            "The integration invitation verification identity does not match.",
            { status: 403, code: "integration_completion_identity_mismatch" }
          );
        }
        if (
          new Set(["twitch_verified", "awaiting_state_resolution"])
            .has(existing.pending_status) &&
          existing.pending_expires_at_ms <= nowMs
        ) {
          this.expirePendingRow(existing, nowMs);
          return { expired: true };
        }
        if (existing.pending_status === "cancelled") {
          throw new IntegrationRegistryError(
            "The pending integration was cancelled.",
            { status: 409, code: "integration_pending_cancelled" }
          );
        }
        if (existing.pending_status === "expired") return { expired: true };
        return {
          pendingIntegration: this.publicPendingInvitation(existing),
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
      const pendingIntegrationId = crypto.randomUUID();
      const pendingExpiresAtMs = nowMs + INTEGRATION_PENDING_TTL_MS;
      this.state.storage.sql.exec(
        `UPDATE integration_invitations
         SET status = 'twitch_verified'
         WHERE invitation_id = ?`,
        invitationId
      );
      this.state.storage.sql.exec(
        `INSERT INTO integration_pending_links
          (invitation_id, integration_id, reservation_id, status,
           twitch_group_key, twitch_group_id, twitch_group_label,
           twitch_actor_id, verified_at_ms, expires_at_ms)
         VALUES (?, ?, ?, 'twitch_verified', ?, ?, ?, ?, ?, ?)`,
        invitationId,
        pendingIntegrationId,
        reservationId,
        twitchGroup.key,
        twitchGroup.id,
        boundedLabel(input?.groupLabel),
        twitchActor.id,
        nowMs,
        pendingExpiresAtMs
      );
      audit(this.state.storage.sql, {
        integrationId: pendingIntegrationId,
        invitationId,
        event: "integration.invitation.twitch_verified.v1",
        actor: twitchActor,
        groupKey: twitchGroup.key,
        occurredAtMs: nowMs
      });
      this.state.storage.sql.exec(
        `UPDATE integration_invitations
         SET status = 'awaiting_state_resolution'
         WHERE invitation_id = ?`,
        invitationId
      );
      this.state.storage.sql.exec(
        `UPDATE integration_pending_links
         SET status = 'awaiting_state_resolution', awaiting_resolution_at_ms = ?
         WHERE invitation_id = ?`,
        nowMs,
        invitationId
      );
      audit(this.state.storage.sql, {
        integrationId: pendingIntegrationId,
        invitationId,
        event: "integration.invitation.awaiting_state_resolution.v1",
        actor: twitchActor,
        groupKey: twitchGroup.key,
        occurredAtMs: nowMs
      });
      return {
        pendingIntegration: this.publicPendingInvitation(
          this.pendingInvitationByReservation(reservationId)
        ),
        replayed: false
      };
    });

    await this.armNextExpiration();
    if (result.expired) {
      throw new IntegrationRegistryError("The pending integration expired.", {
        status: 410,
        code: "integration_pending_expired"
      });
    }
    if (result.status === "active") {
      return {
        integration: this.getIntegration(result.integrationId),
        pendingIntegration: null,
        replayed: result.replayed
      };
    }
    return result;
  }

  async resumeInvitation(input) {
    const reservationId = validatedOpaqueId(
      input?.reservationId,
      "Integration continuation ID"
    );
    const nowMs = Date.now();
    const result = this.state.storage.transactionSync(() => {
      let row = this.pendingInvitationByReservation(reservationId);
      if (!row) {
        throw new IntegrationRegistryError(
          "The integration continuation is invalid or unavailable.",
          { status: 404, code: "integration_pending_not_found" }
        );
      }
      const expiresAtMs = row.pending_expires_at_ms ?? row.reservation_expires_at_ms;
      if (
        new Set([
          "reserved",
          "twitch_verified",
          "awaiting_state_resolution"
        ]).has(row.pending_status ?? row.invitation_status) &&
        expiresAtMs <= nowMs
      ) {
        this.expirePendingRow(row, nowMs);
        row = this.pendingInvitationByReservation(reservationId);
      }
      return this.publicPendingInvitation(row);
    });
    await this.armNextExpiration();
    return {
      pendingIntegration: result,
      integration: result.status === "active"
        ? this.getIntegration(result.integrationId)
        : null
    };
  }

  async cancelInvitation(input) {
    const reservationId = validatedOpaqueId(
      input?.reservationId,
      "Integration continuation ID"
    );
    const nowMs = Date.now();
    const pendingIntegration = this.state.storage.transactionSync(() => {
      let row = this.pendingInvitationByReservation(reservationId);
      if (!row) {
        throw new IntegrationRegistryError(
          "The integration continuation is invalid or unavailable.",
          { status: 404, code: "integration_pending_not_found" }
        );
      }
      if (new Set(["active", "completed"]).has(row.invitation_status)) {
        throw new IntegrationRegistryError(
          "An active integration cannot be cancelled.",
          { status: 409, code: "integration_pending_already_active" }
        );
      }
      if (new Set(["cancelled", "expired"]).has(row.invitation_status)) {
        return this.publicPendingInvitation(row);
      }
      const expiresAtMs = row.pending_expires_at_ms ?? row.reservation_expires_at_ms;
      if (expiresAtMs <= nowMs) {
        this.expirePendingRow(row, nowMs);
        return this.publicPendingInvitation(
          this.pendingInvitationByReservation(reservationId)
        );
      }
      if (!new Set([
        "reserved",
        "twitch_verified",
        "awaiting_state_resolution"
      ]).has(row.invitation_status)) {
        throw new IntegrationRegistryError(
          "This integration invitation cannot be cancelled.",
          { status: 409, code: "integration_pending_not_cancellable" }
        );
      }
      this.state.storage.sql.exec(
        `UPDATE integration_invitations
         SET status = 'cancelled', completed_at_ms = ?
         WHERE invitation_id = ?`,
        nowMs,
        row.invitation_id
      );
      if (row.pending_status) {
        this.state.storage.sql.exec(
          `UPDATE integration_pending_links
           SET status = 'cancelled', cancelled_at_ms = ?
           WHERE invitation_id = ?`,
          nowMs,
          row.invitation_id
        );
      }
      audit(this.state.storage.sql, {
        integrationId: row.pending_integration_id,
        invitationId: row.invitation_id,
        event: "integration.invitation.cancelled.v1",
        occurredAtMs: nowMs
      });
      return this.publicPendingInvitation(
        this.pendingInvitationByReservation(reservationId)
      );
    });
    await this.armNextExpiration();
    return { pendingIntegration };
  }

  async activateInvitation(input) {
    const invitationId = validatedOpaqueId(
      input?.invitationId,
      "Integration invitation ID"
    );
    const reservationId = validatedOpaqueId(
      input?.reservationId,
      "Integration continuation ID"
    );
    const nowMs = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const row = this.pendingInvitationByReservation(reservationId);
      if (!row || row.invitation_id !== invitationId) {
        throw new IntegrationRegistryError(
          "The pending integration is invalid or unavailable.",
          { status: 404, code: "integration_pending_not_found" }
        );
      }
      if (
        new Set(["active", "completed"]).has(row.invitation_status) &&
        row.completed_integration_id
      ) {
        return {
          integrationId: row.completed_integration_id,
          alreadyLinked: false,
          replayed: true
        };
      }
      if (
        row.pending_status === "expired" ||
        row.pending_expires_at_ms <= nowMs
      ) {
        if (row.pending_status !== "expired") this.expirePendingRow(row, nowMs);
        return { expired: true };
      }
      if (
        row.invitation_status !== "awaiting_state_resolution" ||
        row.pending_status !== "awaiting_state_resolution"
      ) {
        throw new IntegrationRegistryError(
          "The pending integration is not ready for activation.",
          { status: 409, code: "integration_pending_not_ready" }
        );
      }

      let integrationId = this.findExistingIntegration(
        row.discord_group_key,
        row.twitch_group_key
      );
      const alreadyLinked = integrationId !== null;
      if (!integrationId) {
        integrationId = row.pending_integration_id;
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
          row.discord_actor_id,
          row.twitch_actor_id
        );
        this.state.storage.sql.exec(
          `INSERT INTO integration_members
            (integration_id, group_key, platform, group_kind, group_id, label,
             joined_at_ms)
           VALUES (?, ?, 'discord', 'guild', ?, ?, ?)`,
          integrationId,
          row.discord_group_key,
          row.discord_group_id,
          row.discord_group_label,
          nowMs
        );
        this.state.storage.sql.exec(
          `INSERT INTO integration_members
            (integration_id, group_key, platform, group_kind, group_id, label,
             joined_at_ms)
           VALUES (?, ?, 'twitch', 'channel', ?, ?, ?)`,
          integrationId,
          row.twitch_group_key,
          row.twitch_group_id,
          row.twitch_group_label,
          nowMs
        );
        audit(this.state.storage.sql, {
          integrationId,
          invitationId,
          event: "integration.activated.v1",
          actor: { platform: "twitch", id: row.twitch_actor_id },
          groupKey: row.twitch_group_key,
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
          ? row.twitch_group_key
          : row.discord_group_key;
        const targetGroupKey = route.target_platform === "twitch"
          ? row.twitch_group_key
          : row.discord_group_key;
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
         SET status = 'active', completed_at_ms = ?, completed_integration_id = ?
         WHERE invitation_id = ?`,
        nowMs,
        integrationId,
        invitationId
      );
      this.state.storage.sql.exec(
        `UPDATE integration_pending_links
         SET status = 'active', activated_at_ms = ?
         WHERE invitation_id = ?`,
        nowMs,
        invitationId
      );
      audit(this.state.storage.sql, {
        integrationId,
        invitationId,
        event: alreadyLinked
          ? "integration.invitation.activated_existing.v1"
          : "integration.invitation.activated.v1",
        actor: { platform: "twitch", id: row.twitch_actor_id },
        groupKey: row.twitch_group_key,
        occurredAtMs: nowMs
      });
      const discordGroup = parseGroupKey(row.discord_group_key);
      const twitchGroup = parseGroupKey(row.twitch_group_key);
      this.assignDefaultLinkIfAbsent({
        sourceGroup: discordGroup,
        targetGroup: twitchGroup,
        integrationId,
        nowMs
      });
      this.assignDefaultLinkIfAbsent({
        sourceGroup: twitchGroup,
        targetGroup: discordGroup,
        integrationId,
        nowMs
      });
      return { integrationId, alreadyLinked, replayed: false };
    });

    await this.armNextExpiration();
    if (result.expired) {
      throw new IntegrationRegistryError("The pending integration expired.", {
        status: 410,
        code: "integration_pending_expired"
      });
    }
    return {
      integration: this.getIntegration(result.integrationId),
      alreadyLinked: result.alreadyLinked,
      replayed: result.replayed
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
      `SELECT i.integration_id, i.status, i.created_at_ms, i.updated_at_ms,
              i.activated_at_ms, i.revoked_at_ms, i.revoked_reason
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
      integrations: this.integrationsWithMembers(rows)
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
      this.repairDefaultLinksForRevokedIntegration(integrationId, nowMs);
      return {
        revoked: true,
        alreadyRevoked: false,
        integration: this.getIntegration(integrationId)
      };
    });
  }

  processGroupRevocationBatch(groupKey) {
    const job = this.state.storage.sql.exec(
      `SELECT group_key, actor_platform, actor_id, reason
       FROM integration_group_revocations
       WHERE group_key = ?`,
      groupKey
    ).toArray()[0];
    if (!job) return { revoked: 0, pending: false };

    const nowMs = Date.now();
    const rows = this.state.storage.sql.exec(
      `SELECT i.integration_id
       FROM integration_members member
       JOIN integrations i
         ON i.integration_id = member.integration_id
        AND i.status = 'active'
       WHERE member.group_key = ?
       ORDER BY i.created_at_ms ASC
       LIMIT ?`,
      groupKey,
      REGISTRY_MAINTENANCE_BATCH_SIZE
    ).toArray();
    const actor = job.actor_platform && job.actor_id
      ? { platform: job.actor_platform, id: job.actor_id }
      : null;
    for (const row of rows) {
      this.state.storage.sql.exec(
        `UPDATE integrations
         SET status = 'revoked', updated_at_ms = ?, revoked_at_ms = ?,
             revoked_reason = ?
         WHERE integration_id = ? AND status = 'active'`,
        nowMs,
        nowMs,
        job.reason,
        row.integration_id
      );
      audit(this.state.storage.sql, {
        integrationId: row.integration_id,
        event: "integration.revoked.v1",
        actor,
        groupKey,
        occurredAtMs: nowMs
      });
      this.repairDefaultLinksForRevokedIntegration(row.integration_id, nowMs);
    }
    const pending = Boolean(this.state.storage.sql.exec(
      `SELECT 1 AS present
       FROM integration_members member
       JOIN integrations i
         ON i.integration_id = member.integration_id
        AND i.status = 'active'
       WHERE member.group_key = ?
       LIMIT 1`,
      groupKey
    ).toArray()[0]);
    if (!pending) {
      this.state.storage.sql.exec(
        "DELETE FROM integration_group_revocations WHERE group_key = ?",
        groupKey
      );
    }
    return { revoked: rows.length, pending };
  }

  async revokeForGroup(input) {
    const group = validatedGroup(input?.group);
    const actor = input?.actor === null || input?.actor === undefined
      ? null
      : validatedActor(input.actor, group.platform);
    const reason = typeof input?.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 100)
      : "group_authorization_revoked";
    const result = this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO integration_group_revocations
          (group_key, actor_platform, actor_id, reason, requested_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(group_key) DO UPDATE SET
           actor_platform = excluded.actor_platform,
           actor_id = excluded.actor_id,
           reason = excluded.reason`,
        group.key,
        actor?.platform ?? null,
        actor?.id ?? null,
        reason,
        Date.now()
      );
      return this.processGroupRevocationBatch(group.key);
    });
    await this.armNextExpiration();
    return result;
  }

  async expireInvitations() {
    const nowMs = Date.now();
    return this.state.storage.transactionSync(() => {
      const rows = this.state.storage.sql.exec(
        `SELECT invitation_id, status, terminal_at_ms
         FROM (
           SELECT invitation_id, status,
                  CASE status
                    WHEN 'reserved' THEN reservation_expires_at_ms
                    ELSE expires_at_ms
                  END AS terminal_at_ms
           FROM integration_invitations
           WHERE (status IN ('invited', 'pending') AND expires_at_ms <= ?)
              OR (status = 'reserved' AND reservation_expires_at_ms <= ?)
           UNION ALL
           SELECT invitation.invitation_id, pending.status,
                  pending.expires_at_ms AS terminal_at_ms
           FROM integration_pending_links pending
           JOIN integration_invitations invitation
             ON invitation.invitation_id = pending.invitation_id
           WHERE pending.status IN ('twitch_verified', 'awaiting_state_resolution')
             AND pending.expires_at_ms <= ?
         ) expired
         ORDER BY terminal_at_ms ASC, invitation_id ASC
         LIMIT ?`,
        nowMs,
        nowMs,
        nowMs,
        REGISTRY_MAINTENANCE_BATCH_SIZE
      ).toArray();
      for (const row of rows) {
        this.state.storage.sql.exec(
          `UPDATE integration_invitations
           SET token_hash = NULL, status = 'expired', completed_at_ms = ?
           WHERE invitation_id = ?`,
          nowMs,
          row.invitation_id
        );
        this.state.storage.sql.exec(
          `UPDATE integration_pending_links SET status = 'expired'
           WHERE invitation_id = ?`,
          row.invitation_id
        );
        audit(this.state.storage.sql, {
          invitationId: row.invitation_id,
          event: "integration.invitation.expired.v1",
          occurredAtMs: nowMs
        });
      }
      return rows.length;
    });
  }

  pruneTerminalInvitations() {
    const cutoffMs = Date.now() - INTEGRATION_INVITATION_RETENTION_MS;
    return this.state.storage.transactionSync(() => {
      const rows = this.state.storage.sql.exec(
        `SELECT invitation_id
         FROM integration_invitations
         WHERE status IN ('active', 'completed', 'cancelled', 'expired')
           AND COALESCE(completed_at_ms, reservation_expires_at_ms, expires_at_ms) <= ?
         ORDER BY COALESCE(
           completed_at_ms,
           reservation_expires_at_ms,
           expires_at_ms
         ) ASC
         LIMIT ?`,
        cutoffMs,
        REGISTRY_MAINTENANCE_BATCH_SIZE
      ).toArray();
      if (rows.length === 0) return 0;
      const invitationIds = rows.map((row) => row.invitation_id);
      const placeholders = invitationIds.map(() => "?").join(", ");
      this.state.storage.sql.exec(
        `DELETE FROM integration_pending_links
         WHERE invitation_id IN (${placeholders})`,
        ...invitationIds
      );
      this.state.storage.sql.exec(
        `DELETE FROM integration_invitation_routes
         WHERE invitation_id IN (${placeholders})`,
        ...invitationIds
      );
      this.state.storage.sql.exec(
        `DELETE FROM integration_invitations
         WHERE invitation_id IN (${placeholders})`,
        ...invitationIds
      );
      return invitationIds.length;
    });
  }

  processNextGroupRevocation() {
    return this.state.storage.transactionSync(() => {
      const job = this.state.storage.sql.exec(
        `SELECT group_key
         FROM integration_group_revocations
         ORDER BY requested_at_ms ASC, group_key ASC
         LIMIT 1`
      ).toArray()[0];
      return job
        ? this.processGroupRevocationBatch(job.group_key)
        : { revoked: 0, pending: false };
    });
  }

  async alarm() {
    await this.expireInvitations();
    this.pruneTerminalInvitations();
    this.processNextGroupRevocation();
    await this.armNextExpiration();
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
      if (request.method === "POST" && url.pathname === "/invitations/verify-twitch") {
        return noStoreJson(await this.verifyInvitation(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/invitations/resume") {
        return noStoreJson(await this.resumeInvitation(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/invitations/cancel") {
        return noStoreJson(await this.cancelInvitation(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/invitations/activate") {
        return noStoreJson(await this.activateInvitation(await request.json()), 201);
      }
      if (request.method === "GET" && url.pathname === "/integrations") {
        return noStoreJson(this.listIntegrations(url));
      }
      if (request.method === "POST" && url.pathname === "/integrations/status") {
        return noStoreJson(this.managementStatus(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/default-links/get") {
        const input = await request.json();
        return noStoreJson({
          defaultLink: this.getDefaultLink(input?.sourceGroup, input?.targetPlatform)
        });
      }
      if (request.method === "POST" && url.pathname === "/default-links/set") {
        return noStoreJson(this.setDefaultLink(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/routes/resolve") {
        return noStoreJson(this.resolveRoutes(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/routes/update") {
        return noStoreJson(this.updateRoute(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/audit") {
        return noStoreJson(this.listAudit(await request.json()));
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
        return noStoreJson(await this.revokeForGroup(await request.json()));
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
