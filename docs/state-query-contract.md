# Public state-query contract

Status: completed design contract for state-querying step 1; implementation is
pending.

This document defines the first-version public meaning of readable state,
composable queries, snapshots, and live results. It is normative for subsequent
state-querying work. Exact JavaScript helper names, HTTP route names, storage
tables, and transport placement may be chosen in later steps, but they must
preserve this contract.

The existing command, feature-state, and shareable-state contracts remain in
force. In particular, a query is a read-only observation from one platform
group's perspective. It does not execute a command, inherit command side
effects, expose a physical realm, or change how command invocations pin state.

## Goals and boundaries

The first version must let an authorized user:

1. discover state that installed features explicitly make readable;
2. read one value or a parameterized collection entry;
3. combine several reads into one named result;
4. read a bounded, complete collection of materialized entries;
5. use one readable result as an argument to another read; and
6. receive the same query as an initial snapshot and subsequent live updates.

The public unit is a logical query for one Discord guild or Twitch channel.
The query continues to mean “the state currently in use by this group” when a
shareable-state default is activated, switched, repaired, or revoked.

The first version does not provide arbitrary JavaScript, SQL, GraphQL,
user-defined functions, mutation, historical event replay, cross-group joins,
access to archived realms, or Discord text-channel ownership. Optional
feature-authored presets may produce ordinary query documents, but they do not
extend the language or limit users to a preset catalog.

## Terms

- A **target group** is the Discord guild or Twitch channel whose current view
  the query observes.
- A **readable export** is feature-declared, typed, read-only state eligible for
  query access. A declaration does not itself make the export public.
- A **binding** is one named read in a query document.
- A **literal argument** is a client-supplied JSON scalar.
- A **dynamic argument** obtains its value from another binding.
- A **projection** selects a declared field from a binding result.
- A **logical reference** identifies a target group, feature, export, and
  normalized arguments without identifying physical storage.
- A **source binding** is the set of current physical owners used to evaluate
  the query. It is internal and never grants access.
- A **result cell** distinguishes present, absent, unselected, and
  dependency-blocked values.
- A **snapshot** is a complete evaluation at an observed revision.
- A **subscription** is continued observation of the same query.
- A **cursor** orders delivered subscription events. It is not a credential,
  storage revision, or permission grant.

## Readable export catalog

Only installed features may declare readable exports. The normalized
declaration for each export contains:

| Field | Meaning |
| --- | --- |
| Feature ID and export ID | Stable logical identity |
| Label and description | Bounded user-facing discovery text |
| Supported platforms | Target-group platforms from which it may be read |
| Kind | `value`, `lookup`, or `collection` |
| Ownership | Group-local state or effective shareable namespace |
| Parameters | Named input schemas and normalization rules |
| Result schema | The type returned when present |
| Absence policy | `absent`, a domain-specific `unselected`, or a declared default |
| Access policy | Eligibility used when an operator creates a read grant |
| Limits | Export-specific result and collection limits within system maxima |
| Schema version | Positive integer version of the public arguments and result representation |

IDs are storage and API identities and must not be renamed after release without
a versioned replacement. Labels may change without changing identity.
Feature IDs follow the existing framework pattern. Export and parameter IDs
follow `^[a-z][a-z0-9_-]{0,63}$`.

After target-group authorization, discovery returns safe public entries in this
shape:

```json
{
  "feature": "fun.deaths",
  "export": "count",
  "version": 1,
  "label": "Death count",
  "description": "The current death count for one game.",
  "kind": "lookup",
  "scope": "effective_shareable",
  "supportedPlatforms": ["discord", "twitch"],
  "parameters": {
    "game": {
      "label": "Game",
      "schema": { "type": "string", "minLength": 1, "maxLength": 80 }
    }
  },
  "resultSchema": {
    "type": "object",
    "properties": {
      "game": { "type": "string" },
      "count": { "type": "integer", "minimum": 0 }
    },
    "required": ["game", "count"]
  },
  "absence": { "kind": "default" }
}
```

Public discovery exposes the logical scope but omits storage keys, namespace
IDs, normalizer implementation, integration membership, realm identity, and
operator-only access rules. The authenticated grant-authoring surface may show
which exports are eligible and which argument scopes can be granted.

The version-1 public schema vocabulary is deliberately small: `string`,
`boolean`, finite `number`, safe `integer`, `object`, and `array`.
`nullable: true` adds explicit JSON null to a schema. String length, numeric
bounds, object `properties` and `required`, and array `items` and
`maxItems` use their ordinary meanings. Objects reject undeclared properties.
Every declaration has a concrete schema; an unrestricted “any” type is not
supported. Schemas and results remain within the query depth and encoded-size
budgets.

Readable exports are distinct from commands. A feature may share pure
normalization or read-domain logic between a command and an export, but query
evaluation must not call command execution. It must not claim a cooldown,
perform authorization intended for mutations, update remembered state, emit
effects, or mutate feature values.

The framework gives an export resolver only controlled, read-only access to its
declared source. It does not receive Durable Object bindings, SQL access,
integration IDs, realm generations, other groups, credentials, or arbitrary
feature namespaces.

### Export kinds

A `value` has no client arguments. It reads one logical value, such as the
game remembered by a Twitch channel.

A `lookup` has one or more typed parameters and returns one logical record,
such as the deaths record for a named game. A parameterized value with no
persisted row may return its declared default.

A `collection` returns the finite set of materialized entries belonging to a
declared collection. It must define stable item identity, deterministic
ordering, membership, and removal behavior. A collection is not the infinite
set of all parameter values that could return a default.

A lookup and its collection view may be related, but they have separate export
IDs and access scopes. Granting a fixed-game lookup does not implicitly grant
enumeration. Granting a collection explicitly states whether entries
materialized after grant creation are included.

### Ownership

Group-local ownership reads the target group's current `ctx.state` equivalent.
Linking never changes its owner. Discord and Twitch local values may therefore
differ while their shareable values agree.

Effective-shareable ownership names one declared shareable namespace. From the
target group's perspective, the framework applies the existing lifecycle:

| Current directional selection | Query source |
| --- | --- |
| No active default | The group's current standalone realm |
| Active default | That integration's current realm |
| Revocation with eligible fallback | The fallback integration's existing realm |
| Revocation without fallback | The ready standalone successor copied from final shared state |
| Activation/revocation still transitioning | No fresh result until resolution is ready |

For the current Discord–Twitch model, the counterpart platform is derived from
the target platform by the export declaration. Clients do not submit a target
integration or realm. Opposite directions agree only when their directional
defaults select the same integration.

Changing an unrelated route or completing a nondefault link does not change a
query source. Pending, cancelled, and expired links do not own readable state.

### Proposed deaths exports

The deaths feature is the first proof, with these proposed public semantics:

| Export | Kind and ownership | Present result |
| --- | --- | --- |
| `remembered_game` | Local value | String; `unselected` when no moderator has selected a game |
| `count` | Effective-shareable lookup by `game` | `{ "game": string, "count": integer }`; missing counter means count zero |
| `counts` | Effective-shareable collection | Array of materialized `{ "game": string, "count": integer }` records |

The `game` parameter uses the deaths feature's existing display and identity
normalization. Query implementation must reuse that domain policy.

Existing bounded-counter storage hashes subjects and cannot recover their
original game names. Step 3 must add ownership-preserving subject metadata and
define legacy coverage. Until that migration exists, the `counts` export is
proposed rather than available; fixed-game `count` lookups must preserve
existing counts.

For deaths, a game is a member of `counts` exactly while its counter row is
materialized. A materialized zero remains a member; `reset` removes the row
and its subject metadata and therefore removes the member. The collection is
ordered by canonical game identity. Display labels and counter identity move,
clone, freeze, and fork together within the same shareable namespace.

## Query document version 1

A query is a JSON object:

```json
{
  "version": 1,
  "target": {
    "platform": "twitch",
    "groupId": "141981764"
  },
  "bindings": {
    "dark_souls": {
      "read": {
        "feature": "fun.deaths",
        "export": "count",
        "version": 1
      },
      "arguments": {
        "game": { "literal": "Dark Souls" }
      }
    }
  },
  "select": {
    "game": { "ref": "dark_souls", "path": ["game"] },
    "deaths": { "ref": "dark_souls", "path": ["count"] }
  }
}
```

`version`, `target`, `bindings`, and `select` are required. Unknown
fields are rejected in version 1. Client input is copied before validation.
The accepted normalized query is immutable.

`target.platform` is `discord` or `twitch`. `target.groupId` is the
platform's stable group ID, not a mutable name. Friendly setup interfaces may
resolve names before constructing the query. Platform IDs are validated by the
same identity contract used by authenticated platform groups.

Binding and selection aliases follow `^[a-z][a-z0-9_-]{0,63}$`. Binding aliases
are local to one query and are not persistent storage identities.

### Binding reads

Each binding contains exactly one `read` object with `feature`, `export`,
and positive integer `version`. The version selects the export's public
argument and result schema; it is independent of query protocol and storage
schema versions. A binding contains `arguments` exactly when the export
declares parameters. Argument names must exactly match the declaration:
missing required, extra, or duplicate arguments are rejected.

An argument expression is exactly one of:

```json
{ "literal": "Dark Souls" }
```

```json
{ "ref": "remembered", "path": [] }
```

Literals are JSON strings, booleans, safe integers, or explicit JSON null when
the parameter schema permits them. Arrays and objects are not literal arguments
in version 1.

A dynamic reference names another binding and optionally projects through a
`path`. A path is an array of declared object-field names. Array indexing,
wildcards, computed paths, and access to undeclared fields are rejected.
Omitting `path` is equivalent to an empty path.

The evaluator derives a dependency graph from dynamic arguments. Forward
references are allowed; cycles are rejected. Each referenced present value,
after projection, must satisfy the destination parameter schema.

### Output selection

`select` is a nonempty object whose keys become result-field names. Every
value is a binding reference with an optional declared-field path:

```json
{
  "deaths": { "ref": "dark_souls", "path": ["count"] }
}
```

Selecting several aliases creates a named result object. Selecting an entire
collection returns its complete array value. Version 1 provides projection and
composition, not arithmetic, comparison, filtering, sorting, aggregation,
renaming collection item fields, or conditional expressions.

Bindings that are not selected may exist solely as dynamic dependencies. They
are still included in authorization, complexity, observation, and error checks.

### Normalization and canonical identity

Validation has two phases:

1. Structural validation checks query shape, identifiers, references, cycles,
   declared exports, declared fields, and static type compatibility.
2. Each export validates and normalizes its literal arguments using its
   declared domain rules. Dynamic arguments are normalized when their source
   value is evaluated.

The service returns the normalized query document, including every pinned
export version. A canonical query digest is SHA-256 over its canonical UTF-8
JSON form, encoded as unpadded base64url.
Canonical JSON recursively sorts object keys, preserves array order, uses JSON
string escaping, rejects non-finite numbers, and contains only values accepted
by this contract. The digest includes the target group and every binding and
selection. It identifies equal normalized logical queries but is not secret,
does not authorize access, and is not a storage address.

Normalization must be idempotent. Two accepted literal spellings that identify
the same domain value produce the same normalized argument and digest. Dynamic
normalization uses the same policy before lookup and grant checks.

Changing an export's argument or result meaning requires a new export schema
version and a documented compatibility decision. A service may support
multiple versions during migration; an unsupported pinned version fails
explicitly and is never silently interpreted as the latest version. Internal
storage migrations do not change the logical query when public meaning is
preserved.

## Result model

A completed evaluation returns one result cell for each selection key:

```json
{
  "state": "present",
  "value": 23
}
```

The allowed cell states are:

| Cell state | Meaning |
| --- | --- |
| `present` | The export produced a value satisfying its schema; JSON null is carried explicitly in `value` |
| `absent` | No value exists and the export declares absence rather than a default |
| `unselected` | A declared domain selection has not been made, such as `remembered_game` |
| `blocked` | A dynamic dependency was absent, unselected, or otherwise unable to supply an argument |

`absent`, `unselected`, and `blocked` do not contain `value`.
`blocked` includes a bounded, stable `reason` and the binding alias that
prevented evaluation; it does not reveal hidden values.

These distinctions are normative:

- A zero counter is `{ "state": "present", "value": 0 }`.
- Explicit JSON null is `{ "state": "present", "value": null }`.
- An empty collection is `{ "state": "present", "value": [] }`.
- A missing value without a default is `{ "state": "absent" }`.
- A missing remembered game is `{ "state": "unselected" }`.
- A counter whose game comes from an unselected remembered game is `blocked`.

The complete transport-neutral envelope is:

```json
{
  "protocolVersion": 1,
  "queryDigest": "opaque-base64url-digest",
  "status": "ready",
  "reason": "initial",
  "bindingRevision": "opaque",
  "resultRevision": "opaque",
  "observedAt": "2026-09-11T21:00:00.000Z",
  "data": {
    "deaths": { "state": "present", "value": 23 }
  }
}
```

Overall statuses are:

| Status | Meaning |
| --- | --- |
| `ready` | All permitted reads completed at validated dependency revisions |
| `transitioning` | Effective ownership is changing and no old value is represented as current |
| `unavailable` | The current source or evaluator cannot presently produce a fresh result |

`transitioning` and `unavailable` omit `data`. A client may retain its last
ready result for display only if it also exposes the non-ready status as stale.
Authorization failures are protocol errors, not an `unavailable` data result.

`reason` is one of `initial`, `value_changed`, `dependency_changed`,
`source_changed`, `resynchronized`, `transition_started`,
`transition_completed`, or a later versioned addition. A source change is
delivered even when every result cell is semantically equal.

### Revisions

`bindingRevision` changes whenever any selected or hidden dependency resolves
to a different physical source, including an A-to-B-to-A sequence. It is opaque
and scoped to the target group and resolved dependency set. Clients cannot use
it to request a realm.

`resultRevision` changes whenever the delivered data, status, or binding
revision changes. Unrelated state mutations that do not affect the query need
not change it.

An evaluation that spans owners reads dependency revisions before and after its
reads. If they do not match, it retries within a bounded budget. Exhaustion
produces `unavailable`; the result is not described as an atomic
cross-Durable-Object snapshot. The contract guarantees convergence and
validated observations, not a transaction spanning owners.

## Query resource limits

Version 1 uses these protocol maxima. An export may declare lower limits.

| Resource | Maximum |
| --- | ---: |
| UTF-8 query document | 16 KiB |
| Bindings | 20 |
| Selected output fields | 20 |
| Arguments per binding | 10 |
| Dynamic dependency edges | 40 |
| Longest dependency path | 8 bindings |
| Projection path | 10 fields |
| Collection bindings | 3 |
| Materialized items in one collection result | 100 |
| UTF-8 encoded ready `data` | 64 KiB |
| Queries multiplexed by one subscription | 20 |

Repeated logical reads may be deduplicated internally but still count as
submitted bindings. Limits are checked before expensive evaluation whenever
possible. A collection larger than its advertised complete bound fails with
`query_collection_too_large`; it is never silently truncated and labeled
complete. Pagination is deferred from version 1.

## Authorization and grants

A readable export declaration establishes eligibility only. Every public
snapshot or subscription requires a valid, environment-scoped read grant
issued through an authenticated operator flow for the target group.

A grant contains:

- target platform and group;
- allowed feature and export IDs;
- allowed literal argument policy, such as exact normalized values or any value
  accepted by the export;
- permission for dynamic arguments from named allowed exports;
- separate collection permission and whether future materialized members are
  included;
- maximum query/resource scope no greater than system limits;
- deployment environment, issuance, expiry, and revocation identity.

The implemented credential representation and operator routes are recorded in
[`state-query-http.md`](state-query-http.md). A query digest, logical reference,
group ID, SSE cursor, integration ID, or CORS approval is never a credential.

Authorization is applied to every binding, including hidden dependencies and
collection membership. Dynamic values are normalized and checked against the
destination argument scope before the dependent lookup. If any binding or
projection is forbidden, the entire query is rejected. Results are not
partially redacted because that could create ambiguous widgets and dependency
leaks.

The service authorizes initial discovery, query registration, snapshot reads,
stream attachment, reconnection, source handoffs, dynamic dependency changes,
new collection members, and continued access after grant expiry or revocation.
A valid grant follows permitted future effective-state owners for the same
logical target group. It never grants direct access to an archived, previous,
or independently addressed realm.

Grant lookup and error behavior must not reveal the existence or value of
unauthorized groups, exports, parameters, subjects, collection members,
integration relationships, or physical sources.

## Snapshots and subscriptions

One-time reads and subscriptions evaluate the identical normalized query.
Subscriptions add observation and delivery; they do not change query semantics.

Initial snapshot evaluation and watcher attachment use a version-checked
handshake:

1. authorize and normalize the query;
2. resolve current source bindings and dependency revisions;
3. register bounded interest tied to those revisions;
4. recheck bindings and revisions; and
5. deliver the snapshot only when the registration and evaluation agree.

If a mutation or source change races the handshake, the service retries or
delivers a later replacement. It cannot publish a snapshot and then silently
miss the intervening change.

A live query is invalidated by relevant value mutations, collection membership
changes, dynamic dependency changes, grant changes, and effective-source
lifecycle changes. Re-evaluation constructs and validates a replacement
dependency set before discarding obsolete interest where possible. Events from
a superseded binding are ignored even if they arrive late.

Delivery is current-state oriented:

- the initial message is a full result;
- every ready update is a full replacement result;
- intermediate results may be coalesced;
- duplicate delivery is allowed;
- the most recent committed result eventually replaces older results while the
  connection remains authorized and the service is healthy; and
- exhaustive replay of every mutation is not promised.

An implementation must durably repair the case where state commits and the
process stops before notification. Delivery failure never rolls back a state
mutation. With no subscribers, revisions continue to change, but query
evaluation and fanout may be skipped.

### SSE compatibility

SSE is the first intended browser delivery surface. It carries the
transport-neutral envelopes above. Each data event has an `id` containing an
opaque subscription cursor and an event type identifying snapshot, update, or
status. Heartbeat comments carry no state.

The cursor is scoped to one authorized subscription and orders its events.
`Last-Event-ID` may request bounded recovery, but the server may respond with
a fresh `resynchronized` snapshot when the cursor is unknown, expired,
belongs to an obsolete binding, or is outside retained history. It must
reauthorize and resolve the current source before replay or resynchronization.

A reconnect after linking, unlinking, or switching a default cannot replay an
archived source as current. Credential expiry or revocation ends data delivery
with a protocol status when possible and prevents a reconnect loop from
continuing unauthorized access.

The public query and result contracts are transport-neutral. Step 2 evaluates
direct SSE ownership and hibernating WebSocket alternatives for cost and
placement without changing query meaning.

## Errors and status codes

Protocol errors and non-ready result statuses use stable codes, safe messages,
and an appropriate HTTP or stream status. They never include storage keys,
SQL, credentials, physical realm identities, hidden state, or stack traces.
`query_transitioning`, `query_evaluation_unstable`, and
`query_source_unavailable` may accompany a non-ready result envelope after an
authorized subscription exists; structural and authorization codes reject the
query or terminate access.

Required first-version codes include:

| Code | Meaning |
| --- | --- |
| `query_document_invalid` | JSON shape, identifier, or unknown field is invalid |
| `query_version_unsupported` | The requested query version is unsupported |
| `query_target_invalid` | The platform group identity is invalid |
| `query_export_not_found` | An allowed discovery context cannot resolve the named export |
| `query_export_version_unsupported` | The named export does not support the pinned public schema version |
| `query_argument_invalid` | Argument names, literal type, or normalization is invalid |
| `query_reference_invalid` | A binding or projection cannot be resolved |
| `query_cycle` | Dynamic binding dependencies form a cycle |
| `query_type_mismatch` | A projected dynamic value cannot satisfy a parameter |
| `query_limit_exceeded` | A structural or encoded-size limit is exceeded |
| `query_collection_too_large` | A complete collection result exceeds its bound |
| `query_collection_incomplete` | Unidentified legacy subjects prevent an honest complete collection |
| `query_result_too_large` | Encoded ready data exceeds its bound |
| `query_access_denied` | The supplied grant does not authorize the complete query |
| `query_grant_expired` | The read grant has expired |
| `query_grant_revoked` | The read grant was revoked |
| `query_transitioning` | The effective source is in a retryable lifecycle transition |
| `query_evaluation_unstable` | Dependency revisions did not stabilize within the retry budget |
| `query_source_unavailable` | The current authorized source cannot be read |

Public unauthenticated behavior may deliberately map several existence-related
conditions to `query_access_denied`. Discovery for an already authorized
operator may return more specific catalog errors.

## Complete examples

The examples use the proposed deaths exports and omit grant transport. They
describe logical behavior, not currently available endpoints.

### 1. Direct local value

```json
{
  "version": 1,
  "target": { "platform": "twitch", "groupId": "141981764" },
  "bindings": {
    "remembered": {
      "read": { "feature": "fun.deaths", "export": "remembered_game", "version": 1 }
    }
  },
  "select": {
    "game": { "ref": "remembered" }
  }
}
```

If no moderator has selected a game, the ready result contains:

```json
{ "game": { "state": "unselected" } }
```

This read does not select a game.

### 2. Literal lookup and field projection

The query document shown in [Query document version 1](#query-document-version-1)
looks up `Dark Souls` and projects `game` and `count` from its record.
If no row exists, the export's default produces present count zero:

```json
{
  "game": { "state": "present", "value": "Dark Souls" },
  "deaths": { "state": "present", "value": 0 }
}
```

### 3. A user-composed three-game result

```json
{
  "version": 1,
  "target": { "platform": "twitch", "groupId": "141981764" },
  "bindings": {
    "dark_souls": {
      "read": { "feature": "fun.deaths", "export": "count", "version": 1 },
      "arguments": { "game": { "literal": "Dark Souls" } }
    },
    "sekiro": {
      "read": { "feature": "fun.deaths", "export": "count", "version": 1 },
      "arguments": { "game": { "literal": "Sekiro" } }
    },
    "celeste": {
      "read": { "feature": "fun.deaths", "export": "count", "version": 1 },
      "arguments": { "game": { "literal": "Celeste" } }
    }
  },
  "select": {
    "darkSouls": { "ref": "dark_souls", "path": ["count"] },
    "sekiro": { "ref": "sekiro", "path": ["count"] },
    "celeste": { "ref": "celeste", "path": ["count"] }
  }
}
```

This is user composition. The feature does not need to define a
“three-game scoreboard” query.

### 4. Complete materialized collection

```json
{
  "version": 1,
  "target": { "platform": "twitch", "groupId": "141981764" },
  "bindings": {
    "known": {
      "read": { "feature": "fun.deaths", "export": "counts", "version": 1 }
    }
  },
  "select": {
    "games": { "ref": "known" }
  }
}
```

An empty ledger returns a present empty array. A ledger above the declared
complete bound returns `query_collection_too_large`; it does not return an
apparently complete prefix.

### 5. Dynamic lookup from Discord local state

```json
{
  "version": 1,
  "target": { "platform": "discord", "groupId": "987654321012345678" },
  "bindings": {
    "remembered": {
      "read": { "feature": "fun.deaths", "export": "remembered_game", "version": 1 }
    },
    "current": {
      "read": { "feature": "fun.deaths", "export": "count", "version": 1 },
      "arguments": {
        "game": { "ref": "remembered" }
      }
    }
  },
  "select": {
    "game": { "ref": "remembered" },
    "deaths": { "ref": "current", "path": ["count"] }
  }
}
```

If the remembered game changes, the subscription attaches and validates the
new counter dependency before retiring the old one. If it is unselected,
`game` is `unselected` and `deaths` is `blocked`.

### 6. Standalone and shared lifecycle

Suppose the literal Twitch query for `Dark Souls` starts with standalone count
4. The Twitch channel then activates a default Discord integration whose
materialized shared count is 9. The subscription sends a `source_changed`
replacement with count 9 and a new binding revision. A later Discord command
that changes the same shared counter to 10 sends a normal value update to the
Twitch observer.

If the integration is revoked without a fallback, the observer reports the
transition and then follows the ready standalone successor copied from the
final shared state. Later Discord and Twitch changes diverge. If a fallback
integration exists, the observer instead reports a source change to that
integration's existing value.

### 7. Denied composed query

A grant permits exact `count` lookups for normalized game `sekiro`, but a
query binds both `Sekiro` and `Celeste`. The complete query fails with
`query_access_denied`. It does not return Sekiro while redacting Celeste.

A grant for `count` also does not permit `counts` enumeration unless that
collection export is separately granted.

## Decisions closed by this contract

1. Users compose bounded queries from declared exports; presets are optional.
2. JSON documents, not executable text expressions, are the version-1 format.
3. The target is one explicit platform group and follows that group's current
   effective state.
4. Public identities are logical and normalized; physical owners stay private.
5. Queries are read-only and separate from command execution.
6. Whole-query authorization avoids partial-result and dynamic-dependency leaks.
7. Collections are finite, deterministic, and complete or explicitly rejected.
8. Initial snapshots and watcher attachment use a version-checked handshake.
9. Full replacement results are the baseline; exhaustive mutation history is
   deferred.
10. Source changes are observable even when data is equal.
11. Reconnects may resynchronize with a current snapshot instead of replaying
    expired history.
12. The query contract is independent of SSE/WebSocket transport placement.

## Implementation handoff

Step 2 must validate transport placement, connection behavior, and resource
budgets against Cloudflare. Step 3 must choose additive Framework API v1 helper
spellings that normalize into the readable-export model above and resolve the
legacy deaths subject-metadata problem. Later steps must preserve the examples
and error distinctions in this contract.

Do not mark an API described here as implemented until its code, behavioral
coverage, documentation, and relevant CI checks exist.
