# Durable integration execution

Cross-platform actions submit normalized effects to one
`IntegrationCoordinator` Durable Object per integration. The coordinator is the
durability boundary between deciding what should happen and contacting Discord,
Twitch, or another platform.

The route runner resolves active versioned routes, creates target effects, and
groups them by integration. Twitch `!announce`, Twitch `stream.online`, and
Discord `/integration_announce_twitch` are the first callers. They submit one
`IntegrationExecution` per linked integration without owning retry,
deduplication, or platform delivery code.

## Acceptance flow

1. The caller builds an immutable `IntegrationExecution` using the shared
   contract factory. Its source event ID is the stable execution identity.
2. The coordinator validates every registered effect kind and its
   platform-specific payload.
3. `IntegrationRegistry` must report the integration as active. The source
   group and every target group must be current members.
4. A canonical SHA-256 fingerprint is calculated for the normalized execution.
5. One SQLite transaction claims the source event ID and writes the execution
   plus every outbox effect.
6. Only after the transaction commits does the coordinator arm its alarm.

An identical source-event replay returns the existing execution. Reusing that
source event with different normalized input is a conflict. Effect idempotency
keys are independently unique within the coordinator, including across
executions.

An execution may contain no effects. This represents a valid, completed action
whose policy or domain behavior intentionally produced no external work.

## Delivery lifecycle

Each outbox effect moves through these states:

| State | Meaning |
| --- | --- |
| `pending` | Persisted and ready for its first attempt |
| `attempting` | Claimed by the current alarm invocation |
| `retry_wait` | A retryable failure is waiting for exponential backoff |
| `delivered` | The adapter returned successfully and its bounded result is stored |
| `dead_letter` | Delivery is terminal or five attempts were exhausted |

Alarms drain at most 20 due effects and stop admitting new effects after five
seconds. The handler already in progress may finish under its own bounded
external-request behavior. Due work left behind is rearmed immediately. Retry
delays begin at 30 seconds and cap at 30 minutes. A
dead-lettered effect can be explicitly rearmed; its stable
idempotency key and original envelope do not change.

The coordinator re-reads the integration before each alarm batch. Revoking a
link therefore dead-letters its outstanding work without calling an external
platform. A temporary registry outage delays the batch without consuming an
effect delivery attempt.

Completed execution ledgers are retained for 14 days and pruned
opportunistically. This bounds storage while covering the expected upstream
redelivery windows.

## Delivery guarantee

The outbox provides durable, at-least-once delivery. It prevents delivery before
the execution is persisted and prevents ordinary source-event replays from
creating duplicate effects. It cannot promise exactly-once behavior across an
external API boundary: a process can fail after a platform accepts a request but
before SQLite records success.

Adapters should use a platform idempotency facility when one exists. Action
authors must also choose stable, target-specific effect idempotency keys and
prefer outcomes that tolerate a rare duplicate.

## Registered effect adapters

The effect registry is an immutable runtime snapshot. Duplicate or malformed
kind registrations fail during Worker startup.

| Kind | Target | Payload | Adapter behavior |
| --- | --- | --- | --- |
| `discord.message.send.v1` | Discord guild plus `destination.channelId` | `content` (1–2000 characters) | Sends a bot message with all automatic mentions disabled |
| `twitch.chat.send.v1` | Twitch channel | `message` (1–500 characters) | Uses the shared Twitch app-token transport, including one authorization refresh |

New effect kinds belong to their platform adapter. A semantic or payload change
uses a new `.vN` kind rather than hidden branching inside the existing handler.
The coordinator itself remains unaware of platform credentials and wire
protocols.

## Internal interfaces

The exported helpers address the correct per-integration Durable Object:

- `submitIntegrationExecution` accepts or replays an execution.
- `getIntegrationExecution` returns its current ledger and effect states.
- `getIntegrationCoordinatorStatus` returns bounded aggregate state counts and
  the next scheduled alarm without exposing effect payloads.
- `getIntegrationDeadLetters` returns a bounded page of terminal failures.
- `retryIntegrationEffect` rearms one dead-lettered effect.

These are internal service interfaces, not public Worker routes. Discord
management commands first prove that their guild is an integration member
through the registry before reading coordinator diagnostics or requesting a
retry. See `docs/integration-management.md`.

## Deployment notes

Wrangler migration `v12` creates `IntegrationCoordinator`, with separate
production and test bindings. No new secret is required; the registered
adapters reuse the existing Discord bot and Twitch application credentials.
