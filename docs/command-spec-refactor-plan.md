# Command Specification Unification Refactor Plan

## Objective
Unify command specification (names, options, behavior, permission requirements, worker routing, and Durable Object behavior mappings) in one canonical place, while preserving current bot behavior and keeping runtime overhead low.

## Current-state review (what is split today)

### Worker command behavior is spread across multiple structures
- Scheduling command parsing/validation is in `doAtNameHandlers`.
- Delivery formatting behavior is in `doAtTypeHandlers`.
- Permission gating is in `protectedCommands` + `checkGuildPermissions`.
- Deferred routing decisions are encoded separately in `isDeferredCmd` checks.

This creates drift risk: adding/changing a command currently requires touching multiple disconnected objects.

### Registration and routing can drift
- Command registration is defined in `src/register-commands.js`.
- Runtime routing names are defined separately in `src/index.js`.

There is no shared source that guarantees these names/semantics stay aligned.

### Existing architecture constraints already match desired behavior
- Raw-body signature verification with timestamp concatenation is correctly implemented.
- Deferred ACK pattern (`type: 5`) + background processing + `PATCH @original` is correctly used for potentially slow paths.
- DO alarm lifecycle and post-mutation recompute-from-storage pattern are correctly implemented.
- Allowed mentions are explicitly controlled for interaction responses and outbound channel messages.

## Target design

## 1) Create a canonical command spec module
Add a new module (e.g. `src/command-spec.js`) exporting a frozen command registry.

Each command spec entry should include:
- `name`
- `description`
- `options` (registration schema)
- `requiresGuild`
- `requiresModeratorOrOwner`
- `deferred`
- `kind` (`schedule`, `list`, `cancel`, `simple`)
- If schedule-kind:
  - `doAtType`
  - `subjectFromInteraction(interaction)`
  - `validateSubject(subject)` -> error string/null
  - `timestampOptionName` + repeat option rules

Additionally, define `doAtType` behavior in the same module:
- `innerContent(job)`
- `allowedMentions(job)`
- `outerContent(job, inner)`

This gives one place for both command parsing and delivery semantics.

## 2) Refactor worker routing to use command spec lookups only
In `src/index.js`:
- Replace `protectedCommands`, `doAtNameHandlers`, and scattered command name branching with `const spec = COMMANDS[name]` lookup.
- Use spec flags for:
  - permission checks
  - deferred handling
  - guild requirement
- For schedule commands, invoke spec extraction/validation helpers to build DO payload.

Outcome: command add/change becomes mostly data-only.

## 3) Refactor DO to use shared doAt behavior mapping
In `GuildScheduler`:
- Replace direct dependency on local `doAtTypeHandlers` with imported canonical `DO_AT_TYPES` mapping from `command-spec.js`.
- Validate incoming `job.doAtType` against this shared map.

Outcome: delivery formatting and worker scheduling stay in lockstep.

## 4) Refactor registration script to consume the same spec
In `src/register-commands.js`:
- Generate Discord command registration payload from the same `COMMANDS` registry.
- Keep any Discord-specific transform isolated (e.g., option type codes), but source names/options from the canonical spec.

Outcome: registration names and runtime routes cannot diverge without failing tests.

## 5) Add guardrail tests for behavioral parity
Add/expand tests to lock current behavior:
- Command name parity between registration output and runtime registry.
- Permission flag assertions (`pingroleat`, `pingmeat`, `sayat`, `doat_list`, `doat_cancel` protected).
- Schedule command subject validation parity.
- DO `doAtType` formatting assertions:
  - role ping mention + `allowed_mentions.roles`
  - user ping mention + `allowed_mentions.users`
  - channel message with `parse: []`
- Deferred routing assertions for commands that perform network/DO work.

## Performance considerations
- Keep registry static and frozen at module load (no per-request reconstruction).
- Continue O(1) command lookup by name (plain object or `Map`).
- Avoid new JSON parse/serialize passes in worker path; refactor should only reorganize control flow.
- Preserve existing DO transaction boundaries and alarm recomputation pattern; these are already efficient and race-aware.

## Execution plan (phased)
1. Introduce `command-spec.js` with current behavior encoded exactly.
2. Update worker to use command spec (no intended behavior changes).
3. Update DO to import shared doAt-type behavior.
4. Update registration script to generate commands from spec.
5. Run tests + add parity tests.
6. Manual smoke check: unknown command, permission denied flow, schedule/list/cancel happy path.

## Acceptance criteria
- No command behavior regressions (inputs, permissions, response content shape, allowed mentions).
- Registration names/options are derived from the same source as runtime routing.
- DO delivery formatting comes from the same source as schedule type mapping.
- Existing tests pass, and new parity tests prevent future drift.
