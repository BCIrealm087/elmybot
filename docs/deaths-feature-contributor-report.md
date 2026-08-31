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

## Follow-up: raw Twitch command tests

The third recommended improvement closes the remaining gap from step 8. The
test runtime now accepts the same bang-prefixed command text that a Twitch
chatter types:

```js
const result = await runtime.twitch.commandText(
  '!deaths "Dark Souls" plus',
  { actor: twitchTestModerator() }
);

result.toReply("Dark Souls deaths: 1");
```

This one call performs command-name detection, quoted-token parsing, action
schema validation, authorization, execution, state mutation, and response
rendering. The existing `runtime.twitch.command(name, input)` entry remains for
tests that intentionally begin with already parsed semantic arguments.

The production Twitch adapter and test runtime now share one internal
command-text extractor. This prevents the test helper from quietly developing
different rules for leading whitespace, command casing, or the boundary
between the name and its argument text. Non-command text and unknown command
names reject in the command-focused test API, making contributor typos visible;
the production chat adapter continues to ignore them as normal chat.

The `fun.deaths` package test was migrated from a direct assertion against
`feature.commands.twitch[0].parse.parse()` to the raw entry point. The test no
longer reaches into its command definition and now proves that quoted game
names work through the same public test surface as the rest of the feature.

**Assessment:** this is a meaningful improvement for hobby contributors. A
syntax-sensitive Twitch test now reads like the chat interaction it describes,
and authors no longer need to know where a parser is stored inside a feature
definition. Keeping both entry points is useful: semantic tests stay concise,
while one or two raw-text tests can cover the platform grammar without
duplicating every behavior case. The implementation complexity belongs to the
framework and platform adapter; the contributor-facing cost is one discoverable
method and one example.

### Raw-command verification record

The focused feature-test-kit, `fun.deaths`, and parser-helper run passed 3 files
and 26 tests. The complete local suite passed 21 files and 224 tests. ESLint,
the public feature-boundary check, workspace-package validation, generated
catalog freshness, and JavaScript syntax checks also passed.

GitHub Actions [run 33430856141](https://github.com/BCIrealm087/elmybot/actions/runs/33430856141)
completed successfully for implementation commit `33d8fa06`: the locked
install, all 224 tests, lint and generated-document checks, tracked-source
syntax checks, and the non-deploying Wrangler Worker dry run passed.

## Follow-up: a progressive contributor documentation path

The fourth recommended improvement changes where a hobby contributor begins,
not the framework behavior. The previous practical entry point was a 530-line
authoring guide whose opening immediately linked the 1,040-line normative
contract and the API stability policy. All of those documents were useful, but
their presentation made them feel like prerequisite reading for a small
command.

The new [`feature-quickstart.md`](feature-quickstart.md) is a self-contained
first-feature path. It covers five steps: scaffold, select an optional pattern,
install explicitly, test through the feature runtime, and run the contributor
checks. It deliberately contains no complete framework specification. A table
routes the author directly to one relevant cookbook when the feature needs
shared platforms, Twitch parsing, state, conditional access, native behavior,
routes, schedules, or events.

The old guide is now labeled the feature authoring reference and explicitly
says it is not meant to be read front to back. The root README points first to
the quickstart. The framework policy and contract send ordinary feature authors
back to it, while identifying themselves as compatibility and maintainer
references. Running the scaffold prints the quickstart path, and every newly
generated workspace README carries the same link, so the recommended next step
is visible at the moment a contributor needs it.

**Assessment:** this is substantially less cumbersome for a hobby programmer.
The first decision is now “does the generated Discord command already fit?”;
only a feature that answers no has to choose another document. The quickstart
still exposes the two manual installation edits—root `package.json` and
`src/features/index.js`—because hiding them would make the explicit-install
model harder to understand. At roughly 150 lines it is not a tiny checklist,
but it is less than one third of the detailed reference and contains the
complete normal path rather than sending the reader through architecture
history. The clearest remaining documentation decision is improvement 5:
explaining when platform state should stay independent and when an integration
should intentionally share it.

### Progressive-documentation verification record

The scaffold-template test passed 1 file and 4 tests, including coverage that a
new workspace README links to the first-feature quickstart. The complete local
suite passed 21 files and 224 tests. ESLint, the public feature-boundary check,
workspace-package validation, generated-catalog freshness, and tracked
JavaScript syntax checks also passed. The new quickstart's local document and
source targets, including every linked cookbook heading, were checked in the
working tree.

GitHub Actions [run 33435782839](https://github.com/BCIrealm087/elmybot/actions/runs/33435782839)
completed successfully for implementation commit `97b478cd`: the locked
install, all 224 tests, lint and generated-document checks, tracked-source
syntax checks, and the non-deploying Wrangler Worker dry run passed.

## Follow-up: choosing local or shared state

The fifth recommended improvement makes the state ownership decision explicit.
Framework state has always been namespaced by feature ID and origin group, but
“one shared action on Discord and Twitch” and “linked Discord and Twitch groups”
could both sound as though they implied shared storage. They do not. The same
action invoked in a Discord guild and a Twitch channel receives two independent
`ctx.state` namespaces, and creating an integration does not merge them.

The state guide now begins with a three-way decision table:

- data owned independently by each group uses `ctx.state` or `ctx.config`;
- local data that causes cross-platform delivery stays local and uses routes
  and effects; and
- one authoritative value mutated by both linked groups belongs to the
  integration relationship.

The third case is intentionally not presented as a ready-to-use API. Framework
API v1 has no `ctx.integration.state`; the existing integration coordinator owns
execution and effect-delivery records rather than arbitrary feature data. The
guidance asks authors to define multi-link selection, unlink/relink lifecycle,
cross-platform authorization, unlinked behavior, atomicity, and retry
idempotency before proposing an integration-scoped service or purpose-built
action. It also warns against embedding integration IDs in local keys or using
routed effects to maintain two supposedly authoritative copies.

The quickstart exposes the choice as two separate rows—group-local memory and
one value shared by linked groups—before the contributor writes code. The
stateful cookbook, integration guide, API policy, normative contract, and design
record now repeat the same boundary at the level appropriate to their audience.

**Assessment:** the ordinary hobby-contributor path is now clear and easy:
“works on both platforms” defaults to independent per-group data, as the
`fun.deaths` feature already does. A genuinely shared scoreboard or economy is
still framework-maintainer work, which is less convenient but honest. Presenting
an unsafe shortcut would hide the hardest product questions and produce
ambiguous behavior as soon as a group has multiple links or an integration is
revoked. The documentation now tells contributors exactly when they can proceed
alone and what design answers they need when they cannot.

This completes all five framework and contributor-experience improvements
identified by the original `fun.deaths` exercise.

### State-ownership guidance verification record

The complete local suite passed 21 files and 224 tests. ESLint, the public
feature-boundary check, workspace-package validation, generated-catalog
freshness, and tracked JavaScript syntax checks also passed. The state-boundary
heading and every new quickstart, cookbook, and integration-guide link to it
were checked directly in the working tree.

GitHub Actions [run 33440277418](https://github.com/BCIrealm087/elmybot/actions/runs/33440277418)
completed successfully for implementation commit `857ff664`: the locked
install, all 224 tests, lint and generated-document checks, tracked-source
syntax checks, and the non-deploying Wrangler Worker dry run passed.

## Default-link work: step 1 directional foundation

Before redesigning `fun.deaths`, the integration registry gained the durable
identity needed to choose one relationship in a many-link group. A default is a
directional edge keyed by source group and target platform, with the selected
integration and target group stored as its value. Discord-to-Twitch and
Twitch-to-Discord defaults are therefore independent even when they initially
refer to the same two-member integration.

The existing `IntegrationRegistry` SQLite initializer creates the additive
table in deployed objects, so no new Durable Object class or Wrangler migration
tag is required. The target group is stored explicitly to avoid assuming that
every future integration contains only one member per platform.

The internal registry operation validates both memberships, requires an active
cross-platform integration, and inserts only when the directional key is
absent. Tests prove that both directions coexist, a later Twitch link cannot
steal a Discord guild's existing default, and same-platform or non-member
targets fail before storage.

**Assessment:** appropriate foundation work, but intentionally not useful to a
feature contributor yet. Keeping automatic assignment and management out of
this step makes the invariant easy to review: one storage key identifies one
direction, and first-writer behavior preserves an established choice. The next
step can call this primitive during link activation without deciding management
UX or revocation fallback at the same time.

### Directional-default verification record

The focused registry run passed 1 file and 13 tests. Its first draft exposed a
test-isolation mistake: the singleton Durable Object retained rows created by
earlier cases, while an assertion counted the entire table. Scoping that
assertion to the source group under test fixed the test without changing the
runtime implementation.

The complete local suite passed 21 files and 227 tests. ESLint, the public
feature-boundary check, workspace-package validation, generated-catalog
freshness, tracked JavaScript syntax checks, and the whitespace/error-marker
check also passed. The deployment-specific Wrangler dry run remains for GitHub
Actions because the Work Mode environment does not provide its deployment
credentials.
