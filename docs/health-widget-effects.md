# Health v2 cosmetic acceptance and effects

Latency-repair roadmap step 8 changes only the v2 health widget's event-handling
policy. A valid live impact is accepted into a small in-memory cosmetic queue,
and its handler returns without awaiting animation completion. The ordinary
durable-event client then sends ACK as before. Other consumers, including the
legacy widget and custom handlers, retain their existing handler/ACK contract.

## Acceptance and bounds

`watchStateEvents` still acquires an authorized baseline, checks scope and
correlation, suppresses historical/replayed/duplicate events, and remembers
handled IDs. The health handler validates all declared impact fields before
acceptance, including bounds for before/after, requested/applied amounts and the
operation/changed types. Invalid live payloads throw; they are not remembered
or ACKed on that failed delivery, even if the page is hidden or the queue is
full. Existing recovery/baseline rules still apply on reconnect.

`public/health-widget/effects.js` implements the health-specific policy:

| Work | Bound/policy |
| --- | --- |
| Running cosmetic effect | At most one; its completion does not own ACK. |
| Pending cosmetic effects | At most eight; overflow drops the oldest pending descriptor. |
| Retained descriptor | Only operation, event ID and operation ID; no numeric health, payload or credential. |
| Hidden page | Cancel running work, clear pending work, validate/accept new events without effects. Becoming visible does not replay skipped effects. |
| Reconnect, handler failure, terminal end, new credentials/connect | Clear obsolete work and cancel the running animation. Late completion cannot clear or advance a newer run. |
| Page teardown | Close the queue, cancel running work, detach both transports. BFCache restoration reloads for a fresh baseline. |
| Animation failure | Cancel/drop that cosmetic effect and continue the queue. It does not reject an already accepted event. |

No event or effect applies another delta, copies its old absolute result into
the display, or reconstructs health after dropped effects. The number, width
and ARIA value remain exclusively driven by authorized readable snapshots.
Accepted clamped no-ops can animate while visible. Duplicate handling neither
enqueues another effect nor evicts an existing pending effect.

The queue starts work without awaiting `Animation.finished`. A never-settling
completion can hold one cosmetic slot, but cannot grow the queue or hold event
ACK. Hiding, lifecycle cancellation and teardown clear that slot without waiting
for cancellation to settle. Completion/rejection callbacks check the original
run's identity before touching current work. No timeout, polling, durable browser
queue or trailing network request is introduced.

## Explicit tradeoff

ACK means validated acceptance, not visible completion. After ACK, a page crash,
reload, cancellation or overflow can lose a pending/unfinished cosmetic effect.
The browser's recent-ID list does not restore that effect. The authoritative
current-health snapshot remains recoverable, and a fresh baseline can suppress
missed historical effects. Preserving every cosmetic effect across a crash
would require a separately reviewed durable browser queue/product requirement.

Browser suspension can prevent JavaScript, WebSockets and animation callbacks
from running. This policy removes the animation dependency while the page can
execute; it does not promise a universal wall-clock ACK or animation deadline.

## Diagnostics and verification

With the existing `?diagnostics=1` opt-in, health traces include
`animation.queued`, `start`, `finish`, `drop`, `skip`, `cancel` and `error` stages,
opaque event/operation IDs, pending/running counts and controlled reasons.
The existing 200-record/minute browser cap remains. No payload, numeric health
or grant is logged. `event.handled` and `event.ack` now reflect health acceptance,
which can precede `animation.finish`; generic clients still await their handlers.

`test/health-widget-effects.spec.js` checks a thousand-event burst, oldest-pending
overflow, never-resolving effects, hidden/visible transitions, cancellation races,
malformed events, clamped no-ops, cosmetic failures and coordinator scope/baseline/
ID handling. Existing generic coordinator/client tests retain awaited-handler
ACK and failed-handler replay semantics.

`scripts/smoke-health-widget-browser.js` runs the shipped widget and both clients
in Chromium over HTTP/WebSocket fixtures. It holds animation completion while
ACKs and snapshots progress, verifies the eight-pending bound and retained FIFO,
then exercises hiding, reconnect, reload recovery, terminal teardown and invalid
payload rejection without ACK. Visibility events use a controlled document
visibility getter to test policy deterministically; they do not emulate browser
background-throttling or suspension timing. Legacy grant/view and separate read/
event authorization checks remain in that smoke test.

No source mutation, destination publication, Worker RPC, SQL or alarm protocol
changes are part of this step. The queue is transient page state; its module is
served as an ordinary health-widget static asset.
