import { initializeStateEventOutbox, STATE_EVENT_OUTBOX_LIMITS } from "./outbox.js";
import { recoveryError } from "./identity.js";

// A readable partition starts at zero, so a widget may subscribe before the
// first operation. Reads allocate no operation, event, notification or alarm.
export function readableStateEventWatermark(state, partitionKey, stateRevision) {
  initializeStateEventOutbox(state);
  return state.storage.transactionSync(() => {
    let row = state.storage.sql.exec("SELECT * FROM state_event_partitions WHERE partition_key = ?", partitionKey).toArray()[0];
    if (!row) {
      const budget = state.storage.sql.exec("SELECT partitions FROM state_event_outbox_budget").one();
      if (budget.partitions >= STATE_EVENT_OUTBOX_LIMITS.partitions) throw recoveryError("partition_capacity", 503);
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const token = "ses1." + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      state.storage.sql.exec("INSERT INTO state_event_partitions VALUES (?, ?, 0)", partitionKey, token);
      state.storage.sql.exec("UPDATE state_event_outbox_budget SET partitions = partitions + 1");
      row = { scope_token: token, operation_sequence: 0 };
    }
    return { version: 1, scopeToken: row.scope_token, operationSequence: Number(row.operation_sequence), stateRevision };
  });
}
