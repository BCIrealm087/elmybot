export function initializeRegistryTables(state) {
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

    CREATE INDEX IF NOT EXISTS integration_invitations_pending_expiry
      ON integration_invitations(status, expires_at_ms);

    CREATE INDEX IF NOT EXISTS integration_invitations_reservation_expiry
      ON integration_invitations(status, reservation_expires_at_ms);

    CREATE INDEX IF NOT EXISTS integration_invitations_completed
      ON integration_invitations(status, completed_at_ms);

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

    CREATE TABLE IF NOT EXISTS integration_default_links (
      source_group_key TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      integration_id TEXT NOT NULL,
      target_group_key TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (source_group_key, target_platform)
    );

    CREATE INDEX IF NOT EXISTS integration_default_links_integration
      ON integration_default_links(integration_id, source_group_key, target_platform);

    CREATE INDEX IF NOT EXISTS integrations_status_created
      ON integrations(status, created_at_ms, integration_id);

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

    CREATE TABLE IF NOT EXISTS integration_group_revocations (
      group_key TEXT PRIMARY KEY,
      actor_platform TEXT,
      actor_id TEXT,
      reason TEXT NOT NULL,
      requested_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS integration_group_revocations_requested
      ON integration_group_revocations(requested_at_ms, group_key);
  `);

  // Stepwise deployments may already contain active integrations created
  // before directional defaults existed. Remove only invalid/stale selections,
  // then deterministically choose the oldest active edge for each missing
  // source-group/target-platform pair. Existing valid choices are preserved.
  state.storage.sql.exec(`
    DELETE FROM integration_default_links AS default_link
    WHERE NOT EXISTS (
      SELECT 1
      FROM integrations integration
      JOIN integration_members source_member
        ON source_member.integration_id = integration.integration_id
       AND source_member.group_key = default_link.source_group_key
      JOIN integration_members target_member
        ON target_member.integration_id = integration.integration_id
       AND target_member.group_key = default_link.target_group_key
       AND target_member.platform = default_link.target_platform
      WHERE integration.integration_id = default_link.integration_id
        AND integration.status = 'active'
    );

    INSERT INTO integration_default_links
      (source_group_key, target_platform, integration_id, target_group_key,
       created_at_ms, updated_at_ms)
    SELECT source_group_key, target_platform, integration_id, target_group_key,
           created_at_ms, created_at_ms
    FROM (
      SELECT source_member.group_key AS source_group_key,
             target_member.platform AS target_platform,
             integration.integration_id,
             target_member.group_key AS target_group_key,
             integration.created_at_ms,
             ROW_NUMBER() OVER (
               PARTITION BY source_member.group_key, target_member.platform
               ORDER BY integration.created_at_ms, integration.integration_id,
                        target_member.group_key
             ) AS preference
      FROM integrations integration
      JOIN integration_members source_member
        ON source_member.integration_id = integration.integration_id
      JOIN integration_members target_member
        ON target_member.integration_id = integration.integration_id
       AND target_member.platform <> source_member.platform
      WHERE integration.status = 'active'
    ) candidates
    WHERE preference = 1
    ON CONFLICT(source_group_key, target_platform) DO NOTHING;
  `);
}
