import {
  createIntegrationRef,
  createPlatformGroupRef
} from "../integrations/contracts.js";
import {
  SHAREABLE_STATE_REALM_PATH_PREFIX,
  SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION,
  ShareableStateRealmError
} from "./realm.js";

const SNAPSHOT_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function createStandaloneRealmIdentity(group, { generation = 1 } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ShareableStateRealmError("The standalone realm generation is invalid.", {
      code: "shareable_state_realm_identity_invalid"
    });
  }
  return Object.freeze({
    kind: "standalone",
    ownerGroup: createPlatformGroupRef(group),
    generation
  });
}

export function createIntegrationRealmIdentity(integration, { generation = 1 } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ShareableStateRealmError("The integration realm generation is invalid.", {
      code: "shareable_state_realm_identity_invalid"
    });
  }
  return Object.freeze({
    kind: "integration",
    ownerIntegration: createIntegrationRef(integration),
    generation
  });
}

function normalizeIdentity(identity) {
  if (identity?.kind === "standalone") {
    return createStandaloneRealmIdentity(
      identity.ownerGroup,
      { generation: identity.generation }
    );
  }
  if (identity?.kind === "integration") {
    return createIntegrationRealmIdentity(
      identity.ownerIntegration,
      { generation: identity.generation }
    );
  }
  throw new ShareableStateRealmError("The shareable-state realm identity is invalid.", {
    code: "shareable_state_realm_identity_invalid"
  });
}

export function shareableStateRealmObjectName(identity) {
  const normalized = normalizeIdentity(identity);
  const ownerKey = normalized.kind === "standalone"
    ? normalized.ownerGroup.key
    : normalized.ownerIntegration.key;
  return `shareable-state:${normalized.kind}:g${normalized.generation}:${ownerKey}`;
}

export function standaloneRealmObjectName(identity) {
  const normalized = createStandaloneRealmIdentity(
    identity?.ownerGroup,
    { generation: identity?.generation }
  );
  return shareableStateRealmObjectName(normalized);
}

export function shareableStateRealmStub(env, identity) {
  if (!env?.SHAREABLE_STATE_REALM) {
    throw new ShareableStateRealmError("Shareable-state realms are not configured.", {
      status: 503,
      code: "shareable_state_realm_not_configured"
    });
  }
  const normalized = normalizeIdentity(identity);
  return env.SHAREABLE_STATE_REALM.get(
    env.SHAREABLE_STATE_REALM.idFromName(shareableStateRealmObjectName(normalized))
  );
}

export function standaloneRealmStub(env, identity) {
  return shareableStateRealmStub(env, createStandaloneRealmIdentity(
    identity?.ownerGroup,
    { generation: identity?.generation }
  ));
}

async function checkedRealmResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw new ShareableStateRealmError(
      "The shareable-state realm returned an invalid response.",
      { status: 502, code: "shareable_state_realm_invalid_response", cause }
    );
  }
  if (!response.ok) {
    throw new ShareableStateRealmError(
      result?.error ?? "The shareable-state realm request failed.",
      {
        status: response.status,
        code: result?.code ?? "shareable_state_realm_request_failed"
      }
    );
  }
  return result;
}

function freezeJson(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJson(entry)));
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(
      ([key, entry]) => [key, freezeJson(entry)]
    )));
  }
  return value;
}

function normalizeSnapshot(snapshot) {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    snapshot.formatVersion !== SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION ||
    typeof snapshot.namespace?.featureId !== "string" ||
    typeof snapshot.namespace?.namespaceId !== "string" ||
    !Number.isSafeInteger(snapshot.namespace?.schemaVersion) ||
    snapshot.namespace.schemaVersion < 1 ||
    !Number.isSafeInteger(snapshot.mutationVersion) ||
    snapshot.mutationVersion < 0 ||
    !SNAPSHOT_FINGERPRINT_PATTERN.test(snapshot.fingerprint ?? "") ||
    typeof snapshot.meaningful !== "boolean" ||
    typeof snapshot.summary !== "object" ||
    snapshot.summary === null ||
    !Array.isArray(snapshot.entries)
  ) {
    throw new ShareableStateRealmError("The shareable-state snapshot is invalid.", {
      status: 502,
      code: "shareable_state_snapshot_invalid"
    });
  }
  if (snapshot.meaningful !== (snapshot.entries.length > 0)) {
    throw new ShareableStateRealmError(
      "The shareable-state snapshot usage marker is invalid.",
      { status: 502, code: "shareable_state_snapshot_invalid" }
    );
  }
  const entries = snapshot.entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.key !== "string" ||
      !("value" in entry)
    ) {
      throw new ShareableStateRealmError(
        "The shareable-state snapshot content is invalid.",
        { status: 502, code: "shareable_state_snapshot_invalid" }
      );
    }
    return Object.freeze({ key: entry.key, value: freezeJson(entry.value) });
  });
  const summary = snapshot.summary.kind === "presence"
    ? { kind: "presence", used: snapshot.summary.used }
    : snapshot.summary.kind === "entry_count"
      ? {
          kind: "entry_count",
          used: snapshot.summary.used,
          entryCount: snapshot.summary.entryCount
        }
      : null;
  if (
    summary === null ||
    typeof summary.used !== "boolean" ||
    summary.used !== snapshot.meaningful ||
    (
      summary.kind === "entry_count" &&
      summary.entryCount !== entries.length
    )
  ) {
    throw new ShareableStateRealmError(
      "The shareable-state snapshot summary is invalid.",
      { status: 502, code: "shareable_state_snapshot_invalid" }
    );
  }
  return Object.freeze({
    formatVersion: snapshot.formatVersion,
    namespace: Object.freeze({
      featureId: snapshot.namespace.featureId,
      namespaceId: snapshot.namespace.namespaceId,
      schemaVersion: snapshot.namespace.schemaVersion
    }),
    mutationVersion: snapshot.mutationVersion,
    fingerprint: snapshot.fingerprint,
    meaningful: snapshot.meaningful,
    summary: Object.freeze(summary),
    entries: Object.freeze(entries)
  });
}

export async function requestShareableStateRealm(env, {
  realm,
  featureId,
  namespaceId,
  operation,
  storage,
  correlationId
}) {
  const normalized = normalizeIdentity(realm);
  return await checkedRealmResponse(await shareableStateRealmStub(env, normalized).fetch(
    `https://shareable-state${SHAREABLE_STATE_REALM_PATH_PREFIX}${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(correlationId ? { "x-correlation-id": correlationId } : {})
      },
      body: JSON.stringify({
        realm: normalized,
        namespace: { featureId, namespaceId },
        storage
      })
    }
  ));
}

export async function snapshotShareableStateNamespace(env, {
  realm,
  featureId,
  namespaceId,
  correlationId
}) {
  return normalizeSnapshot(await requestShareableStateRealm(env, {
    realm,
    featureId,
    namespaceId,
    operation: "snapshot",
    correlationId
  }));
}

export function shareableStateSnapshotHasMeaningfulState(snapshot) {
  return normalizeSnapshot(snapshot).meaningful;
}

export function shareableStateSnapshotsEqual(left, right) {
  const normalizedLeft = normalizeSnapshot(left);
  const normalizedRight = normalizeSnapshot(right);
  return normalizedLeft.namespace.featureId === normalizedRight.namespace.featureId &&
    normalizedLeft.namespace.namespaceId === normalizedRight.namespace.namespaceId &&
    normalizedLeft.namespace.schemaVersion === normalizedRight.namespace.schemaVersion &&
    normalizedLeft.fingerprint === normalizedRight.fingerprint;
}

export async function cloneShareableStateSnapshot(env, {
  realm,
  snapshot,
  expectedTargetMutationVersion = 0,
  correlationId
}) {
  const normalized = normalizeSnapshot(snapshot);
  return await requestShareableStateRealm(env, {
    realm,
    featureId: normalized.namespace.featureId,
    namespaceId: normalized.namespace.namespaceId,
    operation: "clone-snapshot",
    storage: { snapshot: normalized, expectedTargetMutationVersion },
    correlationId
  });
}

export async function requestStandaloneRealmState(env, {
  group,
  generation = 1,
  ...request
}) {
  return await requestShareableStateRealm(env, {
    ...request,
    realm: createStandaloneRealmIdentity(group, { generation })
  });
}
