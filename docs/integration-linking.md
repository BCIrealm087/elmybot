# Discord–Twitch integration linking

Elmybot stores cross-platform relationships in the singleton
`IntegrationRegistry` Durable Object. The registry is authoritative for link
membership, status, invitation state, and lifecycle audit events. Platform-local
configuration remains in each platform's existing Durable Objects.

The registry also owns the versioned routes attached to authenticated links.
Command and event adapters resolve those routes before submitting work to the
per-integration execution ledger and effect outbox. See
`docs/integration-execution.md`.

## Discord commands

The link lifecycle is exposed through three guild-only deferred commands:

- `/integration_link_twitch` creates a one-use Twitch broadcaster invitation
  and uses the command's Discord channel as the initial cross-platform message
  destination.
- `/integration_list` lists the server's active integrations and their IDs.
- `/integration_unlink integration_id:<id>` revokes one integration without
  disconnecting the Twitch channel from Elmybot generally.

All three require `integration.manage`. This capability is intentionally stricter
than scheduling and general configuration: only the Discord server owner or a
member with Administrator or Manage Server can use it. Configured scheduling
roles and other moderator permissions do not grant link management.

The Discord command router still verifies the interaction signature before
evaluating the capability or contacting the registry.

## Authenticated link flow

1. An authorized Discord manager runs `/integration_link_twitch`.
2. `IntegrationRegistry` records the Discord guild and initiating Discord actor,
   generates a cryptographically random invitation, stores only its SHA-256
   hash, and returns a URL with the plaintext token in the fragment.
3. The public connection page removes the fragment from the address bar and
   submits the token in a same-origin form.
4. The Twitch OAuth coordinator atomically reserves the invitation for one OAuth
   state. Replaying the invitation cannot create another OAuth attempt.
5. Twitch OAuth requests `channel:bot`. Elmybot validates the returned token and
   derives the Twitch broadcaster ID from Twitch; neither the browser nor the
   Discord initiator supplies that identity.
6. The broadcaster's channel authorization Durable Object completes the
   reservation and activates an integration containing the Discord guild and
   Twitch channel. The invitation's route templates are bound to those
   authenticated group identities.
7. The registry returns the integration ID, which Discord managers can inspect
   or revoke with the management commands.

Invitations expire after 15 minutes. An invitation reserved by OAuth remains
valid only for that OAuth state's lifetime. Registry alarms expire abandoned
invitations and reservations.

## Relationship model

The initial flow creates an integration with two members:

```text
integration:<opaque ID>
  discord:guild:<guild ID>
  twitch:channel:<broadcaster user ID>
```

The storage model is many-to-many: neither a group nor an integration is limited
to two memberships at the schema level. Repeating the link flow for an already
active Discord–Twitch pair returns the existing integration instead of creating
a duplicate.

Integration rows are revoked rather than deleted. This preserves membership and
audit history while excluding the relationship from active routing and listing.

## Initial routes

Each new Discord invitation seeds two independently versioned routes:

| Route kind | Source | Outcome |
| --- | --- | --- |
| `twitch.stream-online-to-discord.v1` | Twitch channel | Send a stream-online notice to the invitation's Discord channel |
| `twitch.announce-to-discord.v1` | Authorized Twitch command | Send the announcement to the invitation's Discord channel |

Route resolution returns only enabled routes whose integration is still active.
A Twitch channel can be linked to multiple Discord guilds, so one source event
may fan out to several coordinators. The registry caps one event at 25 routes,
matching the shared action and execution contract limits.

Repeating the link flow for an already active Discord–Twitch pair updates these
initial route destinations to the channel where the new link command was run.
Dedicated route inspection, enable/disable, and destination management remain
separate management functionality rather than hidden command behavior.

## Failure and revocation behavior

- A permanent invalid or expired reservation fails safely and is not retried.
- If registry completion is temporarily unavailable after Twitch OAuth succeeds,
  the channel authorization stores a pending completion and retries it from its
  alarm.
- `/integration_unlink` revokes only the selected relationship. It does not
  remove Twitch authorization because the channel may have other integrations
  or use Twitch-native Elmybot behavior.
- Disconnecting or invalidating the Twitch broadcaster authorization revokes all
  active integrations containing that Twitch channel. If registry revocation is
  temporarily unavailable, the channel authorization records pending
  deactivation and retries it from its alarm.
- A group can revoke only an integration of which it is a member.

Each test and production Worker environment has its own
`INTEGRATION_REGISTRY` and `INTEGRATION_COORDINATOR` bindings and Durable Object
namespaces, preserving the existing test/production isolation rule.

## Deployment notes

Wrangler migration `v11` creates `IntegrationRegistry`, and migration `v12`
creates `IntegrationCoordinator`. After deploying, register the Discord command
set again if the three integration commands have not already been registered.
No new secret is required; the flow and effect adapters reuse the existing
Discord verification and bot credentials, Twitch application credentials,
public Twitch origin, and `channel:bot` OAuth configuration.
