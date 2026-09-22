import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  env,
  runInDurableObject
} from "cloudflare:test";
import worker from "../src/index.js";
import { createFeatureServiceRuntime } from "../src/framework/service-runtime.js";
import { featureRegistry } from "../src/features/index.js";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { commands as discordCommands } from "../src/platforms/discord/commands.js";
import { CAPABILITIES } from "../src/platforms/discord/discord-permissions.js";
import {
  TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME
} from "../src/platforms/twitch/channel-auth-common.js";
import {
  issueStateQueryGrant,
  parseStateQueryCredential,
  validateStateQueryCredential
} from "../src/state-querying/grant-client.js";
import { grantPermissionsForExportList } from "../src/state-querying/grants.js";

const queryEnv = {
  ...env,
  STATE_QUERY_DEPLOYMENT_ENVIRONMENT: "test",
  STATE_QUERY_PUBLIC_ORIGIN: "https://example.com",
  STATE_QUERY_CREDENTIAL_SIGNING_SECRET: "test-state-query-signing-secret-32-bytes-minimum",
  TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
  TWITCH_PUBLIC_ORIGIN: "https://example.com",
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret"
};

let idCounter = 0;

function target(platform = "discord") {
  idCounter += 1;
  return {
    platform,
    groupId: `${platform}-state-query-http-${idCounter}`
  };
}

function read(exportId, args) {
  return {
    read: { feature: "fun.deaths", export: exportId, version: 1 },
    ...(args ? { arguments: args } : {})
  };
}

function widgetRead() {
  return {
    read: { feature: "widget.data", export: "latest", version: 1 }
  };
}

function query(selectedTarget, bindings, select) {
  return { version: 1, target: selectedTarget, bindings, select };
}

async function issue(selectedTarget, exportList, options = {}) {
  return issueStateQueryGrant(queryEnv, featureRegistry, {
    target: selectedTarget,
    permissions: grantPermissionsForExportList(
      featureRegistry,
      selectedTarget.platform,
      exportList
    ),
    expiresInSeconds: options.expiresInSeconds ?? 3600,
    ...(options.limits ? { limits: options.limits } : {})
  }, {
    actor: { platform: selectedTarget.platform, id: "test-operator" },
    ...options.clientOptions
  });
}

function bearer(credential, extra = {}) {
  return { authorization: `Bearer ${credential}`, ...extra };
}

async function request(path, init = {}, environment = queryEnv) {
  return worker.fetch(
    new Request(`https://example.com${path}`, init),
    environment,
    createExecutionContext()
  );
}

async function seedDeaths(selectedTarget, { remembered = "Hades", count = 9 } = {}) {
  const kind = selectedTarget.platform === "discord" ? "guild" : "channel";
  const group = {
    platform: selectedTarget.platform,
    kind,
    id: selectedTarget.groupId,
    key: `${selectedTarget.platform}:${kind}:${selectedTarget.groupId}`
  };
  const invocation = createCommandInvocation({
    kind: "fun.deaths.manage.v1",
    origin: {
      group,
      actor: { platform: selectedTarget.platform, id: "operator", claims: [] }
    },
    sourceEventId: `${selectedTarget.platform}:state-query-http:${selectedTarget.groupId}`
  });
  const services = createFeatureServiceRuntime(env, invocation).featureServices;
  await services.state.set("fun.deaths", "last_game", remembered);
  const otherPlatform = selectedTarget.platform === "discord" ? "twitch" : "discord";
  const scope = await services.shareableState.current(
    "fun.deaths",
    otherPlatform,
    "game_deaths"
  );
  await services.shareableState.boundedCounter(
    "fun.deaths",
    scope,
    {
      name: "game",
      subject: remembered.toLowerCase(),
      subjectLabel: remembered,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      initial: 0
    },
    "set",
    count
  );
}

async function seedWidgetData(selectedTarget, publication) {
  const kind = selectedTarget.platform === "discord" ? "guild" : "channel";
  const group = {
    platform: selectedTarget.platform,
    kind,
    id: selectedTarget.groupId,
    key: `${selectedTarget.platform}:${kind}:${selectedTarget.groupId}`
  };
  const invocation = createCommandInvocation({
    kind: "widget.data.publish.v1",
    origin: {
      group,
      actor: { platform: selectedTarget.platform, id: "operator", claims: [] }
    },
    sourceEventId: `${selectedTarget.platform}:state-query-http:${selectedTarget.groupId}`
  });
  const services = createFeatureServiceRuntime(env, invocation).featureServices;
  const otherPlatform = selectedTarget.platform === "discord" ? "twitch" : "discord";
  const scope = await services.shareableState.current(
    "widget.data",
    otherPlatform,
    "published_data"
  );
  await services.shareableState.set("widget.data", scope, "latest", publication);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("state-query read grants and HTTP snapshots", () => {
  it("stores only a credential hash and returns a grant-filtered catalog", async () => {
    const selectedTarget = target();
    const issued = await issue(
      selectedTarget,
      "fun.deaths:remembered_game:v1,fun.deaths:count:v1"
    );
    const parsed = await parseStateQueryCredential(queryEnv, issued.credential);
    const groupKey = `discord:guild:${selectedTarget.groupId}`;
    const stub = env.CONFIG.get(env.CONFIG.idFromName(groupKey));
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec(
        `SELECT grant_id, secret_digest, permissions_json, issued_by_json
         FROM state_query_read_grants WHERE grant_id = ?`,
        issued.grant.id
      ).one();
      expect(row.grant_id).toBe(issued.grant.id);
      expect(row.secret_digest).not.toBe(parsed.secret);
      expect(JSON.stringify(row)).not.toContain(issued.credential);
      expect(JSON.stringify(row)).not.toContain(parsed.secret);
      expect(JSON.parse(row.issued_by_json)).toEqual({
        id: "test-operator",
        platform: "discord"
      });
    });

    const response = await request("/state-query/catalog", {
      headers: bearer(issued.credential)
    });
    const catalog = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(catalog.target).toEqual(selectedTarget);
    expect(catalog.exports.map((entry) => entry.export)).toEqual([
      "count",
      "remembered_game"
    ]);
    expect(catalog.exports[0].grantScope.arguments.game.values).toEqual({ kind: "any" });
  });

  it("discovers, grants, reads, projects, and wholly denies widget data", async () => {
    const selectedTarget = target("twitch");
    const publication = {
      updateId: "wdu1." + "b".repeat(43),
      data: "consumer-defined widget text",
      origin: "twitch"
    };
    await seedWidgetData(selectedTarget, publication);
    const issued = await issue(selectedTarget, "widget.data:latest:v1");

    const catalogResponse = await request("/state-query/catalog", {
      headers: bearer(issued.credential)
    });
    const catalog = await catalogResponse.json();
    expect(catalogResponse.status).toBe(200);
    expect(catalog.exports).toHaveLength(1);
    expect(catalog.exports[0]).toMatchObject({
      feature: "widget.data",
      export: "latest",
      version: 1,
      kind: "value",
      scope: "effective_shareable",
      absence: { kind: "absent" },
      resultSchema: {
        type: "object",
        properties: {
          updateId: { type: "string", minLength: 48, maxLength: 48 },
          data: { type: "string", minLength: 1, maxLength: 400 },
          origin: { type: "string", minLength: 6, maxLength: 7 }
        },
        required: ["updateId", "data", "origin"]
      }
    });

    const body = query(selectedTarget, {
      widget: widgetRead()
    }, {
      widget: { ref: "widget" },
      data: { ref: "widget", path: ["data"] }
    });
    const response = await request("/state-query/snapshot", {
      method: "POST",
      headers: bearer(issued.credential, { "content-type": "application/json" }),
      body: JSON.stringify(body)
    });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.data).toEqual({
      data: { state: "present", value: publication.data },
      widget: { state: "present", value: publication }
    });
    expect(Object.keys(result.data.widget.value).sort())
      .toEqual(["data", "origin", "updateId"]);
    expect(JSON.stringify(result.data.widget.value)).not.toMatch(
      /actor|sourceEvent|group|integration|realm|storage/i
    );

    const deathsOnly = await issue(selectedTarget, "fun.deaths:remembered_game:v1");
    const denied = await request("/state-query/snapshot", {
      method: "POST",
      headers: bearer(deathsOnly.credential, { "content-type": "application/json" }),
      body: JSON.stringify(query(selectedTarget, {
        remembered: read("remembered_game"),
        widget: widgetRead()
      }, {
        remembered: { ref: "remembered" },
        widget: { ref: "widget" }
      }))
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("query_access_denied");
  });

  it("evaluates an authorized literal and dynamic snapshot without changing state", async () => {
    const selectedTarget = target();
    await seedDeaths(selectedTarget);
    const issued = await issue(
      selectedTarget,
      "fun.deaths:remembered_game:v1,fun.deaths:count:v1"
    );
    const body = query(selectedTarget, {
      remembered: read("remembered_game"),
      current: read("count", { game: { ref: "remembered" } }),
      fixed: read("count", { game: { literal: " HADES " } })
    }, {
      game: { ref: "remembered" },
      current: { ref: "current", path: ["count"] },
      fixed: { ref: "fixed", path: ["count"] }
    });

    const response = await request("/state-query/snapshot", {
      method: "POST",
      headers: bearer(issued.credential, { "content-type": "application/json" }),
      body: JSON.stringify(body)
    });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      protocolVersion: 1,
      status: "ready",
      data: {
        game: { state: "present", value: "Hades" },
        current: { state: "present", value: 9 },
        fixed: { state: "present", value: 9 }
      }
    });
    expect(result.observation).toBeUndefined();
  });

  it("includes collection members materialized after an explicit future-members grant", async () => {
    const selectedTarget = target();
    const issued = await issue(selectedTarget, "fun.deaths:counts:v1");
    await seedDeaths(selectedTarget, { remembered: "Sekiro", count: 4 });
    const response = await request("/state-query/snapshot", {
      method: "POST",
      headers: bearer(issued.credential, { "content-type": "application/json" }),
      body: JSON.stringify(query(selectedTarget, {
        counts: read("counts")
      }, { counts: { ref: "counts" } }))
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.counts).toEqual({
      state: "present",
      value: [{ game: "Sekiro", count: 4 }]
    });
  });

  it("enforces exact arguments, dynamic sources, collections, target, and hidden exports", async () => {
    const selectedTarget = target();
    const rememberedRead = {
      feature: "fun.deaths",
      export: "remembered_game",
      version: 1
    };
    const issued = await issueStateQueryGrant(queryEnv, featureRegistry, {
      target: selectedTarget,
      expiresInSeconds: 3600,
      permissions: [
        { read: rememberedRead },
        {
          read: { feature: "fun.deaths", export: "count", version: 1 },
          arguments: {
            game: {
              values: { exact: [" HADES "] },
              dynamicFrom: [rememberedRead]
            }
          }
        }
      ]
    }, {
      actor: { platform: "discord", id: "test-operator" }
    });
    const snapshot = async (body) => {
      const response = await request("/state-query/snapshot", {
        method: "POST",
        headers: bearer(issued.credential, { "content-type": "application/json" }),
        body: JSON.stringify(body)
      });
      return { response, result: await response.json() };
    };

    const deniedLiteral = await snapshot(query(selectedTarget, {
      count: read("count", { game: { literal: "Sekiro" } })
    }, { count: { ref: "count" } }));
    expect(deniedLiteral.response.status).toBe(403);
    expect(deniedLiteral.result.error.code).toBe("query_access_denied");

    await seedDeaths(selectedTarget, { remembered: "Sekiro", count: 3 });
    const deniedDynamicValue = await snapshot(query(selectedTarget, {
      remembered: read("remembered_game"),
      count: read("count", { game: { ref: "remembered" } })
    }, { count: { ref: "count" } }));
    expect(deniedDynamicValue.response.status).toBe(403);
    expect(deniedDynamicValue.result.error.code).toBe("query_access_denied");

    const deniedCollection = await snapshot(query(selectedTarget, {
      counts: read("counts")
    }, { counts: { ref: "counts" } }));
    expect(deniedCollection.response.status).toBe(403);
    expect(deniedCollection.result.error.code).toBe("query_access_denied");

    const nonexistent = await snapshot(query(selectedTarget, {
      hidden: {
        read: { feature: "private.unknown", export: "secret", version: 1 }
      }
    }, { hidden: { ref: "hidden" } }));
    expect(nonexistent.response.status).toBe(403);
    expect(nonexistent.result).toEqual(deniedCollection.result);

    const wrongTarget = await snapshot(query(target(), {
      remembered: read("remembered_game")
    }, { remembered: { ref: "remembered" } }));
    expect(wrongTarget.response.status).toBe(403);
    expect(wrongTarget.result.error.code).toBe("query_access_denied");
  });

  it("exchanges a bearer credential for a same-origin secure session", async () => {
    const issued = await issue(target(), "fun.deaths:remembered_game:v1");
    const crossOrigin = await request("/state-query/session", {
      method: "POST",
      headers: bearer(issued.credential, { origin: "https://attacker.example" })
    });
    expect(crossOrigin.status).toBe(403);

    const session = await request("/state-query/session", {
      method: "POST",
      headers: bearer(issued.credential, { origin: "https://example.com" })
    });
    const cookie = session.headers.get("set-cookie");
    expect(session.status).toBe(204);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Domain=");

    const catalog = await request("/state-query/catalog", {
      headers: { cookie: cookie.split(";")[0] }
    });
    expect(catalog.status).toBe(200);
  });

  it("enforces grant-specific resource ceilings below the system limits", async () => {
    const selectedTarget = target();
    const issued = await issue(
      selectedTarget,
      "fun.deaths:remembered_game:v1,fun.deaths:count:v1",
      { limits: { maxBindings: 1 } }
    );
    const response = await request("/state-query/snapshot", {
      method: "POST",
      headers: bearer(issued.credential, { "content-type": "application/json" }),
      body: JSON.stringify(query(selectedTarget, {
        remembered: read("remembered_game"),
        count: read("count", { game: { literal: "Hades" } })
      }, { count: { ref: "count" } }))
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("query_access_denied");
  });

  it("distinguishes expiry and revocation while rejecting another environment", async () => {
    const selectedTarget = target();
    const expired = await issue(selectedTarget, "fun.deaths:remembered_game:v1", {
      expiresInSeconds: 300,
      clientOptions: { nowMs: Date.now() - 301_000 }
    });
    await expect(validateStateQueryCredential(queryEnv, expired.credential))
      .rejects.toMatchObject({ code: "query_grant_expired" });

    const issued = await issue(selectedTarget, "fun.deaths:remembered_game:v1");
    const revoked = await request("/state-query/grant", {
      method: "DELETE",
      headers: bearer(issued.credential)
    });
    expect(revoked.status).toBe(204);
    const after = await request("/state-query/catalog", {
      headers: bearer(issued.credential)
    });
    expect(after.status).toBe(401);
    expect((await after.json()).error.code).toBe("query_grant_revoked");

    const production = {
      ...queryEnv,
      STATE_QUERY_DEPLOYMENT_ENVIRONMENT: "production",
      TWITCH_DEPLOYMENT_ENVIRONMENT: "production"
    };
    await expect(validateStateQueryCredential(production, issued.credential))
      .rejects.toMatchObject({ code: "query_access_denied" });

    const forgedParts = issued.credential.split(".");
    forgedParts[3] = `${forgedParts[3][0] === "A" ? "B" : "A"}${forgedParts[3].slice(1)}`;
    const forgedConfig = {
      idFromName: vi.fn(),
      get: vi.fn()
    };
    await expect(validateStateQueryCredential({
      ...queryEnv,
      CONFIG: forgedConfig
    }, forgedParts.join("."))).rejects.toMatchObject({ code: "query_access_denied" });
    expect(forgedConfig.idFromName).not.toHaveBeenCalled();
    expect(forgedConfig.get).not.toHaveBeenCalled();
  });

  it("issues Discord grants only through the manager capability command", async () => {
    expect(discordCommands.state_query_grant.guild).toEqual({
      capability: CAPABILITIES.STATE_QUERY_MANAGE
    });
    const guildId = target().groupId;
    const result = await discordCommands.state_query_grant.exec({
      guild_id: guildId,
      member: { user: { id: "discord-manager" } },
      data: {
        options: [
          {
            name: "exports",
            value: "fun.deaths:remembered_game:v1,fun.deaths:count:v1"
          },
          { name: "duration_hours", value: 1 }
        ]
      }
    }, queryEnv);
    expect(result.flags).toBe(64);
    const credential = result.content.match(/`(elmybot-sqg-v1\.[^`]+)`/)?.[1];
    expect(credential).toBeTruthy();
    const grant = await validateStateQueryCredential(queryEnv, credential);
    expect(grant.target).toEqual({ platform: "discord", groupId: guildId });
  });

  it("reauthenticates a Twitch broadcaster before issuing and immediately revokes OAuth", async () => {
    const oauthStub = env.TWITCH_CHANNEL_OAUTH.get(
      env.TWITCH_CHANNEL_OAUTH.idFromName(TWITCH_CHANNEL_OAUTH_COORDINATOR_NAME)
    );
    await runInDurableObject(oauthStub, async (instance) => {
      instance.env = queryEnv;
    });
    const page = await request("/state-query/operator/twitch");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("Continue with Twitch");

    const start = await request("/state-query/operator/twitch", {
      method: "POST",
      headers: {
        origin: "https://example.com",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        exports: "fun.deaths:remembered_game:v1,fun.deaths:count:v1",
        duration_hours: "1"
      })
    });
    const authorizationUrl = new URL(start.headers.get("location"));
    expect(start.status).toBe(303);
    expect(authorizationUrl.origin).toBe("https://id.twitch.tv");
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid");
    expect(authorizationUrl.searchParams.get("redirect_uri"))
      .toBe("https://example.com/state-query/operator/twitch/callback");

    const externalFetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://id.twitch.tv/oauth2/token") {
        return Response.json({
          access_token: "temporary-state-query-token",
          refresh_token: "temporary-state-query-refresh",
          expires_in: 14_000,
          scope: ["openid"],
          token_type: "bearer"
        });
      }
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Response.json({
          client_id: "client-id",
          user_id: "twitch-broadcaster",
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
      "/state-query/operator/twitch/callback?code=oauth-code&state=" +
      authorizationUrl.searchParams.get("state")
    );
    const callbackHtml = await callback.text();
    const credential = callbackHtml.match(/<code>(elmybot-sqg-v1\.[^<]+)<\/code>/)?.[1];
    expect(callback.status).toBe(200);
    expect(credential).toBeTruthy();
    expect(callback.headers.get("set-cookie")).toContain(credential);
    expect(externalFetch).toHaveBeenCalledTimes(3);
    const grant = await validateStateQueryCredential(queryEnv, credential);
    expect(grant.target).toEqual({
      platform: "twitch",
      groupId: "twitch-broadcaster"
    });
  });
});
