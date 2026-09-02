import { jsonResponse, logError } from "../common.js";
import {
  createIntegrationRef,
  createPlatformGroupRef,
  IntegrationContractError
} from "../integrations/contracts.js";

const FEATURE_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const NAMESPACE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_JSON_DEPTH = 20;
const MAX_INCREMENT_AMOUNT = 1_000_000;
const MAX_COUNTER_SUBJECT_LENGTH = 300;
const SNAPSHOT_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REALM_OPERATIONS = new Set([
  "get",
  "set",
  "delete",
  "increment",
  "bounded-counter",
  "snapshot",
  "clone-snapshot"
]);

export const SHAREABLE_STATE_REALM_PATH_PREFIX =
  "/internal/shareable-state/realm/";
export const SHAREABLE_STATE_REALM_SCHEMA_VERSION = 1;
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
  return { name, subject, min, max, initial, operation, amount, value };
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
  `);
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
    if (existing.storage_schema_version !== SHAREABLE_STATE_REALM_SCHEMA_VERSION) {
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
    `SELECT schema_version, mutation_version
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
    return {
      schemaVersion: metadata.schema_version,
      mutationVersion: metadata.mutation_version,
      entries
    };
  });
}

function snapshotFingerprintInput(namespace, schemaVersion, entries) {
  return JSON.stringify({
    formatVersion: SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION,
    featureId: namespace.featureId,
    namespaceId: namespace.namespaceId,
    schemaVersion,
    entries: entries.map((entry) => [entry.key, entry.valueJson])
  });
}

async function fingerprintSnapshotRows(namespace, schemaVersion, entries) {
  return await sha256Fingerprint(
    snapshotFingerprintInput(namespace, schemaVersion, entries)
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
      captured.entries
    ),
    meaningful: captured.entries.length > 0,
    summary: collisionSummary(
      namespace.declaration,
      captured.entries.length
    ),
    entries: captured.entries.map((entry) => ({
      key: entry.key,
      value: JSON.parse(entry.valueJson)
    }))
  };
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
  return { snapshot, entries, expectedTargetMutationVersion };
}

async function cloneSnapshot(state, namespace, input) {
  const normalized = requireSnapshotCloneInput(namespace, input);
  const fingerprint = await fingerprintSnapshotRows(
    namespace,
    namespace.declaration.schemaVersion,
    normalized.entries
  );
  if (fingerprint !== normalized.snapshot.fingerprint) {
    fail("The shareable-state snapshot fingerprint does not match its content.", {
      status: 409,
      code: "shareable_state_snapshot_fingerprint_mismatch"
    });
  }
  return state.storage.transactionSync(() => {
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
    touchNamespace(state.storage.sql, namespace, nowMs);
    return {
      cloned: true,
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

async function boundedCounterValue(state, namespace, input) {
  const descriptor = requireCounterInput(input);
  const key = await boundedCounterKey(descriptor.name, descriptor.subject);
  return state.storage.transactionSync(() => {
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
    if (existing?.value_json === valueJson) return { value };
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
    return { value };
  });
}

async function runOperation(state, namespace, operation, input) {
  switch (operation) {
    case "get":
      return getValue(state, namespace, input);
    case "set":
      return setValue(state, namespace, input);
    case "delete":
      return removeValue(state, namespace, input);
    case "increment":
      return incrementValue(state, namespace, input);
    case "bounded-counter":
      return await boundedCounterValue(state, namespace, input);
    case "snapshot":
      return await snapshotNamespace(state, namespace);
    case "clone-snapshot":
      return await cloneSnapshot(state, namespace, input);
    default:
      return null;
  }
}

function noStoreJson(value, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
}

export class ShareableStateRealmBackend {
  constructor(state, env, featureRegistry) {
    this.state = state;
    this.env = env;
    this.featureRegistry = featureRegistry;
    initializeShareableStateRealmTables(state);
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
    try {
      let input;
      try {
        input = await request.json();
      } catch (cause) {
        fail("Request body must be valid JSON.", { cause });
      }
      const identity = normalizeRealmIdentity(input?.realm);
      const namespace = namespaceDeclaration(this.featureRegistry, input?.namespace);
      bindRealmIdentity(this.state, identity);
      ensureNamespace(this.state, namespace);
      const result = await runOperation(
        this.state,
        namespace,
        operation,
        input?.storage
      );
      return noStoreJson(result);
    } catch (error) {
      if (error instanceof ShareableStateRealmError) {
        return noStoreJson({ error: error.message, code: error.code }, error.status);
      }
      const correlationId =
        request.headers.get("x-correlation-id") ?? crypto.randomUUID();
      logError("shareable_state.realm_request_failed", {
        platform: "shared",
        correlationId,
        route: url.pathname
      }, error);
      return noStoreJson({ error: "Unknown error.", correlationId }, 500);
    }
  }
}
