# Widget data publication and state-query integration roadmap

Status: implementation roadmap; Steps 1–7 completed through 2026-09-23.
Created: 2026-09-19.
Work branch: `codex-querying-experiment` in `BCIrealm087/elmybot`.
Baseline reviewed: `47d6e3fb974157b7ea70621241ae05191e81e949`.

This roadmap adds a small cross-platform feature that lets an authorized Discord
or Twitch user publish a bounded string for widgets and other state-query
clients. It deliberately uses the existing current-state query contract:
subscribers receive a complete current replacement, rapid intermediate writes
may be coalesced, and a newly connected client receives the latest value.

Guaranteed delivery of every command invocation, durable event history,
per-consumer acknowledgements, and alternate event transports are separate
future work. They must not be implied by this feature's names, documentation, or
tests.

## Product goal and agreed direction

A moderator can issue one Discord or Twitch command containing arbitrary bounded
text. The feature stores that text together with a stable opaque update identity.
An authorized state-query client can read the current value once or subscribe to
replacement updates through the existing hibernating WebSocket transport.

The recommended first version has these semantics:

- The payload is a string. A client may interpret it as JSON or another
  application-specific format, but Elmybot does not parse or execute it.
- One current value exists per effective shareable-state realm. A later accepted
  command replaces the earlier value.
- The feature works before linking. When directional defaults select the same
  integration, Discord and Twitch commands update the same shared value.
- Query subscriptions follow the target group's current effective realm through
  the existing linking, default-switching, revocation, and successor rules.
- Every distinct source command has a distinct `updateId`, including two
  commands with identical payload text.
- A retry of the same source command derives the same `updateId` and should be
  an idempotent write.
- Writers and readers are authorized separately. The command is moderator-only;
  public reads still require an operator-issued state-query grant.
- The command response acknowledges success without echoing the full payload.
- Payload text and raw platform event identifiers are not logged.

The first version intentionally has one slot and no topic argument. An update ID
distinguishes invocations; it does not create independent data lanes. Named
topics can be added later as a parameterized lookup after a concrete multi-widget
use case justifies their storage, parser, authorization, and fanout costs.

## Proposed public shape

Step 1 must finalize these identifiers before implementation. The recommended
starting names are:

| Surface | Proposed identity |
| --- | --- |
| Feature ID | `widget.data` |
| Action kind | `widget.data.publish.v1` |
| Shareable namespace | `published_data` |
| State key | `latest` |
| Readable export | `latest`, version 1 |
| Discord command | `/widget_data data:<text>` |
| Twitch command | `!widgetdata <text...>` |

The stored and query-visible present value should be one atomic object:

```json
{
  "updateId": "opaque-stable-id",
  "data": "consumer-defined text",
  "origin": "twitch"
}
```

Recommended field rules:

- `updateId` is a fixed-length, unguessable-looking identifier derived from
  the feature/action identity, origin platform, origin group, and
  `ctx.sourceEventId`. A SHA-256 base64url digest is sufficient. It avoids
  exposing the raw Discord interaction or Twitch message identifier and remains
  stable when the same source event is retried.
- `data` is trimmed consistently by both platform adapters and bounded by one
  common limit at or below the practical Twitch command remainder. Step 1 should
  choose the exact limit after testing representative Unicode input; 400–500
  characters is the intended range.
- `origin` is exactly `discord` or `twitch`. Actor identity, group identity,
  credentials, and integration identity are not included.
- Version 1 does not include a publication timestamp. The query envelope's
  `observedAt` remains observation time, not command time. A future command-time
  field requires an idempotent source timestamp or a versioned public-schema
  decision.

The readable export should be a `value` with
`scope: { kind: "effective_shareable", namespace: "published_data" }`,
operator-grant access, and `absent` semantics before the first publication.
The result schema is the exact object above with no undeclared fields.

The shareable namespace should use a presence collision summary. If Discord and
Twitch both have different nonempty standalone values when linked, the existing
resolution flow must require an explicit choice of Discord, Twitch, reset, or
cancel. No timestamp-based or last-write-wins merge is introduced.

## Correctness boundaries

### Current state, not an event stream

The current state-query contract permits replacement coalescing. Clients must
use `updateId` to recognize the logical publication represented by a result,
but they must not infer that every command will be delivered. In particular:

1. A client connected before one command should eventually receive the current
   replacement while authorized and healthy.
2. A slow client may receive only the newest result after several rapid
   commands.
3. A reconnect may receive a fresh snapshot rather than replaying earlier
   publications.
4. A client connecting for the first time receives only the current value.
5. WebSocket sequence numbers, cursors, query digests, binding revisions, and
   result revisions are transport/query identities, not publication IDs.

Tests and documentation must use words such as “publish current widget data” or
“replace the latest value,” not “send every event,” “queue,” or “exactly once.”

### Atomic and idempotent value replacement

The ID, payload, and origin must be written as one JSON value with one state
operation. Separate state keys would allow partial observation and unnecessary
intermediate notifications.

Because feature storage treats an identical serialized set as a no-op, deriving
the ID from the stable source event provides the desired behavior:

- a distinct command with the same payload has a different object and is
  observable;
- an actual retry of the same command has the same object and need not create a
  second mutation; and
- consumers can de-duplicate duplicate transport delivery by `updateId`.

### Ownership and lifecycle

The action resolves `published_data` through
`ctx.shareableState.current(otherPlatform, "published_data")` and writes
`latest`. The readable export uses the same namespace through the query
framework's controlled effective-shareable context.

Existing lifecycle behavior remains authoritative:

| Situation | Widget-data source |
| --- | --- |
| No active default | Origin group's standalone realm |
| Both directions select one integration | One shared integration realm |
| Another nondefault link activates | Existing selected realm remains current |
| Default changes | Later writes and subscriptions follow the newly selected realm |
| Selected link revokes with fallback | Subscription follows the fallback realm |
| Selected link revokes without fallback | Subscription follows the copied standalone successor |
| Activation or revocation is transitioning | Mutation fails retryably; query reports its existing safe non-ready status |

No feature code receives or persists integration IDs, realm IDs, generations, or
other groups' identifiers.

### Security and resource use

The payload is untrusted text even when written by a moderator. Elmybot stores
and returns it as JSON data; widget authors are responsible for safe parsing and
rendering and must not insert it as executable HTML or JavaScript without their
own validation.

The feature should:

- require the existing moderator capability on both platforms;
- use a small command cooldown or equivalent bounded mutation policy chosen in
  step 1;
- reject empty and oversized input before state access;
- never echo the full payload into Discord or Twitch chat;
- never include the payload in logs, errors, correlation IDs, or metrics;
- remain within the existing 16-KiB state-value and 64-KiB ready-result limits;
  and
- rely on existing read-grant, target, session, revocation, and WebSocket
  authorization rather than introducing a public unauthenticated route.

## Milestones and step tracking

Keep these step numbers stable during implementation. A step is complete only
when its code, focused tests, documentation, and relevant CI checks satisfy its
exit criteria.

| Milestone | Steps | Result |
| --- | --- | --- |
| A: Contract and feature foundation | 1–2 | Frozen semantics, names, package, and cross-platform parsing |
| B: Publication and querying | 3–4 | Atomic shareable writes and a discoverable readable export |
| C: Live and lifecycle proof | 5–6 | Subscription updates and correct linked-state transitions |
| D: Usability and hardening | 7–8 | Widget guidance, security checks, and full clean-run verification |

### 1. Freeze the version-1 feature contract

**Status:** completed on 2026-09-19. **Depends on:** this roadmap.

The approved normative result is
[`widget-data-contract.md`](widget-data-contract.md). It freezes the command,
payload, update identity, shareable ownership, collision, readable-export,
authorization, coalescing, and deferred-event-delivery semantics described by
this step. Implementation begins in step 2.

Write a concise normative contract for command names, input normalization and
maximum length, access, cooldown, acknowledgement text, feature IDs, namespace
schema version, stored value, update-ID derivation, absence, link collisions,
and query-visible schema.

Confirm that `ctx.sourceEventId` is stable across the supported Discord and
Twitch retry paths. Specify the exact digest input with unambiguous length
framing or canonical JSON so concatenation cannot create identity ambiguity.
Define whether an already-current identical source event returns ordinary
success without rewriting.

Record the current-state/coalescing guarantee and the absence of history in both
maintainer and widget-consumer language. Explicitly defer topics, collections,
event replay, durable queues, arbitrary binary data, actor metadata, public
writes, and guaranteed per-command delivery.

**Exit criteria:** every public name and schema is fixed; examples cover first
publication, repeated identical data from distinct commands, retry of one source
event, empty state, oversized input, and a coalesced burst; there are no
unresolved choices that would change persisted or public identity.

### 2. Add and install the private feature package

**Status:** completed on 2026-09-19. **Depends on:** step 1.

Create a private workspace feature package under `packages/features/` using
only `@elmybot/framework` APIs. Add matching framework compatibility metadata,
the explicit installation in `src/features/index.js`, and package-level tests.

Define one action command for Discord and Twitch. Discord uses one required
string option. Twitch uses `twitchRestText` so internal spaces do not require
quoting. Both normalize to the same action input and the same length policy.

Add a small pure helper that derives the opaque update ID from the frozen digest
contract. Make the helper deterministic and directly testable. Do not add a new
framework service unless the supported Worker cryptography and test runtime
cannot implement the contract cleanly at the feature boundary.

**Exit criteria:** workspace validation and registry installation pass; generated
Discord registration and raw Twitch command-text tests accept ordinary and
Unicode payloads, preserve internal spaces, reject empty/oversized input, and
enforce moderator access.

### 3. Implement atomic effective-shareable publication

**Status:** completed on 2026-09-19. **Depends on:** steps 1–2.

Declare the `published_data` shareable namespace with schema version 1 and a
presence collision summary. Resolve the effective realm once per command and set
the complete `latest` object with one storage operation.

Return a bounded generic acknowledgement containing, at most, a short display
prefix of the update ID. Do not return or log the data. Preserve the existing
retryable transition error instead of falling back to another realm.

Test standalone Discord and Twitch writes, linked writes through both origins,
same-data distinct events, same-source retries, authorization denial, and
concurrent last-writer-wins behavior. Assertions must treat one final current
value as the guarantee and must not require observation of every intermediate
write.

**Exit criteria:** one accepted command produces one coherent current object;
distinct source events remain distinguishable; a same-source retry does not
invent a new logical publication; transition failures cannot partially write or
redirect state.

### 4. Add the readable export and snapshot/query proof

**Status:** completed on 2026-09-22. **Depends on:** step 3.

Declare `latest:v1` as an effective-shareable readable value with the exact
public schema and operator-grant access. Return `absent` before publication and
`present` with the complete object afterward.

Add an optional feature-authored query builder only if it removes meaningful
client boilerplate; it must return an ordinary version-1 query document and
must not create a new query language or preset-only path.

Cover catalog discovery, normalized query preparation, snapshot evaluation,
field projection, grant issuance/denial, and result-size validation. Verify that
the export exposes no actor, raw source event, group, integration, realm, or
storage identity.

**Exit criteria:** an authorized snapshot can read and project the current
publication from either platform target; an unauthorized read fails as a whole;
empty state is distinguishable from an empty string, which the command itself
rejects.

### 5. Prove live replacement and coalescing behavior

**Status:** completed on 2026-09-22. **Depends on:** step 4.

Extend state-query live and WebSocket coverage so a real feature command, rather
than a synthetic storage mutation, invalidates and reevaluates a subscription.
Verify an initial snapshot, one command-driven update, acknowledgement,
hibernatable recovery, and a current resynchronization after reconnect.

Add a burst test whose only required data outcome is the last accepted
publication. It may observe intermediate replacements, but must not require or
forbid them. Verify that two distinct commands with identical data remain
distinguishable when both are observed and that a final same-data publication
is distinguishable from the earlier one.

Use the existing transport sequence and cursor only for delivery protocol
assertions. Widget logic in tests de-duplicates publications by `updateId`.

**Exit criteria:** live clients converge on the latest accepted object, repeated
payload text can still produce a new logical publication, and no test or
documentation accidentally upgrades the contract to exhaustive delivery.

### 6. Verify linking and source-handoff lifecycle

**Status:** completed on 2026-09-22. **Depends on:** steps 3–5.

Exercise empty/nonempty/identical/colliding standalone candidates and confirm the
existing namespace-level resolution choices. Verify activation, directional
default selection, default switching, nondefault-link creation, revocation with
fallback, revocation without fallback, relinking, and delayed obsolete-source
notifications.

For a source handoff, the subscription must deliver or resynchronize to the new
current realm even when the visible widget-data object is identical. A delayed
notification from the former realm cannot restore its value.

Keep these checks automated with the existing integration and observer test
harness. Manual live-platform testing is not a standalone completion gate
unless implementation uncovers a critical behavior that the harness cannot
represent.

**Exit criteria:** command writes and query reads select the same realm throughout
the lifecycle; collision resolution is explicit; obsolete realms cannot mutate
or overwrite the selected result.

### 7. Add widget-consumer and contributor guidance

**Status:** completed on 2026-09-23. **Depends on:** steps 4–6.

The consumer and contributor handoff is
[`widget-data.md`](widget-data.md). It documents publishing and grant setup,
snapshot and WebSocket shapes, complete-replacement handling, safe rendering,
`updateId` de-duplication, effective ownership, and a same-origin OBS/browser
example whose synchronous application completes before the maintained client
acknowledges the cursor. The README, browser guide, and generated feature
catalog link to it. Documentation contract tests protect the required semantics
and reject credential, query, or cursor parameters in example URLs.

Document:

- both command syntaxes and moderator requirement;
- how an operator grants access to `widget.data:latest:v1`;
- snapshot and WebSocket query examples;
- the exact result-cell and publication object shapes;
- client handling for `absent`, `present`, transitioning, unavailable,
  reconnect, duplicate delivery, and `updateId` de-duplication;
- safe rendering and consumer-side parsing of untrusted data;
- latest-state/coalescing semantics, including a concrete three-command example;
- how linked and standalone ownership changes the selected value; and
- why cursors, result revisions, and query digests are not publication IDs.

Include a minimal browser/OBS-oriented example that applies complete replacement
state and acknowledges the WebSocket cursor only after applying it. It must not
place grants, query documents, or cursors in URLs.

Update the feature and framework catalog documentation without presenting
topics or guaranteed event delivery as implemented functionality.

**Exit criteria:** a widget developer can configure an authorized subscription,
extract `data`, de-duplicate by `updateId`, and understand exactly what may be
coalesced without reading internal implementation files.

### 8. Harden, verify, and prepare the reviewed milestone

**Status:** pending. **Depends on:** steps 1–7.

Review all new paths for payload leakage, unsafe error reflection, overbroad
grants, unbounded values, accidental actor exposure, platform-specific parsing
drift, source-event identity instability, and misleading event-stream language.

Run the locked clean checks:

```sh
npm ci
npm run feature:workspaces
npm run lint
npm test -- --run
```

Let CI perform the authoritative JavaScript syntax check, browser smoke, and
non-deploying Wrangler dry run. Inspect the triggered GitHub Actions run and
diagnose any failure before declaring the milestone complete.

Update this roadmap's status and progress log with the final contract, commits,
test totals, and CI run. Production deployment and live Cloudflare testing remain
operator-managed unless a newly discovered critical risk specifically requires
manual evidence.

**Exit criteria:** the full suite and CI pass; the installed feature is documented
and bounded; existing Discord, Twitch, linking, query, grant, browser, and
WebSocket behavior remains compatible; deferred event-delivery work is clearly
separated.

## Deferred follow-up: guaranteed event delivery

A future event-oriented capability may reuse authentication and logical group
targeting, but it is not an extension of the current value semantics by naming
alone. It must separately design:

- durable append/retention limits;
- globally meaningful event identity and ordering scope;
- per-consumer or consumer-group acknowledgement;
- reconnect replay and expiration behavior;
- slow-consumer backpressure;
- topic or routing semantics;
- link/default changes during retained history;
- delivery guarantees and duplicate handling;
- write and fanout quotas; and
- cost behavior with no subscribers and many subscribers.

That work should compare a dedicated event log/queue and alternate transports
against the current state-query WebSocket. It must not reinterpret existing
state-query cursors or retained replacement history as a durable command-event
log.

## Progress log

| Date | Step | Commit | Verification | Notes |
| --- | --- | --- | --- | --- |
| 2026-09-19 | Roadmap | `aa05f78` | CI run 35419090662 passed | Initial agreed plan; implementation not started |
| 2026-09-19 | 1 | `aad7dd8`, `6ace057` | CI run 35435837932 passed | Approved `widget-data-contract.md`; implementation not started |
| 2026-09-19 | 2 | `c0750bd`, `83fccc8` | CI run 35446952598 passed | Installed private widget-data package, cross-platform bounded command definitions, deterministic update-ID helper, and package/registration tests; persistence remains step 3 |
| 2026-09-19 | 3 | `0b44ffd`, `d274571` | CI run 35474663099 passed | Added atomic effective-shareable `latest` publication, exact success acknowledgement, lifecycle/concurrency coverage, and multi-namespace integration discovery assertions; readable export remains step 4 |
| 2026-09-22 | 4 | `f13b2d1`, `4c8de22`, `c3cfbe0`, `e49a1a3` | CI run 35717200571 passed | Added discoverable `latest:v1` effective-shareable export, exact absence/present schema validation, ordinary-query snapshot and projection proof on both platforms, grant/catalog denial coverage, result-size bounds, and camelCase public-field projection support; no feature-specific query builder added |
| 2026-09-22 | 5 | `2b658a7` | CI run 35755726387 passed | Proved real command-driven live invalidation, exact acknowledgement, hibernating-socket recovery, reconnect resynchronization, same-data update identity, and burst convergence on the final accepted publication without requiring exhaustive delivery; 433 tests passed |
| 2026-09-22 | 6 | `8572ff5` | CI run 35758823670 passed | Proved all five `published_data` presence-resolution outcomes and command/query agreement through activation, directional defaults, nondefault links, same-value default handoff, delayed obsolete-source delivery, revocation with fallback, lazy standalone successor creation, and relinking; no production lifecycle changes were required; 435 tests passed |
| 2026-09-23 | 7 | `57d871b`, `78d171e`, `0bf0432` | CI run 35818145526 passed | Added the widget consumer/contributor guide, exact snapshot and WebSocket examples, safe synchronous OBS/browser replacement handling, grant and ownership guidance, catalog/README links, and documentation contract tests; 438 tests across 47 files passed with lint, browser smoke, syntax checks, and the Wrangler dry run; no deployment or runtime behavior changed |
