# `@elmybot/framework`

Private npm-workspace facade for Elmybot's stable contributor Framework API.
Feature packages use these exports instead of reaching into Worker internals:

| Import | Audience | Contents |
| --- | --- | --- |
| `@elmybot/framework` | Feature production source | Feature, action, command, route, event, schedule, schema, and context helpers |
| `@elmybot/framework/testing` | Feature tests only | Deployment-free feature runtime, fixtures, and assertions |

The package major matches `frameworkApiVersion`; version `1.0.0` therefore
represents Framework API v1. Compatibility and deprecation rules are defined in
[`docs/framework-api.md`](../../docs/framework-api.md), and practical examples
live in [`docs/feature-authoring.md`](../../docs/feature-authoring.md).

This first form delegates to the reviewed source in `src/framework/` and is
private, build-time-only repository infrastructure. It is not independently
publishable: external publication would first require self-contained package
source or build output, provenance and release automation, and a separate
supply-chain review. Production feature code must not import the `/testing`
entry point.
