import { jsonResponse, logError } from "../common.js";
import { alarmDrainTimeRemaining } from "../alarm-drain.js";
import {
  advanceStateQueryBinding,
  drainStateQueryBindingNotifications,
  prepareStateQueryBindingMutation,
  pruneStateQueryBindingNotifications,
  registerStateQueryBindingWatcher,
  unregisterStateQueryBindingWatcher
} from "../state-querying/binding-notifications.js";
import { StateQueryNotificationError } from "../state-querying/source-notifications.js";
import {
  advanceDurableEventBindings,
  drainDurableEventBindingNotifications,
  DurableEventBindingError,
  prepareDurableEventBindingMutation,
  pruneDurableEventBindingNotifications
} from "../durable-events/binding-notifications.js";
import { appendWithDurableEventBindingAuthority } from "../durable-events/binding-authority.js";
import { DurableEventError } from "../durable-events/contract.js";
import { initializeRegistryTables } from "./registry-schema.js";
import {
  cloneShareableStateSnapshot,
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  freezeShareableStateNamespace,
  initializeEmptyShareableStateNamespace,
  inventoryShareableStateNamespaces,
  releaseShareableStateNamespaceSeal,
  sealShareableStateNamespace,
  shareableStateRealmObjectName,
  shareableStateSnapshotsEqual,
  snapshotShareableStateNamespace,
  ShareableStateRealmError
} from "../shareable-state/index.js";
import {
  discoverIntegrationShareableState,
  IntegrationStateDiscoveryError
} from "./state-discovery.js";
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
  getStateQueryBinding,
  INTEGRATION_REGISTRY_NAME,
  integrationRegistryStub,
  listIntegrationAudit,
  listIntegrationsForGroup,
  reserveIntegrationInvitation,
  registerStateQueryBindingWatcher,
  resolvePendingIntegrationState,
  resolveEffectiveShareableStateRealm,
  resumePendingIntegration,
  resolveIntegrationRoutes,
  revokeIntegration,
  revokeIntegrationsForGroup,
  setIntegrationDefaultLink,
  unregisterStateQueryBindingWatcher,
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
const MAX_PENDING_STATE_SELECTIONS = 500;
const PENDING_STATE_SELECTIONS = new Set(["discord", "twitch", "reset"]);
const FINALIZATION_SEAL_LEASE_MS = 60 * 1000;
const REGISTRY_REVOCATION_RETRY_MS = 5 * 1000;
const BINDING_LIFECYCLE_MUTATION_PATHS = new Set([
  "/invitations/activate",
  "/default-links/set",
  "/shareable-state/resolve",
  "/integrations/revoke",
  "/groups/revoke"
]);

function noStoreJson(value, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function validatedDiscoveryVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new IntegrationRegistryError(
      "The shareable-state discovery version is invalid.",
      { code: "integration_state_resolution_invalid" }
    );
  }
  return value;
}

function validatedStateSelections(value) {
  if (!Array.isArray(value) || value.length > MAX_PENDING_STATE_SELECTIONS) {
    throw new IntegrationRegistryError(
      "The shareable-state resolution choices are invalid.",
      { code: "integration_state_resolution_invalid" }
    );
  }
  return value.map((selection) => {
    if (
      typeof selection?.featureId !== "string" ||
      selection.featureId.length < 1 ||
      selection.featureId.length > 200 ||
      typeof selection?.namespaceId !== "string" ||
      selection.namespaceId.length < 1 ||
      selection.namespaceId.length > 200 ||
      !PENDING_STATE_SELECTIONS.has(selection?.selection)
    ) {
      throw new IntegrationRegistryError(
        "The shareable-state resolution choices are invalid.",
        { code: "integration_state_resolution_invalid" }
      );
    }
    return {
      featureId: selection.featureId,
      namespaceId: selection.namespaceId,
      selection: selection.selection
    };
  });
}

export class IntegrationRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.integrationRevocations = new Map();
    this.groupRevocations = new Map();
    this.durableEventAppendTail = Promise.resolve();
    initializeRegistryTables(state);
    state.blockConcurrencyWhile(async () => {
      await this.armNextExpiration();
    });
  }

  async armNextExpiration() {
    const nowMs = Date.now();
    pruneStateQueryBindingNotifications(this.state.storage.sql, nowMs);
    pruneDurableEventBindingNotifications(this.state.storage.sql, nowMs);
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
         ((SELECT MIN(requested_at_ms) + ?
           FROM integration_group_revocations)),
         ((SELECT MIN(requested_at_ms) + ?
           FROM integration_revocation_jobs)),
         ((SELECT MIN(next_attempt_at_ms)
           FROM state_query_binding_outbox)),
         ((SELECT MIN(lease_expires_at_ms)
           FROM state_query_binding_watchers)),
         ((SELECT MIN(next_attempt_at_ms)
           FROM durable_event_binding_outbox)),
         ((SELECT MIN(expires_at_ms)
           FROM durable_event_binding_watchers))
       )
       SELECT MIN(next_at_ms) AS next_at_ms FROM next_maintenance`,
      INTEGRATION_INVITATION_RETENTION_MS,
      REGISTRY_REVOCATION_RETRY_MS,
      REGISTRY_REVOCATION_RETRY_MS
    ).one().next_at_ms;
    if (nextMaintenance === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(Math.max(nowMs, nextMaintenance));
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
      shareableStateGeneration: row.shareable_state_generation ?? 1,
      members: membersByIntegration.get(row.integration_id) ?? []
    }));
  }

  getIntegration(integrationId) {
    const row = this.state.storage.sql.exec(
      `SELECT integration_id, status, created_at_ms, updated_at_ms,
              activated_at_ms, revoked_at_ms, revoked_reason,
              shareable_state_generation
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
      shareableStateGeneration: row.shareable_state_generation ?? 1,
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
              default_link.created_at_ms, default_link.updated_at_ms,
              integration.shareable_state_generation
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

  stateQueryBinding(sourceGroupInput, targetPlatformInput) {
    const sourceGroup = validatedGroup(sourceGroupInput);
    const targetPlatform = validatedPlatform(
      targetPlatformInput,
      "State-query binding target platform"
    );
    if (sourceGroup.platform === targetPlatform) {
      throw new IntegrationRegistryError(
        "A state-query binding must target another platform.",
        { status: 422, code: "integration_default_platform_invalid" }
      );
    }
    const recorded = this.state.storage.sql.exec(
      `SELECT binding_revision, binding_status, source_key, reason
       FROM state_query_binding_revisions
       WHERE source_group_key = ? AND target_platform = ?`,
      sourceGroup.key,
      targetPlatform
    ).toArray()[0];
    let status;
    let sourceKey;
    let defaultReason;
    const transition = this.defaultLinkTransition(sourceGroup, targetPlatform);
    if (transition && transition !== "active") {
      status = "transitioning";
      sourceKey = null;
      defaultReason = "transition_started";
    } else {
      const defaultLink = this.getDefaultLink(sourceGroup, targetPlatform);
      if (defaultLink) {
        status = "ready";
        sourceKey = shareableStateRealmObjectName(createIntegrationRealmIdentity(
          defaultLink.integration,
          { generation: defaultLink.integration.shareableStateGeneration ?? 1 }
        ));
        defaultReason = "integration_selected";
      } else {
        const successor = this.state.storage.sql.exec(
          `SELECT generation, status FROM shareable_state_standalone_successors
           WHERE group_key = ?`,
          sourceGroup.key
        ).toArray()[0];
        if (successor && successor.status !== "ready") {
          status = successor.status === "pending" ? "transitioning" : "unavailable";
          sourceKey = null;
          defaultReason = successor.status === "pending"
            ? "successor_pending"
            : "successor_unavailable";
        } else {
          status = "ready";
          sourceKey = shareableStateRealmObjectName(createStandaloneRealmIdentity(
            sourceGroup,
            { generation: successor?.generation ?? 1 }
          ));
          defaultReason = successor ? "successor_ready" : "initial";
        }
      }
    }
    const recordedMatches = recorded &&
      recorded.binding_status === status &&
      (recorded.source_key ?? null) === sourceKey;
    return {
      revision: Number(recorded?.binding_revision ?? 0),
      status,
      sourceKey,
      reason: recordedMatches ? recorded.reason : defaultReason
    };
  }

  advanceStateQueryBinding(input) {
    const revision = advanceStateQueryBinding(this.state, input);
    advanceDurableEventBindings(this.state, input, revision);
    return revision;
  }

  async appendDurableEvent(input) {
    const previous = this.durableEventAppendTail;
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.durableEventAppendTail = previous.then(() => current);
    await previous;
    try {
      return await appendWithDurableEventBindingAuthority(this, input);
    } finally {
      release();
    }
  }

  registerStateQueryBindingWatcher(input) {
    const binding = this.stateQueryBinding(input?.sourceGroup, input?.targetPlatform);
    return registerStateQueryBindingWatcher(this.state, this.env, input, binding);
  }

  unregisterStateQueryBindingWatcher(input) {
    return unregisterStateQueryBindingWatcher(this.state, this.env, input);
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
      const integration = this.getIntegration(integrationId);
      this.advanceStateQueryBinding({
        sourceGroup,
        targetPlatform: targetGroup.platform,
        status: "ready",
        sourceKey: shareableStateRealmObjectName(createIntegrationRealmIdentity(
          integration,
          { generation: integration.shareableStateGeneration ?? 1 }
        )),
        reason: "integration_activated",
        nowMs
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
      const integration = this.getIntegration(integrationId);
      this.advanceStateQueryBinding({
        sourceGroup,
        targetPlatform: targetGroup.platform,
        status: "ready",
        sourceKey: shareableStateRealmObjectName(createIntegrationRealmIdentity(
          integration,
          { generation: integration.shareableStateGeneration ?? 1 }
        )),
        reason: "default_changed",
        nowMs
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
    const unavailableEdges = [];

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
        const fallbackIntegration = this.getIntegration(fallback.integration_id);
        this.advanceStateQueryBinding({
          sourceGroup: parseGroupKey(edge.source_group_key),
          targetPlatform: edge.target_platform,
          status: "ready",
          sourceKey: shareableStateRealmObjectName(createIntegrationRealmIdentity(
            fallbackIntegration,
            { generation: fallbackIntegration.shareableStateGeneration ?? 1 }
          )),
          reason: "fallback_selected",
          nowMs
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
      unavailableEdges.push({
        sourceGroupKey: edge.source_group_key,
        targetPlatform: edge.target_platform
      });
      unavailable += 1;
    }
    return { reassigned, unavailable, unavailableEdges };
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
      activatedAtMs: row.activated_at_ms ?? null,
      stateDiscovery: this.publicPendingDiscovery(row.invitation_id),
      stateResolution: this.publicPendingResolution(row.invitation_id)
    };
  }

  latestPendingDiscovery(invitationId) {
    return this.state.storage.sql.exec(
      `SELECT invitation_id, discovery_version, requires_resolution,
              discord_realm_json, twitch_realm_json, discovered_at_ms
       FROM integration_pending_discoveries
       WHERE invitation_id = ?
       ORDER BY discovery_version DESC
       LIMIT 1`,
      invitationId
    ).toArray()[0] ?? null;
  }

  publicPendingDiscovery(invitationId) {
    const discovery = this.latestPendingDiscovery(invitationId);
    if (!discovery) return null;
    const namespaces = this.state.storage.sql.exec(
      `SELECT feature_id, feature_label, namespace_id, namespace_label,
              schema_version, discord_summary_json, twitch_summary_json,
              outcome, automatic_selection
       FROM integration_pending_namespace_discoveries
       WHERE invitation_id = ? AND discovery_version = ?
       ORDER BY feature_id, namespace_id`,
      invitationId,
      discovery.discovery_version
    ).toArray().map((row) => ({
      featureId: row.feature_id,
      featureLabel: row.feature_label,
      namespaceId: row.namespace_id,
      namespaceLabel: row.namespace_label,
      schemaVersion: row.schema_version,
      discordSummary: JSON.parse(row.discord_summary_json),
      twitchSummary: JSON.parse(row.twitch_summary_json),
      outcome: row.outcome,
      automaticSelection: row.automatic_selection ?? null
    }));
    return {
      version: discovery.discovery_version,
      discoveredAtMs: discovery.discovered_at_ms,
      requiresResolution: Boolean(discovery.requires_resolution),
      namespaces
    };
  }

  publicPendingResolution(invitationId) {
    const discovery = this.latestPendingDiscovery(invitationId);
    if (!discovery) return null;
    const resolution = this.state.storage.sql.exec(
      `SELECT invitation_id, discovery_version, resolved_at_ms
       FROM integration_pending_resolutions
       WHERE invitation_id = ? AND discovery_version = ?`,
      invitationId,
      discovery.discovery_version
    ).toArray()[0];
    if (!resolution) return null;
    const selections = this.state.storage.sql.exec(
      `SELECT feature_id, namespace_id, selection, selection_source
       FROM integration_pending_namespace_resolutions
       WHERE invitation_id = ? AND discovery_version = ?
       ORDER BY feature_id, namespace_id`,
      invitationId,
      resolution.discovery_version
    ).toArray().map((row) => ({
      featureId: row.feature_id,
      namespaceId: row.namespace_id,
      selection: row.selection,
      source: row.selection_source
    }));
    return {
      discoveryVersion: resolution.discovery_version,
      resolvedAtMs: resolution.resolved_at_ms,
      selections
    };
  }

  pendingNamespaceDiscoveries(invitationId, discoveryVersion) {
    return this.state.storage.sql.exec(
      `SELECT feature_id, namespace_id, outcome, automatic_selection
       FROM integration_pending_namespace_discoveries
       WHERE invitation_id = ? AND discovery_version = ?
       ORDER BY feature_id, namespace_id`,
      invitationId,
      discoveryVersion
    ).toArray();
  }

  effectiveCandidateRealm(group, targetPlatform) {
    const selected = this.state.storage.sql.exec(
      `SELECT default_link.integration_id,
              integration.shareable_state_generation
       FROM integration_default_links default_link
       JOIN integrations integration
         ON integration.integration_id = default_link.integration_id
       WHERE default_link.source_group_key = ?
         AND default_link.target_platform = ?
         AND integration.status = 'active'
       LIMIT 1`,
      group.key,
      targetPlatform
    ).toArray()[0];
    return selected
      ? createIntegrationRealmIdentity(
          { id: selected.integration_id },
          { generation: selected.shareable_state_generation ?? 1 }
        )
      : this.currentStandaloneRealm(group);
  }

  currentStandaloneRealm(groupInput) {
    const group = validatedGroup(groupInput);
    const successor = this.state.storage.sql.exec(
      `SELECT generation
       FROM shareable_state_standalone_successors
       WHERE group_key = ?`,
      group.key
    ).toArray()[0];
    return createStandaloneRealmIdentity(group, {
      generation: successor?.generation ?? 1
    });
  }

  defaultLinkTransition(sourceGroup, targetPlatform) {
    return this.state.storage.sql.exec(
      `SELECT integration.status
       FROM integration_default_links default_link
       JOIN integrations integration
         ON integration.integration_id = default_link.integration_id
       WHERE default_link.source_group_key = ?
         AND default_link.target_platform = ?`,
      sourceGroup.key,
      targetPlatform
    ).toArray()[0]?.status ?? null;
  }

  async ensureStandaloneSuccessor(groupInput, targetPlatformInput, correlationId) {
    const group = validatedGroup(groupInput);
    const targetPlatform = validatedPlatform(
      targetPlatformInput,
      "State-query binding target platform"
    );
    const successor = this.state.storage.sql.exec(
      `SELECT group_key, generation, status, source_integration_id,
              source_generation
       FROM shareable_state_standalone_successors
       WHERE group_key = ?`,
      group.key
    ).toArray()[0];
    if (!successor) return createStandaloneRealmIdentity(group);
    const targetRealm = createStandaloneRealmIdentity(group, {
      generation: successor.generation
    });
    if (successor.status === "ready") return targetRealm;
    if (successor.status !== "pending") {
      throw new IntegrationRegistryError(
        "The standalone shareable-state successor is invalid.",
        { status: 503, code: "integration_state_successor_invalid" }
      );
    }
    const sourceRealm = createIntegrationRealmIdentity(
      { id: successor.source_integration_id },
      { generation: successor.source_generation }
    );
    const namespaces = this.state.storage.sql.exec(
      `SELECT feature_id, namespace_id, schema_version, mutation_version,
              fingerprint, meaningful
       FROM integration_revocation_namespaces
       WHERE integration_id = ?
       ORDER BY feature_id, namespace_id`,
      successor.source_integration_id
    ).toArray();
    try {
      for (const namespace of namespaces) {
        const snapshot = await snapshotShareableStateNamespace(this.env, {
          realm: sourceRealm,
          featureId: namespace.feature_id,
          namespaceId: namespace.namespace_id,
          correlationId
        });
        if (
          snapshot.namespace.schemaVersion !== namespace.schema_version ||
          snapshot.mutationVersion !== namespace.mutation_version ||
          snapshot.fingerprint !== namespace.fingerprint ||
          snapshot.meaningful !== Boolean(namespace.meaningful)
        ) {
          throw new IntegrationRegistryError(
            "The archived integration state no longer matches its revocation ledger.",
            { status: 503, code: "integration_state_successor_source_invalid" }
          );
        }
        await cloneShareableStateSnapshot(this.env, {
          realm: targetRealm,
          snapshot,
          idempotencyKey:
            `successor:${successor.source_integration_id}:` +
            `g${successor.generation}:${namespace.feature_id}:` +
            namespace.namespace_id,
          correlationId
        });
        const cloned = await snapshotShareableStateNamespace(this.env, {
          realm: targetRealm,
          featureId: namespace.feature_id,
          namespaceId: namespace.namespace_id,
          correlationId
        });
        if (
          cloned.mutationVersion !== 1 ||
          !shareableStateSnapshotsEqual(snapshot, cloned)
        ) {
          throw new IntegrationRegistryError(
            "The standalone shareable-state successor could not be verified.",
            { status: 503, code: "integration_state_successor_invalid" }
          );
        }
      }
    } catch (cause) {
      if (cause instanceof IntegrationRegistryError) throw cause;
      if (cause instanceof ShareableStateRealmError) {
        throw new IntegrationRegistryError(
          "The standalone shareable-state successor is temporarily unavailable.",
          {
            status: 503,
            code: "integration_state_successor_unavailable",
            cause
          }
        );
      }
      throw cause;
    }
    const readyAtMs = Date.now();
    this.state.storage.transactionSync(() => {
      const current = this.state.storage.sql.exec(
        `SELECT generation, status, source_integration_id
         FROM shareable_state_standalone_successors
         WHERE group_key = ?`,
        group.key
      ).toArray()[0];
      if (
        !current ||
        current.generation !== successor.generation ||
        current.source_integration_id !== successor.source_integration_id
      ) {
        throw new IntegrationRegistryError(
          "The standalone shareable-state successor changed during recovery.",
          { status: 409, code: "integration_state_successor_stale" }
        );
      }
      if (current.status === "ready") return;
      this.state.storage.sql.exec(
        `UPDATE shareable_state_standalone_successors
         SET status = 'ready', ready_at_ms = ?
         WHERE group_key = ? AND generation = ? AND status = 'pending'`,
        readyAtMs,
        group.key,
        successor.generation
      );
      audit(this.state.storage.sql, {
        integrationId: successor.source_integration_id,
        event: "integration.state_successor.ready.v1",
        groupKey: group.key,
        occurredAtMs: readyAtMs
      });
      this.advanceStateQueryBinding({
        sourceGroup: group,
        targetPlatform,
        status: "ready",
        sourceKey: shareableStateRealmObjectName(targetRealm),
        reason: "successor_ready",
        nowMs: readyAtMs
      });
    });
    return targetRealm;
  }

  async resolveEffectiveShareableState(input) {
    const sourceGroup = validatedGroup(input?.sourceGroup);
    const targetPlatform = validatedPlatform(
      input?.targetPlatform,
      "Shareable-state target platform"
    );
    if (sourceGroup.platform === targetPlatform) {
      throw new IntegrationRegistryError(
        "Shareable state must target another platform.",
        { status: 422, code: "integration_default_platform_invalid" }
      );
    }
    const transition = this.defaultLinkTransition(sourceGroup, targetPlatform);
    if (transition && transition !== "active") {
      throw new IntegrationRegistryError(
        "Shareable state is transitioning after integration revocation.",
        { status: 409, code: "shareable_state_transition" }
      );
    }
    let defaultLink = this.getDefaultLink(sourceGroup, targetPlatform);
    if (defaultLink) {
      return {
        defaultLink,
        standaloneRealm: null,
        bindingRevision: this.stateQueryBinding(sourceGroup, targetPlatform).revision
      };
    }
    const standaloneRealm = await this.ensureStandaloneSuccessor(
      sourceGroup,
      targetPlatform,
      input?.correlationId
    );
    defaultLink = this.getDefaultLink(sourceGroup, targetPlatform);
    if (defaultLink) {
      return {
        defaultLink,
        standaloneRealm: null,
        bindingRevision: this.stateQueryBinding(sourceGroup, targetPlatform).revision
      };
    }
    if (this.defaultLinkTransition(sourceGroup, targetPlatform)) {
      throw new IntegrationRegistryError(
        "Shareable state changed while its standalone successor was prepared.",
        { status: 409, code: "shareable_state_transition" }
      );
    }
    return {
      defaultLink: null,
      standaloneRealm,
      bindingRevision: this.stateQueryBinding(sourceGroup, targetPlatform).revision
    };
  }

  async ensureEffectiveCandidateRealm(group, targetPlatform, correlationId) {
    const resolved = await this.resolveEffectiveShareableState({
      sourceGroup: group,
      targetPlatform,
      correlationId
    });
    return resolved.defaultLink
      ? createIntegrationRealmIdentity(resolved.defaultLink.integration, {
          generation:
            resolved.defaultLink.integration.shareableStateGeneration ?? 1
        })
      : resolved.standaloneRealm;
  }

  persistPendingDiscovery(row, discovery, { replaceVersion = null } = {}) {
    const nowMs = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const current = this.pendingInvitationByReservation(row.reservation_id);
      if (
        !current ||
        current.invitation_id !== row.invitation_id ||
        current.pending_status !== "awaiting_state_resolution"
      ) {
        throw new IntegrationRegistryError(
          "The pending integration is no longer available for state discovery.",
          { status: 409, code: "integration_state_discovery_stale" }
        );
      }
      if (current.pending_expires_at_ms <= nowMs) {
        this.expirePendingRow(current, nowMs);
        return { expired: true };
      }
      const existing = this.latestPendingDiscovery(row.invitation_id);
      if (replaceVersion === null && existing) {
        return this.publicPendingDiscovery(row.invitation_id);
      }
      if (
        replaceVersion !== null &&
        existing?.discovery_version !== replaceVersion
      ) {
        return this.publicPendingDiscovery(row.invitation_id);
      }
      const discoveryVersion = existing
        ? existing.discovery_version + 1
        : 1;
      this.state.storage.sql.exec(
        `INSERT INTO integration_pending_discoveries
          (invitation_id, discovery_version, requires_resolution,
           discord_realm_json, twitch_realm_json, discovered_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.invitation_id,
        discoveryVersion,
        discovery.requiresResolution ? 1 : 0,
        JSON.stringify(discovery.discordRealm),
        JSON.stringify(discovery.twitchRealm),
        nowMs
      );
      for (const namespace of discovery.namespaces) {
        this.state.storage.sql.exec(
          `INSERT INTO integration_pending_namespace_discoveries
            (invitation_id, discovery_version, feature_id, feature_label,
             namespace_id, namespace_label, schema_version,
             discord_mutation_version, discord_fingerprint,
             discord_meaningful, discord_summary_json,
             twitch_mutation_version, twitch_fingerprint,
             twitch_meaningful, twitch_summary_json, outcome,
             automatic_selection)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.invitation_id,
          discoveryVersion,
          namespace.featureId,
          namespace.featureLabel,
          namespace.namespaceId,
          namespace.namespaceLabel,
          namespace.schemaVersion,
          namespace.discord.mutationVersion,
          namespace.discord.fingerprint,
          namespace.discord.meaningful ? 1 : 0,
          JSON.stringify(namespace.discord.summary),
          namespace.twitch.mutationVersion,
          namespace.twitch.fingerprint,
          namespace.twitch.meaningful ? 1 : 0,
          JSON.stringify(namespace.twitch.summary),
          namespace.outcome,
          namespace.automaticSelection
        );
      }
      audit(this.state.storage.sql, {
        integrationId: row.pending_integration_id,
        invitationId: row.invitation_id,
        event: replaceVersion === null
          ? discovery.requiresResolution
            ? "integration.state_discovery.collisions_found.v1"
            : "integration.state_discovery.automatically_resolved.v1"
          : "integration.state_discovery.refreshed.v1",
        occurredAtMs: nowMs
      });
      return this.publicPendingDiscovery(row.invitation_id);
    });
    if (result.expired) {
      throw new IntegrationRegistryError("The pending integration expired.", {
        status: 410,
        code: "integration_pending_expired"
      });
    }
    return result;
  }

  async ensurePendingDiscovery(reservationId) {
    const row = this.pendingInvitationByReservation(reservationId);
    if (!row || row.pending_status !== "awaiting_state_resolution") return null;
    const existing = this.publicPendingDiscovery(row.invitation_id);
    if (existing) return existing;
    const discordGroup = parseGroupKey(row.discord_group_key);
    const twitchGroup = parseGroupKey(row.twitch_group_key);
    const discordRealm = await this.ensureEffectiveCandidateRealm(
      discordGroup,
      "twitch",
      `integration-state-discovery:${row.pending_integration_id}:discord`
    );
    const twitchRealm = await this.ensureEffectiveCandidateRealm(
      twitchGroup,
      "discord",
      `integration-state-discovery:${row.pending_integration_id}:twitch`
    );
    let discovery;
    try {
      discovery = await discoverIntegrationShareableState(this.env, {
        discordRealm,
        twitchRealm,
        correlationId: `integration-state-discovery:${row.pending_integration_id}`
      });
    } catch (error) {
      if (error instanceof IntegrationStateDiscoveryError) {
        throw new IntegrationRegistryError(error.message, {
          status: error.status,
          code: error.code,
          cause: error
        });
      }
      throw error;
    }
    return this.persistPendingDiscovery(row, discovery);
  }

  async refreshPendingDiscovery(reservationId, replaceVersion) {
    const row = this.pendingInvitationByReservation(reservationId);
    if (!row || row.pending_status !== "awaiting_state_resolution") {
      throw new IntegrationRegistryError(
        "The pending integration is no longer available for rediscovery.",
        { status: 409, code: "integration_state_discovery_stale" }
      );
    }
    const discordGroup = parseGroupKey(row.discord_group_key);
    const twitchGroup = parseGroupKey(row.twitch_group_key);
    const discordRealm = await this.ensureEffectiveCandidateRealm(
      discordGroup,
      "twitch",
      `integration-state-rediscovery:${row.pending_integration_id}:discord`
    );
    const twitchRealm = await this.ensureEffectiveCandidateRealm(
      twitchGroup,
      "discord",
      `integration-state-rediscovery:${row.pending_integration_id}:twitch`
    );
    let discovery;
    try {
      discovery = await discoverIntegrationShareableState(this.env, {
        discordRealm,
        twitchRealm,
        correlationId: `integration-state-rediscovery:${row.pending_integration_id}`
      });
    } catch (error) {
      if (error instanceof IntegrationStateDiscoveryError) {
        throw new IntegrationRegistryError(error.message, {
          status: error.status,
          code: error.code,
          cause: error
        });
      }
      throw error;
    }
    return this.persistPendingDiscovery(row, discovery, { replaceVersion });
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
    await this.ensurePendingDiscovery(reservationId);
    return {
      ...result,
      pendingIntegration: this.publicPendingInvitation(
        this.pendingInvitationByReservation(reservationId)
      )
    };
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
    if (result.status === "awaiting_state_resolution") {
      await this.ensurePendingDiscovery(reservationId);
      return {
        pendingIntegration: this.publicPendingInvitation(
          this.pendingInvitationByReservation(reservationId)
        ),
        integration: null
      };
    }
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

  async resolveInvitationState(input) {
    const reservationId = validatedOpaqueId(
      input?.reservationId,
      "Integration continuation ID"
    );
    const discoveryVersion = validatedDiscoveryVersion(input?.discoveryVersion);
    const requestedSelections = validatedStateSelections(input?.selections);
    const requestedByKey = new Map();
    for (const selection of requestedSelections) {
      const key = `${selection.featureId}\u0000${selection.namespaceId}`;
      if (requestedByKey.has(key)) {
        throw new IntegrationRegistryError(
          "Each colliding namespace must have exactly one resolution choice.",
          { status: 422, code: "integration_state_resolution_incomplete" }
        );
      }
      requestedByKey.set(key, selection.selection);
    }

    const nowMs = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const row = this.pendingInvitationByReservation(reservationId);
      if (!row) {
        throw new IntegrationRegistryError(
          "The integration continuation is invalid or unavailable.",
          { status: 404, code: "integration_pending_not_found" }
        );
      }
      if (
        row.pending_status === "awaiting_state_resolution" &&
        row.pending_expires_at_ms <= nowMs
      ) {
        this.expirePendingRow(row, nowMs);
        return { expired: true };
      }
      const discovery = this.latestPendingDiscovery(row.invitation_id);
      if (!discovery || discovery.discovery_version !== discoveryVersion) {
        throw new IntegrationRegistryError(
          "Shareable state changed while the resolution page was open.",
          { status: 409, code: "integration_state_resolution_stale" }
        );
      }
      const namespaces = this.pendingNamespaceDiscoveries(
        row.invitation_id,
        discoveryVersion
      );
      const collisions = namespaces.filter((namespace) =>
        namespace.outcome === "collision"
      );
      if (collisions.length === 0) {
        throw new IntegrationRegistryError(
          "This pending integration has no state collisions to resolve.",
          { status: 409, code: "integration_state_resolution_not_required" }
        );
      }
      const expectedKeys = new Set(collisions.map((namespace) =>
        `${namespace.feature_id}\u0000${namespace.namespace_id}`
      ));
      if (
        requestedByKey.size !== expectedKeys.size ||
        [...requestedByKey.keys()].some((key) => !expectedKeys.has(key))
      ) {
        throw new IntegrationRegistryError(
          "Every colliding namespace requires one resolution choice.",
          { status: 422, code: "integration_state_resolution_incomplete" }
        );
      }

      const existing = this.state.storage.sql.exec(
        `SELECT resolved_at_ms
         FROM integration_pending_resolutions
         WHERE invitation_id = ? AND discovery_version = ?`,
        row.invitation_id,
        discoveryVersion
      ).toArray()[0];
      if (existing) {
        const stored = this.publicPendingResolution(row.invitation_id);
        const storedUserSelections = stored?.selections.filter(
          (selection) => selection.source === "user"
        ) ?? [];
        const same = stored?.discoveryVersion === discoveryVersion &&
          storedUserSelections.length === requestedByKey.size &&
          storedUserSelections.every((selection) => requestedByKey.get(
              `${selection.featureId}\u0000${selection.namespaceId}`
            ) === selection.selection);
        if (same) {
          return {
            stateResolution: stored,
            replayed: true,
            pendingIntegration: this.publicPendingInvitation(row)
          };
        }
        throw new IntegrationRegistryError(
          "State-resolution choices have already been recorded.",
          { status: 409, code: "integration_state_resolution_already_recorded" }
        );
      }
      if (
        row.invitation_status !== "awaiting_state_resolution" ||
        row.pending_status !== "awaiting_state_resolution"
      ) {
        throw new IntegrationRegistryError(
          "This integration is not awaiting state resolution.",
          { status: 409, code: "integration_state_resolution_unavailable" }
        );
      }
      this.state.storage.sql.exec(
        `INSERT INTO integration_pending_resolutions
          (invitation_id, discovery_version, resolved_by_platform,
           resolved_by_actor_id, resolved_at_ms)
         VALUES (?, ?, 'twitch', ?, ?)`,
        row.invitation_id,
        discoveryVersion,
        row.twitch_actor_id,
        nowMs
      );
      for (const namespace of namespaces) {
        const key = `${namespace.feature_id}\u0000${namespace.namespace_id}`;
        const userSelected = namespace.outcome === "collision";
        const selection = userSelected
          ? requestedByKey.get(key)
          : namespace.automatic_selection;
        if (!PENDING_STATE_SELECTIONS.has(selection)) {
          throw new IntegrationRegistryError(
            "The discovered shareable-state decision is invalid.",
            { status: 409, code: "integration_state_resolution_invalid" }
          );
        }
        this.state.storage.sql.exec(
          `INSERT INTO integration_pending_namespace_resolutions
            (invitation_id, discovery_version, feature_id, namespace_id,
             selection, selection_source)
           VALUES (?, ?, ?, ?, ?, ?)`,
          row.invitation_id,
          discoveryVersion,
          namespace.feature_id,
          namespace.namespace_id,
          selection,
          userSelected ? "user" : "automatic"
        );
      }
      audit(this.state.storage.sql, {
        integrationId: row.pending_integration_id,
        invitationId: row.invitation_id,
        event: "integration.state_resolution.recorded.v1",
        actor: { platform: "twitch", id: row.twitch_actor_id },
        groupKey: row.twitch_group_key,
        occurredAtMs: nowMs
      });
      return {
        stateResolution: this.publicPendingResolution(row.invitation_id),
        replayed: false,
        pendingIntegration: this.publicPendingInvitation(row)
      };
    });
    await this.armNextExpiration();
    if (result.expired) {
      throw new IntegrationRegistryError("The pending integration expired.", {
        status: 410,
        code: "integration_pending_expired"
      });
    }
    return result;
  }

  pendingFinalizationPlan(row) {
    const discovery = this.latestPendingDiscovery(row.invitation_id);
    if (!discovery) {
      throw new IntegrationRegistryError(
        "Shareable-state discovery has not completed.",
        { status: 409, code: "integration_state_discovery_required" }
      );
    }
    const resolution = this.publicPendingResolution(row.invitation_id);
    if (discovery.requires_resolution && !resolution) {
      throw new IntegrationRegistryError(
        "Shareable-state collisions still require a decision.",
        { status: 409, code: "integration_state_resolution_required" }
      );
    }
    const selectedByKey = new Map((resolution?.selections ?? []).map(
      (selection) => [
        `${selection.featureId}\u0000${selection.namespaceId}`,
        selection.selection
      ]
    ));
    const namespaces = this.state.storage.sql.exec(
      `SELECT feature_id, namespace_id, schema_version,
              discord_mutation_version, discord_fingerprint,
              twitch_mutation_version, twitch_fingerprint,
              outcome, automatic_selection
       FROM integration_pending_namespace_discoveries
       WHERE invitation_id = ? AND discovery_version = ?
       ORDER BY feature_id, namespace_id`,
      row.invitation_id,
      discovery.discovery_version
    ).toArray().map((namespace) => {
      const key = `${namespace.feature_id}\u0000${namespace.namespace_id}`;
      const selection = resolution
        ? selectedByKey.get(key)
        : namespace.automatic_selection;
      if (!PENDING_STATE_SELECTIONS.has(selection)) {
        throw new IntegrationRegistryError(
          "The shareable-state finalization plan is incomplete.",
          { status: 409, code: "integration_state_resolution_required" }
        );
      }
      return {
        featureId: namespace.feature_id,
        namespaceId: namespace.namespace_id,
        schemaVersion: namespace.schema_version,
        selection,
        discord: {
          mutationVersion: namespace.discord_mutation_version,
          fingerprint: namespace.discord_fingerprint
        },
        twitch: {
          mutationVersion: namespace.twitch_mutation_version,
          fingerprint: namespace.twitch_fingerprint
        }
      };
    });
    if (resolution && selectedByKey.size !== namespaces.length) {
      throw new IntegrationRegistryError(
        "The shareable-state finalization plan is inconsistent.",
        { status: 409, code: "integration_state_resolution_required" }
      );
    }
    try {
      return {
        version: discovery.discovery_version,
        discordRealm: JSON.parse(discovery.discord_realm_json),
        twitchRealm: JSON.parse(discovery.twitch_realm_json),
        namespaces
      };
    } catch (cause) {
      throw new IntegrationRegistryError(
        "The shareable-state discovery record is invalid.",
        { status: 500, code: "integration_state_discovery_invalid", cause }
      );
    }
  }

  finalizationCandidateRealmsAreCurrent(row, plan) {
    const discordRealm = this.effectiveCandidateRealm(
      parseGroupKey(row.discord_group_key),
      "twitch"
    );
    const twitchRealm = this.effectiveCandidateRealm(
      parseGroupKey(row.twitch_group_key),
      "discord"
    );
    return shareableStateRealmObjectName(discordRealm) ===
        shareableStateRealmObjectName(plan.discordRealm) &&
      shareableStateRealmObjectName(twitchRealm) ===
        shareableStateRealmObjectName(plan.twitchRealm);
  }

  async releaseFinalizationSeals(seals, correlationId) {
    await Promise.allSettled(seals.map((seal) =>
      releaseShareableStateNamespaceSeal(this.env, {
        realm: seal.realm,
        featureId: seal.featureId,
        namespaceId: seal.namespaceId,
        sealId: seal.sealId,
        correlationId
      })
    ));
  }

  async acquireFinalizationSeals(row, plan, correlationId) {
    const unitsByKey = new Map();
    for (const namespace of plan.namespaces) {
      for (const [side, realm] of [
        ["discord", plan.discordRealm],
        ["twitch", plan.twitchRealm]
      ]) {
        const realmKey = shareableStateRealmObjectName(realm);
        const key = `${realmKey}\u0000${namespace.featureId}\u0000${namespace.namespaceId}`;
        const unit = unitsByKey.get(key) ?? {
          realm,
          realmKey,
          featureId: namespace.featureId,
          namespaceId: namespace.namespaceId,
          sides: []
        };
        unit.sides.push(side);
        unitsByKey.set(key, unit);
      }
    }
    const units = [...unitsByKey.values()].sort((left, right) =>
      left.realmKey.localeCompare(right.realmKey) ||
      left.featureId.localeCompare(right.featureId) ||
      left.namespaceId.localeCompare(right.namespaceId)
    );
    const acquired = [];
    const snapshots = new Map();
    const expiresAtMs = Date.now() + FINALIZATION_SEAL_LEASE_MS;
    try {
      for (const unit of units) {
        const sealId =
          `finalize:${row.pending_integration_id}:v${plan.version}:` +
          `${unit.featureId}:${unit.namespaceId}`;
        const sealed = await sealShareableStateNamespace(this.env, {
          realm: unit.realm,
          featureId: unit.featureId,
          namespaceId: unit.namespaceId,
          sealId,
          expiresAtMs,
          correlationId
        });
        acquired.push({ ...unit, sealId });
        for (const side of unit.sides) {
          snapshots.set(
            `${unit.featureId}\u0000${unit.namespaceId}\u0000${side}`,
            sealed.snapshot
          );
        }
      }
      return { acquired, snapshots };
    } catch (cause) {
      await this.releaseFinalizationSeals(acquired, correlationId);
      if (cause instanceof ShareableStateRealmError) {
        throw new IntegrationRegistryError(
          "Shareable state is busy with another transition.",
          {
            status: cause.code === "shareable_state_transition_sealed" ? 409 : 503,
            code: cause.code === "shareable_state_transition_sealed"
              ? "integration_state_finalization_busy"
              : "integration_state_finalization_unavailable",
            cause
          }
        );
      }
      throw cause;
    }
  }

  finalizationSnapshotsAreCurrent(plan, snapshots) {
    return plan.namespaces.every((namespace) =>
      ["discord", "twitch"].every((side) => {
        const snapshot = snapshots.get(
          `${namespace.featureId}\u0000${namespace.namespaceId}\u0000${side}`
        );
        const expected = namespace[side];
        return snapshot?.namespace.schemaVersion === namespace.schemaVersion &&
          snapshot.mutationVersion === expected.mutationVersion &&
          snapshot.fingerprint === expected.fingerprint;
      })
    );
  }

  async materializeFinalization(row, plan, snapshots, correlationId) {
    const realm = createIntegrationRealmIdentity(
      { id: row.pending_integration_id },
      { generation: plan.version }
    );
    const expectedFingerprints = new Map();
    try {
      for (const namespace of plan.namespaces) {
        const idempotencyKey =
          `finalize:${row.pending_integration_id}:v${plan.version}:` +
          `${namespace.featureId}:${namespace.namespaceId}`;
        let result;
        if (namespace.selection === "reset") {
          result = await initializeEmptyShareableStateNamespace(this.env, {
            realm,
            featureId: namespace.featureId,
            namespaceId: namespace.namespaceId,
            idempotencyKey,
            correlationId
          });
        } else {
          const snapshot = snapshots.get(
            `${namespace.featureId}\u0000${namespace.namespaceId}\u0000` +
            namespace.selection
          );
          result = await cloneShareableStateSnapshot(this.env, {
            realm,
            snapshot,
            idempotencyKey,
            correlationId
          });
        }
        expectedFingerprints.set(
          `${namespace.featureId}\u0000${namespace.namespaceId}`,
          result.fingerprint
        );
      }
      for (const namespace of plan.namespaces) {
        const snapshot = await snapshotShareableStateNamespace(this.env, {
          realm,
          featureId: namespace.featureId,
          namespaceId: namespace.namespaceId,
          correlationId
        });
        const expectedFingerprint = expectedFingerprints.get(
          `${namespace.featureId}\u0000${namespace.namespaceId}`
        );
        if (
          snapshot.mutationVersion !== 1 ||
          snapshot.namespace.schemaVersion !== namespace.schemaVersion ||
          snapshot.fingerprint !== expectedFingerprint ||
          (namespace.selection === "reset" && snapshot.meaningful)
        ) {
          throw new IntegrationRegistryError(
            "The new integration realm could not be verified.",
            { status: 503, code: "integration_state_finalization_invalid" }
          );
        }
        if (namespace.selection !== "reset") {
          const source = snapshots.get(
            `${namespace.featureId}\u0000${namespace.namespaceId}\u0000` +
            namespace.selection
          );
          if (!shareableStateSnapshotsEqual(source, snapshot)) {
            throw new IntegrationRegistryError(
              "The new integration realm could not be verified.",
              { status: 503, code: "integration_state_finalization_invalid" }
            );
          }
        }
      }
    } catch (cause) {
      if (cause instanceof IntegrationRegistryError) throw cause;
      if (cause instanceof ShareableStateRealmError) {
        throw new IntegrationRegistryError(
          "The new integration realm could not be materialized.",
          {
            status: cause.code === "shareable_state_transition_sealed" ? 409 : 503,
            code: cause.code === "shareable_state_transition_sealed"
              ? "integration_state_finalization_busy"
              : "integration_state_finalization_unavailable",
            cause
          }
        );
      }
      throw cause;
    }
    return { generation: plan.version, realm };
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
    let row = this.pendingInvitationByReservation(reservationId);
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
        integration: this.getIntegration(row.completed_integration_id),
        alreadyLinked: false,
        replayed: true
      };
    }
    if (
      row.pending_status === "expired" ||
      row.pending_expires_at_ms <= Date.now()
    ) {
      if (row.pending_status !== "expired") {
        this.state.storage.transactionSync(() => this.expirePendingRow(
          this.pendingInvitationByReservation(reservationId),
          Date.now()
        ));
      }
      await this.armNextExpiration();
      throw new IntegrationRegistryError("The pending integration expired.", {
        status: 410,
        code: "integration_pending_expired"
      });
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

    await this.ensurePendingDiscovery(reservationId);
    row = this.pendingInvitationByReservation(reservationId);
    if (
      new Set(["active", "completed"]).has(row?.invitation_status) &&
      row.completed_integration_id
    ) {
      return {
        integration: this.getIntegration(row.completed_integration_id),
        alreadyLinked: false,
        replayed: true
      };
    }
    const existingBeforeMaterialization = this.findExistingIntegration(
      row.discord_group_key,
      row.twitch_group_key
    );
    const correlationId = `integration-state-finalize:${row.pending_integration_id}`;
    let plan = null;
    let seals = [];
    let materializedGeneration = 1;
    let result;
    try {
      if (!existingBeforeMaterialization) {
        plan = this.pendingFinalizationPlan(row);
        if (
          plan.namespaces.length > 0 &&
          !this.finalizationCandidateRealmsAreCurrent(row, plan)
        ) {
          await this.refreshPendingDiscovery(reservationId, plan.version);
          throw new IntegrationRegistryError(
            "Shareable state changed while the link was being finalized.",
            { status: 409, code: "integration_state_rediscovery_required" }
          );
        }
        const sealed = await this.acquireFinalizationSeals(
          row,
          plan,
          correlationId
        );
        seals = sealed.acquired;
        if (
          (
            plan.namespaces.length > 0 &&
            !this.finalizationCandidateRealmsAreCurrent(row, plan)
          ) ||
          !this.finalizationSnapshotsAreCurrent(plan, sealed.snapshots)
        ) {
          await this.releaseFinalizationSeals(seals, correlationId);
          seals = [];
          await this.refreshPendingDiscovery(reservationId, plan.version);
          throw new IntegrationRegistryError(
            "Shareable state changed while the link was being finalized.",
            { status: 409, code: "integration_state_rediscovery_required" }
          );
        }
        const materialized = await this.materializeFinalization(
          row,
          plan,
          sealed.snapshots,
          correlationId
        );
        materializedGeneration = materialized.generation;
        const current = this.pendingInvitationByReservation(reservationId);
        const concurrentlyActivated = Boolean(
          current?.completed_integration_id &&
          new Set(["active", "completed"]).has(current.invitation_status)
        );
        if (
          plan.namespaces.length > 0 &&
          !concurrentlyActivated &&
          !this.finalizationCandidateRealmsAreCurrent(row, plan)
        ) {
          await this.refreshPendingDiscovery(reservationId, plan.version);
          throw new IntegrationRegistryError(
            "Shareable state changed while the link was being finalized.",
            { status: 409, code: "integration_state_rediscovery_required" }
          );
        }
      }

      const nowMs = Date.now();
      result = this.state.storage.transactionSync(() => {
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
      if (
        plan &&
        this.latestPendingDiscovery(row.invitation_id)?.discovery_version !==
          plan.version
      ) {
        throw new IntegrationRegistryError(
          "Shareable state changed while the link was being finalized.",
          { status: 409, code: "integration_state_rediscovery_required" }
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
             completed_by_platform, completed_by_actor_id,
             shareable_state_generation)
           VALUES (?, 'active', ?, ?, ?, 'discord', ?, 'twitch', ?, ?)`,
          integrationId,
          nowMs,
          nowMs,
          nowMs,
          row.discord_actor_id,
          row.twitch_actor_id,
          materializedGeneration
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
        if (plan?.namespaces.length > 0) {
          audit(this.state.storage.sql, {
            integrationId,
            invitationId,
            event: "integration.state_resolution.applied.v1",
            actor: { platform: "twitch", id: row.twitch_actor_id },
            groupKey: row.twitch_group_key,
            occurredAtMs: nowMs
          });
        }
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
    } finally {
      await this.releaseFinalizationSeals(seals, correlationId);
    }

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
              i.activated_at_ms, i.revoked_at_ms, i.revoked_reason,
              i.shareable_state_generation
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

  beginIntegrationRevocation({ integrationId, group, actor, reason }) {
    const requestedAtMs = Date.now();
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
      if (integration.status === "revoked") {
        return { started: false, alreadyRevoked: true, integration };
      }
      if (!new Set(["active", "revoking"]).has(integration.status)) {
        throw new IntegrationRegistryError(
          "The integration cannot enter revocation from its current state.",
          { status: 409, code: "integration_revocation_unavailable" }
        );
      }
      if (integration.status === "active") {
        const selectedBindings = this.state.storage.sql.exec(
          `SELECT source_group_key, target_platform
           FROM integration_default_links
           WHERE integration_id = ?
           ORDER BY source_group_key, target_platform`,
          integrationId
        ).toArray();
        this.state.storage.sql.exec(
          `UPDATE integrations
           SET status = 'revoking', updated_at_ms = ?, revoked_reason = ?
           WHERE integration_id = ? AND status = 'active'`,
          requestedAtMs,
          reason,
          integrationId
        );
        audit(this.state.storage.sql, {
          integrationId,
          event: "integration.revocation.started.v1",
          actor,
          groupKey: group.key,
          occurredAtMs: requestedAtMs
        });
        for (const binding of selectedBindings) {
          this.advanceStateQueryBinding({
            sourceGroup: parseGroupKey(binding.source_group_key),
            targetPlatform: binding.target_platform,
            status: "transitioning",
            sourceKey: null,
            reason: "revocation_started",
            nowMs: requestedAtMs
          });
        }
      }
      this.state.storage.sql.exec(
        `INSERT INTO integration_revocation_jobs
          (integration_id, actor_platform, actor_id, group_key, reason,
           requested_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(integration_id) DO NOTHING`,
        integrationId,
        actor?.platform ?? null,
        actor?.id ?? null,
        group.key,
        reason,
        requestedAtMs
      );
      return {
        started: integration.status === "active",
        alreadyRevoked: false,
        integration: this.getIntegration(integrationId)
      };
    });
  }

  async freezeIntegrationForRevocation(integration, correlationId) {
    const realm = createIntegrationRealmIdentity(integration, {
      generation: integration.shareableStateGeneration ?? 1
    });
    try {
      const inventory = await inventoryShareableStateNamespaces(this.env, {
        realm,
        correlationId
      });
      const manifests = [];
      for (const namespace of inventory.namespaces) {
        const frozen = await freezeShareableStateNamespace(this.env, {
          realm,
          featureId: namespace.featureId,
          namespaceId: namespace.namespaceId,
          freezeId:
            `revoke:${integration.id}:${namespace.featureId}:` +
            namespace.namespaceId,
          correlationId
        });
        manifests.push({
          featureId: namespace.featureId,
          namespaceId: namespace.namespaceId,
          schemaVersion: frozen.snapshot.namespace.schemaVersion,
          mutationVersion: frozen.snapshot.mutationVersion,
          fingerprint: frozen.snapshot.fingerprint,
          meaningful: frozen.snapshot.meaningful
        });
      }
      return manifests;
    } catch (cause) {
      if (cause instanceof ShareableStateRealmError) {
        throw new IntegrationRegistryError(
          "Integration state could not be frozen for revocation.",
          { status: 503, code: "integration_revocation_state_unavailable" }
        );
      }
      throw cause;
    }
  }

  recordStandaloneSuccessor(edge, integration, nowMs) {
    const sourceGroup = parseGroupKey(edge.sourceGroupKey);
    const current = this.state.storage.sql.exec(
      `SELECT generation, status, source_integration_id
       FROM shareable_state_standalone_successors
       WHERE group_key = ?`,
      sourceGroup.key
    ).toArray()[0];
    if (current?.status === "pending") {
      throw new IntegrationRegistryError(
        "An earlier standalone shareable-state successor is still pending.",
        { status: 409, code: "integration_state_successor_pending" }
      );
    }
    const generation = (current?.generation ?? 1) + 1;
    this.state.storage.sql.exec(
      `INSERT INTO shareable_state_standalone_successors
        (group_key, generation, status, source_integration_id,
         source_generation, created_at_ms, ready_at_ms)
       VALUES (?, ?, 'pending', ?, ?, ?, NULL)
       ON CONFLICT(group_key) DO UPDATE SET
         generation = excluded.generation,
         status = 'pending',
         source_integration_id = excluded.source_integration_id,
         source_generation = excluded.source_generation,
         created_at_ms = excluded.created_at_ms,
         ready_at_ms = NULL`,
      sourceGroup.key,
      generation,
      integration.id,
      integration.shareableStateGeneration ?? 1,
      nowMs
    );
    audit(this.state.storage.sql, {
      integrationId: integration.id,
      event: "integration.state_successor.recorded.v1",
      groupKey: sourceGroup.key,
      occurredAtMs: nowMs
    });
    this.advanceStateQueryBinding({
      sourceGroup,
      targetPlatform: edge.targetPlatform,
      status: "transitioning",
      sourceKey: null,
      reason: "successor_pending",
      nowMs
    });
  }

  async completeIntegrationRevocation(integrationIdInput) {
    const integrationId = validatedOpaqueId(integrationIdInput, "Integration ID");
    const inFlight = this.integrationRevocations.get(integrationId);
    if (inFlight) return await inFlight;
    const operation = this.performIntegrationRevocation(integrationId);
    this.integrationRevocations.set(integrationId, operation);
    try {
      return await operation;
    } finally {
      if (this.integrationRevocations.get(integrationId) === operation) {
        this.integrationRevocations.delete(integrationId);
      }
    }
  }

  async performIntegrationRevocation(integrationId) {
    const before = this.getIntegration(integrationId);
    if (!before) {
      throw new IntegrationRegistryError("The integration was not found.", {
        status: 404,
        code: "integration_not_found"
      });
    }
    if (before.status === "revoked") {
      return { revoked: false, alreadyRevoked: true, integration: before };
    }
    if (before.status !== "revoking") {
      throw new IntegrationRegistryError(
        "The integration is not awaiting revocation.",
        { status: 409, code: "integration_revocation_unavailable" }
      );
    }
    const job = this.state.storage.sql.exec(
      `SELECT actor_platform, actor_id, group_key, reason
       FROM integration_revocation_jobs
       WHERE integration_id = ?`,
      integrationId
    ).toArray()[0];
    if (!job) {
      throw new IntegrationRegistryError(
        "The integration revocation recovery record is unavailable.",
        { status: 503, code: "integration_revocation_state_invalid" }
      );
    }
    const manifests = await this.freezeIntegrationForRevocation(
      before,
      `integration-revocation:${integrationId}`
    );
    const nowMs = Date.now();
    return this.state.storage.transactionSync(() => {
      const integration = this.getIntegration(integrationId);
      if (integration.status === "revoked") {
        return { revoked: false, alreadyRevoked: true, integration };
      }
      if (integration.status !== "revoking") {
        throw new IntegrationRegistryError(
          "The integration revocation changed while state was being frozen.",
          { status: 409, code: "integration_revocation_stale" }
        );
      }
      for (const manifest of manifests) {
        const existing = this.state.storage.sql.exec(
          `SELECT schema_version, mutation_version, fingerprint, meaningful
           FROM integration_revocation_namespaces
           WHERE integration_id = ? AND feature_id = ? AND namespace_id = ?`,
          integrationId,
          manifest.featureId,
          manifest.namespaceId
        ).toArray()[0];
        if (existing && (
          existing.schema_version !== manifest.schemaVersion ||
          existing.mutation_version !== manifest.mutationVersion ||
          existing.fingerprint !== manifest.fingerprint ||
          Boolean(existing.meaningful) !== manifest.meaningful
        )) {
          throw new IntegrationRegistryError(
            "The integration revocation ledger is inconsistent.",
            { status: 503, code: "integration_revocation_state_invalid" }
          );
        }
        if (!existing) {
          this.state.storage.sql.exec(
            `INSERT INTO integration_revocation_namespaces
              (integration_id, feature_id, namespace_id, schema_version,
               mutation_version, fingerprint, meaningful)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            integrationId,
            manifest.featureId,
            manifest.namespaceId,
            manifest.schemaVersion,
            manifest.mutationVersion,
            manifest.fingerprint,
            manifest.meaningful ? 1 : 0
          );
        }
      }
      const repaired = this.repairDefaultLinksForRevokedIntegration(
        integrationId,
        nowMs
      );
      for (const edge of repaired.unavailableEdges) {
        this.recordStandaloneSuccessor(edge, integration, nowMs);
      }
      this.state.storage.sql.exec(
        `UPDATE integrations
         SET status = 'revoked', updated_at_ms = ?, revoked_at_ms = ?,
             revoked_reason = ?
         WHERE integration_id = ? AND status = 'revoking'`,
        nowMs,
        nowMs,
        job.reason,
        integrationId
      );
      audit(this.state.storage.sql, {
        integrationId,
        event: "integration.revoked.v1",
        actor: job.actor_platform && job.actor_id
          ? { platform: job.actor_platform, id: job.actor_id }
          : null,
        groupKey: job.group_key,
        occurredAtMs: nowMs
      });
      this.state.storage.sql.exec(
        "DELETE FROM integration_revocation_jobs WHERE integration_id = ?",
        integrationId
      );
      return {
        revoked: true,
        alreadyRevoked: false,
        integration: this.getIntegration(integrationId)
      };
    });
  }

  async revokeIntegration(input) {
    const integrationId = validatedOpaqueId(input?.integrationId, "Integration ID");
    const group = validatedGroup(input?.group);
    const actor = validatedActor(input?.actor, group.platform);
    const reason = typeof input?.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 100)
      : "unlinked";
    const begun = this.beginIntegrationRevocation({
      integrationId,
      group,
      actor,
      reason
    });
    if (begun.alreadyRevoked) {
      return { revoked: false, alreadyRevoked: true, integration: begun.integration };
    }
    await this.armNextExpiration();
    try {
      return await this.completeIntegrationRevocation(integrationId);
    } finally {
      await this.armNextExpiration();
    }
  }

  async processGroupRevocationBatch(groupKey) {
    const inFlight = this.groupRevocations.get(groupKey);
    if (inFlight) return await inFlight;
    const operation = this.performGroupRevocationBatch(groupKey);
    this.groupRevocations.set(groupKey, operation);
    try {
      return await operation;
    } finally {
      if (this.groupRevocations.get(groupKey) === operation) {
        this.groupRevocations.delete(groupKey);
      }
    }
  }

  async performGroupRevocationBatch(groupKey) {
    const startedAtMs = Date.now();
    const job = this.state.storage.sql.exec(
      `SELECT group_key, actor_platform, actor_id, reason
       FROM integration_group_revocations
       WHERE group_key = ?`,
      groupKey
    ).toArray()[0];
    if (!job) return { revoked: 0, pending: false };

    const rows = this.state.storage.sql.exec(
      `SELECT i.integration_id
       FROM integration_members member
       JOIN integrations i
         ON i.integration_id = member.integration_id
        AND i.status IN ('active', 'revoking')
       WHERE member.group_key = ?
       ORDER BY i.created_at_ms ASC
       LIMIT ?`,
      groupKey,
      REGISTRY_MAINTENANCE_BATCH_SIZE
    ).toArray();
    const actor = job.actor_platform && job.actor_id
      ? { platform: job.actor_platform, id: job.actor_id }
      : null;
    let revoked = 0;
    for (const [processed, row] of rows.entries()) {
      if (!alarmDrainTimeRemaining(startedAtMs, processed)) break;
      const integration = this.getIntegration(row.integration_id);
      if (integration.status === "active") {
        this.beginIntegrationRevocation({
          integrationId: row.integration_id,
          group: parseGroupKey(groupKey),
          actor,
          reason: job.reason
        });
      }
      const completed = await this.completeIntegrationRevocation(
        row.integration_id
      );
      if (completed.revoked) revoked += 1;
    }
    const pending = Boolean(this.state.storage.sql.exec(
      `SELECT 1 AS present
       FROM integration_members member
       JOIN integrations i
         ON i.integration_id = member.integration_id
        AND i.status IN ('active', 'revoking')
       WHERE member.group_key = ?
       LIMIT 1`,
      groupKey
    ).toArray()[0]);
    if (!pending) {
      this.state.storage.sql.exec(
        "DELETE FROM integration_group_revocations WHERE group_key = ?",
        groupKey
      );
    } else {
      this.state.storage.sql.exec(
        `UPDATE integration_group_revocations SET requested_at_ms = ?
         WHERE group_key = ?`,
        Date.now(),
        groupKey
      );
    }
    return { revoked, pending };
  }

  async revokeForGroup(input) {
    const group = validatedGroup(input?.group);
    const actor = input?.actor === null || input?.actor === undefined
      ? null
      : validatedActor(input.actor, group.platform);
    const reason = typeof input?.reason === "string" && input.reason.length > 0
      ? input.reason.slice(0, 100)
      : "group_authorization_revoked";
    this.state.storage.transactionSync(() => {
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
    });
    await this.armNextExpiration();
    try {
      return await this.processGroupRevocationBatch(group.key);
    } finally {
      await this.armNextExpiration();
    }
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
        `DELETE FROM integration_pending_namespace_resolutions
         WHERE invitation_id IN (${placeholders})`,
        ...invitationIds
      );
      this.state.storage.sql.exec(
        `DELETE FROM integration_pending_resolutions
         WHERE invitation_id IN (${placeholders})`,
        ...invitationIds
      );
      this.state.storage.sql.exec(
        `DELETE FROM integration_pending_namespace_discoveries
         WHERE invitation_id IN (${placeholders})`,
        ...invitationIds
      );
      this.state.storage.sql.exec(
        `DELETE FROM integration_pending_discoveries
         WHERE invitation_id IN (${placeholders})`,
        ...invitationIds
      );
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

  async processNextGroupRevocation() {
    const job = this.state.storage.sql.exec(
      `SELECT group_key
       FROM integration_group_revocations
       ORDER BY requested_at_ms ASC, group_key ASC
       LIMIT 1`
    ).toArray()[0];
    return job
      ? await this.processGroupRevocationBatch(job.group_key)
      : { revoked: 0, pending: false };
  }

  async processNextIntegrationRevocation() {
    const job = this.state.storage.sql.exec(
      `SELECT integration_id
       FROM integration_revocation_jobs
       ORDER BY requested_at_ms ASC, integration_id ASC
       LIMIT 1`
    ).toArray()[0];
    return job
      ? await this.completeIntegrationRevocation(job.integration_id)
      : null;
  }

  async alarm() {
    try {
      await this.durableEventAppendTail;
      await this.expireInvitations();
      this.pruneTerminalInvitations();
      await this.processNextGroupRevocation();
      await this.processNextIntegrationRevocation();
      await drainStateQueryBindingNotifications(this.state, this.env);
      await drainDurableEventBindingNotifications(this.state, this.env);
    } finally {
      await this.armNextExpiration();
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (
        request.method === "POST" &&
        BINDING_LIFECYCLE_MUTATION_PATHS.has(url.pathname)
      ) {
        await this.durableEventAppendTail;
        await prepareStateQueryBindingMutation(this.state);
        await prepareDurableEventBindingMutation(this.state);
      }
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
      if (
        request.method === "POST" &&
        url.pathname === "/invitations/resolve-state"
      ) {
        return noStoreJson(await this.resolveInvitationState(await request.json()));
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
        const result = this.setDefaultLink(await request.json());
        await this.armNextExpiration();
        return noStoreJson(result);
      }
      if (request.method === "POST" && url.pathname === "/state-query/bindings/get") {
        const input = await request.json();
        return noStoreJson({
          binding: this.stateQueryBinding(input?.sourceGroup, input?.targetPlatform)
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/state-query/bindings/register"
      ) {
        const result = this.registerStateQueryBindingWatcher(await request.json());
        await this.armNextExpiration();
        return noStoreJson(result);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/state-query/bindings/unregister"
      ) {
        const result = this.unregisterStateQueryBindingWatcher(await request.json());
        await this.armNextExpiration();
        return noStoreJson(result);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/shareable-state/resolve"
      ) {
        return noStoreJson(await this.resolveEffectiveShareableState(
          await request.json()
        ));
      }
      if (
        request.method === "POST" &&
        url.pathname === "/durable-events/append"
      ) {
        const input = await request.json();
        const result = await this.appendDurableEvent(input);
        await this.armNextExpiration();
        return noStoreJson(result);
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
        return noStoreJson(await this.revokeIntegration(await request.json()));
      }
      if (request.method === "POST" && url.pathname === "/groups/revoke") {
        return noStoreJson(await this.revokeForGroup(await request.json()));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (
        error instanceof IntegrationRegistryError ||
        error instanceof StateQueryNotificationError ||
        error instanceof DurableEventBindingError ||
        error instanceof DurableEventError
      ) {
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
