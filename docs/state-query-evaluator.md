# Read-only composable state-query evaluator

Status: implemented foundation for state-querying roadmap step 4 on 2026-09-12.
Read grants, public HTTP access, notifications, lifecycle observation, and SSE
remain later roadmap steps.

## Implemented boundary

The internal state-querying entry point now accepts the version-1 query document
specified in [`state-query-contract.md`](state-query-contract.md). It validates
and normalizes the complete document before opening any state source, then
returns a transport-neutral ready, transitioning, or unavailable envelope.

The evaluator supports:

1. direct readable values;
2. typed literal lookups;
3. named combinations and declared-object field projection;
4. complete materialized collections; and
5. lookup parameters supplied by another readable binding.

Queries remain user-composed. A feature does not define a special query for a
three-game overlay or a current-game widget. Presets may later expand into the
same document format.

This module is not an HTTP route and performs no authorization by itself. Step
5 must authorize the whole normalized query before calling it and expose only
the public envelope. The evaluator's observation plan is internal infrastructure
for later notification and subscription work.

## Validation and canonicalization

Preparation enforces the contract's 16 KiB document limit, 20 bindings, 20
selected fields, 10 arguments per binding, 40 dynamic edges, dependency depth
8, projection depth 10, three collection bindings, and 64 KiB ready-result
limit. Unknown fields, missing arguments, undeclared projections, cycles,
unsupported export versions, and statically incompatible dynamic parameters
fail with stable `query_*` codes.

Literal arguments use their readable export's domain normalizer before the
query is accepted. Canonical JSON recursively sorts object keys, and SHA-256
over that UTF-8 representation produces the unpadded base64url query digest.
Equivalent deaths spellings such as `" DARK   Souls "` and `"dark souls"`
therefore have the same normalized document and digest.

Dynamic values are projected and normalized at evaluation time. An absent or
unselected source produces a `blocked` destination cell; it does not turn into
a literal null or a default game.

## Feature resolver contract

`defineReadableStateExport()` now requires a `resolve(ctx, arguments)` function.
The function receives canonical arguments and a frozen, scope-bound context:

```js
async resolve(ctx, { game }) {
  const count = await ctx.state.boundedCounter("game", game, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  return {
    state: "present",
    value: { game, count }
  };
}
```

The context exposes only read operations for the declaration's feature and
selected ownership scope:

- `state.get(key)` returns `{ found: false }` or `{ found: true, value }`, so a
  stored JSON null remains distinct from absence;
- `state.boundedCounter(name, subject, options)` reads its existing/default
  value without materializing it; and
- `state.boundedCounterSubjects(name)` reads known materialized members and
  explicit legacy coverage.

There is no `set`, `delete`, `increment`, reset, configuration, link,
integration, realm, credential, SQL, binding, or effect access. Resolver output
must be a `present`, `absent`, or `unselected` cell consistent with the
declaration and result schema. Query evaluation never calls an action, claims a
cooldown, changes a remembered game, or emits an effect.

## Ownership, dependencies, and consistency

Group-local declarations resolve against the selected Discord guild or Twitch
channel. Effective-shareable declarations derive the counterpart platform and
resolve the target group's currently selected standalone or integration realm.
Clients never submit a realm or integration ID.

Each resolver read records an exact internal value, bounded-counter, or
collection-membership dependency. Equivalent reads against the same physical
source, export version, and normalized arguments are evaluated once per attempt.
The returned observation plan retains these dependencies for steps 6–9 but is
not part of the future public response.

Local feature-state namespaces now have an idempotently created mutation-version
row. Shareable namespaces reuse their existing mutation version. An attempt
captures every used source's revision before its reads and checks it again after
all bindings finish. A changed revision retries the complete query up to three
times by default; exhaustion returns `query_evaluation_unstable`. This validates
a converged observation but does not claim a transaction across owners.

The ready envelope contains opaque query, binding, and result digests. At this
snapshot stage the binding value fingerprints the currently resolved source
set. Step 7 supplies the durable handoff revision needed for live A-to-B-to-A
ordering and source-change delivery.

## Deaths proof

The deaths resolvers implement all three step-3 declarations:

- `remembered_game` reads local `last_game` and returns `unselected` when absent;
- `count` reads the effective shareable counter by canonical game identity and
  returns zero when no row exists; and
- `counts` returns known materialized subjects in canonical-identity order.

Known subject labels are used for display. An exact lookup of a historical
counter still succeeds when its label is unknown. A complete collection cannot
be honestly produced while unidentified hashed rows remain, so `counts` fails
with `query_collection_incomplete` instead of returning a misleading prefix.
Later authorized mutations can attach metadata without changing the count.

Tests cover literal normalization, direct and dynamic reads, named projection,
read deduplication, collection membership, blocked dependencies, legacy exact
lookup, incomplete collections, cycles, type errors, limits, retry recovery,
retry exhaustion, and a real Durable Object-backed deaths query whose local and
shareable revisions remain unchanged.
