# elmybot

A Discord scheduling bot built on **Cloudflare Workers + Durable Objects**.

Discord does not run this bot continuously. Instead, Discord sends HTTPS interaction requests to the Worker. The Worker verifies the request signature, routes the command, and delegates scheduling/configuration work to per-guild Durable Objects.

## Current capabilities

- Public health check command:
  - `/alive`
- Scheduling commands:
  - `/pingroleat` — schedule a role ping at a Unix timestamp
  - `/pingmeat` — schedule a user ping at a Unix timestamp
  - `/sayat` — schedule a plain channel message (or random GIF result) at a Unix timestamp
  - `/sayat_random` — schedule a plain channel message (or random GIF result) after a bounded random interval
- Scheduler management commands:
  - `/doat_list`
  - `/doat_cancel`
- Guild configuration commands:
  - `/config_allow_role`
  - `/config_disallow_role`
- Repeating schedules:
  - daily repeats for timestamp-based commands
  - repeated bounded random intervals for `/sayat_random`

## Architecture

```text
Discord
  -> Worker (src/index.js)
     -> GuildScheduler Durable Object (src/message-scheduling/backend.js)
     -> GuildConfig Durable Object (src/guild-configuration.js)
     -> Discord REST API
```

### Worker flow

`src/index.js` is the Discord interactions entrypoint. It is responsible for:

1. Serving a simple `GET /` health check that returns `OK`.
2. Rejecting non-`POST` interaction requests.
3. Verifying Discord request signatures using:
   - `X-Signature-Ed25519`
   - `X-Signature-Timestamp`
   - the raw request body (`timestamp + rawBody`)
4. Replying to interaction type `1` with `{ type: 1 }` (`PONG`).
5. Routing slash commands defined in `src/commands.js`.
6. Using the deferred interaction pattern for longer-running guild commands:
   - immediate ACK with response type `5`
   - background execution via `ctx.waitUntil(...)`
   - PATCH to `.../webhooks/{application_id}/{token}/messages/@original`

## Command model

Command definitions live in `src/commands.js`.

### Public command

- `/alive` — simple responsiveness check.

### Scheduling commands

All scheduling commands are guild-only, deferred, and protected by the bot's permission model.

- `/pingroleat`
  - required: `timestamp`, `role`
  - optional: `repeat_daily`
  - schedules a job with `type: "pingroleat"`

- `/pingmeat`
  - required: `timestamp`, `user`
  - optional: `repeat_daily`
  - schedules a job with `type: "pingmeat"`

- `/sayat`
  - required: `timestamp`, `message`
  - optional: `repeat_daily`, `gif`
  - schedules a job with `type: "sayat"`
  - when `gif` is true, `message` is treated as a GIF search string and delivery sends an embed with a random result

- `/sayat_random`
  - required: `message`
  - optional: `min_interval` (default `7200`), `max_interval` (default `21600`), `repeats`, `gif`
  - schedules a job with `type: "sayat_random"`
  - when `gif` is true, `message` is treated as a GIF search string and each delivery fetches a random result

### Scheduler management commands

- `/doat_list` — list up to the first 15 scheduled jobs for the guild.
- `/doat_cancel job_id:<id>` — cancel a scheduled job by its job ID.

### Guild configuration commands

- `/config_allow_role role:<role>` — allow a guild role to use protected commands.
- `/config_disallow_role role:<role>` — remove that allowance.

### GIF mode (for `/sayat` and `/sayat_random`)

- GIF mode is enabled by setting the optional `gif` boolean option to `true`.
- The `message` field becomes a search query (validated as non-empty and max 20 characters).
- At delivery time, the scheduler fetches a random GIF match and posts it as a Discord embed image.
- Plain-text mode remains the default when `gif` is omitted or false.

## Permissions model

Implemented in `src/discord-permissions.js`.

- Everyone can run `/alive`.
- Commands prefixed with `config_` are restricted to guild owner or moderators.
- Scheduling/list/cancel commands allow any of:
  - guild owner
  - moderator
  - a role listed in the guild's `allowedRoles` configuration
- Moderator status is inferred from Discord permission bitfields (`ADMINISTRATOR`, `MANAGE_GUILD`, `MANAGE_MESSAGES`, and related moderation permissions).
- Owner status is checked by fetching the guild from the Discord REST API and matching `owner_id`.

## Durable Objects

### `GuildScheduler`

Implemented in `src/message-scheduling/backend.js`.

Each guild gets one `GuildScheduler` Durable Object instance. It stores scheduled jobs, keeps them sorted by `runAtMs`, and maintains one alarm for the next due job.

#### Storage

- `jobs` — sorted array of scheduled jobs
- `delivered` — dedupe map keyed by `${job.id}:${job.timestamp}`

Current job shape:

```js
{
  id,
  guildId,
  channelId,
  type,
  subject,
  timestamp,
  runAtMs,
  extraData,
  repeats,
  createdBy
}
```

#### Behavior

- Scheduling and cancellation mutate `jobs` inside `state.storage.transaction(...)`.
- After each mutation, the next alarm is recomputed from persisted storage.
- `alarm()` loops over due jobs, delivers them through Discord's channel message API, then removes or reschedules each occurrence.
- Repeating timestamp-based jobs advance by one day and catch up if the alarm fires late.
- Repeating random-interval jobs compute a new bounded random delay each time.

#### Mention policy

- Role ping jobs mention only the configured role via `allowed_mentions.roles`.
- User ping jobs mention only the configured user via `allowed_mentions.users`.
- Plain message jobs use `allowed_mentions: { parse: [] }`.

### `GuildConfig`

Implemented in `src/guild-configuration.js`.

Each guild gets one `GuildConfig` Durable Object instance. It stores per-guild configuration values, currently used for the `allowedRoles` list that grants protected command access to specific roles.

## Project structure

- `src/index.js` — Worker entrypoint, signature verification, routing, deferred responses.
- `src/commands.js` — slash command registry and scheduling command wiring.
- `src/message-scheduling/backend.js` — `GuildScheduler` Durable Object and alarm-driven delivery.
- `src/message-scheduling/commands-extension.js` — Worker-side scheduling validation and helper functions.
- `src/guild-configuration.js` — `GuildConfig` Durable Object.
- `src/discord-permissions.js` — permission constants and guild/member permission evaluation.
- `src/common.js` — shared response/option helpers.
- `src/register-commands.js` — script for registering slash commands with Discord.
- `test/index.spec.js` — Worker/DO integration-style test coverage.
- `wrangler.jsonc` — Worker config, Durable Object bindings, and migrations.

## Configuration

### Required runtime env/secrets

- `PUBLIC_KEY` — Discord application public key used for request signature verification.
- `DISCORD_TOKEN` — bot token used for guild owner lookup, editing deferred interaction responses, and channel message delivery.
- `KLIPY_API_KEY` — API key used for GIF search requests.
- `KLIPY_API_KEY_NAME` — client key/name sent with GIF search requests.

### Slash-command registration env vars

`src/register-commands.js` supports production and test modes:

- production (default): `APP_ID`, `DISCORD_TOKEN`
- test (`--test`): `TEST_APP_ID`, `TEST_DISCORD_TOKEN`

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Register slash commands if needed:

   ```bash
   npm run register
   # or: node src/register-commands.js --test
   ```

3. Start the Worker locally:

   ```bash
   npm run dev
   ```

4. Run the automated test suite:

   ```bash
   npm test
   ```

## Cloudflare deployment notes

- Durable Object bindings:
  - `SCHEDULER` -> `GuildScheduler`
  - `CONFIG` -> `GuildConfig`
- Durable Object migration tags in `wrangler.jsonc` are append-only after deployment.
- Non-inheritable environment bindings must be repeated inside environment blocks when needed.
