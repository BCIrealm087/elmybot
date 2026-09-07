# Pending integration shareable-state discovery

Step 7 connects the pending-integration lifecycle to the protected
shareable-state snapshot layer. Discovery begins after Twitch verification and
finishes before any integration member, route, default link, or shared realm is
made active.

## Candidate realms

The registry selects one effective candidate for each proposed member:

- if the group has an active directional default to the other platform, use
  that integration's realm;
- otherwise, use the group's standalone realm.

This selection is independent in each direction. When a Discord guild already
defaults to one Twitch integration but the newly verified Twitch channel is
unlinked, discovery compares the guild's current integration realm with the
channel's standalone realm. Nondefault integrations are never selected
implicitly.

## Protected inventory

Each candidate realm inventories every namespace declared by the installed
feature catalog. This operation is infrastructure-only and returns:

- feature and namespace identifiers and bounded labels;
- current schema and monotonic mutation versions;
- the deterministic content fingerprint;
- whether persisted state is meaningful; and
- the declaration-approved `presence` or `entry_count` summary.

It does not return persisted keys or values. The registry stores only this
metadata plus the two candidate realm identities. Raw snapshot content remains
inside its owning realm and is not placed in lifecycle rows, audit events, or
browser responses.

## Generic classification

The registry applies the same policy to every compatible declared namespace:

| Discord candidate | Twitch candidate | Outcome | Initial selection |
| --- | --- | --- | --- |
| Empty | Empty | `both_empty` | Reset/empty |
| Used | Empty | `discord_only` | Discord |
| Empty | Used | `twitch_only` | Twitch |
| Used and identical | Used and identical | `identical` | Either equivalent candidate |
| Used and different | Used and different | `collision` | User choice required |

Only the final row requires input. Automatic selections are durable discovery
decisions, not early writes: Step 9 will recheck the recorded versions and
fingerprints, clone the selected snapshots into a fresh integration realm, and
then activate the link. Until that finalizer exists, any pending link containing
declared namespaces remains behind the activation barrier.

## Persistence and recovery

One immutable discovery revision is recorded for the current pending link.
Verification replay and browser resume return that same revision without
duplicating rows or audit events. A temporary realm or registry failure leaves
the verified relationship pending; the channel authorization alarm and the
browser pending page can retry discovery without replaying Twitch OAuth.

Discovery records one of two audit events:

- `integration.state_discovery.automatically_resolved.v1`; or
- `integration.state_discovery.collisions_found.v1`.

Cancellation and expiry preserve the bounded discovery record until ordinary
invitation-retention cleanup. Cleanup removes namespace discovery rows before
their parent discovery and invitation rows.

Schema/catalog disagreement fails closed as a retryable maintenance condition.
It never falls back to copying unknown data or offering reset as a way around an
unreadable source schema.
