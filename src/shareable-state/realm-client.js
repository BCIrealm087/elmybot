import { createPlatformGroupRef } from "../integrations/contracts.js";
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

export function standaloneRealmObjectName(identity) {
  const normalized = createStandaloneRealmIdentity(
    identity?.ownerGroup,
    { generation: identity?.generation }
  );
  return `shareable-state:standalone:g${normalized.generation}:` +
    normalized.ownerGroup.key;
}

export function standaloneRealmStub(env, identity) {
  if (!env?.SHAREABLE_STATE_REALM) {
    throw new ShareableStateRealmError("Shareable-state realms are not configured.", {
      status: 503,
      code: "shareable_state_realm_not_configured"
    });
  }
  const normalized = createStandaloneRealmIdentity(
    identity?.ownerGroup,
    { generation: identity?.generation }
  );
  return env.SHAREABLE_STATE_REALM.get(
    env.SHAREABLE_STATE_REALM.idFromName(standaloneRealmObjectName(normalized))
  );
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

export async function requestStandaloneRealmState(env, {
  group,
  generation = 1,
  featureId,
  namespaceId,
  operation,
  storage,
  correlationId
}) {
  const realm = createStandaloneRealmIdentity(group, { generation });
  return await checkedRealmResponse(await standaloneRealmStub(env, realm).fetch(
    `https://shareable-state${SHAREABLE_STATE_REALM_PATH_PREFIX}${operation}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(correlationId ? { "x-correlation-id": correlationId } : {})
      },
      body: JSON.stringify({
        realm,
        namespace: { featureId, namespaceId },
        storage
      })
    }
  ));
}
