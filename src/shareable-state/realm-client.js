import {
  createIntegrationRef,
  createPlatformGroupRef
} from "../integrations/contracts.js";
import {
  SHAREABLE_STATE_REALM_PATH_PREFIX,
  ShareableStateRealmError
} from "./realm.js";

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
