export const ALARM_DRAIN_TIME_BUDGET_MS = 5_000;

// Always admit one item so housekeeping or registry lookup time cannot leave
// due work spinning without an attempt. The budget is checked between items;
// the active handler retains its own timeout and completion semantics.
export function alarmDrainTimeRemaining(
	startedAtMs,
	processed,
	nowMs = Date.now()
) {
	return processed === 0 || nowMs - startedAtMs < ALARM_DRAIN_TIME_BUDGET_MS;
}
