# Contributor framework API stability

## Status

**Framework API v1 is stable as of 2026-08-30.**

This policy covers the JavaScript API used by reviewed feature modules bundled
with Elmybot. It does not make runtime-loaded third-party code safe, and it does
not turn Worker internals into supported extension points.

## Supported entry points

Production feature modules import only from:

```js
import {
  defineFeature,
  frameworkApiVersion
} from "../../framework/index.js";
```

Private workspace feature packages use the package facade instead:

```js
import {
  defineFeature,
  frameworkApiVersion
} from "@elmybot/framework";
```

Both entries expose the same API v1 objects. The workspace package version uses
the framework API as its major version (`@elmybot/framework@1.x` implements API
v1). In this first stage the package is private and delegates to the Worker's
existing implementation; it is not yet an independently publishable artifact.

`src/framework/index.js` is the stable runtime-authoring boundary. Its v1
surface consists of:

- manifest and version helpers: `defineFeature`, `isFeatureDefinition`,
  `frameworkApiVersion`, `supportedFrameworkApiVersions`, and
  `FeatureDefinitionError`;
- action and routing helpers: `defineAction`, `defineRoute`,
  `defineEventAction`, and `defineScheduledAction`;
- validation and access helpers: `schema`, `SchemaValidationError`, `access`,
  and `FRAMEWORK_CAPABILITIES`;
- Discord authoring helpers: `discordActionCommand`, `discordNativeCommand`,
  `discordOption`, `discordScheduledActionCommand`, and `discordTextResult`;
  and
- Twitch authoring helpers: `twitchActionCommand`, `twitchNativeCommand`,
  `twitchNoArgs`, `twitchRestText`, `twitchTokens`, and `twitchTextResult`.

Actions may explicitly request the controlled `authorization`, `config`,
`state`, and `random` context services. `authorization` delegates conditional
checks to the same platform-owned capability policy used for whole actions; it
does not expose platform roles, badges, or authorizer functions.
The `state` service includes the additive `boundedCounter(name, subject,
options)` API. It safely derives storage keys for arbitrary subjects and makes
each saturating read, increment, decrement, or reset one atomic operation.

`FEATURE_FRAMEWORK_API_VERSION` remains as a deprecated compatibility alias for
`frameworkApiVersion`. It is not used by new examples or generated features.

Feature tests may additionally import the documented test kit from
`src/framework/testing.js`. The test kit follows the v1 feature contract but is
not a production feature dependency. Workspace tests use the equivalent
`@elmybot/framework/testing` export.

All other modules below `src/framework/` are implementation details. In
particular, `internal.js`, registry composition, service runtimes, storage
clients, definition brands, adapter descriptors, and catalog tooling carry no
compatibility guarantee for feature authors.

## Manifest compatibility

Every feature binds itself to the contract it was authored against:

```js
export default defineFeature({
  apiVersion: frameworkApiVersion,
  id: "fun.example",
  description: "An example feature."
});
```

Composition never guesses how to execute an incompatible feature.
`defineFeature()` rejects an unsupported version with
`code: "unsupported_framework_api_version"` and reports the received and
supported versions in `error.details`.

The framework API version and semantic kind versions solve different problems:

- `apiVersion` versions JavaScript authoring shapes and execution semantics.
- `.vN` suffixes version persisted actions, routes, events, effects, and
  schedules.

A framework refactor that preserves the public contract changes neither. A
breaking JavaScript API change requires a new framework API version. A breaking
persisted semantic change requires a new `.vN` kind even if the framework API
does not change.

## Compatibility rules

The following are backward-compatible within v1:

- adding a new exported helper without changing existing exports;
- adding an optional manifest or helper option with a stable default;
- adding a new explicitly requested context service, schema helper, platform
  adapter, or effect factory;
- adding a method to an existing frozen context service without changing its
  existing methods;
- accepting additional input that existing definitions previously rejected;
  and
- improving error text while preserving documented error codes and fields.

The following require a new framework API version:

- removing or renaming an export, field, method, or accepted option;
- changing callback arguments, return shapes, authorization timing, or method
  semantics;
- making an optional field required;
- newly rejecting a previously valid definition; or
- weakening the isolation between feature code and credentials, persistence,
  Worker bindings, or delivery infrastructure.

Bug fixes that restore documented v1 behavior are compatible even when code
had accidentally relied on the bug.

## Deprecation policy

1. A deprecation must name its replacement, be recorded below, and be marked in
   code and contributor documentation.
2. A deprecated v1 API remains functional for the rest of v1. Deprecation alone
   does not permit its removal.
3. Removal requires a new framework API version, a migration note, updated
   scaffolds and examples, and confirmation that no installed feature uses the
   deprecated API.
4. Supported API versions may coexist for a bounded migration, but each feature
   is composed against exactly one declared version. There is no best-effort
   fallback.
5. Persisted semantic kinds follow the stricter drain rules in
   `command-feature-framework-contract.md`; an API deprecation never authorizes
   deleting a kind still referenced by jobs, inbox entries, executions, or dead
   letters.

### Current deprecations

| API | Replacement | Deprecated | Earliest removal |
| --- | --- | --- | --- |
| `FEATURE_FRAMEWORK_API_VERSION` | `frameworkApiVersion` | 2026-08-30 | Framework API v2 |

## Enforced isolation

Feature modules may import local feature code, other explicitly installed
feature modules, and the public framework entry. ESLint rejects relative imports
from feature modules into any other `src/` area, including:

- Durable Object and SQL storage implementations;
- integration registries and coordinators;
- Discord or Twitch authentication and delivery adapters;
- Worker bindings and platform request handlers; and
- framework registry, service-runtime, or adapter internals.

Workspace feature source is stricter: relative imports must stay inside its own
package, and framework imports must use exactly `@elmybot/framework`.
`@elmybot/framework/testing` is available only to package tests. Package
manifests are also checked for API-major peer compatibility and matching feature
metadata before CI accepts them.

This rule is intentionally mechanical so an internal dependency cannot enter a
feature merely because review missed it. Native features still receive narrow,
documented operations through their controlled execution context.

## Change checklist

Before changing the contributor API:

1. classify the change as compatible, deprecated, or breaking;
2. update the exact public-export contract test;
3. update this policy, the normative framework contract, scaffold, examples,
   and generated documentation where applicable;
4. add compatibility tests for old and new definitions;
5. assign a new semantic `.vN` kind when persisted meaning changes; and
6. run the complete test, lint, syntax, and Worker dry-run checks.
