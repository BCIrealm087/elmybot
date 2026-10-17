import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createCommandInvocation } from "../src/integrations/contracts.js";
import { createDiscordActionInvocation } from "../src/platforms/discord/actions.js";
import { createTwitchActionInvocation } from "../src/platforms/twitch/actions.js";
import { durableEventId } from "../src/durable-events/contract.js";
import { defineFeature, frameworkApiVersion } from "../src/framework/index.js";
import { createFeatureRegistry } from "../src/framework/internal.js";
import { ShareableStateRealmBackend } from "../src/shareable-state/realm.js";
import {
  STATE_EVENT_LIMITS as LIMITS, canonicalJson, createStateEventIdentity, fingerprint,
  newAttempt
} from "../src/state-events/identity.js";
import {
  commitStateEventAtOwner, confirmStateEventOwner, fenceStateEventOwner, lookupStateEventOrigin,
  lookupStateEventOwner, prepareStateEventOrigin, retireStateEventOwner
} from "../src/state-events/storage.js";
import { createStateEventRecovery } from "../src/state-events/recovery.js";
import { createStateEventOwnerClient } from "../src/state-events/owner-client.js";

let sequence = 0;
const unique = (label) => `${label}-${Date.now()}-${++sequence}`;
const routeId = `des1.${"r".repeat(43)}`;
function stub(key, shared = false) {
  const ns = shared ? env.SHAREABLE_STATE_REALM : env.CONFIG;
  return ns.get(ns.idFromName(key));
}
async function fixture({ shared = false } = {}) {
  const group = unique("origin");
  const groupKey = `discord:guild:${group}`;
  const sourceCreatedAtMs = Date.now();
  const invocation = createCommandInvocation({ kind: "test.score.change.v1", args: { amount: 2 },
    sourceEventId: `discord:interaction:${unique("source")}`, sourceCreatedAtMs,
    origin: { group: { platform: "discord", kind: "guild", id: group },
      actor: { platform: "discord", id: "actor", claims: [] } } });
  const declaration = { version: 1, namespaceVersion: 1, mutation: "increment", payloadVersion: 1 };
  const identity = await createStateEventIdentity({ environment: "test", featureId: "test.score", invocation, declaration });
  function route(owner = group) {
    const realm = { kind: "standalone", generation: 1,
      ownerGroup: { platform: "discord", kind: "guild", id: owner } };
    return { kind: shared ? "effective_shareable" : "group_local",
      key: shared ? `shareable-state:standalone:g1:discord:guild:${owner}` : groupKey,
      bindingRevision: 1, streamRouteId: routeId,
      ...(shared ? { realm, namespace: { featureId: "test.score", namespaceId: "score" } } : {}) };
  }
  const request = { operation: "change", input: { amount: 2 }, config: { multiplier: 3 },
    mutation: { kind: "increment", key: "score", amount: 6 } };
  const eventId = await durableEventId({ featureId: "test.score", streamId: "changes", version: 1,
    originGroupKey: groupKey, sourceEventId: invocation.sourceEventId });
  const origin = stub(groupKey);
  const owner = (attempt) => stub(attempt.route.key, shared);
  const client = {
    confirm: (attempt) => runInDurableObject(owner(attempt), (_i, state) => confirmStateEventOwner(state, attempt, attempt.route.key)),
    lookup: (attempt) => runInDurableObject(owner(attempt), (_i, state) => lookupStateEventOwner(state, attempt, attempt.route.key)),
    fence: (attempt) => runInDurableObject(owner(attempt), (_i, state) => fenceStateEventOwner(state, attempt, attempt.route.key))
  };
  const withRecovery = (run, transport = client) => runInDurableObject(origin, (_i, state) => run(createStateEventRecovery(state, transport), state));
  const prepare = (options = {}) => withRecovery((recovery) => recovery.prepare(identity,
    () => ({ request, route: route(), cooldownSeconds: 1, ...options })));
  const commit = (record, overrides = {}) => runInDurableObject(owner(record.attempt), async (_i, state) => {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS recovery_witness (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
    state.storage.sql.exec("INSERT OR IGNORE INTO recovery_witness VALUES (1, 0)");
    return commitStateEventAtOwner(state, { attempt: record.attempt, request: record.request,
      physicalOwnerKey: record.attempt.route.key, ...overrides }, () => {
      const before = state.storage.sql.exec("SELECT value FROM recovery_witness WHERE id = 1").one().value;
      const after = before + 6;
      state.storage.sql.exec("UPDATE recovery_witness SET value = ? WHERE id = 1", after);
      return { eventId, result: { before, after } };
    });
  });
  const value = (record) => runInDurableObject(owner(record.attempt), (_i, state) =>
    state.storage.sql.exec("SELECT value FROM recovery_witness WHERE id = 1").one().value);
  return { identity, invocation, declaration, request, origin, route, owner, client, withRecovery, prepare, commit, value, sourceCreatedAtMs };
}

describe("state-event identity and pinned recovery", () => {
  it("uses the reserved operation tuple, independent of owner/configuration", async () => {
    const f = await fixture();
    const tuple = ["elmybot.state-event-operation.v1", "test", "test.score", f.invocation.kind,
      f.invocation.origin.group.key, f.invocation.sourceEventId];
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(tuple))));
    const expected = "seo1." + btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(f.identity.operationId).toBe(expected);
    expect(await fingerprint({ b: 2, a: 1 })).toBe(await fingerprint({ a: 1, b: 2 }));
    for (const value of [undefined, { get x() { throw new Error("getter must not run"); } }, new Array(2), new Date(), { n: NaN }]) {
      expect(() => canonicalJson(value)).toThrow();
    }
  });

  it("uses immutable platform source times and rejects missing/invalid time", async () => {
    const time = Date.now() - 30_000;
    const snowflake = String((BigInt(time) - 1420070400000n) << 22n);
    const discord = createDiscordActionInvocation({ id: snowflake, guild_id: "guild", user: { id: "actor" } }, "test.score.change.v1");
    expect(discord.sourceCreatedAtMs).toBe(time);
    const twitch = createTwitchActionInvocation({ broadcaster_user_id: "channel", chatter_user_id: "actor" },
      "message", "test.score.change.v1", {}, new Date(time).toISOString());
    expect(twitch.sourceCreatedAtMs).toBe(time);
    const f = await fixture();
    await expect(createStateEventIdentity({ environment: "test", featureId: "test.score",
      invocation: { ...f.invocation, sourceCreatedAtMs: undefined }, declaration: {} })).rejects.toMatchObject({ code: "state_event_invalid_source" });
    expect(() => createCommandInvocation({ ...f.invocation, sourceCreatedAtMs: NaN })).toThrow();
  });

  it("persists preparation before owner contact and recovers before claiming cooldown or reading config again", async () => {
    const f = await fixture();
    const prepared = await f.prepare();
    await evictDurableObject(f.origin);
    const retry = await f.withRecovery((recovery) => recovery.prepare(f.identity, () => { throw new Error("must not reprepare"); }));
    expect(retry).toEqual(prepared);
    await f.withRecovery(async (_r, state) => {
      const newIdentity = await createStateEventIdentity({ environment: "test", featureId: "test.score",
        invocation: { ...f.invocation, sourceEventId: "discord:interaction:other" }, declaration: f.declaration });
      await expect(prepareStateEventOrigin(state, { identity: newIdentity, route: f.route(), request: f.request, cooldownSeconds: 1 }, f.sourceCreatedAtMs))
        .rejects.toMatchObject({ code: "state_event_cooldown" });
    });
  });

  it("rejects changed arguments, declaration, timestamp or action for the same feature/source", async () => {
    const f = await fixture(); await f.prepare();
    for (const change of [{ args: { amount: 3 } }, { kind: "test.score.other.v1" }, { sourceCreatedAtMs: f.sourceCreatedAtMs + 1 }]) {
      const identity = await createStateEventIdentity({ environment: "test", featureId: "test.score",
        invocation: { ...f.invocation, ...change }, declaration: f.declaration });
      await expect(f.withRecovery((r) => r.prepare(identity, () => { throw new Error("must not prepare"); })))
        .rejects.toMatchObject({ code: "state_event_source_conflict" });
    }
    const identity = await createStateEventIdentity({ environment: "test", featureId: "test.score",
      invocation: f.invocation, declaration: { ...f.declaration, version: 2 } });
    await expect(f.withRecovery((r) => r.recover(identity))).rejects.toMatchObject({ code: "state_event_source_conflict" });
  });

  it("returns the original receipt/result on concurrent commits and retries after state changes", async () => {
    const f = await fixture(); const prepared = await f.prepare();
    const outcomes = await Promise.all([f.commit(prepared), f.commit(prepared), f.commit(prepared)]);
    expect(outcomes[1]).toEqual(outcomes[0]); expect(outcomes[2]).toEqual(outcomes[0]);
    expect(await f.value(prepared)).toBe(6);
    await runInDurableObject(f.owner(prepared.attempt), (_i, state) => state.storage.sql.exec("UPDATE recovery_witness SET value = 99"));
    expect(await f.commit(prepared)).toEqual(outcomes[0]);
    expect(await f.value(prepared)).toBe(99);
    await expect(f.commit(prepared, { request: { ...prepared.request, input: { amount: 99 } } }))
      .rejects.toMatchObject({ code: "state_event_source_conflict" });
  });

  it("resolves a lost commit reply at the old owner even after defaults move", async () => {
    const f = await fixture({ shared: true }); const prepared = await f.prepare();
    const accepted = await f.commit(prepared); // reply lost before origin finalization
    await evictDurableObject(f.origin); await evictDurableObject(f.owner(prepared.attempt));
    let resolutions = 0;
    expect(await f.withRecovery((r) => r.repin(f.identity, () => { resolutions++; return f.route("new-owner"); }))).toEqual(accepted);
    expect(resolutions).toBe(0); expect(await f.value(prepared)).toBe(6);
    expect(await f.withRecovery((r) => r.recover(f.identity))).toEqual(accepted);
  });

  it("keeps uncertain requests pinned and never resolves defaults on owner timeouts", async () => {
    const f = await fixture({ shared: true }); const prepared = await f.prepare();
    const unavailable = { lookup() { throw new Error("lost response"); }, fence() { throw new Error("lost response"); } };
    let resolutions = 0;
    await expect(f.withRecovery((r) => r.recover(f.identity), unavailable)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    await expect(f.withRecovery((r) => r.repin(f.identity, () => { resolutions++; return f.route("new"); }), unavailable))
      .rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    expect(resolutions).toBe(0);
    expect(await f.withRecovery((r) => r.lookup(f.identity))).toEqual(prepared);
  });

  it("fences a lost precommit request before repinning, then rejects the delayed old mutation", async () => {
    const f = await fixture({ shared: true }); const old = await f.prepare();
    const next = await f.withRecovery((r) => r.repin(f.identity, () => f.route(unique("new"))));
    expect(next.attempt.epoch).toBe(2); expect(next.request).toEqual(old.request);
    await expect(f.commit(old)).rejects.toMatchObject({ code: "state_event_attempt_fenced" });
    const accepted = await f.commit(next);
    expect(await f.value(old)).toBe(0); expect(await f.value(next)).toBe(6);
    expect(await f.withRecovery((r) => r.recover(f.identity))).toEqual(accepted);
  });

  it("serializes commit versus fence and concurrent repins without accepting at two owners", async () => {
    const f = await fixture({ shared: true }); const old = await f.prepare();
    const outcomes = await Promise.allSettled([
      f.commit(old),
      f.withRecovery((r) => r.repin(f.identity, () => f.route(unique("new-a")))),
      f.withRecovery((r) => r.repin(f.identity, () => f.route(unique("new-b"))))
    ]);
    const current = await f.withRecovery((r) => r.lookup(f.identity));
    if (outcomes[0].status === "fulfilled") {
      expect(current.state).toBe("committed"); expect(await f.value(old)).toBe(6);
    } else {
      expect(outcomes[0].reason.code).toBe("state_event_attempt_fenced");
      expect(current.attempt.epoch).toBe(2);
      await f.commit(current); expect(await f.value(current)).toBe(6); expect(await f.value(old)).toBe(0);
    }
  });

  it("retains fences when revisiting a prior owner and bounds repeated repinning", async () => {
    const f = await fixture({ shared: true }); const old = await f.prepare();
    await f.withRecovery((r) => r.repin(f.identity, () => f.route(unique("second"))));
    let current = await f.withRecovery((r) => r.repin(f.identity, () => old.attempt.route));
    await expect(f.commit(old)).rejects.toMatchObject({ code: "state_event_attempt_fenced" });
    for (let i = current.attempt.epoch; i < LIMITS.maxAttempts; i++) {
      current = await f.withRecovery((r) => r.repin(f.identity, () => f.route(unique("owner"))));
    }
    await expect(f.withRecovery((r) => r.repin(f.identity, () => f.route(unique("owner")))))
      .rejects.toMatchObject({ code: "state_event_attempt_limit" });
    expect((await f.commit(current)).state).toBe("committed");
  });

  it("admits no fresh mutation after two hours while still recovering an existing receipt", async () => {
    const f = await fixture(); const prepared = await f.prepare(); const accepted = await f.commit(prepared);
    await runInDurableObject(f.origin, async (_i, state) => {
      expect(await commitStateEventAtOwner(state, { attempt: prepared.attempt, request: prepared.request,
        physicalOwnerKey: prepared.attempt.route.key }, () => { throw new Error("must not recompute"); },
      f.sourceCreatedAtMs + LIMITS.sourceLifetimeMs + 1)).toEqual(accepted);
      const fresh = await createStateEventIdentity({ environment: "test", featureId: "test.score",
        invocation: { ...f.invocation, sourceEventId: "discord:interaction:late" }, declaration: f.declaration });
      await expect(prepareStateEventOrigin(state, { identity: fresh, request: f.request, route: f.route(), cooldownSeconds: 1 },
        f.sourceCreatedAtMs + LIMITS.sourceLifetimeMs)).rejects.toMatchObject({ code: "state_event_source_expired" });
    });
    const g = await fixture(); const pending = await g.prepare();
    await runInDurableObject(g.origin, async (_i, state) => {
      await expect(commitStateEventAtOwner(state, { attempt: pending.attempt, request: pending.request,
        physicalOwnerKey: pending.attempt.route.key }, () => { throw new Error("must not mutate"); },
      g.sourceCreatedAtMs + LIMITS.sourceLifetimeMs)).rejects.toMatchObject({ code: "state_event_source_expired" });
    });
  });

  it("rolls back mutation on invalid results or receipt capacity failure", async () => {
    const f = await fixture(); const prepared = await f.prepare();
    await runInDurableObject(f.origin, async (_i, state) => {
      state.storage.sql.exec("CREATE TABLE recovery_witness (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
      state.storage.sql.exec("INSERT INTO recovery_witness VALUES (1, 0)");
      const input = { attempt: prepared.attempt, request: prepared.request, physicalOwnerKey: prepared.attempt.route.key };
      const apply = (result) => { state.storage.sql.exec("UPDATE recovery_witness SET value = 6"); return result; };
      await expect(commitStateEventAtOwner(state, input, () => apply({ eventId: "invalid", result: {} })))
        .rejects.toMatchObject({ code: "state_event_invalid_result" });
      expect(state.storage.sql.exec("SELECT value FROM recovery_witness").one().value).toBe(0);
      // Simulate a full shared metadata budget, independent of the state/outbox budget.
      state.storage.sql.exec("UPDATE state_event_budget SET metadata_bytes = ?", LIMITS.maxMetadataBytes);
      await expect(commitStateEventAtOwner(state, input, () => apply({ eventId: `dev1.${"e".repeat(43)}`, result: { after: 6 } })))
        .rejects.toMatchObject({ code: "state_event_capacity" });
      expect(state.storage.sql.exec("SELECT value FROM recovery_witness").one().value).toBe(0);
      expect(lookupStateEventOwner(state, prepared.attempt, prepared.attempt.route.key)).toEqual({ state: "absent" });
    });
  });

  it("shares origin/owner budgets, keeps pending receipts, and prunes only a bounded terminal batch", async () => {
    const f = await fixture(); const prepared = await f.prepare(); await f.commit(prepared);
    await runInDurableObject(f.origin, async (_i, state) => {
      expect(state.storage.sql.exec("SELECT rows, pending_rows FROM state_event_budget").one()).toMatchObject({ rows: 2, pending_rows: 1 });
      const now = f.sourceCreatedAtMs + LIMITS.receiptRetentionMs + 10_000;
      for (let i = 0; i < LIMITS.pruneBatch + 1; i++) {
        const identity = await createStateEventIdentity({ environment: "test", featureId: "test.score",
          invocation: { ...f.invocation, sourceEventId: `discord:interaction:fence-${i}` }, declaration: {} });
        fenceStateEventOwner(state, newAttempt(identity, prepared.attempt.preparedFingerprint, f.route()), f.route().key, f.sourceCreatedAtMs);
      }
      const late = newAttempt(await createStateEventIdentity({ environment: "test", featureId: "test.score",
        invocation: { ...f.invocation, sourceEventId: "discord:interaction:trigger" }, declaration: {} }), prepared.attempt.preparedFingerprint, f.route());
      fenceStateEventOwner(state, late, f.route().key, now);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM state_event_records WHERE prune_at_ms IS NOT NULL").one().n).toBe(2);
      expect(lookupStateEventOrigin(state, f.identity)?.state).toBe("prepared");
      expect(lookupStateEventOwner(state, prepared.attempt, f.route().key).state).toBe("committed");
      retireStateEventOwner(state, prepared.attempt, f.route().key, now);
      confirmStateEventOwner(state, prepared.attempt, f.route().key, now);
      fenceStateEventOwner(state, late, f.route().key, now + 1);
      await expect(commitStateEventAtOwner(state, { attempt: prepared.attempt, request: prepared.request,
        physicalOwnerKey: f.route().key }, () => { throw new Error("cannot replay after pruning"); }, now + 1))
        .rejects.toMatchObject({ code: "state_event_source_expired" });
    });
  });

  it("preserves the first configuration across concurrent preparation", async () => {
    const f = await fixture();
    const records = await Promise.all([f.prepare(), f.prepare({ request: { ...f.request, config: { multiplier: 9 } } })]);
    expect(records[0]).toEqual(records[1]);
    expect((await f.withRecovery((r) => r.lookup(f.identity))).request).toEqual(records[0].request);
  });

  it("enforces pending request bytes and rolls back the cooldown when admission is full", async () => {
    const f = await fixture();
    await runInDurableObject(f.origin, async (_i, state) => {
      const request = { data: "x".repeat(16_000) };
      const makeIdentity = (i) => createStateEventIdentity({ environment: "test", featureId: "test.score",
        invocation: { ...f.invocation, sourceEventId: `discord:interaction:capacity-${i}` }, declaration: {} });
      const admit = (identity, now) => prepareStateEventOrigin(state,
        { identity, request, route: f.route(), cooldownSeconds: 1 }, now);
      const count = Math.floor(LIMITS.maxPendingBytes / new TextEncoder().encode(canonicalJson(request)).byteLength);
      for (let i = 0; i < count; i++) await admit(await makeIdentity(i), f.sourceCreatedAtMs + i * 1000);
      const next = await makeIdentity(count);
      const when = f.sourceCreatedAtMs + count * 1000;
      await expect(admit(next, when)).rejects.toMatchObject({ code: "state_event_capacity" });
      expect(state.storage.sql.exec("SELECT expires_at_ms FROM framework_feature_cooldowns").one().expires_at_ms).toBe(when);
      await expect(prepareStateEventOrigin(state, { identity: next, request: { data: "x".repeat(LIMITS.maxRequestBytes) },
        route: f.route(), cooldownSeconds: 1 }, when)).rejects.toMatchObject({ code: "state_event_too_large" });
      const budget = state.storage.sql.exec("SELECT * FROM state_event_budget").one();
      expect(budget.rows).toBe(count); expect(budget.pending_rows).toBe(count);
      expect(budget.pending_bytes).toBeLessThanOrEqual(LIMITS.maxPendingBytes);
    });
  });

  it("bounds pending route count even for tiny requests", async () => {
    const f = await fixture();
    await runInDurableObject(f.origin, async (_i, state) => {
      for (let i = 0; i <= LIMITS.maxPendingRows; i++) {
        const identity = await createStateEventIdentity({ environment: "test", featureId: "test.score",
          invocation: { ...f.invocation, sourceEventId: `discord:interaction:row-${i}` }, declaration: {} });
        const admission = prepareStateEventOrigin(state, { identity, request: {}, route: f.route(), cooldownSeconds: 1 },
          f.sourceCreatedAtMs + i * 1000);
        if (i === LIMITS.maxPendingRows) await expect(admission).rejects.toMatchObject({ code: "state_event_capacity" });
        else await admission;
      }
      expect(state.storage.sql.exec("SELECT rows, pending_rows FROM state_event_budget").one())
        .toMatchObject({ rows: LIMITS.maxPendingRows, pending_rows: LIMITS.maxPendingRows });
    });
  });

  it("keeps an unknown expired operation until the owner proves noncommit, then releases its request", async () => {
    const f = await fixture({ shared: true }); const prepared = await f.prepare();
    const late = f.sourceCreatedAtMs + LIMITS.sourceLifetimeMs + 1000;
    const unavailable = { lookup() { throw new Error("offline"); }, fence() { throw new Error("offline"); } };
    await expect(f.withRecovery((r) => r.retire(f.identity, late), unavailable)).rejects.toMatchObject({ code: "state_event_outcome_unknown" });
    expect(await f.withRecovery((r) => r.lookup(f.identity))).toEqual(prepared);
    const retired = await f.withRecovery((r) => r.retire(f.identity, late));
    expect(retired.state).toBe("expired"); expect(retired.request).toBeNull();
    expect(await f.client.lookup(prepared.attempt)).toEqual({ state: "fenced" });
    await expect(f.commit(prepared)).rejects.toMatchObject({ code: "state_event_attempt_fenced" });
    await expect(f.withRecovery((r) => r.repin(f.identity, () => f.route("new")))).rejects.toMatchObject({ code: "state_event_source_expired" });
  });

  it("returns a proven commit even when origin receipt caching cannot grow", async () => {
    const f = await fixture({ shared: true }); const prepared = await f.prepare(); const accepted = await f.commit(prepared);
    await runInDurableObject(f.origin, (_i, state) => state.storage.sql.exec("UPDATE state_event_budget SET metadata_bytes = ?", LIMITS.maxMetadataBytes));
    expect(await f.withRecovery((r) => r.recover(f.identity))).toEqual(accepted);
    expect((await f.withRecovery((r) => r.lookup(f.identity))).state).toBe("prepared");
    expect(await f.value(prepared)).toBe(6);
  });

  it("makes a confirmed origin receipt pruneable only after its owner marks delivery terminal", async () => {
    const f = await fixture(); const prepared = await f.prepare(); const accepted = await f.commit(prepared);
    expect(await f.withRecovery((r) => r.recover(f.identity))).toEqual(accepted);
    await runInDurableObject(f.origin, (_i, state) => {
      expect(state.storage.sql.exec("SELECT prune_at_ms FROM state_event_records WHERE record_key LIKE 'origin:%'").one().prune_at_ms).toBeNull();
      retireStateEventOwner(state, prepared.attempt, prepared.attempt.route.key);
    });
    expect(await f.withRecovery((r) => r.retire(f.identity))).toEqual(accepted);
    await runInDurableObject(f.origin, (_i, state) => {
      const row = state.storage.sql.exec("SELECT prune_at_ms FROM state_event_records WHERE record_key LIKE 'origin:%'").one();
      expect(row.prune_at_ms).toBeGreaterThanOrEqual(f.sourceCreatedAtMs + LIMITS.receiptRetentionMs);
      expect(state.storage.sql.exec("SELECT pending_rows, pending_bytes FROM state_event_budget").one())
        .toMatchObject({ pending_rows: 0, pending_bytes: 0 });
    });
  });

  it("keeps terminal owner receipts until durable origin confirmation, and retries lost acknowledgements", async () => {
    const f = await fixture({ shared: true }); const prepared = await f.prepare(); const accepted = await f.commit(prepared);
    await runInDurableObject(f.owner(prepared.attempt), (_i, state) => {
      retireStateEventOwner(state, prepared.attempt, prepared.attempt.route.key);
      expect(state.storage.sql.exec("SELECT prune_at_ms FROM state_event_records").one().prune_at_ms).toBeNull();
    });
    const lost = { ...f.client, confirm() { throw new Error("ack lost before reaching owner"); } };
    expect(await f.withRecovery((r) => r.recover(f.identity), lost)).toEqual(accepted);
    await runInDurableObject(f.owner(prepared.attempt), (_i, state) => {
      expect(state.storage.sql.exec("SELECT prune_at_ms FROM state_event_records").one().prune_at_ms).toBeNull();
    });
    await evictDurableObject(f.origin);
    const lostReply = { ...f.client, async confirm(attempt) { await f.client.confirm(attempt); throw new Error("ack reply lost"); } };
    expect(await f.withRecovery((r) => r.recover(f.identity), lostReply)).toEqual(accepted);
    expect((await f.withRecovery((r) => r.lookup(f.identity))).ownerConfirmed).not.toBe(true);
    expect(await f.withRecovery((r) => r.recover(f.identity))).toEqual(accepted);
    expect((await f.withRecovery((r) => r.lookup(f.identity))).ownerConfirmed).toBe(true);
    expect(await f.value(prepared)).toBe(6);
    await runInDurableObject(f.owner(prepared.attempt), (_i, state) => {
      expect(state.storage.sql.exec("SELECT prune_at_ms FROM state_event_records").one().prune_at_ms)
        .toBeGreaterThanOrEqual(accepted.receipt.committedAtMs + LIMITS.receiptRetentionMs);
    });
  });

  it("uses lazy local owner endpoints and rejects requests delivered to the wrong object", async () => {
    const f = await fixture(); const prepared = await f.prepare();
    const client = createStateEventOwnerClient(env);
    expect(await client.lookup(prepared.attempt)).toEqual({ state: "absent" });
    expect(await client.fence(prepared.attempt)).toEqual({ state: "fenced" });
    await expect(client.confirm(prepared.attempt)).rejects.toMatchObject({ code: "state_event_missing_receipt" });
    const wrong = stub(`discord:guild:${unique("wrong")}`);
    const response = await wrong.fetch("https://config/internal/state-events/owner/fence", {
      method: "POST", body: JSON.stringify({ attempt: prepared.attempt })
    });
    const committedFixture = await fixture(); const committed = await committedFixture.prepare();
    const accepted = await committedFixture.commit(committed);
    expect(await committedFixture.withRecovery((r) => r.recover(committedFixture.identity), client)).toEqual(accepted);
    expect(response.status).toBe(422); expect((await response.json()).code).toBe("state_event_wrong_owner");
    await runInDurableObject(wrong, (_i, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'state_event_records'").toArray()).toEqual([]);
    });
  });

  it("allows shared receipt/fence recovery through a frozen namespace without changing or cloning state", async () => {
    const f = await fixture({ shared: true }); const prepared = await f.prepare();
    const registry = createFeatureRegistry([defineFeature({ apiVersion: frameworkApiVersion, id: "test.score",
      description: "Recovery test", shareableState: [{ id: "score", label: "Score", schemaVersion: 1,
        limits: { maxEntries: 10, maxValueBytes: 100 } }] })]);
    await runInDurableObject(f.owner(prepared.attempt), async (_i, state) => {
      const backend = new ShareableStateRealmBackend(state, env, registry);
      const call = (operation, storage) => backend.fetch(new Request(`https://realm/internal/shareable-state/realm/${operation}`, {
        method: "POST", body: JSON.stringify({ realm: prepared.attempt.route.realm,
          namespace: prepared.attempt.route.namespace, storage })
      }));
      expect((await call("set", { key: "score", value: 7 })).status).toBe(200);
      state.storage.sql.exec("UPDATE shareable_state_realm_namespaces SET freeze_id = 'frozen'");
      const before = state.storage.sql.exec("SELECT * FROM shareable_state_realm_namespaces").toArray();
      expect(await (await call("state-event-lookup", { attempt: prepared.attempt })).json()).toEqual({ state: "absent" });
      expect(await (await call("state-event-fence", { attempt: prepared.attempt })).json()).toEqual({ state: "fenced" });
      expect(state.storage.sql.exec("SELECT * FROM shareable_state_realm_namespaces").toArray()).toEqual(before);
      expect((await call("set", { key: "score", value: 8 })).status).not.toBe(200);
    });
  });
});
