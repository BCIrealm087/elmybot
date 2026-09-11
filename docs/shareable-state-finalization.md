# Shareable-state finalization

Step 9 turns one immutable discovery and resolution revision into an active
Discord–Twitch integration. The integration registry owns this operation;
features, routes, and the browser cannot select realms or copy stored values.

## Activation barrier

A pending link remains `awaiting_state_resolution` until every discovered
namespace has an automatic or user-directed selection. The registry then:

1. loads the current discovery revision and complete selection plan;
2. resolves the current candidate realm for each group again;
3. acquires bounded namespace write seals in deterministic realm order;
4. compares each sealed schema version, mutation version, and fingerprint with
   discovery;
5. clones the selected Discord or Twitch snapshot, or initializes an empty
   namespace for reset, in a fresh integration realm;
6. verifies the complete target namespace set; and
7. atomically creates the active integration, members, routes, audit record,
   and any absent first-link directional defaults.

The target realm is addressed by the pending integration ID and the discovery
revision as its generation. An abandoned partial realm from revision 1 is
therefore unreachable if rediscovery advances the accepted revision to 2.
Active default-link results carry this generation into effective-state
resolution.

## Mutation races and rediscovery

Discovery does not block commands. At finalization, a candidate namespace seal
allows reads but makes writes fail with a bounded, retryable transition error.
The same finalizer may renew its lease; a different finalizer cannot replace an
active seal.

After all seals are held, the registry compares the sealed snapshots with the
recorded candidates. It also rechecks that each group still resolves to the
same realm—for example, that a concurrent default switch did not change its
effective candidate. Any mismatch releases the seals, writes a new discovery
revision, clears the old revision's effective choice, and returns
`integration_state_rediscovery_required`. The browser resumes the new discovery
instead of silently applying stale intent.

## Idempotency and interrupted recovery

Each target namespace receives a deterministic materialization key bound to the
integration, discovery revision, feature, namespace, and selection. Realm
storage records the key and resulting fingerprint. Repeating the exact copy or
reset returns the existing result; reusing the key for different content is an
error.

This makes finalization an idempotent saga across Durable Objects. A failure
after some namespaces were copied leaves the target unreachable and the link
pending. Retrying replays completed namespace operations, finishes the missing
ones, verifies the realm, and runs the registry activation transaction. A
repeated request after activation returns the existing integration. It cannot
create another integration or duplicate the applied-resolution audit event.

Seals have bounded leases and exact-token release. The registry attempts to
release every acquired seal on success, rediscovery, or failure; a process
interruption cannot block writes permanently because an expired seal is removed
on later access.

## Browser behavior

Links with only automatic selections finalize after Twitch verification. A
collision form submission records the choices and immediately starts the same
finalizer. Temporary failures render a retry action on the resumable pending
page, while candidate changes render the latest collision discovery. The
continuation cookie and exact same-origin POST protections from Step 8 remain
required for browser finalization.

The registry records `integration.state_resolution.applied.v1` only in the
transaction that first activates a materialized integration. Candidate keys and
values remain confined to realm-to-realm protected operations and never enter
the registry audit record or browser response.
