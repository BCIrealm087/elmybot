import { recoveryError } from "./identity.js";

// Conservative application binding-call weights, including awaited descendants.
// These are not Cloudflare's depth counter. Keep in sync with the call graph and
// enforced-call tests when changing registry, destination or origin recovery.
export const STATE_EVENT_REMOTE_COST = Object.freeze({
  interest: 2, append: 2, "authority.append": 8, confirm: 2,
  outcome: 2, "origin.retire": 4, "interest-release": 1
});
export const STATE_EVENT_WORK_LIMITS = Object.freeze({ remoteCalls: 20, records: 2, publications: 1, continuationMs: 25 });
const controls = new Set(["retiring", "gap_recorded", "reset_discarded"]);
export function stateEventRecordRemoteCost(row) {
  const shared = JSON.parse(row.intent_json).route.kind === "effective_shareable";
  const cleanup = (shared ? STATE_EVENT_REMOTE_COST["origin.retire"] : 0) + STATE_EVENT_REMOTE_COST["interest-release"];
  if (controls.has(row.state)) return cleanup + (row.state === "gap_recorded" ? STATE_EVENT_REMOTE_COST.confirm : 0);
  return STATE_EVENT_REMOTE_COST.interest + STATE_EVENT_REMOTE_COST.confirm + cleanup +
    (row.state === "appended" ? STATE_EVENT_REMOTE_COST.outcome : STATE_EVENT_REMOTE_COST[shared ? "authority.append" : "append"]);
}
export function createStateEventWorkBudget() {
  let reserved = 0, records = 0, publications = 0;
  const publication = (row) => !controls.has(row.state) && row.state !== "appended";
  return {
    get reserved() { return reserved; },
    get records() { return records; },
    reason(row) {
      if (records >= STATE_EVENT_WORK_LIMITS.records) return "record_quantum";
      if (publication(row) && publications >= STATE_EVENT_WORK_LIMITS.publications) return "publication_quantum";
      if (reserved + stateEventRecordRemoteCost(row) > STATE_EVENT_WORK_LIMITS.remoteCalls) return "remote_budget";
      return null;
    },
    start(row) {
      if (this.reason(row)) throw recoveryError("relay_budget", 503);
      const limit = stateEventRecordRemoteCost(row); let used = 0;
      reserved += limit; records++; if (publication(row)) publications++;
      return {
        take(rpc) {
          const cost = STATE_EVENT_REMOTE_COST[rpc];
          // Refuse unknown/unbudgeted calls before issuing them. Previously
          // completed calls stay charged; a timeout retains its normal fence.
          if (!cost || used + cost > limit) throw recoveryError("relay_budget", 503);
          used += cost;
        }
      };
    }
  };
}
