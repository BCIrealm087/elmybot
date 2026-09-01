const FEATURE_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const VERSIONED_KIND_PATTERN =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/;
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SCOPE_KEY_PATTERN = /^[^\s]{1,300}$/;
const MAX_FEATURE_VALUE_BYTES = 16 * 1024;
const MAX_FEATURE_VALUE_DEPTH = 20;
const MAX_VALUES_PER_NAMESPACE = 100;
const MAX_INCREMENT_AMOUNT = 1_000_000;
const MAX_COUNTER_SUBJECT_LENGTH = 300;
const MAX_COOLDOWN_ROWS = 10_000;
const COOLDOWN_PRUNE_BATCH_SIZE = 100;

export const FEATURE_STORAGE_PATH_PREFIX = "/internal/framework/";
export const INTEGRATION_FEATURE_STATE_PATH_PREFIX =
  "/internal/framework/integration-state/";

export class FeatureStorageUserFacingError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = "FeatureStorageUserFacingError";
    this.status = status;
  }
}

function requireString(value, pattern, message, maxLength = 200) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    throw new FeatureStorageUserFacingError(message);
  }
  return value;
}

function requireFeatureId(value) {
  return requireString(value, FEATURE_ID_PATTERN, "The feature ID is invalid.", 100);
}

function requireActionKind(value) {
  return requireString(value, VERSIONED_KIND_PATTERN, "The action kind is invalid.");
}

function requireKey(value) {
  return requireString(value, KEY_PATTERN, "The feature storage key is invalid.", 64);
}

function requireScopeKey(value) {
  return requireString(value, SCOPE_KEY_PATTERN, "The cooldown scope is invalid.", 300);
}

function copyJsonValue(value, path = "value", depth = 0) {
  if (depth > MAX_FEATURE_VALUE_DEPTH) {
    throw new FeatureStorageUserFacingError(`${path} is nested too deeply.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new FeatureStorageUserFacingError(`${path} contains a non-finite number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      copyJsonValue(entry, `${path}[${index}]`, depth + 1)
    );
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        copyJsonValue(entry, `${path}.${key}`, depth + 1)
      ]));
    }
  }
  throw new FeatureStorageUserFacingError(`${path} must contain only JSON values.`);
}

function serializeValue(value) {
  const serialized = JSON.stringify(copyJsonValue(value));
  if (new TextEncoder().encode(serialized).byteLength > MAX_FEATURE_VALUE_BYTES) {
    throw new FeatureStorageUserFacingError(
      `Feature values must not exceed ${MAX_FEATURE_VALUE_BYTES} bytes.`
    );
  }
  return serialized;
}

export function initializeFeatureStorageTables(state) {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS framework_feature_values (
      value_kind TEXT NOT NULL CHECK (value_kind IN ('config', 'state')),
      feature_id TEXT NOT NULL,
      value_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (value_kind, feature_id, value_key)
    );

    CREATE INDEX IF NOT EXISTS framework_feature_values_namespace
      ON framework_feature_values(value_kind, feature_id, value_key);

    CREATE TABLE IF NOT EXISTS framework_feature_cooldowns (
      feature_id TEXT NOT NULL,
      action_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY (feature_id, action_kind, scope_key)
    );

    CREATE INDEX IF NOT EXISTS framework_feature_cooldowns_expiry
      ON framework_feature_cooldowns(expires_at_ms);
  `);
}

function valueRow(sql, valueKind, featureId, key) {
  return sql.exec(
    `SELECT value_json FROM framework_feature_values
     WHERE value_kind = ? AND feature_id = ? AND value_key = ?`,
    valueKind,
    featureId,
    key
  ).toArray()[0];
}

function getValue(sql, valueKind, input) {
  const featureId = requireFeatureId(input?.featureId);
  const key = requireKey(input?.key);
  const row = valueRow(sql, valueKind, featureId, key);
  return { value: row ? JSON.parse(row.value_json) : null };
}

function namespaceAtCapacity(sql, valueKind, featureId) {
  const row = sql.exec(
    `SELECT COUNT(*) AS total FROM framework_feature_values
     WHERE value_kind = ? AND feature_id = ?`,
    valueKind,
    featureId
  ).toArray()[0];
  return Number(row?.total ?? 0) >= MAX_VALUES_PER_NAMESPACE;
}

function setValue(state, valueKind, input) {
  const featureId = requireFeatureId(input?.featureId);
  const key = requireKey(input?.key);
  const valueJson = serializeValue(input?.value);
  state.storage.transactionSync(() => {
    const existing = valueRow(state.storage.sql, valueKind, featureId, key);
    if (!existing && namespaceAtCapacity(state.storage.sql, valueKind, featureId)) {
      throw new FeatureStorageUserFacingError(
        `A feature may store at most ${MAX_VALUES_PER_NAMESPACE} ${valueKind} values.`,
        409
      );
    }
    state.storage.sql.exec(
      `INSERT INTO framework_feature_values
        (value_kind, feature_id, value_key, value_json, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(value_kind, feature_id, value_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at_ms = excluded.updated_at_ms`,
      valueKind,
      featureId,
      key,
      valueJson,
      Date.now()
    );
  });
  return { ok: true };
}

function deleteValue(state, valueKind, input) {
  const featureId = requireFeatureId(input?.featureId);
  const key = requireKey(input?.key);
  const existing = valueRow(state.storage.sql, valueKind, featureId, key);
  if (existing) {
    state.storage.sql.exec(
      `DELETE FROM framework_feature_values
       WHERE value_kind = ? AND feature_id = ? AND value_key = ?`,
      valueKind,
      featureId,
      key
    );
  }
  return { deleted: Boolean(existing) };
}

function incrementState(state, input) {
  const featureId = requireFeatureId(input?.featureId);
  const key = requireKey(input?.key);
  const amount = input?.amount ?? 1;
  if (
    !Number.isSafeInteger(amount) ||
    Math.abs(amount) > MAX_INCREMENT_AMOUNT
  ) {
    throw new FeatureStorageUserFacingError(
      `State increments must be safe integers between -${MAX_INCREMENT_AMOUNT} and ` +
      `${MAX_INCREMENT_AMOUNT}.`
    );
  }
  return state.storage.transactionSync(() => {
    const existing = valueRow(state.storage.sql, "state", featureId, key);
    if (!existing && namespaceAtCapacity(state.storage.sql, "state", featureId)) {
      throw new FeatureStorageUserFacingError(
        `A feature may store at most ${MAX_VALUES_PER_NAMESPACE} state values.`,
        409
      );
    }
    const current = existing ? JSON.parse(existing.value_json) : 0;
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(current + amount)) {
      throw new FeatureStorageUserFacingError(
        "The selected state value is not a safely incrementable integer.",
        409
      );
    }
    const value = current + amount;
    state.storage.sql.exec(
      `INSERT INTO framework_feature_values
        (value_kind, feature_id, value_key, value_json, updated_at_ms)
       VALUES ('state', ?, ?, ?, ?)
       ON CONFLICT(value_kind, feature_id, value_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at_ms = excluded.updated_at_ms`,
      featureId,
      key,
      JSON.stringify(value),
      Date.now()
    );
    return { value };
  });
}

function requireBoundedCounterInput(input) {
  const featureId = requireFeatureId(input?.featureId);
  const name = requireKey(input?.name);
  const subject = input?.subject;
  if (
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.length > MAX_COUNTER_SUBJECT_LENGTH
  ) {
    throw new FeatureStorageUserFacingError(
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
    throw new FeatureStorageUserFacingError(
      "Bounded counter min, max, and initial values must be safe integers with " +
      "min <= initial <= max."
    );
  }
  const operation = input?.operation;
  if (!["get", "increment", "decrement", "reset"].includes(operation)) {
    throw new FeatureStorageUserFacingError("The bounded counter operation is invalid.");
  }
  const amount = input?.amount;
  if (
    ["increment", "decrement"].includes(operation) &&
    (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_INCREMENT_AMOUNT)
  ) {
    throw new FeatureStorageUserFacingError(
      `Bounded counter amounts must be integers between 1 and ` +
      `${MAX_INCREMENT_AMOUNT}.`
    );
  }
  return { featureId, name, subject, min, max, initial, operation, amount };
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

async function boundedCounterState(state, input) {
  const descriptor = requireBoundedCounterInput(input);
  const key = await boundedCounterKey(descriptor.name, descriptor.subject);
  return state.storage.transactionSync(() => {
    const existing = valueRow(
      state.storage.sql,
      "state",
      descriptor.featureId,
      key
    );
    const current = existing
      ? JSON.parse(existing.value_json)
      : descriptor.initial;
    if (
      !Number.isSafeInteger(current) ||
      current < descriptor.min ||
      current > descriptor.max
    ) {
      throw new FeatureStorageUserFacingError(
        "The selected state value is not a valid bounded counter.",
        409
      );
    }
    if (descriptor.operation === "get") return { value: current };

    let value = descriptor.initial;
    if (descriptor.operation !== "reset") {
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
    if (!existing && namespaceAtCapacity(
      state.storage.sql,
      "state",
      descriptor.featureId
    )) {
      throw new FeatureStorageUserFacingError(
        `A feature may store at most ${MAX_VALUES_PER_NAMESPACE} state values.`,
        409
      );
    }
    state.storage.sql.exec(
      `INSERT INTO framework_feature_values
        (value_kind, feature_id, value_key, value_json, updated_at_ms)
       VALUES ('state', ?, ?, ?, ?)
       ON CONFLICT(value_kind, feature_id, value_key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at_ms = excluded.updated_at_ms`,
      descriptor.featureId,
      key,
      JSON.stringify(value),
      Date.now()
    );
    return { value };
  });
}

function pruneExpiredCooldowns(sql, nowMs) {
  sql.exec(
    `DELETE FROM framework_feature_cooldowns
     WHERE rowid IN (
       SELECT rowid FROM framework_feature_cooldowns
       WHERE expires_at_ms <= ?
       ORDER BY expires_at_ms
       LIMIT ?
     )`,
    nowMs,
    COOLDOWN_PRUNE_BATCH_SIZE
  );
}

function claimCooldown(state, input) {
  const featureId = requireFeatureId(input?.featureId);
  const actionKind = requireActionKind(input?.actionKind);
  const scopeKey = requireScopeKey(input?.scopeKey);
  const seconds = input?.seconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new FeatureStorageUserFacingError(
      "Cooldown seconds must be an integer between 1 and 86400."
    );
  }
  const nowMs = Date.now();
  return state.storage.transactionSync(() => {
    pruneExpiredCooldowns(state.storage.sql, nowMs);
    const existing = state.storage.sql.exec(
      `SELECT expires_at_ms FROM framework_feature_cooldowns
       WHERE feature_id = ? AND action_kind = ? AND scope_key = ?`,
      featureId,
      actionKind,
      scopeKey
    ).toArray()[0];
    if (existing?.expires_at_ms > nowMs) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.expires_at_ms - nowMs) / 1000))
      };
    }
    if (!existing) {
      const total = state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM framework_feature_cooldowns"
      ).toArray()[0];
      if (Number(total?.total ?? 0) >= MAX_COOLDOWN_ROWS) {
        throw new FeatureStorageUserFacingError(
          "This group's feature cooldown ledger is temporarily full.",
          503
        );
      }
    }
    const expiresAtMs = nowMs + seconds * 1000;
    state.storage.sql.exec(
      `INSERT INTO framework_feature_cooldowns
        (feature_id, action_kind, scope_key, expires_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(feature_id, action_kind, scope_key) DO UPDATE SET
         expires_at_ms = excluded.expires_at_ms`,
      featureId,
      actionKind,
      scopeKey,
      expiresAtMs
    );
    return { allowed: true, retryAfterSeconds: 0 };
  });
}

export async function handleFeatureStateStorageOperation(state, operation, input) {
  switch (operation) {
    case "state/get":
      return getValue(state.storage.sql, "state", input);
    case "state/set":
      return setValue(state, "state", input);
    case "state/delete":
      return deleteValue(state, "state", input);
    case "state/increment":
      return incrementState(state, input);
    case "state/bounded-counter":
      return await boundedCounterState(state, input);
    default:
      return null;
  }
}

export async function handleFeatureStorageRequest(state, request, pathname) {
  if (request.method !== "POST" || !pathname.startsWith(FEATURE_STORAGE_PATH_PREFIX)) {
    return null;
  }
  const input = await request.json();
  const operation = pathname.slice(FEATURE_STORAGE_PATH_PREFIX.length);
  switch (operation) {
    case "config/get":
      return getValue(state.storage.sql, "config", input);
    case "config/set":
      return setValue(state, "config", input);
    case "config/delete":
      return deleteValue(state, "config", input);
    case "cooldown/claim":
      return claimCooldown(state, input);
    default:
      return await handleFeatureStateStorageOperation(state, operation, input);
  }
}

export const FEATURE_STORAGE_LIMITS = Object.freeze({
  maxValueBytes: MAX_FEATURE_VALUE_BYTES,
  maxValuesPerNamespace: MAX_VALUES_PER_NAMESPACE,
  maxIncrementAmount: MAX_INCREMENT_AMOUNT
});
