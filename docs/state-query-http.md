# State-query read grants, discovery, and snapshot HTTP API

Status: implemented foundation for state-querying roadmap step 5 on 2026-09-12.
Recoverable committed-change notifications were added in step 6. Lifecycle
handoff observation, live dependency tracking, and SSE remain steps 7–9.

## Security model

Readable-state declarations establish eligibility; they do not make values
public. Every catalog or snapshot request must present a live read grant for one
exact Discord guild or Twitch channel. Grant issuance requires a verified actor
from that same platform:

- Discord server owners and members with Administrator or Manage Server use the
  `/state_query_grant` slash command. Discord delivers the credential through an
  ephemeral interaction response.
- Twitch broadcasters open `GET /state-query/operator/twitch`, select readable
  exports, and reauthenticate through an OAuth authorization-code flow with the
  identity-only [`openid`](https://dev.twitch.tv/docs/authentication/getting-tokens-oidc/)
  scope. The verified Twitch user ID becomes the target
  channel ID. The temporary access token is revoked immediately and is never
  stored by the state-query service.

The Twitch OAuth callback
`https://<worker-host>/state-query/operator/twitch/callback` must be registered
on the matching environment's Twitch application. Issuance does not accept the
bot OAuth token or `TWITCH_OAUTH_SETUP_TOKEN` as an overlay credential.

Each credential contains 256 random secret bits and an opaque grant ID. The
target and deployment identity needed to locate and reject the credential are
encoded in the token, but clients must treat the complete value as opaque.
An environment-specific HMAC authenticates those routing fields before any
per-group Durable Object lookup, preventing forged tokens from materializing
arbitrary group namespaces.
Only SHA-256 of the secret is stored in the target group's `GroupConfig` Durable
Object. The verified issuer identity, normalized scope, issuance and expiry
times, environment, and revocation state are durable. At most 100 unexpired,
unrevoked grants may exist per group. Expired records are retained for seven
days before opportunistic cleanup.

Grant lifetimes range from five minutes to 30 days and default to 24 hours.
Tokens are shown once, must not be logged, and must never appear in a URL.
Production and test tokens are cryptographically random and also carry distinct
environment identities; a token issued in one environment is rejected in the
other before a group lookup.

## Scope and whole-query authorization

A grant stores explicit `(feature, export, version)` permissions. Every lookup
parameter independently declares:

- literal/resolved values as `any`, `none`, or a normalized finite exact set;
- the named readable exports permitted to provide a dynamic value.

Collections require a separate `includeFutureMembers` decision. Version 1
supports complete materialized collections only when this value is `true`;
frozen-membership collection grants are rejected rather than returning an
incomplete result. This makes authorization of members materialized after grant
creation explicit.

Per-grant document, binding, selection, argument, dynamic-edge, dependency-depth,
projection-depth, collection, and result-size ceilings can only reduce the
system limits. Authorization covers selected bindings and hidden dependencies.
The adapter performs a raw identity/target precheck before detailed query
preparation, authorizes the normalized plan, and checks normalized dynamic
values before opening their destination source. Any failure rejects the whole
query with `query_access_denied`; no partial values are returned.

The initial platform authoring interfaces accept 1–20 comma-separated catalog
identities such as:

```text
fun.deaths:remembered_game:v1,fun.deaths:count:v1,fun.deaths:counts:v1
```

They issue `any` value policies for the selected lookup exports, allow dynamic
arguments only from another selected export, and explicitly include future
members for selected collections. The underlying grant model also supports
exact and dynamic-only policies for narrower future authoring interfaces.

## Browser credential transport

Non-browser clients send the grant in an HTTP header:

```http
Authorization: Bearer <state-query-grant>
```

Native `EventSource` cannot set that header. A same-origin browser client may
therefore exchange it once:

```http
POST /state-query/session
Origin: https://<worker-host>
Authorization: Bearer <state-query-grant>
```

The empty `204` response sets a path-scoped `HttpOnly; Secure;
SameSite=Strict` cookie whose maximum age cannot exceed the grant expiry. The
raw credential is not returned. `DELETE /state-query/session` clears the local
cookie without revoking the grant. Cookie-authenticated state-changing requests
require an exact configured origin.

No state-query response sets `Access-Control-Allow-Origin`. CORS is deliberately
closed and is not treated as authorization. Responses use `no-store, private`,
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a locked
down content security policy. Credentials are not accepted in query parameters,
and logs contain only the method, fixed route, correlation ID, and safe errors.

## Authorized discovery

`GET /state-query/catalog` accepts Bearer or session-cookie authentication and
returns only exports permitted by that grant:

```json
{
  "protocolVersion": 1,
  "target": { "platform": "twitch", "groupId": "1234" },
  "grant": {
    "id": "opaque-id",
    "expiresAt": "2026-09-13T12:00:00.000Z",
    "limits": { "maxBindings": 20 }
  },
  "exports": []
}
```

Each entry uses the public readable-state catalog shape and adds the grant's
normalized argument, dynamic-source, and collection scope. It never includes
normalizer code, storage keys, namespace IDs, integration membership, physical
realm identities, values, credentials, or issuer metadata.

## One-time snapshots

`POST /state-query/snapshot` accepts Bearer or session-cookie authentication,
requires `Content-Type: application/json`, and receives the exact version-1
query document from [`state-query-contract.md`](state-query-contract.md). The
query target must equal the grant target. A successful response is the public
transport-neutral envelope; the evaluator's internal source/dependency
observation is omitted.

Example:

```powershell
$headers = @{
  Authorization = "Bearer $stateQueryGrant"
  "Content-Type" = "application/json"
}
$query = @{
  version = 1
  target = @{ platform = "twitch"; groupId = "1234" }
  bindings = @{
    remembered = @{
      read = @{ feature = "fun.deaths"; export = "remembered_game"; version = 1 }
    }
    current = @{
      read = @{ feature = "fun.deaths"; export = "count"; version = 1 }
      arguments = @{ game = @{ ref = "remembered" } }
    }
  }
  select = @{ deaths = @{ ref = "current"; path = @("count") } }
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "$workerUrl/state-query/snapshot" `
  -Headers $headers -Body $query
```

The endpoint resolves the target group's current effective state on every
request. It does not retain a realm identity from grant issuance and does not
execute commands or mutations.

## Live subscriptions

`POST /state-query/stream` accepts the same authentication and query meaning,
with one to 20 client-named queries in a single SSE subscription. It performs a
version-checked snapshot-and-attach handshake, then sends complete replacement
results, status events, and heartbeat comments. Recovery cursors, buffering,
cleanup, and examples are specified in
[`state-query-sse.md`](state-query-sse.md).

## Revocation and errors

`DELETE /state-query/grant` authenticates with the credential itself, marks the
grant revoked durably, and clears its session cookie. A cookie-authenticated
revoke requires the configured same origin. Revocation is idempotent for the
same valid credential. Later catalog and snapshot requests return
`query_grant_revoked`; expired credentials return `query_grant_expired`. An
already-open live subscription emits the matching terminal status and closes
after its independent authorization check.

Malformed, wrong-environment, wrong-target, unknown-export, and otherwise
unauthorized requests are collapsed to `query_access_denied` before they can
enumerate groups or hidden exports. Authorized structural mistakes retain the
specific safe `query_*` codes from the public contract.

## Configuration

Set distinct committed values per environment:

| Variable | Meaning |
| --- | --- |
| `STATE_QUERY_DEPLOYMENT_ENVIRONMENT` | Short stable identity such as `production` or `test` |
| `STATE_QUERY_PUBLIC_ORIGIN` | Exact HTTPS Worker origin used for OAuth and cookie-origin checks |
| `STATE_QUERY_CREDENTIAL_SIGNING_SECRET` | Secret with at least 32 characters used only to authenticate grant routing fields |

The implementation falls back to the corresponding Twitch values for backward
compatibility, but new deployments should configure the state-query names
explicitly. Generate a different signing secret for every environment with
`wrangler secret put STATE_QUERY_CREDENTIAL_SIGNING_SECRET`. No new Durable
Object class is required; grants use the existing per-group `CONFIG` binding.
