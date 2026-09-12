import { jsonResponse, logError } from "../common.js";
import {
  createIntegrationRef,
  createPlatformGroupRef,
  IntegrationContractError
} from "../integrations/contracts.js";
import {
  snapshotAndSealLegacyIntegrationFeatureState
} from "../integrations/coordinator-client.js";
import {
  drainStateQueryNotifications,
  initializeShareableStateNotificationTables,
  prepareStateQueryMutation,
  recoverStateQueryNotificationDelivery,
  registerStateQuerySourceWatcher,
  stateQueryNotificationTablesExist,
  StateQueryNotificationError,
  unregisterStateQuerySourceWatcher
} from "../state-querying/source-notifications.js";

const FEATURE_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const NAMESPACE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_JSON_DEPTH = 20;
const MAX_INCREMENT_AMOUNT = 1_000_000;
const MAX_COUNTER_SUBJECT_LENGTH = 300;
const MAX_COUNTER_SUBJECT_LABEL_LENGTH = 80;
const SNAPSHOT_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TRANSITION_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,300}$/;
const MAX_TRANSITION_SEAL_LEASE_MS = 2 * 60 * 1000;
const REALM_OPERATIONS = new Set([
  "get",
  "query-read",
  "revision",
  "set",
  "delete",
  "increment",
  "bounded-counter",
  "bounded-counter-subjects",
  "snapshot",
  "seal-snapshot",
  "freeze-snapshot",
  "release-seal",
  "clone-snapshot",
  "initialize-empty",
  "inventory",
  "watch-register",
  "watch-unregister"
]);

export const SHAREABLE_STATE_REALM_PATH_PREFIX =
  "/internal/shareable-state/realm/";
export const SHAREABLE_STATE_REALM_SCHEMA_VERSION = 4;
export const SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION = 1;

export class ShareableStateRealmError extends Error {
  constructor(message, {
    status = 422,
    code = "shareable_state_realm_invalid",
    cause
  } = {}) {
    super(message, { cause });
    this.name = "ShareableStateRealmError";
    this.status = status;
    this.code = code;
  }
}

function fail(message, options) {
  throw new ShareableStateRealmError(message, options);
}

function requireString(value, pattern, message, maxLength = 100) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    fail(message);
  }
  return value;
}

function requireFeatureId(value) {
  return requireString(value, FEATURE_ID_PATTERN, "The feature ID is invalid.");
}

function requireNamespaceId(value) {
  return requireString(
    value,
    NAMESPACE_ID_PATTERN,
    "The shareable namespace ID is invalid.",
    64
  );
}

function requireKey(value) {
  return requireString(value, KEY_PATTERN, "The shareable-state key is invalid.", 64);
}

function requireTransitionToken(value, subject) {
  return requireString(
    value,
    TRANSITION_TOKEN_PATTERN,
    `${subject} is invalid.`,
    300
  );
}

function canonicalJsonValue(value, path = "value", depth = 0) {
  if (depth > MAX_JSON_DEPTH) fail(`${path} is nested too deeply.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      canonicalJsonValue(entry, `${path}[${index}]`, depth + 1)
    );
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [
        key,
        canonicalJsonValue(value[key], `${path}.${key}`, depth + 1)
      ]));
    }
  }
  fail(`${path} must contain only JSON values.`);
}

function serializeValue(value, maxValueBytes) {
  const serialized = JSON.stringify(canonicalJsonValue(value));
  if (new TextEncoder().encode(serialized).byteLength > maxValueBytes) {
    fail(`Shareable-state values must not exceed ${maxValueBytes} bytes.`);
  }
  return serialized;
}

async function sha256Fingerprint(value) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ));
  return "sha256:" + Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

function requireAmount(value) {
  const amount = value ?? 1;
  if (
    !Number.isSafeInteger(amount) ||
    Math.abs(amount) > MAX_INCREMENT_AMOUNT
  ) {
    fail(
      `Shareable-state increments must be safe integers between ` +
      `-${MAX_INCREMENT_AMOUNT} and ${MAX_INCREMENT_AMOUNT}.`
    );
  }
  return amount;
}

function requireCounterInput(input) {
  const name = requireKey(input?.name);
  const subject = input?.subject;
  if (
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > MAX_COUNTER_SUBJECT_LENGTH
  ) {
    fail(
      `Bounded counter subjects must contain between 1 and ` +
      `${MAX_COUNTER_SUBJECT_LENGTH} characters.`
    );
  }
  const min = input?.min ?? 0;
  const max = input?.max ?? Number.MAX_SAFE_INTEGER;
  const initial = input?.initial ?? min;
  if (
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    !Number.isSafeInteger(initial) ||
    min > max ||
    initial < min ||
    initial > max
  ) {
    fail(
      "Bounded counter min, max, and initial values must be safe integers with " +
      "min <= initial <= max."
    );
  }
  const operation = input?.operation;
  if (!new Set(["get", "set", "increment", "decrement", "reset"]).has(operation)) {
    fail("The bounded counter operation is invalid.");
  }
  const amount = input?.amount;
  if (
    new Set(["increment", "decrement"]).has(operation) &&
    (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_INCREMENT_AMOUNT)
  ) {
    fail(
      `Bounded counter amounts must be integers between 1 and ` +
      `${MAX_INCREMENT_AMOUNT}.`
    );
  }
  const value = input?.value;
  if (
    operation === "set" &&
    (!Number.isSafeInteger(value) || value < min || value > max)
  ) {
    fail("Bounded counter values must be safe integers within the configured bounds.");
  }
  const subjectLabel = input?.subjectLabel;
  if (
    subjectLabel !== undefined &&
    (
      typeof subjectLabel !== "string" ||
      subjectLabel.trim().length === 0 ||
      subjectLabel.length > MAX_COUNTER_SUBJECT_LABEL_LENGTH ||
      Array.from(subjectLabel).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
      })
    )
  ) {
    fail(
      `Bounded counter subject labels must contain between 1 and ` +
      `${MAX_COUNTER_SUBJECT_LABEL_LENGTH} characters.`
    );
  }
  return {
    name,
    subject,
    ...(subjectLabel === undefined ? {} : { subjectLabel: subjectLabel.trim() }),
    min,
    max,
    initial,
    operation,
    amount,
    value
  };
}

async function boundedCounterKey(name, subject) {
  const payload = new TextEncoder().encode(JSON.stringify([name, subject]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  const hexadecimal = Array.from(
    digest,
    (value) => value.toString(16).padStart(2, "0")
  ).join("");
  return `bc_${hexadecimal.slice(0, 60)}`;
}

export function initializeShareableStateRealmTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS shareable_state_realm_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      storage_schema_version INTEGER NOT NULL CHECK (storage_schema_version >= 1),
      realm_kind TEXT NOT NULL CHECK (realm_kind IN ('standalone', 'integration')),
      owner_key TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shareable_state_realm_namespaces (
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
      mutation_version INTEGER NOT NULL DEFAULT 0 CHECK (mutation_version >= 0),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      freeze_id TEXT,
      frozen_at_ms INTEGER,
      PRIMARY KEY (feature_id, namespace_id)
    );

    CREATE TABLE IF NOT EXISTS shareable_state_realm_values (
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      value_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (feature_id, namespace_id, value_key)
    );

    CREATE INDEX IF NOT EXISTS shareable_state_realm_values_namespace
      ON shareable_state_realm_values(feature_id, namespace_id, value_key);

    CREATE TABLE IF NOT EXISTS shareable_state_realm_namespace_seals (
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      seal_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (feature_id, namespace_id)
    );

    CREATE TABLE IF NOT EXISTS shareable_state_realm_materializations (
      idempotency_key TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      mutation_version INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shareable_state_realm_legacy_adoptions (
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('adopted', 'already_materialized')),
      source_sealed_at_ms INTEGER,
      entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
      completed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (feature_id, namespace_id)
    );

    CREATE TABLE IF NOT EXISTS shareable_state_realm_counter_subjects (
      feature_id TEXT NOT NULL,
      namespace_id TEXT NOT NULL,
      counter_name TEXT NOT NULL,
      subject_identity TEXT NOT NULL,
      subject_label TEXT NOT NULL,
      value_key TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (feature_id, namespace_id, counter_name, subject_identity),
      UNIQUE (feature_id, namespace_id, value_key)
    );
  `);
  const namespaceColumns = new Set(
    state.storage.sql.exec("PRAGMA table_info(shareable_state_realm_namespaces)")
      .toArray()
      .map((column) => column.name)
  );
  if (!namespaceColumns.has("freeze_id")) {
    state.storage.sql.exec(
      "ALTER TABLE shareable_state_realm_namespaces ADD COLUMN freeze_id TEXT"
    );
  }
  if (!namespaceColumns.has("frozen_at_ms")) {
    state.storage.sql.exec(
      "ALTER TABLE shareable_state_realm_namespaces ADD COLUMN frozen_at_ms INTEGER"
    );
  }
}

function normalizeRealmIdentity(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !new Set(["standalone", "integration"]).has(value.kind) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  ) {
    fail("The shareable-state realm identity is invalid.", {
      code: "shareable_state_realm_identity_invalid"
    });
  }
  let owner;
  try {
    owner = value.kind === "standalone"
      ? createPlatformGroupRef(value.ownerGroup)
      : createIntegrationRef(value.ownerIntegration);
  } catch (cause) {
    if (cause instanceof IntegrationContractError) {
      fail("The shareable-state realm owner is invalid.", {
        code: "shareable_state_realm_identity_invalid",
        cause
      });
    }
    throw cause;
  }
  return Object.freeze({
    kind: value.kind,
    owner,
    generation: value.generation
  });
}

function bindRealmIdentity(state, identity) {
  const existing = state.storage.sql.exec(
    `SELECT storage_schema_version, realm_kind, owner_key, generation
     FROM shareable_state_realm_meta WHERE singleton = 1`
  ).toArray()[0];
  if (existing) {
    if (
      existing.storage_schema_version < 1 ||
      existing.storage_schema_version > SHAREABLE_STATE_REALM_SCHEMA_VERSION
    ) {
      fail("The stored shareable-state realm layout is not supported.", {
        status: 409,
        code: "shareable_state_realm_schema_unsupported"
      });
    }
    if (
      existing.realm_kind !== identity.kind ||
      existing.owner_key !== identity.owner.key ||
      existing.generation !== identity.generation
    ) {
      fail("This shareable-state realm belongs to a different owner.", {
        status: 409,
        code: "shareable_state_realm_identity_mismatch"
      });
    }
    if (existing.storage_schema_version < SHAREABLE_STATE_REALM_SCHEMA_VERSION) {
      state.storage.sql.exec(
        `UPDATE shareable_state_realm_meta
         SET storage_schema_version = ? WHERE singleton = 1`,
        SHAREABLE_STATE_REALM_SCHEMA_VERSION
      );
    }
    return;
  }
  state.storage.sql.exec(
    `INSERT INTO shareable_state_realm_meta
      (singleton, storage_schema_version, realm_kind, owner_key,
       generation, created_at_ms)
     VALUES (1, ?, ?, ?, ?, ?)`,
    SHAREABLE_STATE_REALM_SCHEMA_VERSION,
    identity.kind,
    identity.owner.key,
    identity.generation,
    Date.now()
  );
}

function realmSourceKey(identity) {
  return `shareable-state:${identity.kind}:g${identity.generation}:${identity.owner.key}`;
}

function namespaceDeclaration(registry, input) {
  const featureId = requireFeatureId(input?.featureId);
  const namespaceId = requireNamespaceId(input?.namespaceId);
  const declaration = registry.featuresById[featureId]?.shareableState.find(
    (candidate) => candidate.id === namespaceId
  );
  if (!declaration) {
    fail("The shareable-state namespace is not declared by an installed feature.", {
      status: 404,
      code: "shareable_state_namespace_not_declared"
    });
  }
  return Object.freeze({ featureId, namespaceId, declaration });
}

function ensureNamespace(state, namespace) {
  const existing = state.storage.sql.exec(
    `SELECT schema_version, mutation_version, freeze_id
     FROM shareable_state_realm_namespaces
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.featureId,
    namespace.namespaceId
  ).toArray()[0];
  if (!existing) {
    const nowMs = Date.now();
    state.storage.sql.exec(
      `INSERT INTO shareable_state_realm_namespaces
        (feature_id, namespace_id, schema_version, mutation_version,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 0, ?, ?)`,
      namespace.featureId,
      namespace.namespaceId,
      namespace.declaration.schemaVersion,
      nowMs,
      nowMs
    );
    return;
  }
  if (existing.schema_version === namespace.declaration.schemaVersion) return;
  if (existing.freeze_id) {
    fail("The archived shareable-state namespace cannot be upgraded in place.", {
      status: 409,
      code: "shareable_state_realm_frozen"
    });
  }
  if (!namespace.declaration.compatibleVersions.includes(existing.schema_version)) {
    fail("The stored shareable-state schema is not compatible with this feature.", {
      status: 409,
      code: "shareable_state_schema_unsupported"
    });
  }
  state.storage.sql.exec(
    `UPDATE shareable_state_realm_namespaces
     SET schema_version = ?, mutation_version = mutation_version + 1,
         updated_at_ms = ?
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.declaration.schemaVersion,
    Date.now(),
    namespace.featureId,
    namespace.namespaceId
  );
}

function namespaceSchemaMutationPending(state, namespace) {
  const existing = state.storage.sql.exec(
    `SELECT schema_version FROM shareable_state_realm_namespaces
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.featureId,
    namespace.namespaceId
  ).toArray()[0];
  return Boolean(
    existing && existing.schema_version !== namespace.declaration.schemaVersion
  );
}

function namespaceSnapshotRows(state, namespace) {
  return state.storage.transactionSync(() => {
    const metadata = state.storage.sql.exec(
      `SELECT schema_version, mutation_version
       FROM shareable_state_realm_namespaces
       WHERE feature_id = ? AND namespace_id = ?`,
      namespace.featureId,
      namespace.namespaceId
    ).one();
    const entries = state.storage.sql.exec(
      `SELECT value_key, value_json
       FROM shareable_state_realm_values
       WHERE feature_id = ? AND namespace_id = ?
       ORDER BY value_key ASC`,
      namespace.featureId,
      namespace.namespaceId
    ).toArray().map((entry) => ({
      key: entry.value_key,
      valueJson: entry.value_json
    }));
    const entryKeys = new Set(entries.map((entry) => entry.key));
    const counterSubjects = state.storage.sql.exec(
      `SELECT counter_name, subject_identity, subject_label, value_key
       FROM shareable_state_realm_counter_subjects
       WHERE feature_id = ? AND namespace_id = ?
       ORDER BY counter_name, subject_identity`,
      namespace.featureId,
      namespace.namespaceId
    ).toArray().filter((subject) => entryKeys.has(subject.value_key)).map((subject) => ({
      counterName: subject.counter_name,
      identity: subject.subject_identity,
      label: subject.subject_label,
      valueKey: subject.value_key
    }));
    return {
      schemaVersion: metadata.schema_version,
      mutationVersion: metadata.mutation_version,
      entries,
      counterSubjects
    };
  });
}

function snapshotFingerprintInput(namespace, schemaVersion, entries, counterSubjects = []) {
  const input = {
    formatVersion: SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION,
    featureId: namespace.featureId,
    namespaceId: namespace.namespaceId,
    schemaVersion,
    entries: entries.map((entry) => [entry.key, entry.valueJson])
  };
  if (counterSubjects.length > 0) {
    input.counterSubjects = counterSubjects.map((subject) => [
      subject.counterName,
      subject.identity,
      subject.label,
      subject.valueKey
    ]);
  }
  return JSON.stringify(input);
}

async function fingerprintSnapshotRows(
  namespace,
  schemaVersion,
  entries,
  counterSubjects = []
) {
  return await sha256Fingerprint(
    snapshotFingerprintInput(namespace, schemaVersion, entries, counterSubjects)
  );
}

function collisionSummary(declaration, entryCount) {
  const used = entryCount > 0;
  if (declaration.collisionSummary.kind === "entry_count") {
    return { kind: "entry_count", used, entryCount };
  }
  return { kind: "presence", used };
}

async function snapshotNamespace(state, namespace) {
  const captured = namespaceSnapshotRows(state, namespace);
  return {
    formatVersion: SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION,
    namespace: {
      featureId: namespace.featureId,
      namespaceId: namespace.namespaceId,
      schemaVersion: captured.schemaVersion
    },
    mutationVersion: captured.mutationVersion,
    fingerprint: await fingerprintSnapshotRows(
      namespace,
      captured.schemaVersion,
      captured.entries,
      captured.counterSubjects
    ),
    meaningful: captured.entries.length > 0,
    summary: collisionSummary(
      namespace.declaration,
      captured.entries.length
    ),
    entries: captured.entries.map((entry) => ({
      key: entry.key,
      value: JSON.parse(entry.valueJson)
    })),
    ...(captured.counterSubjects.length > 0
      ? { counterSubjects: captured.counterSubjects }
      : {})
  };
}

function legacyAdoptionCompleted(sql, namespace) {
  return Boolean(sql.exec(
    `SELECT 1 AS completed FROM shareable_state_realm_legacy_adoptions
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.featureId,
    namespace.namespaceId
  ).toArray()[0]);
}

function recordLegacyAdoption(state, namespace, {
  outcome,
  sourceSealedAtMs = null,
  entryCount
}) {
  state.storage.sql.exec(
    `INSERT INTO shareable_state_realm_legacy_adoptions
      (feature_id, namespace_id, outcome, source_sealed_at_ms,
       entry_count, completed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(feature_id, namespace_id) DO NOTHING`,
    namespace.featureId,
    namespace.namespaceId,
    outcome,
    sourceSealedAtMs,
    entryCount,
    Date.now()
  );
}

async function adoptLegacyIntegrationState(
  state,
  env,
  identity,
  namespace,
  correlationId
) {
  if (
    identity.kind !== "integration" ||
    namespace.declaration.adoptLegacyIntegrationState !== true ||
    legacyAdoptionCompleted(state.storage.sql, namespace)
  ) {
    return;
  }
  const current = namespaceSnapshotRows(state, namespace);
  if (current.mutationVersion !== 0 || current.entries.length !== 0) {
    recordLegacyAdoption(state, namespace, {
      outcome: "already_materialized",
      entryCount: current.entries.length
    });
    return;
  }
  const source = await snapshotAndSealLegacyIntegrationFeatureState(env, {
    integration: identity.owner,
    featureId: namespace.featureId,
    targetNamespaceId: namespace.namespaceId,
    correlationId
  });
  if (
    source?.featureId !== namespace.featureId ||
    source?.targetNamespaceId !== namespace.namespaceId ||
    !Number.isSafeInteger(source?.sealedAtMs) ||
    source.sealedAtMs < 0 ||
    !Array.isArray(source?.entries)
  ) {
    fail("Legacy integration state returned an invalid migration snapshot.", {
      status: 502,
      code: "shareable_state_legacy_snapshot_invalid"
    });
  }
  const entries = source.entries.map((entry) => ({
    key: entry.key,
    valueJson: serializeValue(
      entry.value,
      namespace.declaration.limits.maxValueBytes
    )
  })).sort((left, right) => left.key.localeCompare(right.key));
  const counterSubjects = normalizeSnapshotCounterSubjects(
    source.counterSubjects,
    entries
  );
  const snapshot = {
    formatVersion: SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION,
    namespace: {
      featureId: namespace.featureId,
      namespaceId: namespace.namespaceId,
      schemaVersion: namespace.declaration.schemaVersion
    },
    mutationVersion: 0,
    fingerprint: await fingerprintSnapshotRows(
      namespace,
      namespace.declaration.schemaVersion,
      entries,
      counterSubjects
    ),
    meaningful: entries.length > 0,
    summary: collisionSummary(namespace.declaration, entries.length),
    entries: entries.map((entry) => ({
      key: entry.key,
      value: JSON.parse(entry.valueJson)
    })),
    ...(counterSubjects.length > 0 ? { counterSubjects } : {})
  };
  await cloneSnapshot(state, namespace, {
    snapshot,
    expectedTargetMutationVersion: 0,
    idempotencyKey: `legacy:${namespace.featureId}:${namespace.namespaceId}`
  });
  recordLegacyAdoption(state, namespace, {
    outcome: "adopted",
    sourceSealedAtMs: source.sealedAtMs,
    entryCount: entries.length
  });
}

function activeNamespaceSeal(sql, namespace, nowMs = Date.now()) {
  const row = sql.exec(
    `SELECT seal_id, expires_at_ms
     FROM shareable_state_realm_namespace_seals
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.featureId,
    namespace.namespaceId
  ).toArray()[0];
  if (!row) return null;
  if (row.expires_at_ms <= nowMs) {
    sql.exec(
      `DELETE FROM shareable_state_realm_namespace_seals
       WHERE feature_id = ? AND namespace_id = ? AND expires_at_ms <= ?`,
      namespace.featureId,
      namespace.namespaceId,
      nowMs
    );
    return null;
  }
  return row;
}

function requireNamespaceWritable(sql, namespace) {
  const frozen = sql.exec(
    `SELECT freeze_id FROM shareable_state_realm_namespaces
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.featureId,
    namespace.namespaceId
  ).toArray()[0];
  if (frozen?.freeze_id) {
    fail("Shareable state is permanently frozen after integration revocation.", {
      status: 409,
      code: "shareable_state_realm_frozen"
    });
  }
  if (activeNamespaceSeal(sql, namespace)) {
    fail("Shareable state is temporarily sealed for an integration transition.", {
      status: 409,
      code: "shareable_state_transition_sealed"
    });
  }
}

async function freezeNamespaceSnapshot(state, namespace, input) {
  const freezeId = requireTransitionToken(
    input?.freezeId,
    "The permanent freeze ID"
  );
  state.storage.transactionSync(() => {
    const existing = state.storage.sql.exec(
      `SELECT freeze_id FROM shareable_state_realm_namespaces
       WHERE feature_id = ? AND namespace_id = ?`,
      namespace.featureId,
      namespace.namespaceId
    ).one();
    if (existing.freeze_id && existing.freeze_id !== freezeId) {
      fail("Shareable state was already frozen by another transition.", {
        status: 409,
        code: "shareable_state_realm_frozen"
      });
    }
    if (!existing.freeze_id) {
      state.storage.sql.exec(
        `UPDATE shareable_state_realm_namespaces
         SET freeze_id = ?, frozen_at_ms = ?
         WHERE feature_id = ? AND namespace_id = ?`,
        freezeId,
        Date.now(),
        namespace.featureId,
        namespace.namespaceId
      );
    }
  });
  return {
    freezeId,
    snapshot: await snapshotNamespace(state, namespace)
  };
}

async function sealNamespaceSnapshot(state, namespace, input) {
  const sealId = requireTransitionToken(input?.sealId, "The transition seal ID");
  const expiresAtMs = input?.expiresAtMs;
  const nowMs = Date.now();
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs > nowMs + MAX_TRANSITION_SEAL_LEASE_MS
  ) {
    fail("The transition seal expiry is invalid.", {
      code: "shareable_state_transition_seal_invalid"
    });
  }
  state.storage.transactionSync(() => {
    const existing = activeNamespaceSeal(state.storage.sql, namespace, nowMs);
    if (existing && existing.seal_id !== sealId) {
      fail("Shareable state is already sealed for another transition.", {
        status: 409,
        code: "shareable_state_transition_sealed"
      });
    }
    state.storage.sql.exec(
      `INSERT INTO shareable_state_realm_namespace_seals
        (feature_id, namespace_id, seal_id, expires_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(feature_id, namespace_id) DO UPDATE SET
         expires_at_ms = excluded.expires_at_ms`,
      namespace.featureId,
      namespace.namespaceId,
      sealId,
      expiresAtMs,
      nowMs
    );
  });
  return { sealId, expiresAtMs, snapshot: await snapshotNamespace(state, namespace) };
}

function releaseNamespaceSeal(state, namespace, input) {
  const sealId = requireTransitionToken(input?.sealId, "The transition seal ID");
  const released = state.storage.transactionSync(() => {
    const existing = activeNamespaceSeal(state.storage.sql, namespace);
    if (!existing) return false;
    if (existing.seal_id !== sealId) {
      fail("The transition seal belongs to another operation.", {
        status: 409,
        code: "shareable_state_transition_seal_mismatch"
      });
    }
    state.storage.sql.exec(
      `DELETE FROM shareable_state_realm_namespace_seals
       WHERE feature_id = ? AND namespace_id = ? AND seal_id = ?`,
      namespace.featureId,
      namespace.namespaceId,
      sealId
    );
    return true;
  });
  return { released };
}

async function namespaceInventory(
  state,
  registry,
  prepareNamespace,
  prepareNamespaceMutation
) {
  const declarations = registry.features.flatMap((feature) =>
    feature.shareableState.map((declaration) => ({
      featureId: feature.id,
      featureLabel: feature.description,
      namespaceId: declaration.id,
      declaration
    }))
  ).sort((left, right) =>
    left.featureId.localeCompare(right.featureId) ||
    left.namespaceId.localeCompare(right.namespaceId)
  );
  const namespaces = [];
  for (const item of declarations) {
    const namespace = Object.freeze({
      featureId: item.featureId,
      namespaceId: item.namespaceId,
      declaration: item.declaration
    });
    if (namespaceSchemaMutationPending(state, namespace)) {
      await prepareNamespaceMutation(namespace);
    }
    ensureNamespace(state, namespace);
    await prepareNamespace(namespace);
    const captured = namespaceSnapshotRows(state, namespace);
    namespaces.push({
      featureId: item.featureId,
      featureLabel: item.featureLabel,
      namespaceId: item.namespaceId,
      namespaceLabel: item.declaration.label,
      schemaVersion: captured.schemaVersion,
      mutationVersion: captured.mutationVersion,
      fingerprint: await fingerprintSnapshotRows(
        namespace,
        captured.schemaVersion,
        captured.entries,
        captured.counterSubjects
      ),
      meaningful: captured.entries.length > 0,
      summary: collisionSummary(item.declaration, captured.entries.length)
    });
  }
  return { namespaces };
}

function normalizeSnapshotCounterSubjects(value, entries) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > entries.length) {
    fail("The shareable-state snapshot counter subjects are invalid.", {
      code: "shareable_state_snapshot_invalid"
    });
  }
  const entryKeys = new Set(entries.map((entry) => entry.key));
  const identities = new Set();
  const valueKeys = new Set();
  return value.map((subject) => {
    const counterName = requireKey(subject?.counterName);
    const identity = subject?.identity;
    const label = subject?.label;
    const valueKey = requireKey(subject?.valueKey);
    if (
      typeof identity !== "string" ||
      identity.length === 0 ||
      identity.length > MAX_COUNTER_SUBJECT_LENGTH ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      label.length > MAX_COUNTER_SUBJECT_LABEL_LENGTH ||
      Array.from(label).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
      }) ||
      !entryKeys.has(valueKey)
    ) {
      fail("The shareable-state snapshot counter subjects are invalid.", {
        code: "shareable_state_snapshot_invalid"
      });
    }
    const identityKey = `${counterName}\u0000${identity}`;
    if (identities.has(identityKey) || valueKeys.has(valueKey)) {
      fail("The shareable-state snapshot counter subjects are duplicated.", {
        code: "shareable_state_snapshot_invalid"
      });
    }
    identities.add(identityKey);
    valueKeys.add(valueKey);
    return {
      counterName,
      identity,
      label: label.trim(),
      valueKey
    };
  }).sort((left, right) =>
    left.counterName.localeCompare(right.counterName) ||
    left.identity.localeCompare(right.identity)
  );
}

function requireSnapshotCloneInput(namespace, input) {
  const snapshot = input?.snapshot;
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    snapshot.formatVersion !== SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION ||
    snapshot.namespace?.featureId !== namespace.featureId ||
    snapshot.namespace?.namespaceId !== namespace.namespaceId ||
    snapshot.namespace?.schemaVersion !== namespace.declaration.schemaVersion ||
    !Number.isSafeInteger(snapshot.mutationVersion) ||
    snapshot.mutationVersion < 0 ||
    typeof snapshot.meaningful !== "boolean" ||
    !SNAPSHOT_FINGERPRINT_PATTERN.test(snapshot.fingerprint ?? "") ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length > namespace.declaration.limits.maxEntries
  ) {
    fail("The shareable-state snapshot is invalid.", {
      code: "shareable_state_snapshot_invalid"
    });
  }
  const keys = new Set();
  const entries = snapshot.entries.map((entry) => {
    const key = requireKey(entry?.key);
    if (keys.has(key)) {
      fail("The shareable-state snapshot contains duplicate keys.", {
        code: "shareable_state_snapshot_invalid"
      });
    }
    keys.add(key);
    return {
      key,
      valueJson: serializeValue(
        entry?.value,
        namespace.declaration.limits.maxValueBytes
      )
    };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const counterSubjects = normalizeSnapshotCounterSubjects(
    snapshot.counterSubjects,
    entries
  );
  if (snapshot.meaningful !== (entries.length > 0)) {
    fail("The shareable-state snapshot usage marker is invalid.", {
      code: "shareable_state_snapshot_invalid"
    });
  }
  const expectedTargetMutationVersion = input?.expectedTargetMutationVersion ?? 0;
  if (
    !Number.isSafeInteger(expectedTargetMutationVersion) ||
    expectedTargetMutationVersion < 0
  ) {
    fail("The expected target mutation version is invalid.", {
      code: "shareable_state_snapshot_invalid"
    });
  }
  const idempotencyKey = input?.idempotencyKey === undefined
    ? null
    : requireTransitionToken(
        input.idempotencyKey,
        "The materialization idempotency key"
      );
  return {
    snapshot,
    entries,
    counterSubjects,
    expectedTargetMutationVersion,
    idempotencyKey
  };
}

function replayedMaterialization(sql, namespace, idempotencyKey, fingerprint) {
  if (!idempotencyKey) return null;
  const existing = sql.exec(
    `SELECT feature_id, namespace_id, fingerprint, mutation_version
     FROM shareable_state_realm_materializations
     WHERE idempotency_key = ?`,
    idempotencyKey
  ).toArray()[0];
  if (!existing) return null;
  if (
    existing.feature_id !== namespace.featureId ||
    existing.namespace_id !== namespace.namespaceId ||
    existing.fingerprint !== fingerprint
  ) {
    fail("The materialization idempotency key was already used differently.", {
      status: 409,
      code: "shareable_state_materialization_idempotency_conflict"
    });
  }
  return {
    cloned: false,
    replayed: true,
    mutationVersion: existing.mutation_version,
    fingerprint: existing.fingerprint
  };
}

function recordMaterialization(
  sql,
  namespace,
  idempotencyKey,
  fingerprint,
  mutationVersion,
  nowMs
) {
  if (!idempotencyKey) return;
  sql.exec(
    `INSERT INTO shareable_state_realm_materializations
      (idempotency_key, feature_id, namespace_id, fingerprint,
       mutation_version, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    idempotencyKey,
    namespace.featureId,
    namespace.namespaceId,
    fingerprint,
    mutationVersion,
    nowMs
  );
}

async function cloneSnapshot(state, namespace, input) {
  const normalized = requireSnapshotCloneInput(namespace, input);
  const fingerprint = await fingerprintSnapshotRows(
    namespace,
    namespace.declaration.schemaVersion,
    normalized.entries,
    normalized.counterSubjects
  );
  if (fingerprint !== normalized.snapshot.fingerprint) {
    fail("The shareable-state snapshot fingerprint does not match its content.", {
      status: 409,
      code: "shareable_state_snapshot_fingerprint_mismatch"
    });
  }
  return state.storage.transactionSync(() => {
    const replayed = replayedMaterialization(
      state.storage.sql,
      namespace,
      normalized.idempotencyKey,
      fingerprint
    );
    if (replayed) return replayed;
    requireNamespaceWritable(state.storage.sql, namespace);
    const target = state.storage.sql.exec(
      `SELECT mutation_version
       FROM shareable_state_realm_namespaces
       WHERE feature_id = ? AND namespace_id = ?`,
      namespace.featureId,
      namespace.namespaceId
    ).one();
    const targetEntryCount = Number(state.storage.sql.exec(
      `SELECT COUNT(*) AS total
       FROM shareable_state_realm_values
       WHERE feature_id = ? AND namespace_id = ?`,
      namespace.featureId,
      namespace.namespaceId
    ).one().total);
    if (target.mutation_version !== normalized.expectedTargetMutationVersion) {
      fail("The target shareable-state namespace changed before cloning.", {
        status: 409,
        code: "shareable_state_clone_target_stale"
      });
    }
    if (target.mutation_version !== 0 || targetEntryCount !== 0) {
      fail("Snapshots may only be cloned into a fresh namespace.", {
        status: 409,
        code: "shareable_state_clone_target_not_fresh"
      });
    }
    const nowMs = Date.now();
    for (const entry of normalized.entries) {
      state.storage.sql.exec(
        `INSERT INTO shareable_state_realm_values
          (feature_id, namespace_id, value_key, value_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
        namespace.featureId,
        namespace.namespaceId,
        entry.key,
        entry.valueJson,
        nowMs
      );
    }
    for (const subject of normalized.counterSubjects) {
      state.storage.sql.exec(
        `INSERT INTO shareable_state_realm_counter_subjects
          (feature_id, namespace_id, counter_name, subject_identity,
           subject_label, value_key, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        namespace.featureId,
        namespace.namespaceId,
        subject.counterName,
        subject.identity,
        subject.label,
        subject.valueKey,
        nowMs
      );
    }
    touchNamespace(state.storage.sql, namespace, nowMs);
    recordMaterialization(
      state.storage.sql,
      namespace,
      normalized.idempotencyKey,
      fingerprint,
      1,
      nowMs
    );
    return {
      cloned: true,
      ...(normalized.idempotencyKey ? { replayed: false } : {}),
      mutationVersion: 1,
      fingerprint
    };
  });
}

async function initializeEmptyNamespace(state, namespace, input) {
  const expectedTargetMutationVersion = input?.expectedTargetMutationVersion ?? 0;
  if (expectedTargetMutationVersion !== 0) {
    fail("Empty namespaces may only be initialized in a fresh realm.", {
      code: "shareable_state_snapshot_invalid"
    });
  }
  const idempotencyKey = requireTransitionToken(
    input?.idempotencyKey,
    "The materialization idempotency key"
  );
  const fingerprint = await fingerprintSnapshotRows(
    namespace,
    namespace.declaration.schemaVersion,
    []
  );
  return state.storage.transactionSync(() => {
    const replayed = replayedMaterialization(
      state.storage.sql,
      namespace,
      idempotencyKey,
      fingerprint
    );
    if (replayed) return replayed;
    requireNamespaceWritable(state.storage.sql, namespace);
    const target = state.storage.sql.exec(
      `SELECT mutation_version
       FROM shareable_state_realm_namespaces
       WHERE feature_id = ? AND namespace_id = ?`,
      namespace.featureId,
      namespace.namespaceId
    ).one();
    const targetEntryCount = Number(state.storage.sql.exec(
      `SELECT COUNT(*) AS total
       FROM shareable_state_realm_values
       WHERE feature_id = ? AND namespace_id = ?`,
      namespace.featureId,
      namespace.namespaceId
    ).one().total);
    if (target.mutation_version !== 0 || targetEntryCount !== 0) {
      fail("Empty state may only be initialized in a fresh namespace.", {
        status: 409,
        code: "shareable_state_clone_target_not_fresh"
      });
    }
    const nowMs = Date.now();
    touchNamespace(state.storage.sql, namespace, nowMs);
    recordMaterialization(
      state.storage.sql,
      namespace,
      idempotencyKey,
      fingerprint,
      1,
      nowMs
    );
    return {
      cloned: true,
      replayed: false,
      mutationVersion: 1,
      fingerprint
    };
  });
}

function valueRow(sql, namespace, key) {
  return sql.exec(
    `SELECT value_json FROM shareable_state_realm_values
     WHERE feature_id = ? AND namespace_id = ? AND value_key = ?`,
    namespace.featureId,
    namespace.namespaceId,
    key
  ).toArray()[0];
}

function namespaceAtCapacity(sql, namespace) {
  const row = sql.exec(
    `SELECT COUNT(*) AS total FROM shareable_state_realm_values
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.featureId,
    namespace.namespaceId
  ).toArray()[0];
  return Number(row?.total ?? 0) >= namespace.declaration.limits.maxEntries;
}

function touchNamespace(sql, namespace, nowMs) {
  sql.exec(
    `UPDATE shareable_state_realm_namespaces
     SET mutation_version = mutation_version + 1, updated_at_ms = ?
     WHERE feature_id = ? AND namespace_id = ?`,
    nowMs,
    namespace.featureId,
    namespace.namespaceId
  );
}

function writeValue(state, namespace, key, valueJson) {
  return state.storage.transactionSync(() => {
    requireNamespaceWritable(state.storage.sql, namespace);
    const existing = valueRow(state.storage.sql, namespace, key);
    if (existing?.value_json === valueJson) return false;
    if (!existing && namespaceAtCapacity(state.storage.sql, namespace)) {
      fail(
        `This shareable namespace may store at most ` +
        `${namespace.declaration.limits.maxEntries} values.`,
        { status: 409, code: "shareable_state_namespace_full" }
      );
    }
    const nowMs = Date.now();
    state.storage.sql.exec(
      `INSERT INTO shareable_state_realm_values
        (feature_id, namespace_id, value_key, value_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(feature_id, namespace_id, value_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at_ms = excluded.updated_at_ms`,
      namespace.featureId,
      namespace.namespaceId,
      key,
      valueJson,
      nowMs
    );
    touchNamespace(state.storage.sql, namespace, nowMs);
    return true;
  });
}

function deleteValue(state, namespace, key) {
  return state.storage.transactionSync(() => {
    requireNamespaceWritable(state.storage.sql, namespace);
    const existing = valueRow(state.storage.sql, namespace, key);
    if (!existing) return false;
    const nowMs = Date.now();
    state.storage.sql.exec(
      `DELETE FROM shareable_state_realm_values
       WHERE feature_id = ? AND namespace_id = ? AND value_key = ?`,
      namespace.featureId,
      namespace.namespaceId,
      key
    );
    touchNamespace(state.storage.sql, namespace, nowMs);
    return true;
  });
}

function getValue(state, namespace, input) {
  const key = requireKey(input?.key);
  const row = valueRow(state.storage.sql, namespace, key);
  return { value: row ? JSON.parse(row.value_json) : null };
}

function queryReadValue(state, namespace, input) {
  const key = requireKey(input?.key);
  const row = valueRow(state.storage.sql, namespace, key);
  return row
    ? { found: true, value: JSON.parse(row.value_json) }
    : { found: false };
}

function namespaceRevision(state, namespace) {
  const row = state.storage.sql.exec(
    `SELECT mutation_version FROM shareable_state_realm_namespaces
     WHERE feature_id = ? AND namespace_id = ?`,
    namespace.featureId,
    namespace.namespaceId
  ).one();
  return { mutationVersion: Number(row.mutation_version) };
}

function setValue(state, namespace, input) {
  const key = requireKey(input?.key);
  const valueJson = serializeValue(
    input?.value,
    namespace.declaration.limits.maxValueBytes
  );
  writeValue(state, namespace, key, valueJson);
  return { ok: true };
}

function removeValue(state, namespace, input) {
  return { deleted: deleteValue(state, namespace, requireKey(input?.key)) };
}

function incrementValue(state, namespace, input) {
  const key = requireKey(input?.key);
  const amount = requireAmount(input?.amount);
  return state.storage.transactionSync(() => {
    requireNamespaceWritable(state.storage.sql, namespace);
    const existing = valueRow(state.storage.sql, namespace, key);
    const current = existing ? JSON.parse(existing.value_json) : 0;
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(current + amount)) {
      fail("The selected shareable-state value is not safely incrementable.", {
        status: 409,
        code: "shareable_state_value_not_incrementable"
      });
    }
    const value = current + amount;
    if (amount === 0) return { value };
    if (!existing && namespaceAtCapacity(state.storage.sql, namespace)) {
      fail(
        `This shareable namespace may store at most ` +
        `${namespace.declaration.limits.maxEntries} values.`,
        { status: 409, code: "shareable_state_namespace_full" }
      );
    }
    const valueJson = serializeValue(
      value,
      namespace.declaration.limits.maxValueBytes
    );
    const nowMs = Date.now();
    state.storage.sql.exec(
      `INSERT INTO shareable_state_realm_values
        (feature_id, namespace_id, value_key, value_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(feature_id, namespace_id, value_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at_ms = excluded.updated_at_ms`,
      namespace.featureId,
      namespace.namespaceId,
      key,
      valueJson,
      nowMs
    );
    touchNamespace(state.storage.sql, namespace, nowMs);
    return { value };
  });
}

function counterSubjectMetadata(sql, namespace, descriptor, key) {
  const byIdentity = sql.exec(
    `SELECT value_key, subject_label
     FROM shareable_state_realm_counter_subjects
     WHERE feature_id = ? AND namespace_id = ?
       AND counter_name = ? AND subject_identity = ?`,
    namespace.featureId,
    namespace.namespaceId,
    descriptor.name,
    descriptor.subject
  ).toArray()[0];
  if (byIdentity && byIdentity.value_key !== key) {
    fail("The bounded counter subject identity conflicts with stored metadata.", {
      status: 409,
      code: "shareable_state_counter_subject_conflict"
    });
  }
  const byKey = sql.exec(
    `SELECT counter_name, subject_identity
     FROM shareable_state_realm_counter_subjects
     WHERE feature_id = ? AND namespace_id = ? AND value_key = ?`,
    namespace.featureId,
    namespace.namespaceId,
    key
  ).toArray()[0];
  if (
    byKey &&
    (byKey.counter_name !== descriptor.name || byKey.subject_identity !== descriptor.subject)
  ) {
    fail("The bounded counter storage key conflicts with stored subject metadata.", {
      status: 409,
      code: "shareable_state_counter_subject_conflict"
    });
  }
  return byIdentity ?? null;
}

function recordCounterSubject(sql, namespace, descriptor, key) {
  if (descriptor.subjectLabel === undefined) return false;
  const existing = counterSubjectMetadata(sql, namespace, descriptor, key);
  if (existing) return false;
  sql.exec(
    `INSERT INTO shareable_state_realm_counter_subjects
      (feature_id, namespace_id, counter_name, subject_identity,
       subject_label, value_key, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    namespace.featureId,
    namespace.namespaceId,
    descriptor.name,
    descriptor.subject,
    descriptor.subjectLabel,
    key,
    Date.now()
  );
  return true;
}

function deleteCounterSubject(sql, namespace, descriptor, key) {
  sql.exec(
    `DELETE FROM shareable_state_realm_counter_subjects
     WHERE feature_id = ? AND namespace_id = ?
       AND counter_name = ? AND subject_identity = ? AND value_key = ?`,
    namespace.featureId,
    namespace.namespaceId,
    descriptor.name,
    descriptor.subject,
    key
  );
}

function boundedCounterSubjects(state, namespace, input) {
  const name = requireKey(input?.name);
  const subjects = state.storage.sql.exec(
    `SELECT metadata.subject_identity, metadata.subject_label, values_table.value_json
     FROM shareable_state_realm_counter_subjects AS metadata
     INNER JOIN shareable_state_realm_values AS values_table
       ON values_table.feature_id = metadata.feature_id
      AND values_table.namespace_id = metadata.namespace_id
      AND values_table.value_key = metadata.value_key
     WHERE metadata.feature_id = ? AND metadata.namespace_id = ?
       AND metadata.counter_name = ?
     ORDER BY metadata.subject_identity`,
    namespace.featureId,
    namespace.namespaceId,
    name
  ).toArray().map((entry) => ({
    identity: entry.subject_identity,
    label: entry.subject_label,
    value: JSON.parse(entry.value_json)
  }));
  const unidentified = state.storage.sql.exec(
    `SELECT COUNT(*) AS total
     FROM shareable_state_realm_values AS values_table
     LEFT JOIN shareable_state_realm_counter_subjects AS metadata
       ON metadata.feature_id = values_table.feature_id
      AND metadata.namespace_id = values_table.namespace_id
      AND metadata.value_key = values_table.value_key
     WHERE values_table.feature_id = ? AND values_table.namespace_id = ?
       AND length(values_table.value_key) = 63
       AND values_table.value_key GLOB 'bc_[0-9a-f]*'
       AND metadata.value_key IS NULL`,
    namespace.featureId,
    namespace.namespaceId
  ).toArray()[0];
  const unidentifiedCount = Number(unidentified?.total ?? 0);
  return {
    subjects,
    coverage: {
      complete: unidentifiedCount === 0,
      identifiedCount: subjects.length,
      unidentifiedCount
    }
  };
}

async function boundedCounterValue(state, namespace, input) {
  const descriptor = requireCounterInput(input);
  const key = await boundedCounterKey(descriptor.name, descriptor.subject);
  return state.storage.transactionSync(() => {
    if (descriptor.operation !== "get") {
      requireNamespaceWritable(state.storage.sql, namespace);
    }
    const existing = valueRow(state.storage.sql, namespace, key);
    const current = existing ? JSON.parse(existing.value_json) : descriptor.initial;
    if (
      !Number.isSafeInteger(current) ||
      current < descriptor.min ||
      current > descriptor.max
    ) {
      fail("The selected shareable-state value is not a valid bounded counter.", {
        status: 409,
        code: "shareable_state_counter_invalid"
      });
    }
    if (descriptor.operation === "get") return { value: current };
    if (descriptor.operation === "reset") {
      if (existing) {
        const nowMs = Date.now();
        state.storage.sql.exec(
          `DELETE FROM shareable_state_realm_values
           WHERE feature_id = ? AND namespace_id = ? AND value_key = ?`,
          namespace.featureId,
          namespace.namespaceId,
          key
        );
        deleteCounterSubject(state.storage.sql, namespace, descriptor, key);
        touchNamespace(state.storage.sql, namespace, nowMs);
      }
      return { value: descriptor.initial };
    }

    let value = descriptor.operation === "set" ? descriptor.value : current;
    if (new Set(["increment", "decrement"]).has(descriptor.operation)) {
      const direction = descriptor.operation === "increment" ? 1n : -1n;
      const candidate = BigInt(current) + direction * BigInt(descriptor.amount);
      value = Number(
        candidate < BigInt(descriptor.min)
          ? BigInt(descriptor.min)
          : candidate > BigInt(descriptor.max)
            ? BigInt(descriptor.max)
            : candidate
      );
    }
    if (!existing && value === descriptor.initial) return { value };
    const valueJson = serializeValue(
      value,
      namespace.declaration.limits.maxValueBytes
    );
    if (existing?.value_json === valueJson) {
      if (recordCounterSubject(state.storage.sql, namespace, descriptor, key)) {
        touchNamespace(state.storage.sql, namespace, Date.now());
      }
      return { value };
    }
    if (!existing && namespaceAtCapacity(state.storage.sql, namespace)) {
      fail(
        `This shareable namespace may store at most ` +
        `${namespace.declaration.limits.maxEntries} values.`,
        { status: 409, code: "shareable_state_namespace_full" }
      );
    }
    const nowMs = Date.now();
    state.storage.sql.exec(
      `INSERT INTO shareable_state_realm_values
        (feature_id, namespace_id, value_key, value_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(feature_id, namespace_id, value_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at_ms = excluded.updated_at_ms`,
      namespace.featureId,
      namespace.namespaceId,
      key,
      valueJson,
      nowMs
    );
    recordCounterSubject(state.storage.sql, namespace, descriptor, key);
    touchNamespace(state.storage.sql, namespace, nowMs);
    return { value };
  });
}

async function runOperation(state, namespace, operation, input) {
  switch (operation) {
    case "get":
      return getValue(state, namespace, input);
    case "query-read":
      return queryReadValue(state, namespace, input);
    case "revision":
      return namespaceRevision(state, namespace);
    case "set":
      return setValue(state, namespace, input);
    case "delete":
      return removeValue(state, namespace, input);
    case "increment":
      return incrementValue(state, namespace, input);
    case "bounded-counter":
      return await boundedCounterValue(state, namespace, input);
    case "bounded-counter-subjects":
      return boundedCounterSubjects(state, namespace, input);
    case "snapshot":
      return await snapshotNamespace(state, namespace);
    case "seal-snapshot":
      return await sealNamespaceSnapshot(state, namespace, input);
    case "freeze-snapshot":
      return await freezeNamespaceSnapshot(state, namespace, input);
    case "release-seal":
      return releaseNamespaceSeal(state, namespace, input);
    case "clone-snapshot":
      return await cloneSnapshot(state, namespace, input);
    case "initialize-empty":
      return await initializeEmptyNamespace(state, namespace, input);
    default:
      return null;
  }
}

function noStoreJson(value, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

function operationMayMutateState(operation, storage) {
  if (new Set(["set", "delete", "increment", "clone-snapshot", "initialize-empty"])
    .has(operation)) {
    return true;
  }
  return operation === "bounded-counter" && storage?.operation !== "get";
}

export class ShareableStateRealmBackend {
  constructor(state, env, featureRegistry) {
    this.state = state;
    this.env = env;
    this.featureRegistry = featureRegistry;
    this.legacyAdoptions = new Map();
    initializeShareableStateRealmTables(state);
    if (stateQueryNotificationTablesExist(state)) {
      initializeShareableStateNotificationTables(state);
      state.blockConcurrencyWhile(async () => {
        await recoverStateQueryNotificationDelivery(state);
      });
    }
  }

  async prepareLegacyAdoption(identity, namespace, correlationId) {
    const key = `${namespace.featureId}\u0000${namespace.namespaceId}`;
    const existing = this.legacyAdoptions.get(key);
    if (existing) return await existing;
    const operation = adoptLegacyIntegrationState(
      this.state,
      this.env,
      identity,
      namespace,
      correlationId
    );
    this.legacyAdoptions.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.legacyAdoptions.get(key) === operation) {
        this.legacyAdoptions.delete(key);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      !url.pathname.startsWith(SHAREABLE_STATE_REALM_PATH_PREFIX)
    ) {
      return new Response("Not found", { status: 404 });
    }
    const operation = url.pathname.slice(SHAREABLE_STATE_REALM_PATH_PREFIX.length);
    if (!REALM_OPERATIONS.has(operation)) {
      return new Response("Not found", { status: 404 });
    }
    const correlationId =
      request.headers.get("x-correlation-id") ?? crypto.randomUUID();
    try {
      let input;
      try {
        input = await request.json();
      } catch (cause) {
        fail("Request body must be valid JSON.", { cause });
      }
      const identity = normalizeRealmIdentity(input?.realm);
      bindRealmIdentity(this.state, identity);
      if (operation === "inventory") {
        return noStoreJson(await namespaceInventory(
          this.state,
          this.featureRegistry,
          async (namespace) => await this.prepareLegacyAdoption(
            identity,
            namespace,
            correlationId
          ),
          async (namespace) => await prepareStateQueryMutation(this.state, {
            kind: "shareable",
            key: realmSourceKey(identity),
            featureId: namespace.featureId,
            namespaceId: namespace.namespaceId
          })
        ));
      }
      const namespace = namespaceDeclaration(this.featureRegistry, input?.namespace);
      const expectedSource = { kind: "shareable", key: realmSourceKey(identity) };
      const prepareNotification = async () => await prepareStateQueryMutation(
        this.state,
        {
          ...expectedSource,
          featureId: namespace.featureId,
          namespaceId: namespace.namespaceId
        }
      );
      if (operation === "watch-register") {
        initializeShareableStateNotificationTables(this.state);
        if (namespaceSchemaMutationPending(this.state, namespace)) {
          await prepareNotification();
        }
        ensureNamespace(this.state, namespace);
        await this.prepareLegacyAdoption(identity, namespace, correlationId);
        return noStoreJson(await registerStateQuerySourceWatcher(
          this.state,
          this.env,
          {
            ...input?.storage,
            featureId: namespace.featureId,
            namespaceId: namespace.namespaceId,
            source: expectedSource
          },
          expectedSource
        ));
      }
      if (operation === "watch-unregister") {
        initializeShareableStateNotificationTables(this.state);
        if (namespaceSchemaMutationPending(this.state, namespace)) {
          await prepareNotification();
        }
        ensureNamespace(this.state, namespace);
        return noStoreJson(await unregisterStateQuerySourceWatcher(
          this.state,
          this.env,
          {
            ...input?.storage,
            featureId: namespace.featureId,
            namespaceId: namespace.namespaceId,
            source: expectedSource
          },
          expectedSource
        ));
      }
      if (
        operationMayMutateState(operation, input?.storage) ||
        namespaceSchemaMutationPending(this.state, namespace)
      ) {
        await prepareNotification();
      }
      ensureNamespace(this.state, namespace);
      if (!new Set(["clone-snapshot", "initialize-empty"]).has(operation)) {
        await this.prepareLegacyAdoption(identity, namespace, correlationId);
      }
      const result = await runOperation(
        this.state,
        namespace,
        operation,
        input?.storage
      );
      return noStoreJson(result);
    } catch (error) {
      if (
        error instanceof ShareableStateRealmError ||
        error instanceof StateQueryNotificationError
      ) {
        return noStoreJson({ error: error.message, code: error.code }, error.status);
      }
      logError("shareable_state.realm_request_failed", {
        platform: "shared",
        correlationId,
        route: url.pathname
      }, error);
      return noStoreJson({ error: "Unknown error.", correlationId }, 500);
    }
  }

  async alarm() {
    await drainStateQueryNotifications(this.state, this.env);
  }
}
