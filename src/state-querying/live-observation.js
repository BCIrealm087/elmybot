import { createPlatformGroupRef } from "../integrations/contracts.js";
import { recordStateQueryMetric } from "./operations.js";
import { featureRegistry } from "../features/index.js";
import {
  validateStateQueryGrantReference,
  StateQueryCredentialError,
  stateQueryEnvironment
} from "./grant-client.js";
import {
  authorizeStateQueryBinding,
  authorizeStateQueryPlan
} from "./grants.js";
import { evaluateStateQuery } from "./evaluator.js";
import {
  canonicalStateQueryJson,
  prepareStateQuery,
  StateQueryError,
  stateQueryDigest
} from "./query.js";

const QUERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 5 * 60;
const DEFAULT_LEASE_SECONDS = 2 * 60;
const MAX_ACTIVE_QUERIES = 400;
const MAX_DISTINCT_PLANS = 100;
const MAX_EDGES_PER_QUERY = 40;
const MAX_ACTIVE_EDGES = 2_000;
const DRAIN_BATCH_SIZE = 20;
const DRAIN_CONCURRENCY = 4;
const ATTACH_ATTEMPTS = 3;
const ATTEMPT_LEASE_MS = 30 * 1000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30 * 1000;
const AUTHORIZATION_CHECK_MS = 30 * 1000;

export const STATE_QUERY_LIVE_PATHS = Object.freeze({
  attach: "/internal/state-query/live/attach",
  renew: "/internal/state-query/live/renew",
  remove: "/internal/state-query/live/remove",
  get: "/internal/state-query/live/get"
});

export const STATE_QUERY_LIVE_LIMITS = Object.freeze({
  minLeaseSeconds: MIN_LEASE_SECONDS,
  maxLeaseSeconds: MAX_LEASE_SECONDS,
  defaultLeaseSeconds: DEFAULT_LEASE_SECONDS,
  maxActiveQueries: MAX_ACTIVE_QUERIES,
  maxDistinctPlans: MAX_DISTINCT_PLANS,
  maxEdgesPerQuery: MAX_EDGES_PER_QUERY,
  maxActiveEdges: MAX_ACTIVE_EDGES,
  drainBatchSize: DRAIN_BATCH_SIZE
});

export class StateQueryLiveError extends Error {
  constructor(message, {
    status = 422,
    code = "state_query_live_invalid",
    cause
  } = {}) {
    super(message, { cause });
    this.name = "StateQueryLiveError";
    this.status = status;
    this.code = code;
  }
}

function fail(message, options) {
  throw new StateQueryLiveError(message, options);
}

function normalizedTarget(value) {
  try {
    const group = createPlatformGroupRef({
      platform: value?.platform,
      kind: value?.platform === "discord" ? "guild" : "channel",
      id: value?.groupId ?? value?.id
    });
    return Object.freeze({
      platform: group.platform,
      groupId: group.id,
      group
    });
  } catch {
    fail("Live-query target is invalid.");
  }
}

function queryId(value) {
  if (typeof value !== "string" || !QUERY_ID_PATTERN.test(value)) {
    fail("Live-query ID is invalid.");
  }
  return value;
}

function leaseSeconds(value) {
  const selected = value ?? DEFAULT_LEASE_SECONDS;
  if (
    !Number.isSafeInteger(selected) ||
    selected < MIN_LEASE_SECONDS ||
    selected > MAX_LEASE_SECONDS
  ) {
    fail(
      `Live-query lease must be between ${MIN_LEASE_SECONDS} and ` +
      `${MAX_LEASE_SECONDS} seconds.`
    );
  }
  return selected;
}

function counterpart(platform) {
  return platform === "discord" ? "twitch" : "discord";
}

export function initializeLiveObservationTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS state_query_observer_queries (
      query_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      query_digest TEXT NOT NULL,
      query_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      result_revision TEXT NOT NULL,
      result_sequence INTEGER NOT NULL CHECK (result_sequence >= 1),
      query_state TEXT NOT NULL CHECK (query_state IN ('active', 'denied')),
      error_code TEXT,
      pending_reason TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
      next_authorization_at_ms INTEGER NOT NULL,
      lease_expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS state_query_observer_queries_due
      ON state_query_observer_queries(query_state, pending_reason,
                                      next_attempt_at_ms);
    CREATE INDEX IF NOT EXISTS state_query_observer_queries_expiry
      ON state_query_observer_queries(lease_expires_at_ms);

    CREATE TABLE IF NOT EXISTS state_query_observer_sources (
      edge_key TEXT PRIMARY KEY,
      watcher_id TEXT NOT NULL UNIQUE,
      source_kind TEXT NOT NULL CHECK (
        source_kind IN ('group_local', 'shareable', 'binding')
      ),
      attachment_json TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
      lease_expires_at_ms INTEGER NOT NULL,
      source_state TEXT NOT NULL CHECK (source_state IN ('active', 'detaching')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS state_query_observer_sources_due
      ON state_query_observer_sources(source_state, next_attempt_at_ms);

    CREATE TABLE IF NOT EXISTS state_query_observer_query_sources (
      query_id TEXT NOT NULL,
      edge_key TEXT NOT NULL,
      dependency_kinds_json TEXT NOT NULL,
      PRIMARY KEY (query_id, edge_key)
    );

    CREATE INDEX IF NOT EXISTS state_query_observer_query_sources_edge
      ON state_query_observer_query_sources(edge_key, query_id);
  `);
}

function bindObserver(state, environment, target, nowMs) {
  const existing = state.storage.sql.exec(
    `SELECT environment, target_platform, target_group_id
     FROM state_query_observer_meta WHERE singleton = 1`
  ).toArray()[0];
  if (existing && (
    existing.environment !== environment ||
    existing.target_platform !== target.platform ||
    existing.target_group_id !== target.groupId
  )) {
    fail("Live query does not belong to this observer.", {
      status: 409,
      code: "state_query_observer_identity_mismatch"
    });
  }
  if (!existing) {
    state.storage.sql.exec(
      `INSERT INTO state_query_observer_meta
        (singleton, environment, target_platform, target_group_id, created_at_ms)
       VALUES (1, ?, ?, ?, ?)`,
      environment,
      target.platform,
      target.groupId,
      nowMs
    );
  }
}

function observerTarget(state) {
  const row = state.storage.sql.exec(
    `SELECT environment, target_platform, target_group_id
     FROM state_query_observer_meta WHERE singleton = 1`
  ).toArray()[0];
  if (!row) return null;
  return {
    environment: row.environment,
    target: normalizedTarget({
      platform: row.target_platform,
      groupId: row.target_group_id
    })
  };
}

async function watcherClient() {
  return await import("./watcher-client.js");
}

function attachmentInput(descriptor, target, watcherId, selectedLeaseSeconds) {
  return {
    ...descriptor.attachment,
    target: { platform: target.platform, groupId: target.groupId },
    watcherId,
    expectedRevision: descriptor.expectedRevision,
    leaseSeconds: selectedLeaseSeconds
  };
}

async function registerDescriptor(env, descriptor, target, watcherId, selectedLeaseSeconds) {
  const api = await watcherClient();
  const input = attachmentInput(
    descriptor,
    target,
    watcherId,
    selectedLeaseSeconds
  );
  if (descriptor.kind === "group_local") {
    return await api.registerLocalStateQueryWatcher(env, input);
  }
  if (descriptor.kind === "shareable") {
    return await api.registerShareableStateQueryWatcher(env, input);
  }
  return await api.registerStateQueryBindingWatcher(env, input);
}

async function unregisterDescriptor(env, row, target) {
  const api = await watcherClient();
  const descriptor = JSON.parse(row.attachment_json);
  const input = {
    ...descriptor,
    target: { platform: target.platform, groupId: target.groupId },
    watcherId: row.watcher_id
  };
  if (row.source_kind === "group_local") {
    return await api.unregisterLocalStateQueryWatcher(env, input);
  }
  if (row.source_kind === "shareable") {
    return await api.unregisterShareableStateQueryWatcher(env, input);
  }
  return await api.unregisterStateQueryBindingWatcher(env, input);
}

function descriptorsFromEvaluation(result) {
  if (result.envelope.status !== "ready") return [];
  const dependencies = result.observation.dependencies;
  const source = result.observation.sourceWatches.map((watch) => {
    const { binding, expectedRevision, kind, ...attachment } = watch;
    return {
      kind,
      attachment,
      expectedRevision,
      dependencyKinds: [...new Set(dependencies
        .filter((dependency) => dependency.source === binding)
        .map((dependency) => dependency.kind))].sort()
    };
  });
  const bindings = result.observation.bindingWatches.map((watch) => {
    const { expectedRevision, ...attachment } = watch;
    return {
      kind: "binding",
      attachment,
      expectedRevision,
      dependencyKinds: ["binding"]
    };
  });
  return [...source, ...bindings];
}

async function bindingDescriptorsForPlan(env, plan) {
  const needsBinding = Object.values(plan.bindings).some(
    ({ definition }) => definition.scope.kind === "effective_shareable"
  );
  if (!needsBinding) return [];
  const target = normalizedTarget(plan.query.target);
  const targetPlatform = counterpart(target.platform);
  const api = await watcherClient();
  const current = await api.getStateQueryBinding(env, {
    sourceGroup: target.group,
    targetPlatform
  });
  return [{
    kind: "binding",
    attachment: {
      sourceGroup: target.group,
      targetPlatform
    },
    expectedRevision: current.binding.revision,
    dependencyKinds: ["binding"]
  }];
}

async function preparedDescriptors(target, descriptors) {
  const prepared = [];
  for (const descriptor of descriptors) {
    const edgeKey = await stateQueryDigest({
      target: { platform: target.platform, groupId: target.groupId },
      kind: descriptor.kind,
      attachment: descriptor.attachment
    });
    prepared.push({
      ...descriptor,
      edgeKey,
      watcherId: `sqe:${edgeKey}`
    });
  }
  return [...new Map(prepared.map((descriptor) => [
    descriptor.edgeKey,
    descriptor
  ])).values()];
}

async function authorizedEvaluation(env, grantId, query, reason) {
  const plan = await prepareStateQuery(featureRegistry, query);
  const grant = await validateStateQueryGrantReference(env, {
    target: plan.query.target,
    grantId
  });
  authorizeStateQueryPlan(plan, grant);
  const result = await evaluateStateQuery(featureRegistry, plan.query, {
    env,
    preparedPlan: plan,
    correlationId: `state-query-live:${crypto.randomUUID()}`,
    reason,
    authorizeBinding: (binding, argumentsValue) =>
      authorizeStateQueryBinding(grant, binding, argumentsValue),
    maxResultBytes: grant.limits.maxResultBytes
  });
  const descriptors = result.envelope.status === "ready"
    ? descriptorsFromEvaluation(result)
    : await bindingDescriptorsForPlan(env, plan);
  return { plan, grant, result, descriptors };
}

function existingSourceRows(state, edgeKeys) {
  const rows = new Map();
  for (const edgeKey of edgeKeys) {
    const row = state.storage.sql.exec(
      `SELECT edge_key, watcher_id, source_kind, attachment_json,
              expected_revision, lease_expires_at_ms, source_state
       FROM state_query_observer_sources WHERE edge_key = ?`,
      edgeKey
    ).toArray()[0];
    if (row) rows.set(edgeKey, row);
  }
  return rows;
}

async function attachDescriptors(state, env, target, descriptors, selectedLeaseSeconds) {
  const existing = existingSourceRows(state, descriptors.map(({ edgeKey }) => edgeKey));
  const attached = [];
  for (let index = 0; index < descriptors.length; index += DRAIN_CONCURRENCY) {
    const batch = descriptors.slice(index, index + DRAIN_CONCURRENCY);
    const results = await Promise.all(batch.map(async (descriptor) => ({
      descriptor,
      result: await registerDescriptor(
        env,
        descriptor,
        target,
        descriptor.watcherId,
        selectedLeaseSeconds
      )
    })));
    attached.push(...results);
  }
  const mismatched = attached.some(({ result }) => !result.revisionMatched);
  if (mismatched) {
    await Promise.allSettled(attached
      .filter(({ descriptor }) => !existing.has(descriptor.edgeKey))
      .map(({ descriptor }) => unregisterDescriptor(env, {
        watcher_id: descriptor.watcherId,
        source_kind: descriptor.kind,
        attachment_json: JSON.stringify(descriptor.attachment)
      }, target)));
  }
  return { attached, mismatched };
}

function sharedLeaseSeconds(
  state,
  edgeKey,
  requestedLeaseExpiresAtMs,
  nowMs,
  excludedQueryId = null
) {
  const shared = state.storage.sql.exec(
    `SELECT MAX(query.lease_expires_at_ms) AS lease_expires_at_ms
     FROM state_query_observer_query_sources relation
     JOIN state_query_observer_queries query ON query.query_id = relation.query_id
     WHERE relation.edge_key = ? AND query.query_state = 'active'
       AND (? IS NULL OR query.query_id != ?)`,
    edgeKey,
    excludedQueryId,
    excludedQueryId
  ).toArray()[0]?.lease_expires_at_ms;
  const requiredUntilMs = Math.max(
    requestedLeaseExpiresAtMs,
    Number(shared ?? 0)
  );
  return Math.max(
    MIN_LEASE_SECONDS,
    Math.min(MAX_LEASE_SECONDS, Math.ceil((requiredUntilMs - nowMs) / 1000))
  );
}

function markOrphanSources(state, nowMs) {
  state.storage.sql.exec(
    `UPDATE state_query_observer_sources
     SET source_state = 'detaching', next_attempt_at_ms = 0, updated_at_ms = ?
     WHERE source_state = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM state_query_observer_query_sources relation
         WHERE relation.edge_key = state_query_observer_sources.edge_key
       )`,
    nowMs
  );
}

function checkAdmission(state, selectedQueryId, plan, descriptors) {
  const existing = existingQuery(state, selectedQueryId);
  const queryTotal = Number(state.storage.sql.exec(
    "SELECT COUNT(*) AS total FROM state_query_observer_queries"
  ).one().total);
  if (!existing && queryTotal >= MAX_ACTIVE_QUERIES) {
    fail("This group observer has too many active queries.", {
      status: 429,
      code: "state_query_live_capacity"
    });
  }
  const distinctTotal = Number(state.storage.sql.exec(
    "SELECT COUNT(DISTINCT query_digest) AS total FROM state_query_observer_queries"
  ).one().total);
  if (
    !existing &&
    distinctTotal >= MAX_DISTINCT_PLANS &&
    !state.storage.sql.exec(
      `SELECT 1 AS found FROM state_query_observer_queries
       WHERE query_digest = ? LIMIT 1`,
      plan.digest
    ).toArray()[0]
  ) {
    fail("This group observer has too many distinct query plans.", {
      status: 429,
      code: "state_query_live_capacity"
    });
  }
  const currentEdges = Number(state.storage.sql.exec(
    "SELECT COUNT(*) AS total FROM state_query_observer_sources"
  ).one().total);
  const newEdges = descriptors.filter(({ edgeKey }) =>
    !state.storage.sql.exec(
      "SELECT 1 AS found FROM state_query_observer_sources WHERE edge_key = ?",
      edgeKey
    ).toArray()[0]
  ).length;
  if (currentEdges + newEdges > MAX_ACTIVE_EDGES) {
    fail("This group observer has too many active dependency edges.", {
      status: 429,
      code: "state_query_live_capacity"
    });
  }
}

function storeEvaluation(
  state,
  {
    selectedQueryId,
    grantId,
    plan,
    grant,
    result,
    descriptors,
    attached,
    selectedLeaseSeconds,
    nowMs,
    keepPending = false,
    fixedLeaseExpiresAtMs = null
  }
) {
  const existing = state.storage.sql.exec(
    `SELECT result_revision, result_sequence FROM state_query_observer_queries
     WHERE query_id = ?`,
    selectedQueryId
  ).toArray()[0];
  const changed = existing?.result_revision !== result.envelope.resultRevision;
  const sequence = existing
    ? Number(existing.result_sequence) + (changed ? 1 : 0)
    : 1;
  const leaseExpiresAtMs = fixedLeaseExpiresAtMs ??
    nowMs + selectedLeaseSeconds * 1000;
  const nextAuthorizationAtMs = Math.min(
    grant.expiresAtMs,
    nowMs + AUTHORIZATION_CHECK_MS
  );
  state.storage.transactionSync(() => {
    const queryTotal = Number(state.storage.sql.exec(
      "SELECT COUNT(*) AS total FROM state_query_observer_queries"
    ).one().total);
    const distinctTotal = Number(state.storage.sql.exec(
      "SELECT COUNT(DISTINCT query_digest) AS total FROM state_query_observer_queries"
    ).one().total);
    if (!existing && queryTotal >= MAX_ACTIVE_QUERIES) {
      fail("This group observer has too many active queries.", {
        status: 429,
        code: "state_query_live_capacity"
      });
    }
    if (
      !existing &&
      distinctTotal >= MAX_DISTINCT_PLANS &&
      !state.storage.sql.exec(
        `SELECT 1 AS found FROM state_query_observer_queries
         WHERE query_digest = ? LIMIT 1`,
        plan.digest
      ).toArray()[0]
    ) {
      fail("This group observer has too many distinct query plans.", {
        status: 429,
        code: "state_query_live_capacity"
      });
    }
    const currentEdges = Number(state.storage.sql.exec(
      "SELECT COUNT(*) AS total FROM state_query_observer_sources"
    ).one().total);
    const newEdges = descriptors.filter(({ edgeKey }) =>
      !state.storage.sql.exec(
        "SELECT 1 AS found FROM state_query_observer_sources WHERE edge_key = ?",
        edgeKey
      ).toArray()[0]
    ).length;
    if (currentEdges + newEdges > MAX_ACTIVE_EDGES) {
      fail("This group observer has too many active dependency edges.", {
        status: 429,
        code: "state_query_live_capacity"
      });
    }
    state.storage.sql.exec(
      `INSERT INTO state_query_observer_queries
        (query_id, grant_id, query_digest, query_json, envelope_json,
         dependencies_json, result_revision, result_sequence, query_state,
         error_code, pending_reason, attempt_count, next_attempt_at_ms,
         next_authorization_at_ms, lease_expires_at_ms, created_at_ms,
         updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(query_id) DO UPDATE SET
         envelope_json = excluded.envelope_json,
         dependencies_json = excluded.dependencies_json,
         result_revision = excluded.result_revision,
         result_sequence = excluded.result_sequence,
         query_state = 'active', error_code = NULL,
         pending_reason = excluded.pending_reason,
         attempt_count = 0,
         next_attempt_at_ms = excluded.next_attempt_at_ms,
         next_authorization_at_ms = excluded.next_authorization_at_ms,
         lease_expires_at_ms = excluded.lease_expires_at_ms,
         updated_at_ms = excluded.updated_at_ms`,
      selectedQueryId,
      grantId,
      plan.digest,
      canonicalStateQueryJson(plan.query),
      canonicalStateQueryJson(result.envelope),
      canonicalStateQueryJson(result.observation?.dependencies ?? []),
      result.envelope.resultRevision,
      sequence,
      keepPending ? "dependency_changed" : null,
      keepPending ? nowMs + RETRY_BASE_MS : 0,
      nextAuthorizationAtMs,
      leaseExpiresAtMs,
      nowMs,
      nowMs
    );
    for (const { descriptor, result: registration } of attached) {
      state.storage.sql.exec(
        `INSERT INTO state_query_observer_sources
          (edge_key, watcher_id, source_kind, attachment_json,
           expected_revision, lease_expires_at_ms, source_state,
           attempt_count, next_attempt_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 0, ?, ?)
         ON CONFLICT(edge_key) DO UPDATE SET
           expected_revision = excluded.expected_revision,
           lease_expires_at_ms = excluded.lease_expires_at_ms,
           source_state = 'active', attempt_count = 0,
           next_attempt_at_ms = 0, updated_at_ms = excluded.updated_at_ms`,
        descriptor.edgeKey,
        descriptor.watcherId,
        descriptor.kind,
        canonicalStateQueryJson(descriptor.attachment),
        descriptor.expectedRevision,
        registration.leaseExpiresAtMs,
        nowMs,
        nowMs
      );
    }
    state.storage.sql.exec(
      "DELETE FROM state_query_observer_query_sources WHERE query_id = ?",
      selectedQueryId
    );
    for (const descriptor of descriptors) {
      state.storage.sql.exec(
        `INSERT INTO state_query_observer_query_sources
          (query_id, edge_key, dependency_kinds_json)
         VALUES (?, ?, ?)`,
        selectedQueryId,
        descriptor.edgeKey,
        canonicalStateQueryJson(descriptor.dependencyKinds)
      );
    }
    markOrphanSources(state, nowMs);
  });
  return {
    queryId: selectedQueryId,
    envelope: result.envelope,
    sequence,
    changed,
    leaseExpiresAtMs
  };
}

async function evaluateAttachAndSwap(
  state,
  env,
  {
    selectedQueryId,
    grantId,
    query,
    reason,
    selectedLeaseSeconds,
    fixedLeaseExpiresAtMs = null
  }
) {
  const target = normalizedTarget(query?.target);
  for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
    const evaluated = await authorizedEvaluation(env, grantId, query, reason);
    let descriptors = await preparedDescriptors(target, evaluated.descriptors);
    if (descriptors.length > MAX_EDGES_PER_QUERY) {
      fail("Live query exceeds the dependency-edge limit.", {
        status: 413,
        code: "query_limit_exceeded"
      });
    }
    checkAdmission(state, selectedQueryId, evaluated.plan, descriptors);
    const nowMs = Date.now();
    const requestedLeaseExpiresAtMs = fixedLeaseExpiresAtMs ??
      nowMs + selectedLeaseSeconds * 1000;
    const attachmentLeaseSeconds = descriptors.reduce(
      (longest, descriptor) => Math.max(longest, sharedLeaseSeconds(
        state,
        descriptor.edgeKey,
        requestedLeaseExpiresAtMs,
        nowMs,
        selectedQueryId
      )),
      selectedLeaseSeconds
    );
    const registration = await attachDescriptors(
      state,
      env,
      target,
      descriptors,
      attachmentLeaseSeconds
    );
    if (registration.mismatched) continue;
    return storeEvaluation(state, {
      selectedQueryId,
      grantId,
      ...evaluated,
      descriptors,
      attached: registration.attached,
      selectedLeaseSeconds,
      nowMs: Date.now(),
      keepPending: evaluated.result.envelope.status === "unavailable",
      fixedLeaseExpiresAtMs
    });
  }
  fail("Live-query dependencies changed during attachment.", {
    status: 503,
    code: "query_evaluation_unstable"
  });
}

function existingQuery(state, selectedQueryId) {
  return state.storage.sql.exec(
    `SELECT query_id, grant_id, query_digest, query_json, envelope_json,
            dependencies_json, result_revision, result_sequence, query_state,
            error_code, pending_reason, lease_expires_at_ms
     FROM state_query_observer_queries WHERE query_id = ?`,
    selectedQueryId
  ).toArray()[0] ?? null;
}

function publicQuery(row) {
  if (!row) return null;
  return {
    queryId: row.query_id,
    state: row.query_state,
    sequence: Number(row.result_sequence),
    envelope: JSON.parse(row.envelope_json),
    dependencies: JSON.parse(row.dependencies_json),
    pending: row.pending_reason !== null,
    errorCode: row.error_code ?? null,
    leaseExpiresAtMs: Number(row.lease_expires_at_ms)
  };
}

export async function attachLiveStateQuery(state, env, input) {
  const selectedQueryId = queryId(input?.queryId);
  const selectedLeaseSeconds = leaseSeconds(input?.leaseSeconds);
  const target = normalizedTarget(input?.query?.target);
  const environment = stateQueryEnvironment(env);
  const nowMs = Date.now();
  bindObserver(state, environment, target, nowMs);
  const existing = existingQuery(state, selectedQueryId);
  if (existing && (
    existing.grant_id !== input?.grantId ||
    existing.query_json !== canonicalStateQueryJson(input?.query)
  )) {
    fail("Live-query ID is already attached to another query.", {
      status: 409,
      code: "state_query_live_conflict"
    });
  }
  const result = await evaluateAttachAndSwap(state, env, {
    selectedQueryId,
    grantId: input?.grantId,
    query: input?.query,
    reason: existing ? "resynchronized" : "initial",
    selectedLeaseSeconds
  });
  await cleanupDetachedSources(state, env);
  await scheduleLiveObservationAlarm(state);
  return result;
}

export async function renewLiveStateQuery(state, env, input) {
  const selectedQueryId = queryId(input?.queryId);
  const selectedLeaseSeconds = leaseSeconds(input?.leaseSeconds);
  const row = existingQuery(state, selectedQueryId);
  if (!row || row.query_state !== "active") {
    fail("Live query was not found.", {
      status: 404,
      code: "state_query_live_not_found"
    });
  }
  const target = observerTarget(state)?.target;
  const grant = await validateStateQueryGrantReference(env, {
    target,
    grantId: row.grant_id
  });
  const sourceRows = state.storage.sql.exec(
    `SELECT source.edge_key, source.watcher_id, source.source_kind,
            source.attachment_json, source.expected_revision
     FROM state_query_observer_sources source
     JOIN state_query_observer_query_sources relation
       ON relation.edge_key = source.edge_key
     WHERE relation.query_id = ? AND source.source_state = 'active'`,
    selectedQueryId
  ).toArray();
  let mismatch = false;
  const registrations = [];
  const requestedLeaseExpiresAtMs = Date.now() + selectedLeaseSeconds * 1000;
  for (const source of sourceRows) {
    const sourceLeaseSeconds = sharedLeaseSeconds(
      state,
      source.edge_key,
      requestedLeaseExpiresAtMs,
      Date.now(),
      selectedQueryId
    );
    const registration = await registerDescriptor(env, {
      kind: source.source_kind,
      attachment: JSON.parse(source.attachment_json),
      expectedRevision: Number(source.expected_revision)
    }, target, source.watcher_id, sourceLeaseSeconds);
    mismatch ||= !registration.revisionMatched;
    registrations.push({ source, registration });
  }
  const nowMs = Date.now();
  const expiresAtMs = nowMs + selectedLeaseSeconds * 1000;
  state.storage.transactionSync(() => {
    state.storage.sql.exec(
      `UPDATE state_query_observer_queries
       SET lease_expires_at_ms = ?, next_authorization_at_ms = ?,
           pending_reason = CASE WHEN ? THEN 'dependency_changed'
                                 ELSE pending_reason END,
           next_attempt_at_ms = CASE WHEN ? THEN 0 ELSE next_attempt_at_ms END,
           updated_at_ms = ?
       WHERE query_id = ?`,
      expiresAtMs,
      Math.min(grant.expiresAtMs, nowMs + AUTHORIZATION_CHECK_MS),
      mismatch ? 1 : 0,
      mismatch ? 1 : 0,
      nowMs,
      selectedQueryId
    );
    for (const { source, registration } of registrations) {
      state.storage.sql.exec(
        `UPDATE state_query_observer_sources
         SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE edge_key = ?`,
        registration.leaseExpiresAtMs,
        nowMs,
        source.edge_key
      );
    }
  });
  await scheduleLiveObservationAlarm(state);
  return publicQuery(existingQuery(state, selectedQueryId));
}

export async function removeLiveStateQuery(state, env, input) {
  const selectedQueryId = queryId(input?.queryId);
  const nowMs = Date.now();
  const removed = state.storage.transactionSync(() => {
    const found = Boolean(existingQuery(state, selectedQueryId));
    state.storage.sql.exec(
      "DELETE FROM state_query_observer_query_sources WHERE query_id = ?",
      selectedQueryId
    );
    state.storage.sql.exec(
      "DELETE FROM state_query_observer_queries WHERE query_id = ?",
      selectedQueryId
    );
    markOrphanSources(state, nowMs);
    return found;
  });
  await cleanupDetachedSources(state, env);
  await scheduleLiveObservationAlarm(state);
  return { removed };
}

export function getLiveStateQuery(state, input) {
  return { query: publicQuery(existingQuery(state, queryId(input?.queryId))) };
}

export function invalidateLiveQueriesForNotification(state, notification, nowMs) {
  const reason = notification.source.kind === "binding"
    ? "source_changed"
    : "dependency_changed";
  const affected = state.storage.sql.exec(
    `SELECT DISTINCT relation.query_id
     FROM state_query_observer_query_sources relation
     JOIN state_query_observer_sources source ON source.edge_key = relation.edge_key
     JOIN state_query_observer_queries query ON query.query_id = relation.query_id
     WHERE source.watcher_id = ? AND query.query_state = 'active'`,
    notification.watcherId
  ).toArray();
  for (const row of affected) {
    state.storage.sql.exec(
      `UPDATE state_query_observer_queries
       SET pending_reason = CASE
             WHEN pending_reason = 'source_changed' THEN pending_reason
             ELSE ?
           END,
           next_attempt_at_ms = 0,
           updated_at_ms = ?
       WHERE query_id = ?`,
      reason,
      nowMs,
      row.query_id
    );
  }
  return affected.length;
}

function pruneExpiredQueries(state, nowMs) {
  const expired = state.storage.sql.exec(
    `SELECT query_id FROM state_query_observer_queries
     WHERE lease_expires_at_ms <= ?`,
    nowMs
  ).toArray();
  if (expired.length === 0) return 0;
  state.storage.transactionSync(() => {
    for (const row of expired) {
      state.storage.sql.exec(
        "DELETE FROM state_query_observer_query_sources WHERE query_id = ?",
        row.query_id
      );
      state.storage.sql.exec(
        "DELETE FROM state_query_observer_queries WHERE query_id = ?",
        row.query_id
      );
    }
    markOrphanSources(state, nowMs);
  });
  return expired.length;
}

function claimDueQueries(state, nowMs) {
  return state.storage.transactionSync(() => {
    const rows = state.storage.sql.exec(
      `SELECT query_id, grant_id, query_json, envelope_json, pending_reason,
              attempt_count, lease_expires_at_ms
       FROM state_query_observer_queries
       WHERE query_state = 'active' AND pending_reason IS NOT NULL
         AND next_attempt_at_ms <= ?
       ORDER BY next_attempt_at_ms, updated_at_ms, query_id
       LIMIT ?`,
      nowMs,
      DRAIN_BATCH_SIZE
    ).toArray();
    for (const row of rows) {
      state.storage.sql.exec(
        `UPDATE state_query_observer_queries
         SET attempt_count = attempt_count + 1, next_attempt_at_ms = ?
         WHERE query_id = ?`,
        nowMs + ATTEMPT_LEASE_MS,
        row.query_id
      );
    }
    return rows;
  });
}

async function checkDueAuthorizations(state, env, nowMs) {
  const selected = observerTarget(state);
  if (!selected) return 0;
  const rows = state.storage.sql.exec(
    `SELECT query_id, grant_id
     FROM state_query_observer_queries
     WHERE query_state = 'active' AND pending_reason IS NULL
       AND next_authorization_at_ms <= ? AND lease_expires_at_ms > ?
     ORDER BY next_authorization_at_ms, query_id
     LIMIT ?`,
    nowMs,
    nowMs,
    DRAIN_BATCH_SIZE
  ).toArray();
  for (let index = 0; index < rows.length; index += DRAIN_CONCURRENCY) {
    await Promise.all(rows.slice(index, index + DRAIN_CONCURRENCY).map(async (row) => {
      try {
        const grant = await validateStateQueryGrantReference(env, {
          target: selected.target,
          grantId: row.grant_id,
          nowMs
        });
        state.storage.sql.exec(
          `UPDATE state_query_observer_queries
           SET next_authorization_at_ms = ?, updated_at_ms = ?
           WHERE query_id = ? AND grant_id = ? AND query_state = 'active'
             AND pending_reason IS NULL`,
          Math.min(grant.expiresAtMs, nowMs + AUTHORIZATION_CHECK_MS),
          nowMs,
          row.query_id,
          row.grant_id
        );
      } catch (error) {
        if (error instanceof StateQueryCredentialError) {
          denyQuery(state, row.query_id, error.code, Date.now());
          return;
        }
        recordStateQueryMetric(state, "authorizationRetries");
        state.storage.sql.exec(
          `UPDATE state_query_observer_queries
           SET next_authorization_at_ms = ?, updated_at_ms = ?
           WHERE query_id = ? AND query_state = 'active'`,
          nowMs + RETRY_BASE_MS,
          nowMs,
          row.query_id
        );
      }
    }));
  }
  return rows.length;
}

function denyQuery(state, selectedQueryId, code, nowMs) {
  state.storage.transactionSync(() => {
    state.storage.sql.exec(
      `UPDATE state_query_observer_queries
       SET query_state = 'denied', error_code = ?, pending_reason = NULL,
           next_attempt_at_ms = 0, updated_at_ms = ? WHERE query_id = ?`,
      code,
      nowMs,
      selectedQueryId
    );
    state.storage.sql.exec(
      "DELETE FROM state_query_observer_query_sources WHERE query_id = ?",
      selectedQueryId
    );
    markOrphanSources(state, nowMs);
  });
}

function retryQuery(state, row, nowMs) {
  recordStateQueryMetric(state, "retries");
  const attempt = Number(row.attempt_count) + 1;
  const delay = Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * (2 ** Math.min(5, attempt - 1))
  );
  state.storage.sql.exec(
    `UPDATE state_query_observer_queries
     SET pending_reason = COALESCE(pending_reason, 'dependency_changed'),
         next_attempt_at_ms = ?, updated_at_ms = ? WHERE query_id = ?`,
    nowMs + delay,
    nowMs,
    row.query_id
  );
}

async function processQuery(state, env, row) {
  recordStateQueryMetric(state, "evaluations");
  const previousEnvelope = JSON.parse(row.envelope_json);
  const reason = previousEnvelope.status !== "ready"
    ? "transition_completed"
    : row.pending_reason;
  try {
    const remainingSeconds = Math.max(
      MIN_LEASE_SECONDS,
      Math.min(
        MAX_LEASE_SECONDS,
        Math.ceil((Number(row.lease_expires_at_ms) - Date.now()) / 1000)
      )
    );
    const replacement = await evaluateAttachAndSwap(state, env, {
      selectedQueryId: row.query_id,
      grantId: row.grant_id,
      query: JSON.parse(row.query_json),
      reason,
      selectedLeaseSeconds: remainingSeconds,
      fixedLeaseExpiresAtMs: Number(row.lease_expires_at_ms)
    });
    if (replacement.envelope.bindingRevision !== previousEnvelope.bindingRevision) {
      recordStateQueryMetric(state, "handoffs");
    }
  } catch (error) {
    if (
      error instanceof StateQueryCredentialError ||
      (error instanceof StateQueryError && error.code === "query_access_denied")
    ) {
      denyQuery(state, row.query_id, error.code, Date.now());
      return;
    }
    retryQuery(state, row, Date.now());
  }
}

export async function cleanupDetachedSources(state, env) {
  const selected = observerTarget(state);
  if (!selected) return { attempted: 0 };
  const nowMs = Date.now();
  const rows = state.storage.sql.exec(
    `SELECT edge_key, watcher_id, source_kind, attachment_json, attempt_count
     FROM state_query_observer_sources
     WHERE source_state = 'detaching' AND next_attempt_at_ms <= ?
     ORDER BY next_attempt_at_ms, updated_at_ms, edge_key
     LIMIT ?`,
    nowMs,
    DRAIN_BATCH_SIZE
  ).toArray();
  for (const row of rows) {
    try {
      await unregisterDescriptor(env, row, selected.target);
      const current = state.storage.sql.exec(
        `SELECT edge_key, watcher_id, source_kind, attachment_json,
                expected_revision, source_state
         FROM state_query_observer_sources WHERE edge_key = ?`,
        row.edge_key
      ).toArray()[0];
      const referencedUntilMs = state.storage.sql.exec(
        `SELECT MAX(query.lease_expires_at_ms) AS lease_expires_at_ms
         FROM state_query_observer_query_sources relation
         JOIN state_query_observer_queries query
           ON query.query_id = relation.query_id
         WHERE relation.edge_key = ? AND query.query_state = 'active'`,
        row.edge_key
      ).toArray()[0]?.lease_expires_at_ms;
      if (current && referencedUntilMs !== null && referencedUntilMs !== undefined) {
        const registration = await registerDescriptor(env, {
          kind: current.source_kind,
          attachment: JSON.parse(current.attachment_json),
          expectedRevision: Number(current.expected_revision)
        }, selected.target, current.watcher_id, sharedLeaseSeconds(
          state,
          row.edge_key,
          Number(referencedUntilMs),
          Date.now()
        ));
        state.storage.transactionSync(() => {
          state.storage.sql.exec(
            `UPDATE state_query_observer_sources
             SET expected_revision = ?, lease_expires_at_ms = ?,
                 source_state = 'active', attempt_count = 0,
                 next_attempt_at_ms = 0, updated_at_ms = ?
             WHERE edge_key = ?`,
            registration.currentRevision,
            registration.leaseExpiresAtMs,
            Date.now(),
            row.edge_key
          );
          if (!registration.revisionMatched) {
            state.storage.sql.exec(
              `UPDATE state_query_observer_queries
               SET pending_reason = COALESCE(pending_reason, 'dependency_changed'),
                   next_attempt_at_ms = 0, updated_at_ms = ?
               WHERE query_id IN (
                 SELECT query_id FROM state_query_observer_query_sources
                 WHERE edge_key = ?
               )`,
              Date.now(),
              row.edge_key
            );
          }
        });
      } else {
        state.storage.sql.exec(
          `DELETE FROM state_query_observer_sources
           WHERE edge_key = ? AND source_state = 'detaching'
             AND NOT EXISTS (
               SELECT 1 FROM state_query_observer_query_sources relation
               WHERE relation.edge_key = state_query_observer_sources.edge_key
             )`,
          row.edge_key
        );
      }
    } catch {
      recordStateQueryMetric(state, "detachRetries");
      const attempt = Number(row.attempt_count) + 1;
      const delay = Math.min(
        RETRY_MAX_MS,
        RETRY_BASE_MS * (2 ** Math.min(5, attempt - 1))
      );
      state.storage.sql.exec(
        `UPDATE state_query_observer_sources
         SET attempt_count = ?, next_attempt_at_ms = ?, updated_at_ms = ?
         WHERE edge_key = ? AND source_state = 'detaching'`,
        attempt,
        nowMs + delay,
        nowMs,
        row.edge_key
      );
    }
  }
  return { attempted: rows.length };
}

export async function drainLiveStateQueries(state, env) {
  const nowMs = Date.now();
  pruneExpiredQueries(state, nowMs);
  const authorizationAttempts = await checkDueAuthorizations(state, env, nowMs);
  const rows = claimDueQueries(state, nowMs);
  for (let index = 0; index < rows.length; index += DRAIN_CONCURRENCY) {
    await Promise.all(rows.slice(index, index + DRAIN_CONCURRENCY).map((row) =>
      processQuery(state, env, row)
    ));
  }
  await cleanupDetachedSources(state, env);
  await scheduleLiveObservationAlarm(state);
  return { attempted: rows.length, authorizationAttempts };
}

export async function scheduleLiveObservationAlarm(state) {
  const nowMs = Date.now();
  pruneExpiredQueries(state, nowMs);
  const row = state.storage.sql.exec(
    `SELECT MIN(next_at_ms) AS next_at_ms FROM (
       SELECT MIN(CASE
         WHEN pending_reason IS NOT NULL THEN next_attempt_at_ms
         ELSE next_authorization_at_ms
       END) AS next_at_ms
       FROM state_query_observer_queries WHERE query_state = 'active'
       UNION ALL
       SELECT MIN(lease_expires_at_ms) AS next_at_ms
       FROM state_query_observer_queries
       UNION ALL
       SELECT MIN(expires_at_ms) AS next_at_ms
       FROM state_query_stream_subscriptions
       UNION ALL
       SELECT MIN(next_attempt_at_ms) AS next_at_ms
       FROM state_query_observer_sources WHERE source_state = 'detaching'
     ) WHERE next_at_ms IS NOT NULL`
  ).toArray()[0];
  const next = row?.next_at_ms;
  const current = await state.storage.getAlarm();
  if (next === null || next === undefined) {
    if (current !== null) await state.storage.deleteAlarm();
    return;
  }
  const selected = Math.max(nowMs, Number(next));
  if (current === null || current > selected) await state.storage.setAlarm(selected);
}
