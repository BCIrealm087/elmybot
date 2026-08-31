# `fun.deaths` contributor-experience report

## Purpose and perspective

This report records the implementation of a shared `deaths` command from the
perspective of a hobby programmer contributing a self-contained feature to
Elmybot. It records the canonical steps in the order they were performed and
assesses how approachable each step felt.

The requested behavior is:

- anyone can display the stored deaths for a named game;
- moderators can add one, subtract one, or reset that game's count;
- the command is available on Discord and Twitch; and
- multi-word game names are supported.

Counts use the framework's existing origin-group namespace. A Discord server
and a Twitch channel therefore have independent counts even if an Elmybot
integration links them. Cross-platform synchronization was not requested and
is not implied by “works on both platforms.”

## Step-by-step record

### 1. Confirm the branch and repository rules

The work began on `codex-feature-experiment`, as required by `AGENTS.md`. The
CI workflow and contributor guardrails already named that branch.

**Assessment:** appropriate and easy. The branch restriction is prominent and
unambiguous.

### 2. Find and read the canonical contributor path

The practical entry point was `docs/feature-authoring.md`, followed by
`docs/framework-api.md`, `docs/feature-state.md`, the normative framework
contract, and the installed `counter` example. These correctly suggested a
shared action, Discord and Twitch adapters, and namespaced state.

**Assessment:** the practical guide is strong, especially its “smallest useful
feature shape” table and stateful cookbook. The total reading surface is large,
though: a hobby contributor must distinguish the practical guide, design
history, normative contract, API-stability policy, state guide, and generated
catalog. Starting is easy; becoming confident that no rule was missed is more
cumbersome than the feature itself.

### 3. Generate the recommended workspace package

The documented command was run unchanged:

```sh
npm run feature:new -- fun-deaths --workspace
```

It produced the package manifest, README, feature module, and focused test in
the documented locations without overwriting anything.

**Assessment:** excellent. This was the clearest and most reassuring part of
the process. The scaffold output also stated the remaining installation steps.

### 4. Model the shared behavior and storage

The feature maps one Discord command and one Twitch command to one semantic
action. In the initial implementation, each normalized game name mapped to a
hand-derived state key. Atomic increment handled `plus`; `reset` used `set`;
and `minus` used an atomic decrement followed by a compensating increment if it
crossed below zero.

**Assessment:** mostly appropriate. The state API makes the ordinary read,
increment, and reset cases pleasantly small and keeps persistence internals out
of the feature. Deriving a safe key from arbitrary game text is left entirely
to the contributor, and enforcing a non-negative decrement requires knowledge
that API v1 has no transaction or compare-and-set operation. That part was
moderately cumbersome and identified a bounded-counter helper as the most
valuable next framework improvement. The follow-up below implements that
recommendation.

### 5. Resolve mixed public/moderator authorization

The requested command is public when no operation is supplied but protected
when `plus`, `minus`, or `reset` is supplied. The existing API attached one
capability to the whole action, so it could make every mode public or every
mode moderator-only, but could not express the requested split. Inspecting
Discord roles or Twitch badges inside the feature would violate the framework
boundary and would not work consistently.

A narrow backward-compatible API-v1 service was therefore added:

```js
uses: { services: ["authorization", "state"] }

await ctx.authorization.allows(access.moderators)
```

The service delegates to the existing platform-owned authorization policy. It
does not expose roles, badges, credentials, or a feature-defined authorizer.

**Assessment:** this was too hard for an ordinary feature contribution. The
framework's original all-or-nothing action capability is a good safe default,
but mixed read/write commands are common for counters. Requiring a framework
addition would likely stop a hobby programmer or push them toward an unsafe
workaround. With the new controlled service, the feature code is clear, but
conditional authorization should now be highlighted in the authoring guide.

### 6. Preserve multi-word Twitch game names

Discord supplies the game and optional operation as separate options. The
existing Twitch token parser split on every whitespace character, so it could
only accept a one-word game before the optional operation. The existing parser
was broadened compatibly to recognize quoted tokens. Twitch users can now type:

```text
!deaths "Dark Souls" plus
```

Existing unquoted token syntax is unchanged, and unterminated quotes produce a
bounded validation error.

**Assessment:** the fixed parser helpers are easy for simple commands but too
rigid once one argument contains spaces and another follows it. Quoted token
support is intuitive and reusable, but needing to modify framework parsing for
such a routine command was moderately cumbersome. The quote behavior should be
documented next to `twitchTokens()` and covered by its contract tests.

### 7. Implement and explicitly install the feature

The scaffold TODOs were replaced with the shared action and two platform
adapters. The package was added at its exact version to root dependencies and
its default export was added once to `installedFeatures`.

**Assessment:** appropriate. Explicit installation is a small amount of manual
work and makes bundling and review easy to understand. The need to update both
`package.json` and `src/features/index.js` is acceptable because the workspace
checker is designed to catch drift.

### 8. Add focused behavioral tests

The package test uses `createFeatureTestRuntime()` with member and moderator
actors on both platforms. It covers public reads, every moderator operation,
denied member mutation, game/group isolation, normalization, quoted Twitch
input, validation, and the zero floor.

**Assessment:** very good. The test runtime is the most contributor-friendly
part after the scaffold. It tests real feature composition and authorization
without requiring Discord, Twitch, or Durable Object setup. A minor surprise is
that runtime command calls accept already parsed semantic arguments, so parser
behavior needs a separate direct assertion.

### 9. Install, generate documentation, and verify

The package was linked with `npm install`, which updated the lockfile. The
focused command covered the package, framework helpers, framework composition,
and both platform suites. Its first run found one fixture omission: the isolated
unit-test registry did not list `authorization` as an available service. After
fixing that test setup, the focused result was 5 files and 135 tests passed.

`npm run feature:workspaces` passed. `npm run feature:docs` regenerated the
installed catalog, and `npm run lint` passed ESLint, the feature API boundary,
workspace validation, and catalog freshness.

The first full-suite run found one expected migration-contract update: a test
still expected the installed service list to contain only `config`, `random`,
and `state`. Updating it to include the new documented `authorization` service
resolved the failure. A final clean installation with `npm ci` succeeded, then:

- `npm test -- --run`: 21 files and 220 tests passed;
- `npm run lint`: passed all four constituent checks; and
- syntax checking every `.js` and `.mjs` file with `node --check`: passed.

The local Work mode limitation documented in `AGENTS.md` means the Wrangler
dry run was deliberately left to CI rather than repeatedly attempting a command
that the environment blocks before execution. GitHub Actions
[run #89](https://github.com/BCIrealm087/elmybot/actions/runs/33356035051)
completed successfully for implementation commit `2c507356`: locked install,
all tests, lint, tracked-source syntax checks, and the non-deploying Wrangler
dry run passed.

**Assessment:** good overall. The commands are clear and fast, and the full
suite caught precisely the one cross-cutting expectation affected by adding a
service. Running overlapping focused, workspace, lint, syntax, full-suite, and
CI checks is somewhat repetitive, but each has a distinct documented purpose.
The warning about proxy environment variables was environmental and did not
affect any result.

## Conclusion

The canonical pipeline is genuinely pleasant for a conventional shared
stateful command: scaffold, declare one action, attach two adapters, test in
memory, install explicitly, and generate the catalog. This feature also exposed
two realistic edges—conditional authorization and multi-word Twitch token
arguments—that were disproportionately difficult. The implementation keeps
those fixes in the framework boundary rather than leaking platform knowledge
into feature code, but the need for framework changes means the original
pipeline was not yet sufficient for this otherwise ordinary hobby feature.

After the two reusable framework gaps were addressed, the final feature itself
remained small, platform-neutral, and isolated in its generated workspace
package. That is a positive result for the architecture, but also a useful
warning: the ease of the happy-path scaffold can conceal substantial framework
work when a command combines conditional permissions or richer Twitch text
parsing.

## Follow-up: bounded counters

The first recommended improvement was implemented as an additive Framework API
v1 method:

```js
const deaths = ctx.state.boundedCounter("game", normalizedGameName);

await deaths.get();
await deaths.increment();
await deaths.decrement();
await deaths.reset();
```

The contributor now chooses only a stable counter name and the feature-domain
identity of the subject. The framework accepts punctuation and Unicode, hashes
the name/subject pair into a collision-resistant private key, applies inclusive
safe-integer bounds, and performs each saturating mutation in one SQLite
transaction. The default floor and initial value are zero.

The `fun.deaths` feature was migrated to this API. Its slugging, hashing,
invalid-value repair, and decrement compensation code disappeared; the command
action now reads almost exactly like its product requirements. A direct Durable
Object test starts at three, performs ten concurrent decrements, and verifies
that the stored result is zero. Separate contract coverage checks custom bounds,
reset behavior, Unicode subjects, subject isolation, and author-facing input
validation.

**Assessment:** this materially improves the hobby-contributor path. A common
per-name counter no longer requires storage-key design or concurrency reasoning,
and safe behavior is the default. Authors still need to decide whether names
such as `Dark Souls` and `dark souls` represent the same subject, which is a
legitimate feature-domain choice rather than framework plumbing. The helper is
slightly more specialized than raw state, but the four-method handle is small
enough to learn from one example and preserves the lower-level API for other
state shapes.

### Follow-up verification record

A clean locked dependency installation completed with `npm ci`. The focused
framework, Durable Object, and feature run passed 3 files and 31 tests. After
the documentation and contract updates, the final local checks passed:

- `npm test -- --run`: 21 files and 222 tests;
- `npm run lint`: ESLint, public-boundary, workspace, and generated-catalog
  checks; and
- `node --check` for every tracked JavaScript and MJS source file.

GitHub Actions [run #91](https://github.com/BCIrealm087/elmybot/actions/runs/33361176761)
completed successfully for implementation commit `6696131c`: the locked
install, complete test suite, lint, tracked-source syntax checks, and
non-deploying Wrangler Worker dry run all passed.

**Assessment:** adding the helper itself touches context, production storage,
the in-memory test runtime, and the normative API documentation, so this is
framework-maintainer work rather than an ordinary hobby feature change. That
complexity is paid once: a future command author uses one handle and can verify
it entirely through the ordinary feature test runtime.

## Follow-up: conditional-access metadata

The second recommended improvement addresses a documentation mismatch. The
action's baseline `capability` is `null` because anyone may show a count, so the
generated catalog previously labeled `/deaths`, `!deaths`, and the shared
action simply as `public`. That omitted the moderator requirement for `plus`,
`minus`, and `reset`.

Framework API v1 now accepts optional structured action metadata:

```js
conditionalAccess: [
  {
    capability: access.moderators,
    when: {
      argument: "operation",
      values: ["plus", "minus", "reset"]
    }
  }
]
```

The framework verifies that `operation` is a primitive action input, that every
listed value is accepted by its schema, that the capability is registered, and
that the action declared the `authorization` service. The frozen metadata is
owned once by the shared action and inherited by both platform commands. The
catalog's column is now named `Access` and renders the result as `public;
framework.moderators when operation is plus, minus, or reset`.

The declaration is deliberately descriptive rather than executable. The
existing `ctx.authorization.allows(access.moderators)` check remains the source
of runtime enforcement and preserves the command's tailored denial message.
This avoids introducing a second authorization engine, but it means review must
still confirm that the declared rule and the explicit check express the same
condition.

**Assessment:** appropriate and reasonably easy for a hobby contributor. The
extra rule is repetitive next to the runtime `if`, but it uses ordinary action
argument names and values rather than platform roles or badges. Schema-aware
validation catches the most likely documentation mistakes—typos and impossible
values—before startup. The remaining possibility of semantic drift is an honest
tradeoff for metadata-only scope; declarative runtime enforcement could be a
later design, but would need a careful decision about custom denial responses.

### Conditional-access verification record

After a clean `npm ci`, the focused framework, catalog, and `fun.deaths` run
passed 3 files and 28 tests. The complete local suite passed 21 files and 223
tests. Lint also confirmed the feature API boundary, workspace package
consistency, and generated-catalog freshness; every tracked JavaScript and MJS
file passed `node --check`.

The final local test process also printed a background Workerd DNS lookup
warning for `id.twitch.tv` after reporting all 223 tests passed. No assertion or
test file failed; the clean GitHub Actions run remains the authoritative check
for this environment-sensitive noise.

GitHub Actions [run #93](https://github.com/BCIrealm087/elmybot/actions/runs/33399732786)
completed successfully for implementation commit `a5326804`: locked install,
all 223 tests, lint and generated-document checks, tracked-source syntax checks,
and the non-deploying Wrangler Worker dry run passed.

**Assessment:** the generated-document check is especially valuable here. It
turns the catalog's access wording into reviewed output rather than relying only
on unit-level metadata assertions. The validation tests additionally confirm
that a missing authorization-service declaration, unknown argument, impossible
enum value, or unregistered capability is rejected before installation.
