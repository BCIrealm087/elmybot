# Codex working instructions

This branch, `codex-ironing`, was created from `master` to begin a Codex-assisted stabilization, cleanup, and polishing phase for Elmybot.

For the current effort:

- Work only on `codex-ironing`.
- Do not commit or push changes directly to `master`, `codex-twitch-integration`, `codex-platform-separation`, or any other branch.
- Before making changes, verify that the active branch is `codex-ironing`.
- Focus on small, scoped fixes, cleanup, maintainability improvements, documentation, and stronger verification while preserving the existing Discord and Twitch behavior and the shared platform-independent foundations.
- For work on the contributor-facing command/feature framework, consult `docs/command-feature-framework.md` for the design and staged plan and `docs/command-feature-framework-contract.md` for the approved normative API. The contract was approved on 2026-08-30, but an API is not implemented merely because it is documented; follow the staged implementation status.
- For changes that can affect runtime, build, or test behavior, run the full test suite whenever it is reasonable to do so. Install the locked dependencies with `npm ci` when needed, run tests in one-shot mode (for example, `npm test -- --run`), and report the exact result. Static checks or targeted simulations are not substitutes when the full suite can run. If full testing is blocked, report the blocker and the checks that were completed instead.
- For now, browser ChatGPT Work mode cannot execute `wrangler deploy --dry-run` because its approval layer classifies the command as a deployment before it runs. Treat this as an accepted environment limitation, not a failed project check, and do not repeatedly retry it. Continue to run the full test suite when reasonable; perform the Wrangler dry-run only from a supported environment such as a local terminal or CI.
- `.github/workflows/ci.yml` is the authoritative clean-run check when it runs. It installs locked dependencies, runs the complete Vitest suite and ESLint, checks JavaScript syntax, and runs `wrangler deploy --dry-run` without deploying.
- After pushing changes that trigger CI, inspect the GitHub Actions run and its job logs. Do not report the pushed work as fully verified until CI passes when the workflow is available. Diagnose failures, make scoped fixes, and rerun or retrigger CI as appropriate; if Actions is disabled, awaiting approval, or otherwise inaccessible, report that blocker explicitly.
- The CI Wrangler dry-run is the supported substitute for the browser Work mode limitation above. It requires no deployment secrets and must remain non-deploying.
