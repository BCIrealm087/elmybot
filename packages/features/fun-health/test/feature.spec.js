import { describe, expect, it } from "vitest";
import feature from "../src/feature.js";
import { createFeatureTestRuntime, defaultTestLink, discordTestActor, discordTestGroup, discordTestModerator, twitchTestGroup, twitchTestModerator } from "@elmybot/framework/testing";
const STREAM = "fun.health:impacts:v2";
const runtime = (options = {}) => createFeatureTestRuntime(feature, { stateEventsEnabled: true, ...options });
const query = (group) => ({ version: 1, target: { platform: group.platform, groupId: group.id }, bindings: { current: { read: { feature: "fun.health", export: "current", version: 1 } } }, select: { health: { ref: "current" } } });
const read = async (r, group) => (await r.query.snapshot(query(group))).envelope.data.health;

describe("authoritative fun.health v2", () => {
  it("saves Discord health while the widget is offline and delivers the committed result later", async () => {
    const r = runtime(), group = discordTestGroup();
    expect((await read(r, group)).value).toBe(100);
    (await r.discord.command("health", { group, actor: discordTestModerator(), args: { operation: "damage", amount: 15 } })).toReply("Health saved and impact queued.");
    expect((await read(r, group)).value).toBe(85);
    const consumer = r.eventStreams.connect({ group, stream: STREAM }), event = await consumer.receive();
    expect(event.payload).toEqual({ operation: "damage", requestedAmount: 15, appliedAmount: 15, before: 100, after: 85, changed: true });
    expect(event.stateEvent.operationSequence).toBe(1); consumer.acknowledge(event); consumer.disconnect();
  });
  it("shares health between symmetric Discord/Twitch defaults and keeps standalone groups isolated", async () => {
    const group = discordTestGroup(), twitch = twitchTestGroup(), isolated = discordTestGroup({ id: "isolated" });
    const r = runtime({ defaultLinks: [defaultTestLink({ sourceGroup: group, targetGroup: twitch }), defaultTestLink({ sourceGroup: twitch, targetGroup: group })] });
    await r.discord.command("health", { group, actor: discordTestModerator(), args: { operation: "damage", amount: 20 } });
    (await r.twitch.commandText("!health heal", { group: twitch, actor: twitchTestModerator() })).toReply("Health saved and impact queued.");
    expect((await read(r, group)).value).toBe(90); expect((await read(r, twitch)).value).toBe(90); expect((await read(r, isolated)).value).toBe(100);
  });
  it("accepts clamped/no-op impacts, preserves cooldown, and returns the same source result once", async () => {
    const r = runtime(), group = discordTestGroup(), input = { group, actor: discordTestModerator(), args: { operation: "heal" }, sourceEventId: "discord:interaction:health-1" };
    const before = await read(r, group); await r.discord.command("health", input);
    await r.discord.command("health", input); const next = await read(r, group);
    expect(next.value).toBe(100); expect(next.stateEvent.operationSequence).toBe(1); expect(next.stateEvent.stateRevision).toBeGreaterThan(before.stateEvent.stateRevision);
    await expect(r.discord.command("health", { ...input, sourceEventId: "discord:interaction:health-2" })).rejects.toMatchObject({ code: "action_cooldown_active" });
    const consumer = r.eventStreams.connect({ group, stream: STREAM }), event = await consumer.receive();
    expect(event.payload).toMatchObject({ appliedAmount: 0, changed: false }); consumer.acknowledge(event); consumer.disconnect();
    r.clock.advance({ seconds: 1 }); await r.discord.command("health", { ...input, sourceEventId: "discord:interaction:health-3", args: { operation: "damage", amount: 100 } });
    expect((await read(r, group)).value).toBe(0);
  });
  it("rejects invalid and unauthorized Discord/Twitch commands before mutation", async () => {
    const r = runtime(), group = discordTestGroup();
    await expect(r.discord.command("health", { group, actor: discordTestActor(), args: { operation: "damage" } })).rejects.toMatchObject({ code: "action_forbidden" });
    await expect(r.twitch.commandText("!health damage 0", { actor: twitchTestModerator() })).rejects.toMatchObject({ code: "action_arguments_invalid" });
    await expect(r.twitch.commandText("!health damage 101", { actor: twitchTestModerator() })).rejects.toMatchObject({ code: "action_arguments_invalid" });
    expect((await read(r, group)).value).toBe(100);
  });
  it("keeps the v1 payload readable as a distinct legacy stream and prevents direct v2 publish", async () => {
    const r = runtime(), group = discordTestGroup();
    const legacy = r.eventStreams.connect({ group, stream: "fun.health:impacts:v1" });
    await r.eventStreams.publish({ group, stream: "fun.health:impacts:v1", payload: { operation: "damage", amount: 15 } });
    expect((await legacy.receive()).payload).toEqual({ operation: "damage", amount: 15 }); legacy.disconnect();
    await expect(r.eventStreams.publish({ group, stream: STREAM, payload: {} })).rejects.toMatchObject({ code: "state_event_operation_required" });
    expect((await read(r, group)).value).toBe(100);
  });
});
