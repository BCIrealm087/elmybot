# `@elmybot/feature-fun-health`

TODO: describe the `fun.health` Elmybot feature.

Generated from the `shareable-counter` recipe. The generated JavaScript and tests are ordinary contributor-owned files.

## Tests to keep

- Keep standalone isolation and two origins selecting the same integration.
- Keep an allowed update, denial without mutation, and the counter floor.

These tests prove feature behavior. Platform ingress, persistence, delivery, and link lifecycle remain framework integration evidence unless this package changes those behaviors.

`defaultTestLink()` selects an in-memory direction and integration identity; it does not run OAuth, collision resolution, revocation, or migration.

Follow the [first-feature quickstart](../../../docs/feature-quickstart.md) for installation and testing.
