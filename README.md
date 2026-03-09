# elmybot

A Discord scheduling bot built on **Cloudflare Workers + Durable Objects**.

Discord does not run this bot continuously. Instead, Discord sends HTTPS interaction requests to the Worker, which validates, routes, and delegates scheduling to a per-guild Durable Object instance.

## Current capabilities

- Schedules future deliveries in a server channel:
  - role ping (`/pingroleat`)
  - user ping (`/pingmeat`)
  - plain channel message at a fixed timestamp (`/sayat`)
  - plain channel message at bounded random intervals (`/sayat_random`)
- Lists scheduled jobs (`/doat_list`)
- Cancels jobs by ID (`/doat_cancel`)
- Supports repeating schedules (daily for fixed-time handlers; interval-based repeats for random handler)
- Restricts scheduling/list/cancel commands to moderators or the guild owner

## Architecture

```text
Discord -> Worker (src/index.js)
          -> GuildScheduler Durable Object (src/message-scheduling.js)
          -> Discord REST API (message delivery + guild owner lookup)
```

### Worker responsibilities

`src/index.js` handles:

1. Request method checks (`POST` for interactions; `GET` health returns `OK`).
2. Discord signature verification using:
   - `X-Signature-Ed25519`
   - `X-Signature-Timestamp`
   - message = `timestamp + rawBody`
3. Interaction parsing and routing by command name.
4. Immediate `PONG` for interaction type `1`.
5. Deferred handling for commands marked `deferred`:
   - immediate ACK with interaction response type `5`
   - background execution with `ctx.waitUntil(...)`
   - PATCH to `.../webhooks/{application_id}/{token}/messages/@original`

## Command model

Command definitions are centralized in `src/commands.js`.

### Public utility

- `/alive`: simple responsiveness check.

### Scheduling commands (guild-only, permission-gated)

- `/pingroleat`
  - `timestamp` (required)
  - `role` (required)
  - optional repeat toggle
  - schedules `doAtType: "ping-role"`

- `/pingmeat`
  - `timestamp` (required)
  - `user` (required)
  - optional repeat toggle
  - schedules `doAtType: "ping-user"`

- `/sayat`
  - `timestamp` (required)
  - `message` (required)
  - optional repeat toggle
  - schedules `doAtType: "channel-message-standard"`

- `/sayat_random`
  - `message` (required)
  - `min_interval` (optional, default 7200s)
  - `max_interval` (optional, default 21600s)
  - `repeats` (optional)
  - schedules `doAtType: "channel-message-random"`

### Scheduler management commands (guild-only, permission-gated)

- `/doat_list`: list pending jobs.
- `/doat_cancel job_id:<id>`: cancel one job.

## Permissions model

Implemented in `src/permissions.js`.

- Everyone can run `/alive`.
- Scheduling/list/cancel commands require moderator-or-owner.
- Moderator is inferred from Discord permission bitfields (`ADMINISTRATOR`, `MANAGE_GUILD`, etc.).
- Owner is checked by fetching guild metadata from Discord API and matching `owner_id`.

## Durable Object scheduler

Implemented in `src/message-scheduling.js` as `GuildScheduler`.

### Storage

- `jobs`: array of scheduled jobs, sorted by `runAtMs` ascending.
- `delivered`: dedupe map (`${job.id}:${job.ts}` -> delivered timestamp) with TTL pruning.

Job shape currently includes:

```js
{
  id,
  guildId,
  channelId,
  doAtType,
  subject,
  ts,
  runAtMs,
  data,
  repeats,
  createdBy
}
```

### Scheduling and alarm behavior

- Mutations use `state.storage.transaction(...)` for atomic read-modify-write.
- After schedule/cancel/deliver mutations, the next alarm is recomputed from persisted `jobs`.
- One alarm is kept for the next due job (`setAlarm(next.runAtMs)`).
- `alarm()` loops while due jobs exist:
  1. load current jobs
  2. deliver earliest due job
  3. remove or reschedule it
  4. continue until no due jobs remain

### Delivery + mention safety

Delivery endpoint:

- `POST https://discord.com/api/v10/channels/{channelId}/messages`
- `Authorization: Bot ${DISCORD_TOKEN}`

Mention policy:

- Role pings: explicit role mention with `allowed_mentions.roles`.
- User pings: explicit user mention with `allowed_mentions.users`.
- Plain messages: `allowed_mentions: { parse: [] }`.
- Interaction responses default to ephemeral with mention parsing disabled.

## Project structure

- `src/index.js` — Worker entrypoint, verification, routing, deferred flow.
- `src/commands.js` — slash command registry and execution wiring.
- `src/message-scheduling.js` — scheduler helpers + `GuildScheduler` Durable Object.
- `src/permissions.js` — permission constants and moderator/owner checks.
- `src/common.js` — shared response/option helpers.
- `src/register-commands.js` — slash command registration script.
- `wrangler.jsonc` — Worker config, DO binding, migrations, test env binding.

## Configuration

### Required runtime env/secrets

- `PUBLIC_KEY` — Discord application public key (signature verification).
- `DISCORD_TOKEN` — bot token used for channel message delivery.
- `DISCORD_BOT_TOKEN` — bot token used for guild owner lookups.

### Discord command registration script env vars

`src/register-commands.js` supports production and test modes:

- production (default): `APP_ID`, `DISCORD_TOKEN`
- test (`--test`): `TEST_APP_ID`, `TEST_DISCORD_TOKEN`

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Register slash commands (optional):

   ```bash
   npm run register
   # or: node src/register-commands.js --test
   ```

3. Start Worker locally:

   ```bash
   npm run dev
   ```

4. Run tests:

   ```bash
   npm test
   ```

## Cloudflare deployment notes

- Durable Object binding name: `SCHEDULER`
- Durable Object class: `GuildScheduler`
- DO migration tags in `wrangler.jsonc` are append-only once deployed.
- Non-inheritable environment bindings (for example test/prod env blocks) must be explicitly repeated.