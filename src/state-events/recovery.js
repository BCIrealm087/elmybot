import { STATE_EVENT_LIMITS as LIMITS, recoveryError, sameAttempt } from "./identity.js";
import {
  expireStateEventOrigin, finalizeStateEventOrigin, lookupStateEventOrigin, markStateEventOriginConfirmed, prepareStateEventOrigin,
  repinStateEventOrigin
} from "./storage.js";

// Runs at the origin object. Transport is a framework-owned owner client, never
// feature code. A timeout is uncertainty, not permission to consult new defaults.
export function createStateEventRecovery(state, ownerClient) {
  async function confirmed(record, outcome) {
    if (outcome?.state !== "committed" || outcome.receipt?.operationId !== record.attempt.identity.operationId) {
      throw recoveryError("invalid_owner_response", 503);
    }
    let cached;
    try {
      cached = finalizeStateEventOrigin(state, record.attempt, outcome.receipt, Date.now(), outcome.terminal === true);
    } catch (error) {
      // A full origin cache cannot undo a verified owner commit. Leave its old
      // locator intact so a retry recovers the same receipt from that owner.
      if (error?.code !== "state_event_capacity" && error?.code !== "state_event_too_large") throw error;
    }
    if (cached?.state === "committed" && !cached.ownerConfirmed) {
      try {
        const acknowledged = await ownerClient.confirm(record.attempt);
        if (acknowledged?.state === "committed" && acknowledged.receipt?.operationId === outcome.receipt.operationId) {
          markStateEventOriginConfirmed(state, record.attempt);
        }
      } catch {
        // The committed result remains known. Retry the acknowledgement on the
        // next recovery; the owner cannot prune its unconfirmed receipt meanwhile.
      }
    }
    return { state: "committed", receipt: outcome.receipt };
  }
  async function ask(method, attempt) {
    try {
      const result = await ownerClient[method](attempt);
      if (!["absent", "fenced", "committed"].includes(result?.state) || (method === "fence" && result.state === "absent")) {
        throw recoveryError("invalid_owner_response", 503);
      }
      return result;
    } catch (error) {
      if (error?.code === "state_event_source_conflict") throw error;
      throw recoveryError("outcome_unknown", 503);
    }
  }
  return Object.freeze({
    lookup(identity) { return lookupStateEventOrigin(state, identity); },
    async prepare(identity, prepare) {
      const existing = lookupStateEventOrigin(state, identity);
      if (existing) return existing;
      // Config/route preparation is lazy: never redo it for an existing source.
      return prepareStateEventOrigin(state, { ...await prepare(), identity });
    },
    async recover(identity) {
      const record = lookupStateEventOrigin(state, identity);
      if (!record || record.state === "expired") return record;
      if (record.state === "committed") return record.ownerConfirmed
        ? { state: "committed", receipt: record.receipt } : confirmed(record, { state: "committed", receipt: record.receipt });
      const outcome = await ask("lookup", record.attempt);
      return outcome.state === "committed" ? confirmed(record, outcome) : record;
    },
    async retire(identity, nowMs = Date.now()) {
      const record = lookupStateEventOrigin(state, identity);
      if (!record || record.state === "expired") return record;
      const outcome = await ask("lookup", record.attempt);
      if (outcome.state === "committed") return confirmed(record, outcome);
      if (record.state === "committed" && outcome.state === "absent") {
        // Owner receipts are removable only after this origin's durable cache
        // acknowledgement AND terminal delivery, so absence now proves retirement.
        return confirmed(record, { state: "committed", receipt: record.receipt, terminal: true });
      }
      if (record.state === "committed") throw recoveryError("invalid_owner_response", 503);
      if (nowMs < identity.sourceCreatedAtMs + LIMITS.sourceLifetimeMs) throw recoveryError("still_pending");
      const fenced = await ask("fence", record.attempt);
      if (fenced.state === "committed") return confirmed(record, fenced);
      return expireStateEventOrigin(state, record.attempt, nowMs);
    },
    async repin(identity, resolve) {
      const record = lookupStateEventOrigin(state, identity);
      if (!record) throw recoveryError("missing_origin", 503);
      if (record.state === "expired") throw recoveryError("source_expired", 410);
      if (record.state === "committed") return record.ownerConfirmed
        ? { state: "committed", receipt: record.receipt } : confirmed(record, { state: "committed", receipt: record.receipt });
      // Fencing and commit serialize at the OLD owner. If commit won, return
      // its receipt. If fencing won, delayed old requests cannot later commit.
      if (record.attempt.epoch >= LIMITS.maxAttempts) {
        const outcome = await ask("lookup", record.attempt);
        if (outcome.state === "committed") return confirmed(record, outcome);
        throw recoveryError("attempt_limit", 503);
      }
      const outcome = await ask("fence", record.attempt);
      if (outcome.state === "committed") return confirmed(record, outcome);
      const current = lookupStateEventOrigin(state, identity);
      if (!current || current.state === "committed" || !sameAttempt(current.attempt, record.attempt)) return current;
      const route = await resolve();
      return repinStateEventOrigin(state, record.attempt, route);
    }
  });
}
