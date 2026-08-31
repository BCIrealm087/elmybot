# `@elmybot/feature-alive`

Private npm-workspace proof for an Elmybot build-time feature package. It owns
the shared Discord `/alive` and Twitch `!alive` feature and imports only the
stable `@elmybot/framework` API.

| Metadata | Value |
| --- | --- |
| Package | `@elmybot/feature-alive` |
| Feature ID | `core.alive` |
| Framework API | v1 |
| Framework peer | `^1.0.0` |

The Worker installs version `1.0.0` explicitly in the root `package.json` and
imports the package from `src/features/index.js`. The former
`src/features/alive/feature.js` path remains a compatibility re-export while
downstream imports migrate.

The package is reviewed, installed explicitly, and bundled with the Worker. It
is not loaded dynamically at runtime.

Run its focused test and validate all workspace metadata from the repository
root:

```sh
npm test -- --run packages/features/alive/test/feature.spec.js
npm run feature:workspaces
```
