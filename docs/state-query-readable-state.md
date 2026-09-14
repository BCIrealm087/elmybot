# Readable state declarations and subject metadata

Status: readable declarations and metadata implemented by roadmap step 3;
read-only resolver execution implemented by step 4 on 2026-09-12; public grants,
HTTP/SSE access, and the deaths contributor proof completed through step 10.

## What this step adds

Features can now opt state into the query model with
`defineReadableStateExport()`. The declarations are registered through the
stable framework entry points, normalized and frozen at startup, and exposed as
a value-free discovery catalog on the internal feature registry.

Omitting `readableState` produces a frozen empty array. Existing features and
commands therefore retain their behavior and do not become readable by default.
Every declaration uses `access: { kind: "operator_grant" }`; declaration makes
an export eligible for a future grant, not public. Step 5 implements grants and
authorized HTTP discovery.

The installed deaths feature declares:

| Export | Kind | Ownership | Meaning |
| --- | --- | --- | --- |
| `remembered_game` v1 | value | `group_local` | The selected Discord-guild or Twitch-channel game; unselected when absent |
| `count` v1 | lookup | `effective_shareable` | One normalized game's standalone or currently selected shared count, defaulting to zero |
| `counts` v1 | collection | `effective_shareable` | Materialized counters whose subjects have known metadata, with explicit legacy coverage |

These declarations do not add public routes or read credentials. Their resolver
functions run only through the internal, controlled read-only evaluator added
in step 4.

## Contributor declaration

```js
import {
  defineFeature,
  defineReadableStateExport,
  frameworkApiVersion
} from "@elmybot/framework";

const normalizeGame = (game) => {
  const label = game.trim().replace(/\s+/g, " ");
  return {
    value: label.normalize("NFKC").toLowerCase(),
    label
  };
};

export default defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.example",
  description: "Example readable state.",
  shareableState: [{
    id: "game_scores",
    label: "Game scores",
    schemaVersion: 1
  }],
  readableState: [
    defineReadableStateExport({
      id: "score",
      version: 1,
      label: "Game score",
      description: "The score for one normalized game.",
      kind: "lookup",
      platforms: ["discord", "twitch"],
      scope: {
        kind: "effective_shareable",
        namespace: "game_scores"
      },
      access: { kind: "operator_grant" },
      parameters: {
        game: {
          label: "Game",
          schema: { type: "string", minLength: 1, maxLength: 80 },
          normalize: normalizeGame
        }
      },
      result: {
        schema: { type: "integer", minimum: 0 },
        absence: { kind: "default" }
      },
      async resolve(ctx, { game }) {
        const count = await ctx.state.boundedCounter("game", game);
        return { state: "present", value: count };
      }
    })
  ]
});
```

An export ID matches `^[a-z][a-z0-9_-]{0,63}$`; identity is the feature ID,
export ID, and positive public schema version. A feature may declare at most 50
versioned exports and may not repeat an ID/version pair. Labels are 1–80
characters and descriptions are 1–200 characters after trimming.

`kind` is `value`, `lookup`, or `collection`. Version 1 lookups have 1–10
required, labeled scalar parameters. Values and collections have none. Supported scalar
parameter types are string, boolean, finite number, and safe integer, optionally
nullable and bounded. Result schemas additionally support closed objects and
bounded arrays. Schema nesting is at most ten levels, objects have at most 20
declared fields, and arrays have at most 100 items.

`scope.kind` is `group_local` or `effective_shareable`. An effective-shareable
declaration names one namespace declared by the same feature; registry creation
fails if it does not. The public catalog returns the logical scope but not the
namespace, storage key, integration, realm, normalizer function, or internal
operator-grant eligibility rule. Resolver functions are also omitted.

`result.absence.kind` is `absent`, `unselected`, or `default`. It declares the result
cell behavior selected in step 1. Concrete value construction belongs to the
resolver and its schema check belongs to the step 4 evaluator. Collections additionally normalize to the
first-release policy:

- membership is materialized entries;
- ordering is canonical subject identity; and
- legacy coverage is reported explicitly.

No collection is silently presented as complete when unidentified rows exist.

## Logical references and normalization

The internal catalog foundation resolves a logical reference shaped like:

```json
{
  "target": { "platform": "twitch", "groupId": "141981764" },
  "read": { "feature": "fun.deaths", "export": "count", "version": 1 },
  "arguments": { "game": "Dark Souls" }
}
```

It validates the installed export, target platform, exact argument set, and raw
parameter schemas. Feature normalization then produces the canonical reference.
For deaths, `"  DARK   Souls  "` and `"dark souls"` both produce canonical
argument `"dark souls"`.

A string normalizer may return the canonical string directly or
`{ value, label }`. The latter records a bounded display label separately from
identity. Both the raw and normalized values must satisfy the declared schema.
The canonical logical reference contains only `value`; labels never affect
query or counter identity.

## Counter subject metadata

Bounded counters continue to derive their existing storage key from
`[counterName, subjectIdentity]`. Step 3 does not change that derivation or move
existing values. The counter handle accepts an additive option:

```js
const subject = normalizeGame(inputGame);
const counter = state.boundedCounter("game", subject.value, {
  subjectLabel: subject.label
});
```

On a mutation that materializes or already addresses a materialized counter,
the storage owner transactionally records:

- feature and shareable namespace where applicable;
- counter name;
- canonical subject identity;
- first recorded display label; and
- the already-derived hashed value key.

The first recorded label is stable; later spelling or capitalization does not
silently rename it. A reset of a shareable bounded counter removes both its
materialized value and subject metadata. Reads of an absent default do not
materialize either. Metadata conflicts fail rather than alias two identities to
one value key.

The new SQLite tables are created with `CREATE TABLE IF NOT EXISTS`. Existing
Durable Object classes and bindings do not change. Shareable realm storage
schema version 4 records the additive layout and upgrades the internal version
marker on first use.

## Snapshot and lifecycle behavior

Shareable snapshots may now carry an optional, bounded `counterSubjects` array.
It is included in the fingerprint when nonempty and omitted when empty, so
pre-step-3 version-1 snapshots retain their existing fingerprints and remain
valid. Snapshot validation requires each subject to reference an included value
key and rejects duplicate identities or keys.

Cloning a snapshot writes values and their subject metadata in the same target
transaction. Consequently the existing lifecycle mechanisms carry metadata
through standalone-to-integration materialization, linking, freezing on
revocation, standalone-successor cloning, fallback selection, and later
relinking. Snapshot equality also covers subject metadata through the fingerprint.

The compatibility-only legacy integration-state adoption includes any metadata
already known by its source. Historical deployments normally have none, so
their count values are adopted unchanged and remain available through exact
game lookup.

## Legacy coverage and reconciliation

An old hashed counter row cannot reveal its original game name. Step 3 never
guesses it, deletes it, resets it, or manufactures a misleading label.

Counter-subject enumeration returns known subjects plus:

```json
{
  "complete": false,
  "identifiedCount": 2,
  "unidentifiedCount": 1
}
```

`unidentifiedCount` counts counter-shaped value rows in the feature namespace
that have no metadata. Because an old hash also cannot reveal which counter
name produced it, this is deliberately namespace-level conservative evidence.
The `counts` export must surface incomplete coverage rather than claim its known
items are the entire historical collection.

When a later authorized mutation addresses an old row using its canonical
subject and supplies `subjectLabel`, metadata is attached without changing the
count. That row then becomes an identified collection member. Exact lookups use
the unchanged hash derivation and work before and after reconciliation.

An automated reverse migration is impossible. A future operator reconciliation
tool may attach a verified label to a known hash, but it must be an explicit,
audited operation and is not part of step 3.

## Implemented and deferred boundary

Implemented now:

- optional validated and frozen declarations through public Framework API v1;
- registry startup checks and a safe value-free catalog model;
- canonical logical-reference and parameter normalization;
- the three deaths export declarations;
- transactional bounded-counter subject metadata and conservative enumeration;
- snapshot fingerprinting, validation, cloning, and legacy-adoption support; and
- behavioral coverage for declarations, references, known/unknown subjects,
  reset, and snapshot cloning.

Step 4 additionally binds each declaration to a scope-limited `resolve`
function. See [`state-query-evaluator.md`](state-query-evaluator.md).

The remaining contributor-facing proof and test workflow is recorded in
[`state-query-deaths-proof.md`](state-query-deaths-proof.md). Grants, authorized
discovery, snapshots, revisions, lifecycle-aware observation, and SSE were
implemented by roadmap steps 5–9.
