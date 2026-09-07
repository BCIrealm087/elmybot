import { describe, expect, it } from "vitest";
import { handleTwitchManagementRoute } from
  "../src/platforms/twitch/routes.js";

function pendingIntegration() {
  return {
    invitationId: "invitation-id",
    integrationId: "pending-integration-id",
    status: "awaiting_state_resolution",
    twitchGroup: { platform: "twitch", kind: "channel", id: "channel-id" },
    twitchLabel: "linked_channel",
    stateResolution: null,
    stateDiscovery: {
      version: 3,
      requiresResolution: true,
      namespaces: [
        {
          featureId: "feature.first",
          featureLabel: "Deaths <unsafe>",
          namespaceId: "counts",
          namespaceLabel: "Death counts",
          outcome: "collision",
          automaticSelection: null,
          discordSummary: {
            kind: "entry_count",
            used: true,
            entryCount: 2,
            unsafeValue: "discord-secret-value"
          },
          twitchSummary: {
            kind: "entry_count",
            used: true,
            entryCount: 1,
            unsafeValue: "twitch-secret-value"
          }
        },
        {
          featureId: "feature.second",
          featureLabel: "Second feature",
          namespaceId: "settings",
          namespaceLabel: "Shared settings",
          outcome: "collision",
          automaticSelection: null,
          discordSummary: { kind: "presence", used: true },
          twitchSummary: { kind: "presence", used: true }
        },
        {
          featureId: "feature.automatic",
          featureLabel: "Automatic feature",
          namespaceId: "state",
          namespaceLabel: "Automatic state",
          outcome: "discord_only",
          automaticSelection: "discord",
          discordSummary: { kind: "presence", used: true },
          twitchSummary: { kind: "presence", used: false }
        }
      ]
    }
  };
}

function routeEnvironment(pending, recordedRequests) {
  const registry = {
    async fetch(input, init) {
      const pathname = new URL(input).pathname;
      const body = init?.body ? JSON.parse(init.body) : null;
      if (pathname === "/invitations/resume") {
        recordedRequests.resumes.push(body);
        return Response.json({ pendingIntegration: pending, integration: null });
      }
      if (pathname === "/invitations/resolve-state") {
        recordedRequests.resolutions.push(body);
        pending.stateResolution = {
          discoveryVersion: body.discoveryVersion,
          resolvedAtMs: Date.now(),
          selections: body.selections.map((selection) => ({
            ...selection,
            source: "user"
          }))
        };
        return Response.json({
          pendingIntegration: pending,
          stateResolution: pending.stateResolution,
          replayed: false
        });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
  };
  return {
    TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
    TWITCH_PUBLIC_ORIGIN: "https://example.com",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_BOT_USER_ID: "bot-user-id",
    INTEGRATION_REGISTRY: {
      idFromName: (name) => name,
      get: () => registry
    }
  };
}

function integrationRequest(pathname, options = {}) {
  return new Request(`https://example.com${pathname}`, {
    ...options,
    headers: {
      cookie: "elmybot_integration_resume=resume-token",
      ...options.headers
    }
  });
}

describe("Twitch integration state-resolution page", () => {
  it("shows only collision summaries with per-namespace and apply-all choices", async () => {
    const recorded = { resumes: [], resolutions: [] };
    const response = await handleTwitchManagementRoute(
      integrationRequest("/twitch/integrations/pending"),
      routeEnvironment(pendingIntegration(), recorded),
      {}
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy"))
      .toContain("form-action 'self'");
    expect(html).toContain("Choose what the new link should use");
    expect(html).toContain("Deaths &lt;unsafe&gt;");
    expect(html).not.toContain("Deaths <unsafe>");
    expect(html).toContain("2 stored entries");
    expect(html).toContain("1 stored entry");
    expect(html).toContain("Stored state is present");
    expect(html).not.toContain("discord-secret-value");
    expect(html).not.toContain("twitch-secret-value");
    expect(html).not.toContain("Automatic feature");
    expect(html.match(/data-apply-choice=/g)).toHaveLength(3);
    expect(html.match(/<input type="radio"/g)).toHaveLength(6);
    expect(html).toContain('action="/twitch/integrations/resolve-state"');
    expect(html).toContain('name="discovery_version" value="3"');
    expect(recorded.resumes).toEqual([{ reservationId: "resume-token" }]);
    expect(recorded.resolutions).toHaveLength(0);
  });

  it("requires same-origin complete choices and maps form indexes server-side", async () => {
    const pending = pendingIntegration();
    const recorded = { resumes: [], resolutions: [] };
    const environment = routeEnvironment(pending, recorded);
    const crossOrigin = await handleTwitchManagementRoute(
      integrationRequest("/twitch/integrations/resolve-state", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: new URLSearchParams({
          discovery_version: "3",
          choice_0: "discord",
          choice_1: "reset"
        })
      }),
      environment,
      {}
    );
    expect(crossOrigin.status).toBe(403);
    expect(recorded.resumes).toHaveLength(0);

    const incomplete = await handleTwitchManagementRoute(
      integrationRequest("/twitch/integrations/resolve-state", {
        method: "POST",
        headers: { origin: "https://example.com" },
        body: new URLSearchParams({
          discovery_version: "3",
          choice_0: "discord"
        })
      }),
      environment,
      {}
    );
    expect(incomplete.status).toBe(422);
    expect(await incomplete.text()).toContain(
      "Choose Discord, Twitch, or reset for every conflicting feature."
    );
    expect(recorded.resolutions).toHaveLength(0);

    const accepted = await handleTwitchManagementRoute(
      integrationRequest("/twitch/integrations/resolve-state", {
        method: "POST",
        headers: { origin: "https://example.com" },
        body: new URLSearchParams({
          discovery_version: "3",
          choice_0: "discord",
          choice_1: "reset",
          feature_id: "attacker-controlled"
        })
      }),
      environment,
      {}
    );
    const acceptedHtml = await accepted.text();
    expect(accepted.status).toBe(200);
    expect(acceptedHtml).toContain("State review is complete");
    expect(acceptedHtml).toContain("Your state choices are recorded");
    expect(recorded.resolutions).toEqual([{
      reservationId: "resume-token",
      discoveryVersion: 3,
      selections: [
        {
          featureId: "feature.first",
          namespaceId: "counts",
          selection: "discord"
        },
        {
          featureId: "feature.second",
          namespaceId: "settings",
          selection: "reset"
        }
      ]
    }]);
  });
});
