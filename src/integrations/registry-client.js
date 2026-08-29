import {
  IntegrationRegistryError,
  validatedGroup,
  validatedOpaqueId
} from "./registry-validation.js";

export const INTEGRATION_REGISTRY_NAME = "integration:registry";

export function integrationRegistryStub(env) {
  if (!env.INTEGRATION_REGISTRY) {
    throw new IntegrationRegistryError("The integration registry is not configured.", {
      status: 503,
      code: "integration_registry_not_configured"
    });
  }
  return env.INTEGRATION_REGISTRY.get(
    env.INTEGRATION_REGISTRY.idFromName(INTEGRATION_REGISTRY_NAME)
  );
}

async function checkedRegistryResponse(response) {
  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok) {
    throw new IntegrationRegistryError(
      result?.error || "The integration registry request failed.",
      {
        status: response.status,
        code: result?.code || "integration_registry_request_failed"
      }
    );
  }
  return result;
}

async function postRegistry(env, pathname, input) {
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    `https://integration-registry${pathname}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  ));
}

export async function createIntegrationInvitation(env, input) {
  return postRegistry(env, "/invitations", input);
}

export async function reserveIntegrationInvitation(env, input) {
  return postRegistry(env, "/invitations/reserve", input);
}

export async function completeIntegrationInvitation(env, input) {
  return postRegistry(env, "/invitations/complete", input);
}

export async function listIntegrationsForGroup(env, group, { limit } = {}) {
  group = validatedGroup(group);
  const url = new URL("https://integration-registry/integrations");
  url.searchParams.set("groupKey", group.key);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(url));
}

export async function getIntegrationById(env, integrationId) {
  integrationId = validatedOpaqueId(integrationId, "Integration ID");
  return checkedRegistryResponse(await integrationRegistryStub(env).fetch(
    `https://integration-registry/integrations/${encodeURIComponent(integrationId)}`
  ));
}

export async function getIntegrationManagementStatus(env, input) {
  return postRegistry(env, "/integrations/status", input);
}

export async function updateIntegrationRoute(env, input) {
  return postRegistry(env, "/routes/update", input);
}

export async function listIntegrationAudit(env, input) {
  return postRegistry(env, "/audit", input);
}

export async function revokeIntegration(env, input) {
  return postRegistry(env, "/integrations/revoke", input);
}

export async function revokeIntegrationsForGroup(env, input) {
  if (!env.INTEGRATION_REGISTRY) return { revoked: 0 };
  return postRegistry(env, "/groups/revoke", input);
}

export async function resolveIntegrationRoutes(env, input) {
  return postRegistry(env, "/routes/resolve", input);
}
