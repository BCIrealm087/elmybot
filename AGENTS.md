# Codex working instructions

This branch, `codex-twitch-integration`, was created from `master` after the platform-separation work was merged, to begin Codex-assisted Twitch integration for Elmybot.

For the current effort:

- Work only on `codex-twitch-integration`.
- Do not commit or push changes directly to `master`, `codex-platform-separation`, or any other branch.
- Before making changes, verify that the active branch is `codex-twitch-integration`.
- Focus new work on adding Twitch as a platform while preserving the existing Discord behavior and using the shared platform-independent scheduling and configuration foundations where appropriate.
- For changes that can affect runtime, build, or test behavior, run the full test suite whenever it is reasonable to do so. Install the locked dependencies with `npm ci` when needed, run tests in one-shot mode (for example, `npm test -- --run`), and report the exact result. Static checks or targeted simulations are not substitutes when the full suite can run. If full testing is blocked, report the blocker and the checks that were completed instead.
- For now, browser ChatGPT Work mode cannot execute `wrangler deploy --dry-run` because its approval layer classifies the command as a deployment before it runs. Treat this as an accepted environment limitation, not a failed project check, and do not repeatedly retry it. Continue to run the full test suite when reasonable; perform the Wrangler dry-run only from a supported environment such as a local terminal or CI.
- `.github/workflows/ci.yml` is the authoritative clean-run check when it runs. It installs locked dependencies, runs the complete Vitest suite and ESLint, checks JavaScript syntax, and runs `wrangler deploy --dry-run` without deploying.
- After pushing changes that trigger CI, inspect the GitHub Actions run and its job logs. Do not report the pushed work as fully verified until CI passes when the workflow is available. Diagnose failures, make scoped fixes, and rerun or retrigger CI as appropriate; if Actions is disabled, awaiting approval, or otherwise inaccessible, report that blocker explicitly.
- The CI Wrangler dry-run is the supported substitute for the browser Work mode limitation above. It requires no deployment secrets and must remain non-deploying.
