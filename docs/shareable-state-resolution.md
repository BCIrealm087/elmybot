# Pending integration state resolution

Step 8 adds the browser decision surface for genuinely different, nonempty
shareable state discovered while linking Discord and Twitch. It builds on the
immutable discovery revision described in
[`shareable-state-discovery.md`](shareable-state-discovery.md). The page does
not read feature storage itself; its accepted decisions are handed to the
Step 9 finalizer.

## What the broadcaster sees

The resumable pending-link page shows only namespaces whose discovery outcome
is `collision`. They are grouped by feature and each namespace offers exactly
three choices:

- **Use Discord state** selects the recorded Discord candidate.
- **Use Twitch state** selects the recorded Twitch candidate.
- **Reset shared state** starts that namespace empty only in the new
  integration realm.

The page also provides Discord-for-all, Twitch-for-all, and reset-all buttons.
Those buttons are a JavaScript convenience that selects the ordinary radio
controls; every namespace remains independently selectable and the form works
without that convenience.

Automatically classified namespaces are not presented as decisions. The
registry carries their `discord`, `twitch`, or `reset` selections into the same
complete resolution record when the broadcaster submits the genuine
collisions.

## Safe summaries

The page renders only the declaration-approved `presence` and `entry_count`
summaries persisted by discovery. It does not accept display text, keys, or
values from feature state. Feature and namespace labels are HTML-escaped, and
an unrecognized summary shape degrades to the generic “stored state was
detected” message.

Reset affects only the future integration realm. Neither candidate realm is
modified by viewing or submitting this page.

## Submission and persistence

The form posts an indexed choice for every currently displayed collision and
the discovery version. The server maps those indexes back to the current
server-side namespace catalog; client-supplied feature or namespace IDs are
ignored. The registry then requires:

- the pending link to still be awaiting state resolution;
- the submitted discovery revision to still be current;
- exactly one valid choice for every collision; and
- no choices for namespaces that were resolved automatically.

One immutable resolution revision is stored per discovery revision. Its
per-namespace rows contain the final selection and whether it came from the
user or automatic discovery policy. Repeating the same submission returns the
existing result without another audit event; attempting to replace a recorded
choice is rejected. A future discovery revision can receive a new resolution,
which is necessary when Step 9 detects intervening state mutations.

The registry records `integration.state_resolution.recorded.v1` with the
OAuth-verified Twitch broadcaster as actor. Public pending-link data includes
the bounded selections but not actor IDs, candidate realm identities,
fingerprints, mutation versions, keys, or values.

## Browser security and lifecycle behavior

Resolution requires the opaque, HTTP-only pending-link continuation cookie and
an exact same-origin POST. The cookie remains `Secure` and `SameSite=Lax`; the
page also retains the restrictive content-security policy, frame denial,
no-referrer policy, and `no-store` response policy used by Twitch onboarding.

Missing choices return the page with a bounded validation message. Expired or
cancelled links cannot acquire a resolution. The existing cancel action remains
available before final activation and leaves both candidate states unchanged.

An accepted resolution now starts finalization immediately. If a retryable
failure interrupts the operation, the resumable page offers the same protected
finalization action without asking for the decisions again. Namespaces with no
collision can finalize directly after Twitch verification.

If either candidate changed since discovery, finalization releases its seals,
records a new discovery revision, and returns the browser to the collision page
when another choice is required. Successful finalization materializes the
selected namespaces in a fresh integration realm and activates the link
idempotently. See
[`shareable-state-finalization.md`](shareable-state-finalization.md).
