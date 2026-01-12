# elmybot

A lightweight Discord bot that schedules role pings, built as a Cloudflare Worker
with a per-guild Durable Object for reliable scheduling.

## Product overview

**What it does**
- Lets moderators schedule a role ping for a specific time.
- Supports listing and canceling scheduled pings.
- Can optionally repeat a ping daily.

**Who it's for**
- Server moderators and admins who need time-based role announcements.
- Product owners looking for a simple, auditable scheduling workflow.

**Why Cloudflare Workers + Durable Objects**
- **Edge-first**: interactions respond quickly to Discord.
- **Durable scheduling**: each guild has its own scheduler state.
- **Minimal infrastructure**: no separate database or servers to run.

## Architecture at a glance

```
Discord -> Worker (src/index.js) -> Durable Object (GuildScheduler)
                                     -> Discord API (send messages)
```

### Request flow
1. Discord sends an interaction to the Worker.
2. The Worker verifies the request signature.
3. The Worker routes the command and checks permissions.
4. Scheduling commands call the guild's Durable Object.
5. The Durable Object stores jobs and sets the next alarm.
6. On alarm, the Durable Object sends the role ping to Discord.

## Commands

### `/alive`
Health check used by admins to confirm the bot is responsive.

### `/pingat`
Schedule a role ping at a specific Unix timestamp.
- **timestamp**: Unix timestamp in seconds (required)
- **role**: role to mention (required)
- **repeat_daily**: if true, repeats every day (optional)

### `/pingat_list`
List the next scheduled pings for the server.

### `/pingat_cancel`
Cancel a scheduled ping by job ID.

## Permissions model

Scheduling is restricted to server moderators and owners. A user is allowed if:
- They have any of the configured moderator permissions (e.g. Manage Messages), or
- They are the server owner (verified via the Discord API).

You can change what counts as "moderator" in `src/permissions.js` (see
`MODERATOR_ANY_OF`).

## Data model

Scheduled jobs are stored in Durable Object storage under the `jobs` key as an
array of items shaped like:

```
{
  id: string,
  guildId: string,
  channelId: string,
  roleId: string,
  scheduledUnix: number,
  runAtMs: number,
  repeatDaily: boolean,
  createdBy: string | null
}
```

The scheduler sorts jobs by `runAtMs` and sets the next alarm accordingly.

## Configuration

Environment variables required at runtime:

- **PUBLIC_KEY**: Discord application public key (used to verify requests).
- **DISCORD_TOKEN**: Bot token used to post messages.
- **DISCORD_BOT_TOKEN**: Bot token used for guild owner lookups.
- **SCHEDULER**: Durable Object binding name.

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Register slash commands (optional but useful for testing):
   ```bash
   node src/register-commands.js
   ```

3. Run the worker locally:
   ```bash
   npm run dev
   ```

## Key files

- `src/index.js`: Worker entrypoint, routing, and Durable Object implementation.
- `src/permissions.js`: Permission helpers for moderator/owner checks.
- `src/register-commands.js`: Script to register slash commands.
- `wrangler.jsonc`: Cloudflare Worker/Durable Object configuration.
