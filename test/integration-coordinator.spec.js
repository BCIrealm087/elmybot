import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  completeIntegrationInvitation,
  createEffect,
  createEffectHandlerRegistry,
  createIntegrationExecution,
  createIntegrationInvitation,
  getIntegrationExecution,
  integrationCoordinatorStub,
  reserveIntegrationInvitation,
  retryIntegrationEffect,
  revokeIntegration,
  submitIntegrationExecution
} from "../src/integrations/index.js";
import { DISCORD_EFFECT_KINDS } from "../src/platforms/discord/integration-effects.js";

const integrationEnv = {
  ...env,
  TWITCH_DEPLOYMENT_ENVIRONMENT: "test",
  TWITCH_PUBLIC_ORIGIN: "https://example.com",
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_BOT_USER_ID: "bot-user-id",
  TWITCH_EVENTSUB_SECRET: "eventsub-secret",
  DISCORD_TOKEN: "discord-token"
};

let idCounter = 0;
const uniqueId = (prefix) => `${prefix}-${++idCounter}`;
const discordGroup = (id = uniqueId("guild")) => ({
  platform: "discord", kind: "guild", id
});
const discordActor = (id = uniqueId("discord-user")) => ({
  platform: "discord", id, claims: []
});
const twitchGroup = (id = uniqueId("broadcaster")) => ({
  platform: "twitch", kind: "channel", id
});
const invitationToken = (invitation) => new URL(invitation.invitationUrl)
  .hash.slice("#invite=".length);

async function activateIntegration() {
  const group = discordGroup();
  const actor = discordActor();
  const channel = twitchGroup();
  const invitation = await createIntegrationInvitation(integrationEnv, {
    group,
    actor,
    connectUrl: "https://example.com/twitch/integrations/connect"
  });
  const reservationId = crypto.randomUUID();
  const reservation = await reserveIntegrationInvitation(integrationEnv, {
    token: invitationToken(invitation),
    reservationId,
    reservationExpiresAtMs: Date.now() + 10 * 60 * 1000
  });
  const completion = await completeIntegrationInvitation(integrationEnv, {
    invitationId: reservation.invitationId,
    reservationId,
    group: channel,
    actor: {
      platform: "twitch",
      id: channel.id,
      claims: ["twitch.broadcaster"]
    }
  });
  return { group, actor, channel, integration: completion.integration };
}

function discordMessageExecution({
  integration,
  source,
  target,
  sourceEventId = `twitch:eventsub:${uniqueId("message")}`,
  idempotencyKey = uniqueId("effect"),
  content = "Cross-platform hello",
  channelId = uniqueId("discord-channel")
}) {
  return createIntegrationExecution({
    integration,
    source: { group: source },
    sourceEventId,
    effects: [createEffect({
      kind: DISCORD_EFFECT_KINDS.SEND_MESSAGE,
      target: { group: target, destination: { channelId } },
      payload: { content },
      integration,
      idempotencyKey,
      correlationId: sourceEventId,
      causationId: sourceEventId
    })]
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Per-integration execution coordinator", () => {
  it("builds an immutable effect registry and rejects duplicates", () => {
    const handler = {
      platform: "test",
      validateEffect: () => null,
      deliver: async () => null
    };
    const kind = "test.message.send.v1";
    const registry = createEffectHandlerRegistry({ [kind]: handler });
    expect(registry[kind]).toMatchObject(handler);
    expect(() => { registry[kind].deliver = async () => "replacement"; })
      .toThrow(TypeError);
    expect(() => { registry["test.other.v1"] = handler; }).toThrow(TypeError);
    expect(() => createEffectHandlerRegistry(
      { [kind]: handler },
      { [kind]: handler }
    )).toThrow(`Duplicate integration effect kind: \`${kind}\`.`);
  });

  it("atomically persists effects and only replays identical execution input", async () => {
    const linked = await activateIntegration();
    vi.spyOn(Date, "now").mockReturnValue(2_100_000_000_000);
    const input = discordMessageExecution({
      integration: linked.integration,
      source: linked.channel,
      target: linked.group
    });
    const stub = integrationCoordinatorStub(integrationEnv, linked.integration.id);
    const accepted = await submitIntegrationExecution(integrationEnv, input);
    expect(accepted).toMatchObject({
      sourceEventId: input.sourceEventId,
      state: "pending",
      replayed: false,
      effects: [{
        idempotencyKey: input.effects[0].idempotencyKey,
        state: "pending",
        attempts: 0
      }]
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM integration_executions"
      ).one().total).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS total FROM integration_effects"
      ).one().total).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect((await submitIntegrationExecution(integrationEnv, input)).replayed).toBe(true);

    const conflicting = discordMessageExecution({
      integration: linked.integration,
      source: linked.channel,
      target: linked.group,
      sourceEventId: input.sourceEventId,
      idempotencyKey: input.effects[0].idempotencyKey,
      content: "Changed output"
    });
    await expect(submitIntegrationExecution(integrationEnv, conflicting))
      .rejects.toMatchObject({
        status: 409,
        code: "integration_execution_conflict"
      });
  });

  it("rejects sources and targets outside the active integration", async () => {
    const linked = await activateIntegration();
    await expect(submitIntegrationExecution(integrationEnv, discordMessageExecution({
      integration: linked.integration,
      source: linked.channel,
      target: discordGroup()
    }))).rejects.toMatchObject({
      status: 403,
      code: "integration_target_not_member"
    });
    await expect(submitIntegrationExecution(integrationEnv, discordMessageExecution({
      integration: linked.integration,
      source: twitchGroup(),
      target: linked.group
    }))).rejects.toMatchObject({
      status: 403,
      code: "integration_source_not_member"
    });
  });

  it("delivers a persisted Discord effect with safe mention handling", async () => {
    const linked = await activateIntegration();
    vi.spyOn(Date, "now").mockReturnValue(2_100_000_000_000);
    const input = discordMessageExecution({
      integration: linked.integration,
      source: linked.channel,
      target: linked.group,
      content: "Hello @everyone"
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await submitIntegrationExecution(integrationEnv, input);
    await runInDurableObject(
      integrationCoordinatorStub(integrationEnv, linked.integration.id),
      async (instance) => instance.alarm()
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      `/channels/${input.effects[0].target.destination.channelId}/messages`
    );
    expect(JSON.parse(init.body)).toEqual({
      content: "Hello @everyone",
      allowed_mentions: { parse: [] }
    });
    expect(await getIntegrationExecution(
      integrationEnv,
      linked.integration.id,
      input.sourceEventId
    )).toMatchObject({
      state: "completed",
      effects: [{ state: "delivered", attempts: 1, lastError: null }]
    });
  });

  it("backs off failures and supports a manual dead-letter retry", async () => {
    const linked = await activateIntegration();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let nowMs = 2_100_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const input = discordMessageExecution({
      integration: linked.integration,
      source: linked.channel,
      target: linked.group
    });
    const fetchMock = vi.fn(async () => Response.json(
      { message: "Temporary failure" }, { status: 503 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const stub = integrationCoordinatorStub(integrationEnv, linked.integration.id);
    await submitIntegrationExecution(integrationEnv, input);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await runInDurableObject(stub, async (instance) => instance.alarm());
      const status = await getIntegrationExecution(
        integrationEnv, linked.integration.id, input.sourceEventId
      );
      expect(status.effects[0].attempts).toBe(attempt);
      if (attempt < 5) {
        expect(status.effects[0].state).toBe("retry_wait");
        nowMs = status.effects[0].nextAttemptAtMs;
      } else {
        expect(status).toMatchObject({
          state: "completed_with_failures",
          effects: [{
            state: "dead_letter",
            lastError: { code: "discord_http_error" }
          }]
        });
      }
    }

    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    expect(await retryIntegrationEffect(
      integrationEnv,
      linked.integration.id,
      input.effects[0].idempotencyKey
    )).toMatchObject({
      state: "pending",
      effects: [{ state: "pending", attempts: 0 }]
    });
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect((await getIntegrationExecution(
      integrationEnv, linked.integration.id, input.sourceEventId
    )).state).toBe("completed");
  });

  it("dead-letters undelivered effects when the link is revoked", async () => {
    const linked = await activateIntegration();
    vi.spyOn(Date, "now").mockReturnValue(2_100_000_000_000);
    const input = discordMessageExecution({
      integration: linked.integration,
      source: linked.channel,
      target: linked.group
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stub = integrationCoordinatorStub(integrationEnv, linked.integration.id);
    await submitIntegrationExecution(integrationEnv, input);
    await revokeIntegration(integrationEnv, {
      integrationId: linked.integration.id,
      group: linked.group,
      actor: linked.actor,
      reason: "test_revocation"
    });
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getIntegrationExecution(
      integrationEnv, linked.integration.id, input.sourceEventId
    )).toMatchObject({
      state: "completed_with_failures",
      effects: [{
        state: "dead_letter",
        attempts: 0,
        lastError: { code: "integration_inactive" }
      }]
    });
    expect(await submitIntegrationExecution(integrationEnv, input)).toMatchObject({
      replayed: true,
      state: "completed_with_failures"
    });
  });
});
