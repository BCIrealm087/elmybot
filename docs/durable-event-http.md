# Durable-event grants, discovery, and HTTP sessions

## Status

The event-specific authorization boundary is implemented. Discord managers and
Twitch broadcasters can issue a credential for one declared stream, inspect its
value-free catalog entry, exchange it for an event-only browser session, and
revoke it.

The consumer WebSocket is intentionally not part of this step. Until the next
transport step adds `/event-stream/socket`, a grant does not attach a consumer
or make publication succeed. Existing state-query snapshot and WebSocket routes
remain unchanged.

## Authorization model

An event grant selects exactly:

- one Discord guild or Twitch channel;
- one declared feature, stream ID, and version;
- the physical group-local or effective-shareable stream selected at issuance;
- one deployment environment; and
- one expiry between five minutes and 30 days, defaulting to 24 hours.

Event grants use the `elmybot-deg-v1` credential prefix and an independent
`DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET`. They are not state-query grants:
`elmybot-sqg-v1` credentials fail on event routes, and event credentials fail on
state-query routes.

The signed credential contains routing fields, a grant UUID, and a random
256-bit secret. The physical stream stores only SHA-256 of that secret together
with bounded grant metadata. A raw credential is returned once by the issuing
flow and is never placed in a URL, log, catalog response, or persisted record.

One physical stream has one current grant. Issuing another grant atomically
marks the prior grant as replaced while preserving the stream's acknowledgement
position and retained backlog. Explicit revocation and future socket
registration use the same stream-owned authority as issuance and validation;
there is no authorization polling window or separate worker-side revocation
queue.

For effective-shareable streams, issuance first verifies the current ordered
binding through the integration registry and registers lifecycle interest for
the grant lifetime. A later default or integration movement leaves the old
physical stream available only for its retained backlog. A consumer for the new
physical stream requires a newly issued grant.

## Issuing a grant

### Discord

Run:

```text
/event_stream_grant stream:<feature>:<stream>:v<version>
```

Optional `duration_hours` and `reset_backlog` arguments control the lifetime and
explicit retention-gap recovery. The exact guild owner, or a member with
Administrator or Manage Server, may issue the grant. The credential is returned
in an ephemeral interaction response.

### Twitch

Open:

```text
https://<worker-host>/event-stream/operator/twitch
```

Select the stream and lifetime, then sign in as the broadcaster. This uses
identity-only Twitch OAuth and validates that the authenticated user owns the
exact target channel. The temporary OAuth token is revoked after the callback.
The result page displays the event credential once and also creates the secure
event session cookie.

Register this exact callback for each environment's Twitch application:

```text
https://<worker-host>/event-stream/operator/twitch/callback
```

## Public HTTP surface

| Method and route | Authentication | Result |
| --- | --- | --- |
| `GET /event-stream/operator/twitch` | Twitch reauthentication begins in the form flow | Stream-selection form |
| `GET /event-stream/operator/twitch/callback` | One-use OAuth state and Twitch identity | One-time credential page and event session |
| `GET /event-stream/catalog` | Bearer credential or event session | The one authorized, value-free stream declaration |
| `POST /event-stream/session` | Bearer credential plus exact same `Origin` | `elmybot_durable_event` session cookie |
| `DELETE /event-stream/session` | Exact same `Origin` | Clears the event session cookie |
| `DELETE /event-stream/grant` | Bearer credential, or cookie plus exact same `Origin` | Atomically revokes the grant and clears the cookie |

The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`, host-only, and
scoped to `Path=/event-stream`. It is deliberately distinct from the
state-query cookie. Cookie-authenticated mutations require an `Origin` exactly
matching `DURABLE_EVENT_PUBLIC_ORIGIN`; bearer revocation is suitable for a
non-browser credential holder.

For example, exchange a credential without exposing it in a URL:

```js
await fetch("/event-stream/session", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${credential}`
  }
});

const catalog = await fetch("/event-stream/catalog").then((response) =>
  response.json()
);
```

The catalog includes the public target, grant ID and expiry, and exactly one
authorized declaration. It never includes payload values, actor IDs, physical
realm identity, integration IDs, binding revisions, consumer history, or other
installed streams.

## Retention-gap reset

Ordinary grant issuance fails with `durable_event_gap_requires_reset` when an
unacknowledged event has expired. An authorized operator may retry with
`reset_backlog:true`. That explicit acknowledgement:

1. discards remaining retained payloads;
2. advances the acknowledgement position to the current tail;
3. clears the gap marker;
4. records a bounded audit entry containing only stream identity, missing
   sequence range, actor, and time; and
5. issues the replacement grant.

The reset does not claim that missing events were delivered. Reset audit rows
and grant tombstones are bounded, and neither contains a payload or raw
credential.

## Deployment configuration

Commit environment-specific non-secret values in `wrangler.jsonc`:

```text
DURABLE_EVENT_STREAMS_ENABLED=true
DURABLE_EVENT_DEPLOYMENT_ENVIRONMENT=production|test
DURABLE_EVENT_PUBLIC_ORIGIN=https://<worker-host>
```

Configure a different strong secret in each environment:

```powershell
npx wrangler secret put DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET
npx wrangler secret put DURABLE_EVENT_CREDENTIAL_SIGNING_SECRET --env test
```

The secret must contain at least 32 characters and should not be reused for
state-query credentials. Disabling `DURABLE_EVENT_STREAMS_ENABLED` rejects
publication and event-grant use without changing any state-query behavior.

## Current limitations

- There is no public consumer WebSocket until transport roadmap step 6.
- A physical stream supports one current grant and, later, one active consumer.
- Replacement revokes the previous credential; it does not create fan-out.
- Delivery will be bounded and at least once, not exactly once.
- Retention gaps require explicit operator acknowledgement; they are never
  skipped automatically.
- Grants cannot browse event history or inspect payloads through HTTP.

The complete frozen protocol and storage contract is in
[`durable-event-contract.md`](durable-event-contract.md). Implementation order
and remaining work are tracked in
[`durable-event-transport-roadmap.md`](durable-event-transport-roadmap.md).
