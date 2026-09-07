import {
  inventoryShareableStateNamespaces
} from "../shareable-state/index.js";

export class IntegrationStateDiscoveryError extends Error {
  constructor(message, {
    status = 503,
    code = "integration_state_discovery_invalid",
    cause
  } = {}) {
    super(message, { cause });
    this.name = "IntegrationStateDiscoveryError";
    this.status = status;
    this.code = code;
  }
}

function namespaceKey(namespace) {
  return `${namespace.featureId}\u0000${namespace.namespaceId}`;
}

function candidate(namespace) {
  return Object.freeze({
    schemaVersion: namespace.schemaVersion,
    mutationVersion: namespace.mutationVersion,
    fingerprint: namespace.fingerprint,
    meaningful: namespace.meaningful,
    summary: namespace.summary
  });
}

export function classifyShareableStateCandidates(discord, twitch) {
  if (!discord.meaningful && !twitch.meaningful) {
    return Object.freeze({ outcome: "both_empty", automaticSelection: "reset" });
  }
  if (discord.meaningful && !twitch.meaningful) {
    return Object.freeze({ outcome: "discord_only", automaticSelection: "discord" });
  }
  if (!discord.meaningful && twitch.meaningful) {
    return Object.freeze({ outcome: "twitch_only", automaticSelection: "twitch" });
  }
  if (
    discord.schemaVersion === twitch.schemaVersion &&
    discord.fingerprint === twitch.fingerprint
  ) {
    return Object.freeze({ outcome: "identical", automaticSelection: "discord" });
  }
  return Object.freeze({ outcome: "collision", automaticSelection: null });
}

export async function discoverIntegrationShareableState(env, {
  discordRealm,
  twitchRealm,
  correlationId
}) {
  let inventories;
  try {
    inventories = await Promise.all([
      inventoryShareableStateNamespaces(env, {
        realm: discordRealm,
        correlationId
      }),
      inventoryShareableStateNamespaces(env, {
        realm: twitchRealm,
        correlationId
      })
    ]);
  } catch (cause) {
    throw new IntegrationStateDiscoveryError(
      "Shareable-state candidates could not be inspected.",
      {
        status: cause?.status >= 400 ? cause.status : 503,
        code: "integration_state_discovery_unavailable",
        cause
      }
    );
  }
  const [discordInventory, twitchInventory] = inventories;
  const twitchByKey = new Map(twitchInventory.namespaces.map((namespace) => [
    namespaceKey(namespace),
    namespace
  ]));
  if (twitchByKey.size !== discordInventory.namespaces.length) {
    throw new IntegrationStateDiscoveryError(
      "Shareable-state namespace catalogs do not match.",
      { code: "integration_state_catalog_mismatch" }
    );
  }
  const namespaces = discordInventory.namespaces.map((discordNamespace) => {
    const key = namespaceKey(discordNamespace);
    const twitchNamespace = twitchByKey.get(key);
    if (
      !twitchNamespace ||
      discordNamespace.schemaVersion !== twitchNamespace.schemaVersion ||
      discordNamespace.featureLabel !== twitchNamespace.featureLabel ||
      discordNamespace.namespaceLabel !== twitchNamespace.namespaceLabel
    ) {
      throw new IntegrationStateDiscoveryError(
        "Shareable-state namespace catalogs do not match.",
        { code: "integration_state_catalog_mismatch" }
      );
    }
    twitchByKey.delete(key);
    const discordCandidate = candidate(discordNamespace);
    const twitchCandidate = candidate(twitchNamespace);
    const classification = classifyShareableStateCandidates(
      discordCandidate,
      twitchCandidate
    );
    return Object.freeze({
      featureId: discordNamespace.featureId,
      featureLabel: discordNamespace.featureLabel,
      namespaceId: discordNamespace.namespaceId,
      namespaceLabel: discordNamespace.namespaceLabel,
      schemaVersion: discordNamespace.schemaVersion,
      discord: discordCandidate,
      twitch: twitchCandidate,
      outcome: classification.outcome,
      automaticSelection: classification.automaticSelection
    });
  });
  if (twitchByKey.size > 0) {
    throw new IntegrationStateDiscoveryError(
      "Shareable-state namespace catalogs do not match.",
      { code: "integration_state_catalog_mismatch" }
    );
  }
  return Object.freeze({
    discordRealm,
    twitchRealm,
    namespaces: Object.freeze(namespaces),
    requiresResolution: namespaces.some(
      (namespace) => namespace.outcome === "collision"
    )
  });
}
