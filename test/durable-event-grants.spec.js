import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineDurableEventStream,
  defineFeature,
  frameworkApiVersion
} from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/feature-registry.js";
import { createPlatformGroupRef } from "../src/integrations/contracts.js";
import { integrationRegistryStub } from "../src/integrations/index.js";
import {
  createStandaloneRealmIdentity,
  shareableStateRealmObjectName
} from "../src/shareable-state/index.js";
import {
  issueDurableEventGrant,
  parseDurableEventCredential,
  revokeDurableEventCredential,
  validateDurableEventCredential,
  validateDurableEventGrantReference
} from "../src/durable-events/grant-client.js";
import { handleDurableEventRequest } from "../src/durable-events/http.js";
import { handleStateQueryRequest } from "../src/state-querying/http.js";
import { durableEventRouteId } from "../src/durable-events/contract.js";
import { commands as discordCommands } from "../src/platforms/discord/commands.js";
import { CAPABILITIES } from "../src/platforms/discord/discord-permissions.js";
import {
  TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME
} from "../src/platforms/twitch/channel-auth-common.js";

const eventEnv = {
  ...env,
  DURABLE_EVENT_STREAMS_ENABLED: "true",
  DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT: "test",
  DURABLE_EVENT_PUBLIC_ORIGIN: "https://example.com",
  DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET:
    "test-durable-event-signing-secret-32-bytes-minimum",
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret"
};

let nextId = 10_000;

function target(platform = "discord") {
  nextId += 1;
  return { platform, groupId: String(nextId) };
}

function registry(scopeKind = "group_local") {
  return createFeatureRegistry([defineFeature({
    apiVersion: frameworkApiVersion,
    id: "test.events",
    description: "Tests event grants.",
    eventStreams: [defineDurableEventStream({
      id: "updates",
      version: 1,
      label: "Updates",
      description: "Test event updates.",
      platforms: ["discord", "twitch"],
      scope: { kind: scopeKind },
      access: { kind: "operator_grant" },
      payload: {
        schema: {
          type: "object",
          properties: { data: { type: "string", minLength: 1, maxLength: 100 } },
          required: ["data"]
        }
      }
    })]
  })]);
}

function group(selectedTarget) {
  return createPlatformGroupRef({
    platform: selectedTarget.platform,
    kind: selectedTarget.platform === "discord" ? "guild" : "channel",
    id: selectedTarget.groupId
  });
}

async function routeFor(selectedTarget, scopeKind = "group_local") {
  const selectedGroup = group(selectedTarget);
  const realmIdentity = scopeKind === "group_local"
    ? selectedGroup.key
    : shareableStateRealmObjectName(createStandaloneRealmIdentity(
        selectedGroup,
        { generation: 1 }
      ));
  const descriptor = {
    deploymentEnvironment: "test",
    scopeKind,
    realmIdentity,
    featureId: "test.events",
    streamId: "updates",
    version: 1
  };
  return { routeId: await durableEventRouteId(descriptor), descriptor };
}

async function prepareStream(selectedTarget, selectedRegistry, scopeKind = "group_local") {
  const route = await routeFor(selectedTarget, scopeKind);
  const stub = env.DURABLE_EVENT_STREAM.get(
    env.DURABLE_EVENT_STREAM.idFromName(route.routeId)
  );
  await runInDurableObject(stub, async (instance) => {
    instance.registry = selectedRegistry;
  });
  return { ...route, stub };
}

async function issue(selectedTarget, selectedRegistry, options = {}) {
  return issueDurableEventGrant(eventEnv, selectedRegistry, {
    target: selectedTarget,
    stream: "test.events:updates:v1",
    expiresInSeconds: options.expiresInSeconds ?? 3_600,
    resetBacklog: options.resetBacklog ?? false
  }, {
    actor: { platform: selectedTarget.platform, id: "operator" },
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs })
  });
}

async function request(path, init, selectedRegistry) {
  return handleDurableEventRequest(
    new Request(`https://example.com${path}`, init),
    eventEnv,
    { registry: selectedRegistry }
  );
}

function bearer(credential, extra = {}) {
  return { authorization: `Bearer ${credential}`, ...extra };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("durable event grants, sessions, and discovery", () => {
  it("stores only a grant-secret digest and returns one value-free authorized stream", async () => {
    const selectedTarget = target();
    const selectedRegistry = registry();
    const route = await prepareStream(selectedTarget, selectedRegistry);
    const issued = await issue(selectedTarget, selectedRegistry);
    const parsed = await parseDurableEventCredential(eventEnv, issued.credential);
    expect(parsed.routeId).toBe(route.routeId);

    await runInDurableObject(route.stub, async (_instance, state) => {
      const row = state.storage.sql.exec(
        `SELECT secret_digest, issued_by_json, target_group_id, route_id
         FROM durable_event_stream_grants WHERE grant_id = ?`,
        issued.grant.id
      ).one();
      expect(row.secret_digest).not.toBe(parsed.secret);
      expect(JSON.stringify(row)).not.toContain(issued.credential);
      expect(JSON.stringify(row)).not.toContain(parsed.secret);
      expect(JSON.parse(row.issued_by_json)).toEqual({
        platform: "discord",
        id: "operator"
      });
      expect(row.target_group_id).toBe(selectedTarget.groupId);
      expect(row.route_id).toBe(route.routeId);
    });

    const response = await request("/event-stream/catalog", {
      headers: bearer(issued.credential)
    }, selectedRegistry);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.target).toEqual(selectedTarget);
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0]).toMatchObject({
      feature: "test.events",
      stream: "updates",
      version: 1,
      scope: { kind: "group_local" }
    });
    expect(JSON.stringify(body)).not.toContain(route.descriptor.realmIdentity);
    expect(JSON.stringify(body)).not.toContain('"id":"operator"');
  });

  it("uses a separate same-origin secure session and rejects state-query credentials", async () => {
    const selectedTarget = target();
    const selectedRegistry = registry();
    await prepareStream(selectedTarget, selectedRegistry);
    const issued = await issue(selectedTarget, selectedRegistry);
    const crossOrigin = await request("/event-stream/session", {
      method: "POST",
      headers: bearer(issued.credential, { origin: "https://attacker.example" })
    }, selectedRegistry);
    expect(crossOrigin.status).toBe(403);

    const session = await request("/event-stream/session", {
      method: "POST",
      headers: bearer(issued.credential, { origin: "https://example.com" })
    }, selectedRegistry);
    const cookie = session.headers.get("set-cookie");
    expect(session.status).toBe(204);
    expect(cookie).toContain("elmybot_durable_event=");
    expect(cookie).toContain("Path=/event-stream");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Domain=");

    const catalog = await request("/event-stream/catalog", {
      headers: { cookie: cookie.split(";")[0] }
    }, selectedRegistry);
    expect(catalog.status).toBe(200);
    const wrongType = await request("/event-stream/catalog", {
      headers: bearer("elmybot-sqg-v1.not-an-event-grant")
    }, selectedRegistry);
    expect(wrongType.status).toBe(403);
    expect(JSON.stringify(await wrongType.json())).not.toContain("not-an-event-grant");
    const stateQueryWrongType = await handleStateQueryRequest(
      new Request("https://example.com/state-query/catalog", {
        headers: bearer(issued.credential)
      }),
      {
        ...eventEnv,
        STATE_QUERY_DEPLOYMENT_ENVIRONMENT: "test",
        STATE_QUERY_PUBLIC_ORIGIN: "https://example.com",
        STATE_QUERY_CREDENTIAL_SIGNING_SECRET:
          "test-state-query-signing-secret-32-bytes-minimum"
      }
    );
    expect(stateQueryWrongType.status).toBe(403);

    const cookieHeader = { cookie: cookie.split(";")[0] };
    const crossOriginRevoke = await request("/event-stream/grant", {
      method: "DELETE",
      headers: cookieHeader
    }, selectedRegistry);
    expect(crossOriginRevoke.status).toBe(403);
    const revoked = await request("/event-stream/grant", {
      method: "DELETE",
      headers: { ...cookieHeader, origin: "https://example.com" }
    }, selectedRegistry);
    expect(revoked.status).toBe(204);
    expect(revoked.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("replaces and revokes grants atomically while references cannot race revocation", async () => {
    const selectedTarget = target();
    const selectedRegistry = registry();
    const route = await prepareStream(selectedTarget, selectedRegistry);
    const first = await issue(selectedTarget, selectedRegistry);
    const second = await issue(selectedTarget, selectedRegistry);
    await expect(validateDurableEventCredential(eventEnv, first.credential))
      .rejects.toMatchObject({ code: "durable_event_grant_revoked" });
    await expect(validateDurableEventCredential(eventEnv, second.credential))
      .resolves.toMatchObject({ id: second.grant.id });
    await expect(validateDurableEventGrantReference(eventEnv, {
      routeId: route.routeId,
      grantId: second.grant.id,
      target: selectedTarget
    })).resolves.toMatchObject({ id: second.grant.id });
    await expect(validateDurableEventGrantReference(eventEnv, {
      routeId: route.routeId,
      grantId: second.grant.id,
      target: target()
    })).rejects.toMatchObject({ code: "durable_event_access_denied" });

    await revokeDurableEventCredential(eventEnv, second.credential);
    await expect(validateDurableEventGrantReference(eventEnv, {
      routeId: route.routeId,
      grantId: second.grant.id,
      target: selectedTarget
    })).rejects.toMatchObject({ code: "durable_event_grant_revoked" });
    await runInDurableObject(route.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT status FROM durable_event_stream_grants ORDER BY issued_at_ms, grant_id"
      ).toArray().map((row) => row.status).sort()).toEqual(["replaced", "revoked"]);
    });
  });

  it("enforces target, environment, expiry, and signed routing isolation", async () => {
    const selectedTarget = target();
    const selectedRegistry = registry();
    await prepareStream(selectedTarget, selectedRegistry);
    const expired = await issue(selectedTarget, selectedRegistry, {
      expiresInSeconds: 300,
      nowMs: Date.now() - 301_000
    });
    await expect(validateDurableEventCredential(eventEnv, expired.credential))
      .rejects.toMatchObject({ code: "durable_event_grant_expired" });

    const issued = await issue(selectedTarget, selectedRegistry);
    await expect(validateDurableEventCredential({
      ...eventEnv,
      DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT: "production"
    }, issued.credential)).rejects.toMatchObject({ code: "durable_event_access_denied" });
    const forged = issued.credential.split(".");
    forged[4] = `${forged[4][0] === "A" ? "B" : "A"}${forged[4].slice(1)}`;
    await expect(validateDurableEventCredential(eventEnv, forged.join(".")))
      .rejects.toMatchObject({ code: "durable_event_access_denied" });
  });

  it("requires explicit loss acknowledgement before resetting a retention gap", async () => {
    const selectedTarget = target();
    const selectedRegistry = registry();
    const route = await prepareStream(selectedTarget, selectedRegistry);
    await issue(selectedTarget, selectedRegistry);
    await runInDurableObject(route.stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE durable_event_stream_metadata
         SET gap_first_sequence = 4, gap_last_sequence = 7 WHERE singleton = 1`
      );
    });
    await expect(issue(selectedTarget, selectedRegistry))
      .rejects.toMatchObject({ code: "durable_event_gap_requires_reset" });
    await expect(issue(selectedTarget, selectedRegistry, { resetBacklog: true }))
      .resolves.toMatchObject({ grant: { target: selectedTarget } });
    await runInDurableObject(route.stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT gap_first_sequence, gap_last_sequence, retained_count, consumer_ready
         FROM durable_event_stream_metadata WHERE singleton = 1`
      ).one()).toMatchObject({
        gap_first_sequence: null,
        gap_last_sequence: null,
        retained_count: 0,
        consumer_ready: 0
      });
      const reset = state.storage.sql.exec(
        `SELECT feature_id, stream_id, stream_version, route_id,
                first_sequence, last_sequence, actor_json, reset_at_ms
         FROM durable_event_stream_resets`
      ).one();
      expect(reset).toMatchObject({
        feature_id: "test.events",
        stream_id: "updates",
        stream_version: 1,
        route_id: route.routeId,
        first_sequence: 4,
        last_sequence: 7
      });
      expect(JSON.parse(reset.actor_json)).toEqual({
        platform: "discord",
        id: "operator"
      });
      expect(Number(reset.reset_at_ms)).toBeGreaterThan(0);
      expect(JSON.stringify(reset)).not.toContain("payload");
    });
  });

  it("pins effective-shareable grants to ordered lifecycle authority", async () => {
    const selectedTarget = target();
    const selectedRegistry = registry("effective_shareable");
    const route = await prepareStream(selectedTarget, selectedRegistry, "effective_shareable");
    await runInDurableObject(integrationRegistryStub(env), async (instance) => {
      instance.env = eventEnv;
    });
    const issued = await issue(selectedTarget, selectedRegistry, {
      expiresInSeconds: 300
    });
    await expect(validateDurableEventCredential(eventEnv, issued.credential))
      .resolves.toMatchObject({ stream: { feature: "test.events", stream: "updates" } });
    await runInDurableObject(integrationRegistryStub(env), async (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT route_id, expected_revision, expected_source_key
         FROM durable_event_binding_watchers WHERE route_id = ?`,
        route.routeId
      ).one()).toMatchObject({
        route_id: route.routeId,
        expected_revision: 0,
        expected_source_key: route.descriptor.realmIdentity
      });
    });
  });

  it("exposes a manager-only Discord command and Twitch broadcaster OAuth start", async () => {
    expect(discordCommands.event_stream_grant.guild).toEqual({
      capability: CAPABILITIES.EVENT_STREAM_MANAGE
    });
    const selectedTarget = target("twitch");
    const selectedRegistry = registry();
    await prepareStream(selectedTarget, selectedRegistry);
    const oauthStub = env.TWITCH_CHANNEL_OAUTH.get(
      env.TWITCH_CHANNEL_OAUTH.idFromName(TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME)
    );
    await runInDurableObject(oauthStub, async (instance) => {
      instance.env = eventEnv;
      instance.registry = selectedRegistry;
    });
    const page = await request("/event-stream/operator/twitch", {}, selectedRegistry);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("test.events:updates:v1");
    const start = await request("/event-stream/operator/twitch", {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        stream: "test.events:updates:v1",
        duration_hours: "1"
      })
    }, selectedRegistry);
    const authorizationUrl = new URL(start.headers.get("location"));
    expect(start.status).toBe(303);
    expect(authorizationUrl.origin).toBe("https://id.twitch.tv");
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid");
    expect(authorizationUrl.searchParams.get("redirect_uri"))
      .toBe("https://example.com/event-stream/operator/twitch/callback");

    const externalFetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://id.twitch.tv/oauth2/token") {
        return Response.json({
          access_token: "temporary-event-token",
          refresh_token: "temporary-event-refresh",
          expires_in: 14_000,
          scope: ["openid"],
          token_type: "bearer"
        });
      }
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Response.json({
          client_id: "client-id",
          user_id: selectedTarget.groupId,
          login: "broadcaster",
          scopes: ["openid"],
          expires_in: 14_000
        });
      }
      if (url === "https://id.twitch.tv/oauth2/revoke") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected external request: ${url}`);
    });
    vi.stubGlobal("fetch", externalFetch);
    const callback = await request(
      "/event-stream/operator/twitch/callback?code=oauth-code&state=" +
        authorizationUrl.searchParams.get("state"),
      {},
      selectedRegistry
    );
    const callbackHtml = await callback.text();
    const credential = callbackHtml.match(/<code>(elmybot-deg-v1\.[^<]+)<\/code>/)?.[1];
    expect(callback.status).toBe(200);
    expect(credential).toBeTruthy();
    expect(callback.headers.get("set-cookie")).toContain(credential);
    expect(externalFetch).toHaveBeenCalledTimes(3);
    await expect(validateDurableEventCredential(eventEnv, credential))
      .resolves.toMatchObject({ target: selectedTarget });
  });
});
