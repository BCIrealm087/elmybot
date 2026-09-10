# Feature operator checklist

Use this checklist when taking a reviewed feature from its
[contributor PR handoff](feature-authoring.md#before-opening-a-pull-request)
to a running environment. The operator owns credentials, deployment, platform
registration, and live verification. Contributors can complete normal behavior
development with the deployment-free test runtime.

Apply the steps relevant to the change. An ordinary command using existing
services does not require new OAuth setup or secrets.

## Review the handoff

- [ ] Read the behavior summary, local verification results, and CI result for
  the commit being deployed. CI includes a non-deploying Worker build.
- [ ] Resolve any linked framework-help request needed for release. For changes
  to persisted data, confirm the maintainer-reviewed migration, compatibility
  evidence, and recovery procedure before rollout. Keep deployed migration
  history intact; see [state migration guidance](feature-state.md#compatibility-api-for-installed-features).
- [ ] Identify any changed command descriptors, configuration keys, service
  credentials, or OAuth requirements from the PR. Mark inapplicable steps as
  such rather than repeating environment setup.

## Configure and deploy

- [ ] Select the test or production environment and its matching bot/application
  identities. Confirm `TWITCH_PUBLIC_ORIGIN` and
  `TWITCH_DEPLOYMENT_ENVIRONMENT` in `wrangler.jsonc`; keep test and production
  Twitch applications and bot accounts separate.
- [ ] Configure only the values and secrets required by the change, using
  [Worker values and secrets](../README.md#worker-values-and-secrets).
  Supply secret values through the operator setup, never through feature code
  or a PR. Discord registration uses separate local environment variables.
- [ ] For initial onboarding or changed OAuth requirements, verify callback
  URLs and the relevant bot/broadcaster authorization using
  [setup and deployment](../README.md#setup-and-deployment). Reuse valid existing
  authorization for ordinary command changes. Features requiring new external
  service access need the reviewed framework integration before this step.
- [ ] Deploy the reviewed commit using the environment-specific commands in
  [setup and deployment](../README.md#setup-and-deployment). The CI dry-run
  validates the build but does not deploy the Worker.
- [ ] If Discord command names, descriptions, or options changed, run Discord
  registration for the same environment. The setup guide lists the test and
  production commands; it registers the complete current command set. Twitch
  text-command changes take effect with the Worker deployment.

## Verify the running feature

- [ ] Exercise a representative invocation on each affected platform, including
  the relevant permission denial or invalid-input correction. For routed or
  shared behavior, verify the intended link and destination. Confirm the
  standalone behavior too when the feature supports it.
- [ ] For Twitch onboarding or delivery changes, inspect the relevant
  [operator health endpoints](../README.md#operator-endpoints) and actual
  delivery. Test-runtime effects alone do not verify platform delivery.
- [ ] Record the deployed commit, environment, registration changes, and live
  verification outcome in the handoff. Keep unresolved operational work visible.
