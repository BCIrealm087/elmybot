import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../src/index.js';
import { ALARM_DRAIN_TIME_BUDGET_MS } from '../src/alarm-drain.js';
import { SCHEDULER_JOB_SCHEMA_VERSION } from '../src/message-scheduling/index.js';
import { commands, DISCORD_JOB_KINDS } from '../src/platforms/discord/commands.js';
import {
  CAPABILITIES,
  checkPermissions,
} from '../src/platforms/discord/discord-permissions.js';
import {
  getRandomTimeFromInterval,
  scheduleMessage,
} from '../src/platforms/discord/message-scheduling/index.js';
import {
  evalGifOptions,
  gifMessageCompose,
  gifMessageInnerContent,
  gifMessageOuterContent,
} from '../src/platforms/discord/gifs-extension.js';
import { putDiscordCommands } from '../src/platforms/discord/register-commands-request.js';
import { discordGroupConfigObjectName } from '../src/platforms/discord/group-config.js';

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeSignedDiscordRequest({ body, secretKey, timestamp = `${Math.floor(Date.now() / 1000)}` }) {
  const message = new TextEncoder().encode(timestamp + body);
  const signature = nacl.sign.detached(message, secretKey);

  return new Request('https://example.com/discord', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': toHex(signature),
      'X-Signature-Timestamp': timestamp,
    },
    body,
  });
}

let idCounter = 0;

function uniqueId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function buildSlashInteraction({
  id = uniqueId('interaction'),
  name,
  options = [],
  guildId = uniqueId('guild'),
  channelId = uniqueId('channel'),
  userId = uniqueId('user'),
  permissions = '0',
  roles = [],
  token = uniqueId('token'),
  applicationId = 'app-id',
} = {}) {
  return {
    id,
    type: 2,
    application_id: applicationId,
    token,
    guild_id: guildId,
    channel_id: channelId,
    data: { name, options },
    member: {
      permissions,
      roles,
      user: { id: userId },
    },
  };
}

async function dispatchInteraction(interaction, envOverrides = {}) {
  const keyPair = nacl.sign.keyPair();
  const body = JSON.stringify(interaction);
  const request = makeSignedDiscordRequest({ body, secretKey: keyPair.secretKey });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, PUBLIC_KEY: toHex(keyPair.publicKey), ...envOverrides }, ctx);
  return { response, ctx };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function mockDiscordApi({ ownerId = 'owner-id', patchStatus = 200 } = {}) {
  const patches = [];
  const sentMessages = [];
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    expect(init.signal).toBeInstanceOf(AbortSignal);

    if (url.startsWith('https://discord.com/api/v10/guilds/')) {
      return jsonResponse({ owner_id: ownerId });
    }

    if (url.includes('/webhooks/') && url.endsWith('/messages/@original')) {
      patches.push(JSON.parse(init.body));
      return jsonResponse({ ok: patchStatus < 400 }, patchStatus);
    }

    if (url.includes('/channels/') && url.endsWith('/messages')) {
      sentMessages.push(JSON.parse(init.body));
      return jsonResponse({ id: uniqueId('message') }, 200);
    }

    throw new Error(`Unexpected external fetch: ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, patches, sentMessages };
}

function schedulerStubFor(guildId) {
  const id = env.SCHEDULER.idFromName(`discord:guild:${guildId}`);
  return env.SCHEDULER.get(id);
}

function configStubFor(guildId) {
  const id = env.CONFIG.idFromName(discordGroupConfigObjectName(guildId));
  return env.CONFIG.get(id);
}

function legacyConfigStubFor(guildId) {
  return env.CONFIG.get(env.CONFIG.idFromName(guildId));
}

async function scheduleTestJob(stub, {
  sourceId = uniqueId('job'),
  guildId = uniqueId('guild'),
  channelId = uniqueId('channel'),
  subject = 'scheduled message',
  runAtMs = Date.now() - 1000,
} = {}) {
  const timestamp = Math.floor(runAtMs / 1000);
  const response = await stub.fetch('https://do/schedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: SCHEDULER_JOB_SCHEMA_VERSION,
      platform: 'discord',
      kind: DISCORD_JOB_KINDS.SEND_AT,
      groupKey: `discord:guild:${guildId}`,
      destination: { channelId },
      subject,
      timestamp,
      extraData: {
        guildId,
        channelId,
        gif: null,
      },
      repeats: false,
      createdBy: null,
      sourceEventId: `discord:${sourceId}`,
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Discord platform', () => {
  it('returns OK for health check GET', async () => {
    const response = await worker.fetch(new Request('https://example.com/discord', { method: 'GET' }), env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });

  it('rejects non-POST/GET methods', async () => {
    const response = await worker.fetch(new Request('https://example.com/discord', { method: 'PUT' }), env, createExecutionContext());
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method Not Allowed');
  });

  it('returns 400 when signature headers are missing', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 1 }),
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Bad Request');
  });

  it('returns 401 when signature is invalid', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/discord', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Ed25519': '00'.repeat(64),
          'X-Signature-Timestamp': `${Math.floor(Date.now() / 1000)}`,
        },
        body: JSON.stringify({ type: 1 }),
      }),
      { ...env, PUBLIC_KEY: '11'.repeat(32) },
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Invalid signature');
  });

  it('responds with PONG to valid signed PING interaction', async () => {
    const kp = nacl.sign.keyPair();
    const body = JSON.stringify({ type: 1 });
    const request = makeSignedDiscordRequest({ body, secretKey: kp.secretKey });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, PUBLIC_KEY: toHex(kp.publicKey) }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it('returns unknown-command interaction response for valid signed slash command', async () => {
    const kp = nacl.sign.keyPair();
    const body = JSON.stringify({
      type: 2,
      data: { name: 'does_not_exist' },
      token: 't',
      application_id: 'a',
    });
    const request = makeSignedDiscordRequest({ body, secretKey: kp.secretKey });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, PUBLIC_KEY: toHex(kp.publicKey) }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 4,
      data: {
        content: 'Unknown command: /does_not_exist',
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
  });

  it('routes /alive and returns immediate interaction response', async () => {
    const kp = nacl.sign.keyPair();
    const body = JSON.stringify({
      id: 'alive-interaction',
      type: 2,
      data: { name: 'alive' },
      token: 't',
      application_id: 'a',
      guild_id: 'alive-guild',
      channel_id: 'alive-channel',
      member: { user: { id: 'alive-user' } },
    });
    const request = makeSignedDiscordRequest({ body, secretKey: kp.secretKey });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, PUBLIC_KEY: toHex(kp.publicKey) }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 4,
      data: { content: "I'm here!!1" },
    });
  });

  it('defaults unknown command capabilities to deny', async () => {
    const missingPolicy = await checkPermissions({}, {}, {
      capability: 'missing.capability',
    });
    expect(missingPolicy).toEqual({
      allowedGroups: [],
      configured: false,
      ok: false,
    });
  });

  it.each([
    ['config_show_value', [{ name: 'entry', value: 'allowedRoles' }]],
    ['config_list_entries', []],
    ['config_allow_role', [{ name: 'role', value: '12345' }]],
    ['config_disallow_role', [{ name: 'role', value: '12345' }]],
  ])('denies configured scheduling roles access to /%s', async (name, options) => {
    const guildId = uniqueId('guild');
    const roleId = uniqueId('role');
    const memberId = uniqueId('member');
    const { patches } = mockDiscordApi({ ownerId: uniqueId('owner') });
    await configStubFor(guildId).fetch('https://config/append-to', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles', value: roleId }),
    });

    const { ctx } = await dispatchInteraction(buildSlashInteraction({
      name,
      options,
      guildId,
      userId: memberId,
      roles: [roleId],
    }));
    await waitOnExecutionContext(ctx);

    expect(patches).toHaveLength(1);
    expect(patches[0].content).toContain('Only members that fall into one of');
    expect(patches[0].content).not.toContain('allowed server role');
  });

  it.each([
    [
      'sayat',
      () => [
        { name: 'timestamp', value: Math.floor(Date.now() / 1000) + 3600 },
        { name: 'message', value: 'authorized message' },
      ],
      '✅ Scheduled job',
    ],
    ['doat_list', () => [], 'No scheduled jobs.'],
    ['doat_dead_letters', () => [], 'No recent failed scheduled-message deliveries.'],
    [
      'doat_cancel',
      () => [{ name: 'job_id', value: 'missing-job-id' }],
      'No job found: `missing-job-id`',
    ],
  ])('allows configured scheduling roles to execute /%s', async (name, options, expectedContent) => {
    const guildId = uniqueId('guild');
    const roleId = uniqueId('role');
    const memberId = uniqueId('member');
    const { patches } = mockDiscordApi({ ownerId: uniqueId('owner') });
    await configStubFor(guildId).fetch('https://config/append-to', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles', value: roleId }),
    });

    const { ctx } = await dispatchInteraction(buildSlashInteraction({
      name,
      options: options(),
      guildId,
      userId: memberId,
      roles: [roleId],
    }));
    await waitOnExecutionContext(ctx);

    expect(patches).toHaveLength(1);
    expect(patches[0].content).toContain(expectedContent);
  });

  it('authorizes intrinsic moderators without fetching the guild owner', async () => {
    const guildId = uniqueId('guild');
    const patches = [];
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://discord.com/api/v10/guilds/')) {
        throw new Error('guild owner lookup should not run');
      }
      if (url.includes('/webhooks/') && url.endsWith('/messages/@original')) {
        patches.push(JSON.parse(init.body));
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected external fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const interaction = buildSlashInteraction({
      name: 'config_list_entries',
      guildId,
      permissions: '32', // MANAGE_GUILD
    });

    const { ctx } = await dispatchInteraction(interaction);
    await waitOnExecutionContext(ctx);

    expect(patches[0].content).toBe('No configured entries.');
    expect(fetchMock.mock.calls.some(([input]) => (
      String(typeof input === 'string' ? input : input.url)
        .startsWith('https://discord.com/api/v10/guilds/')
    ))).toBe(false);
  });

  it('keeps initial and repeated random schedules within inclusive bounds', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_999);
    const random = vi.spyOn(Math, 'random');
    const job = {
      id: 'bounded-random-job',
      timestamp: 1000,
      runAtMs: 1_000_000,
      extraData: { minInterval: 10, maxInterval: 20 },
    };

    random.mockReturnValue(0);
    expect(getRandomTimeFromInterval(job)).toEqual([1010, 1_010_000]);

    random.mockReturnValue(0.999999999);
    expect(getRandomTimeFromInterval(job)).toEqual([1020, 1_020_000]);

    now.mockReturnValue(500_000);
    expect(getRandomTimeFromInterval(job, true)).toEqual([1020, 1_020_000]);
  });

  it('reads an unexpected scheduling response once and logs correlated context', async () => {
    const interaction = buildSlashInteraction({
      id: 'interaction-schedule-error',
      name: 'sayat',
    });
    const responseText = vi.fn(async () => 'upstream failure');
    const scheduleFetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: responseText,
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = {
      idFromName: vi.fn(() => 'scheduler-id'),
      get: vi.fn(() => ({ fetch: scheduleFetch })),
    };

    const result = await scheduleMessage(interaction, { SCHEDULER: scheduler }, {
      kind: DISCORD_JOB_KINDS.SEND_AT,
      getOptions: () => ({
        subject: 'message',
        timestamp: Math.floor(Date.now() / 1000) + 3600,
        repeats: false,
      }),
      eval: () => null,
      composer: { repeatDescription: () => 'daily' },
    });

    expect(responseText).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(
      'Unknown error. Reference: `discord:interaction-schedule-error`.',
    );
    expect(scheduleFetch.mock.calls[0][1].headers['x-correlation-id'])
      .toBe('discord:interaction-schedule-error');

    const log = JSON.parse(consoleError.mock.calls[0][0]);
    expect(log).toMatchObject({
      event: 'discord.scheduling_failed',
      platform: 'discord',
      correlationId: 'discord:interaction-schedule-error',
      groupId: interaction.guild_id,
      command: 'sayat',
      jobKind: DISCORD_JOB_KINDS.SEND_AT,
      error: { status: 503 },
    });
  });

  it('logs unexpected command failures and returns a safe reference', async () => {
    const guildId = uniqueId('guild');
    const ownerId = uniqueId('owner');
    const interaction = buildSlashInteraction({
      id: 'interaction-command-error',
      name: 'config_list_entries',
      guildId,
      userId: ownerId,
    });
    const patches = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://discord.com/api/v10/guilds/')) {
        throw new Error('owner lookup failed');
      }
      if (url.includes('/webhooks/') && url.endsWith('/messages/@original')) {
        patches.push(JSON.parse(init.body));
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected external fetch: ${url}`);
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { ctx } = await dispatchInteraction(interaction);
    await waitOnExecutionContext(ctx);

    expect(patches[0].content).toBe(
      'Unknown error. Reference: `discord:interaction-command-error`.',
    );
    const log = JSON.parse(consoleError.mock.calls[0][0]);
    expect(log).toMatchObject({
      event: 'discord.command_failed',
      platform: 'discord',
      correlationId: 'discord:interaction-command-error',
      groupId: guildId,
      command: 'config_list_entries',
      error: { name: 'Error', message: 'owner lookup failed' },
    });
  });

  it('observes deferred response edit failures through the waitUntil chain', async () => {
    const guildId = uniqueId('guild');
    const ownerId = uniqueId('owner');
    mockDiscordApi({ ownerId, patchStatus: 500 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const interaction = buildSlashInteraction({
      id: 'interaction-patch-error',
      name: 'config_list_entries',
      guildId,
      userId: ownerId,
    });

    const { ctx } = await dispatchInteraction(interaction);
    await waitOnExecutionContext(ctx);

    const logs = consoleError.mock.calls.map(([entry]) => JSON.parse(entry));
    expect(logs).toContainEqual(expect.objectContaining({
      event: 'discord.deferred_response_failed',
      platform: 'discord',
      correlationId: 'discord:interaction-patch-error',
      groupId: guildId,
      command: 'config_list_entries',
      error: expect.objectContaining({ status: 500 }),
    }));
  });

  it('stores scheduled jobs sorted by run time and supports cancellation through the scheduler DO', async () => {
    const guildId = uniqueId('guild');
    const stub = schedulerStubFor(guildId);

    const laterTs = Math.floor(Date.now() / 1000) + 7200;
    const soonerTs = laterTs - 3600;

    const laterResponse = await stub.fetch('https://do/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: SCHEDULER_JOB_SCHEMA_VERSION,
        platform: 'discord',
        kind: DISCORD_JOB_KINDS.SEND_AT,
        groupKey: `discord:guild:${guildId}`,
        destination: { channelId: 'channel-1' },
        sourceEventId: 'discord:direct-later',
        subject: 'later',
        timestamp: laterTs,
        repeats: false,
        extraData: {
          guildId,
          channelId: 'channel-1',
          gif: null,
        },
      }),
    });
    const laterJob = await laterResponse.json();

    const soonerResponse = await stub.fetch('https://do/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: SCHEDULER_JOB_SCHEMA_VERSION,
        platform: 'discord',
        kind: DISCORD_JOB_KINDS.SEND_AT,
        groupKey: `discord:guild:${guildId}`,
        destination: { channelId: 'channel-1' },
        sourceEventId: 'discord:direct-sooner',
        subject: 'sooner',
        timestamp: soonerTs,
        repeats: false,
        extraData: {
          guildId,
          channelId: 'channel-1',
          gif: null,
        },
      }),
    });
    const soonerJob = await soonerResponse.json();

    let listResponse = await stub.fetch('https://do/list');
    let listData = await listResponse.json();

    expect(listData.jobsPreview).toHaveLength(2);
    expect(listData.jobsPreview.map((job) => job.id)).toEqual([soonerJob.id, laterJob.id]);
    expect(listData.jobsPreview.map((job) => job.subject)).toEqual(['sooner', 'later']);
    expect(listData.totalJobs).toBe(2);

    const cancelResponse = await stub.fetch('https://do/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: soonerJob.id }),
    });
    expect((await cancelResponse.json()).timestamp).toBe(soonerTs);

    listResponse = await stub.fetch('https://do/list');
    listData = await listResponse.json();
    expect(listData.totalJobs).toBe(1);
    expect(listData.jobsPreview[0].id).toBe(laterJob.id);
  });

  it('deduplicates scheduling transactionally by source event ID', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const stub = schedulerStubFor(guildId);
    const sourceEventId = `discord:${uniqueId('interaction')}`;
    const timestamp = Math.floor(Date.now() / 1000) + 3600;
    const requestBody = {
      schemaVersion: SCHEDULER_JOB_SCHEMA_VERSION,
      platform: 'discord',
      kind: DISCORD_JOB_KINDS.SEND_AT,
      groupKey: `discord:guild:${guildId}`,
      destination: { channelId },
      sourceEventId,
      subject: 'only once',
      timestamp,
      repeats: false,
      extraData: {
        guildId,
        channelId,
        gif: null,
      },
    };

    const schedule = () => stub.fetch('https://do/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const first = await (await schedule()).json();
    const replay = await (await schedule()).json();
    expect(replay).toEqual(first);

    const list = await (await stub.fetch('https://do/list')).json();
    expect(list.totalJobs).toBe(1);
    expect(list.jobsPreview[0]).toMatchObject({
      id: first.id,
      kind: DISCORD_JOB_KINDS.SEND_AT,
      subject: 'only once',
    });
  });

  it('rejects malformed shared envelopes and adapter payloads before persistence', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const stub = schedulerStubFor(guildId);
    const timestamp = Math.floor(Date.now() / 1000) + 3600;
    const valid = {
      schemaVersion: SCHEDULER_JOB_SCHEMA_VERSION,
      platform: 'discord',
      kind: DISCORD_JOB_KINDS.SEND_AT,
      groupKey: `discord:guild:${guildId}`,
      destination: { channelId },
      sourceEventId: `discord:${uniqueId('interaction')}`,
      subject: 'validated message',
      timestamp,
      repeats: false,
      createdBy: null,
      extraData: { guildId, channelId, gif: null },
    };
    const invalidCases = [
      [{ ...valid, schemaVersion: 99 }, 'Unsupported scheduling schema version.'],
      [{ ...valid, destination: {} }, 'Scheduling destination is required.'],
      [
        { ...valid, destination: { channelId: 'different-channel' } },
        'Discord scheduling destination metadata is inconsistent.',
      ],
      [{ ...valid, timestamp: null }, 'Scheduling handler produced invalid time metadata.'],
    ];

    for (const [body, message] of invalidCases) {
      const response = await stub.fetch('https://do/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ userFacingError: message });
    }

    const malformedJson = await stub.fetch('https://do/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformedJson.status).toBe(400);
    expect((await malformedJson.json()).userFacingError).toBe(
      'Request body must be valid JSON.',
    );
    expect((await (await stub.fetch('https://do/list')).json()).totalJobs).toBe(0);
  });

  it('defers /sayat, patches the original response, then supports listing and canceling the scheduled job', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const ownerId = uniqueId('owner');
    const { patches } = mockDiscordApi({ ownerId });

    const timestamp = Math.floor(Date.now() / 1000) + 3600;
    const scheduleInteraction = buildSlashInteraction({
      name: 'sayat',
      guildId,
      channelId,
      userId: ownerId,
      options: [
        { name: 'timestamp', value: timestamp },
        { name: 'message', value: 'hello future' },
      ],
    });

    const { response: scheduleResponse, ctx: scheduleCtx } = await dispatchInteraction(scheduleInteraction);
    expect(scheduleResponse.status).toBe(200);
    expect(await scheduleResponse.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(scheduleCtx);

    expect(patches).toHaveLength(1);
    expect(patches[0].content).toContain('✅ Scheduled job');
    expect(patches[0].content).toContain('Job ID:');
    expect(patches[0].allowed_mentions).toEqual({ parse: [] });

    const scheduler = schedulerStubFor(guildId);
    const listAfterSchedule = await scheduler.fetch('https://do/list');
    const listAfterScheduleData = await listAfterSchedule.json();
    expect(listAfterScheduleData.totalJobs).toBe(1);
    const scheduledJob = listAfterScheduleData.jobsPreview[0];
    expect(scheduledJob).toMatchObject({
      subject: 'hello future',
      extraData: {
        guildId,
        channelId,
        gif: null,
      },
    });

    const listInteraction = buildSlashInteraction({
      name: 'doat_list',
      guildId,
      channelId,
      userId: ownerId,
    });
    const { response: listResponse, ctx: listCtx } = await dispatchInteraction(listInteraction);
    expect(await listResponse.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(listCtx);

    expect(patches).toHaveLength(2);
    expect(patches[1].content).toContain('📌 Scheduled jobs (1 total, showing 1):');
    expect(patches[1].content).toContain('hello future');
    expect(patches[1].content).toContain(scheduledJob.id);

    const cancelInteraction = buildSlashInteraction({
      name: 'doat_cancel',
      guildId,
      channelId,
      userId: ownerId,
      options: [{ name: 'job_id', value: scheduledJob.id }],
    });
    const { response: cancelResponse, ctx: cancelCtx } = await dispatchInteraction(cancelInteraction);
    expect(await cancelResponse.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(cancelCtx);

    expect(patches).toHaveLength(3);
    expect(patches[2].content).toContain('🗑️ Cancelled job');
    expect(patches[2].content).toContain(scheduledJob.id);

    const finalList = await scheduler.fetch('https://do/list');
    expect((await finalList.json()).jobsPreview).toEqual([]);
  });

  it('allows a configured guild role to use protected scheduling commands', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const ownerId = uniqueId('owner');
    const roleId = uniqueId('role');
    const memberId = uniqueId('member');
    const { patches, fetchMock } = mockDiscordApi({ ownerId });

    const allowRoleInteraction = buildSlashInteraction({
      name: 'config_allow_role',
      guildId,
      channelId,
      userId: ownerId,
      options: [{ name: 'role', value: roleId }],
    });

    const { response: allowResponse, ctx: allowCtx } = await dispatchInteraction(allowRoleInteraction);
    expect(await allowResponse.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(allowCtx);

    expect(patches[0].content).toContain(`<@&${roleId}>`);

    const configState = await configStubFor(guildId).fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles' }),
    });
    expect(await configState.json()).toEqual({ value: [roleId] });

    const timestamp = Math.floor(Date.now() / 1000) + 5400;
    const scheduleInteraction = buildSlashInteraction({
      name: 'sayat',
      guildId,
      channelId,
      userId: memberId,
      roles: [roleId],
      options: [
        { name: 'timestamp', value: timestamp },
        { name: 'message', value: 'role-authorized message' },
      ],
    });

    const { response: scheduleResponse, ctx: scheduleCtx } = await dispatchInteraction(scheduleInteraction);
    expect(await scheduleResponse.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(scheduleCtx);

    expect(patches[1].content).toContain('✅ Scheduled job');
    expect(patches[1].content).toContain('Job ID:');
    expect(fetchMock.mock.calls.filter(([input]) => (
      String(typeof input === 'string' ? input : input.url)
        .startsWith('https://discord.com/api/v10/guilds/')
    ))).toHaveLength(1);

    const schedulerState = await schedulerStubFor(guildId).fetch('https://do/list');
    const schedulerData = await schedulerState.json();
    expect(schedulerData.totalJobs).toBe(1);
    expect(schedulerData.jobsPreview[0]).toMatchObject({
      kind: DISCORD_JOB_KINDS.SEND_AT,
      subject: 'role-authorized message',
      extraData: {
        guildId,
        channelId,
        gif: null,
      },
    });
  });

  it('lazily migrates legacy Discord configuration into the namespaced object once', async () => {
    const guildId = uniqueId('legacy-guild');
    const roleId = uniqueId('legacy-role');
    const lateLegacyRoleId = uniqueId('late-legacy-role');
    const legacyStub = legacyConfigStubFor(guildId);

    const legacyWrite = await legacyStub.fetch('https://config/append-to', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles', value: roleId }),
    });
    expect(legacyWrite.status).toBe(200);

    const permissions = await Promise.all([0, 1].map(() => checkPermissions(
      buildSlashInteraction({
        name: 'sayat',
        guildId,
        userId: uniqueId('member'),
        roles: [roleId],
      }),
      env,
      { capability: CAPABILITIES.SCHEDULE_CREATE },
    )));
    expect(permissions.map(({ ok }) => ok)).toEqual([true, true]);

    const namespacedStub = configStubFor(guildId);
    const namespacedState = await namespacedStub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles' }),
    });
    expect(await namespacedState.json()).toEqual({ value: [roleId] });
    await runInDurableObject(namespacedStub, async (_instance, state) => {
      expect(await state.storage.get('__identityMigration')).toMatchObject({
        source: guildId,
      });
    });
    const listedState = await namespacedStub.fetch('https://config/list');
    expect(await listedState.json()).toEqual({
      totalEntries: 1,
      keys: ['allowedRoles'],
    });

    await legacyStub.fetch('https://config/append-to', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles', value: lateLegacyRoleId }),
    });
    const unchangedNamespacedState = await configStubFor(guildId).fetch(
      'https://config/get',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'allowedRoles' }),
      },
    );
    expect(await unchangedNamespacedState.json()).toEqual({ value: [roleId] });

    const legacyState = await legacyStub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles' }),
    });
    expect(await legacyState.json()).toEqual({
      value: [lateLegacyRoleId, roleId].sort(),
    });
  });

  it('supports repeating random schedules and reports their repeat description', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const ownerId = uniqueId('owner');
    const { patches } = mockDiscordApi({ ownerId });

    const interaction = buildSlashInteraction({
      name: 'sayat_random',
      guildId,
      channelId,
      userId: ownerId,
      options: [
        { name: 'message', value: 'random hello' },
        { name: 'min_interval', value: 600 },
        { name: 'max_interval', value: 900 },
        { name: 'repeats', value: true },
      ],
    });

    const { response, ctx } = await dispatchInteraction(interaction);
    expect(await response.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(ctx);

    expect(patches).toHaveLength(1);
    expect(patches[0].content).toContain('✅ Scheduled job');
    expect(patches[0].content).toContain('Repeats randomly');
    expect(patches[0].allowed_mentions).toEqual({ parse: [] });

    const schedulerState = await schedulerStubFor(guildId).fetch('https://do/list');
    const schedulerData = await schedulerState.json();
    expect(schedulerData.totalJobs).toBe(1);
    expect(schedulerData.jobsPreview[0]).toMatchObject({
      kind: DISCORD_JOB_KINDS.SEND_RANDOM,
      repeats: true,
      extraData: {
        minInterval: 600,
        maxInterval: 900,
      },
    });
  });

  it('accepts /sayat with a GIF query, stores GIF metadata, and renders list entries with GIF marker', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const ownerId = uniqueId('owner');
    const { patches } = mockDiscordApi({ ownerId });

    const timestamp = Math.floor(Date.now() / 1000) + 1800;
    const scheduleInteraction = buildSlashInteraction({
      name: 'sayat',
      guildId,
      channelId,
      userId: ownerId,
      options: [
        { name: 'timestamp', value: timestamp },
        { name: 'message', value: 'gif message title' },
        { name: 'gif', value: 'cat dance' },
      ],
    });

    const { response: scheduleResponse, ctx: scheduleCtx } = await dispatchInteraction(scheduleInteraction);
    expect(await scheduleResponse.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(scheduleCtx);

    expect(patches).toHaveLength(1);
    expect(patches[0].content).toContain('✅ Scheduled job');

    const schedulerState = await schedulerStubFor(guildId).fetch('https://do/list');
    const schedulerData = await schedulerState.json();
    expect(schedulerData.totalJobs).toBe(1);
    expect(schedulerData.jobsPreview[0]).toMatchObject({
      kind: DISCORD_JOB_KINDS.SEND_AT,
      subject: 'gif message title',
      extraData: { gif: 'cat dance' },
    });

    const listInteraction = buildSlashInteraction({
      name: 'doat_list',
      guildId,
      channelId,
      userId: ownerId,
    });
    const { response: listResponse, ctx: listCtx } = await dispatchInteraction(listInteraction);
    expect(await listResponse.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(listCtx);

    expect(patches).toHaveLength(2);
    expect(patches[1].content).toContain('`gif message title` (with `cat dance` gif)');
  });

  it('rejects /sayat gif search strings longer than 20 chars with a user-facing error', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const ownerId = uniqueId('owner');
    const { patches } = mockDiscordApi({ ownerId });

    const tooLongQuery = 'this query is definitely too long';
    const timestamp = Math.floor(Date.now() / 1000) + 1800;
    const interaction = buildSlashInteraction({
      name: 'sayat',
      guildId,
      channelId,
      userId: ownerId,
      options: [
        { name: 'timestamp', value: timestamp },
        { name: 'message', value: 'gif message title' },
        { name: 'gif', value: tooLongQuery },
      ],
    });

    const { response, ctx } = await dispatchInteraction(interaction);
    expect(await response.json()).toEqual({
      type: 5,
      data: {
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    await waitOnExecutionContext(ctx);

    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      content: 'Search string too long (max 20 chars).',
      flags: 64,
      allowed_mentions: { parse: [] },
    });

    const schedulerState = await schedulerStubFor(guildId).fetch('https://do/list');
    const schedulerData = await schedulerState.json();
    expect(schedulerData.totalJobs).toBe(0);
  });

  it('normalizes omitted, empty, whitespace, and valid optional GIF queries', () => {
    const cases = [
      { input: undefined, normalized: null, error: null },
      { input: '', normalized: null, error: null },
      { input: '   ', normalized: null, error: null },
      { input: '  cat dance  ', normalized: 'cat dance', error: null },
      {
        input: 'this query is definitely too long',
        normalized: 'this query is definitely too long',
        error: 'Search string too long (max 20 chars).',
      },
    ];

    for (const testCase of cases) {
      const options = { extraData: { gif: testCase.input } };
      expect(evalGifOptions(options)).toBe(testCase.error);
      expect(options.extraData.gif).toBe(testCase.normalized);
    }
  });

  it('bounds each alarm batch and re-arms immediately for remaining due jobs', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const stub = schedulerStubFor(guildId);
    const sentMessages = [];
    let nowMs = 2_100_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    vi.stubGlobal('fetch', vi.fn(async (_input, init = {}) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      sentMessages.push(JSON.parse(init.body).content);
      return jsonResponse({ id: uniqueId('message') });
    }));

    const dueAtMs = nowMs + 1_000;
    for (let index = 0; index < 21; index++) {
      await scheduleTestJob(stub, {
        sourceId: `batch-job-${String(index).padStart(2, '0')}`,
        guildId,
        channelId,
        subject: `batch-message-${index}`,
        runAtMs: dueAtMs,
      });
    }

    nowMs = dueAtMs + 1_000;
    await runInDurableObject(stub, async (instance) => instance.alarm());

    expect(sentMessages).toHaveLength(20);
    const remainingResponse = await stub.fetch('https://do/list');
    const remainingData = await remainingResponse.json();
    expect(remainingData.totalJobs).toBe(1);
    expect(remainingData.jobsPreview).toHaveLength(1);
    const [remaining] = remainingData.jobsPreview;
    expect(new Set([...sentMessages, remaining.subject])).toEqual(
      new Set(Array.from({ length: 21 }, (_, index) => `batch-message-${index}`)),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).toBeGreaterThanOrEqual(
        remaining.delivery.nextAttemptAtMs,
      );
      expect(nextAlarm).toBeLessThanOrEqual(Date.now() + 1_000);
      await state.storage.deleteAlarm();
    });
  });

  it('stops an alarm at its time budget and immediately re-arms due work', async () => {
    const guildId = uniqueId('guild');
    const channelId = uniqueId('channel');
    const stub = schedulerStubFor(guildId);
    const sentMessages = [];
    let nowMs = 2_100_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    vi.stubGlobal('fetch', vi.fn(async (_input, init = {}) => {
      sentMessages.push(JSON.parse(init.body).content);
      nowMs += ALARM_DRAIN_TIME_BUDGET_MS;
      return jsonResponse({ id: uniqueId('message') });
    }));

    for (let index = 0; index < 2; index++) {
      await scheduleTestJob(stub, {
        sourceId: `timed-job-${index}`,
        guildId,
        channelId,
        subject: `timed-message-${index}`,
        runAtMs: nowMs - 1_000,
      });
    }

    await runInDurableObject(stub, async (instance) => instance.alarm());

    expect(sentMessages).toHaveLength(1);
    expect((await (await stub.fetch('https://do/list')).json()).totalJobs).toBe(1);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(nowMs);
      await state.storage.deleteAlarm();
    });
  });

  it('dead-letters a terminal delivery failure and continues with later due jobs', async () => {
    const guildId = uniqueId('guild');
    const stub = schedulerStubFor(guildId);
    const failedChannelId = uniqueId('deleted-channel');
    const liveChannelId = uniqueId('live-channel');
    const sentChannels = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.includes(`/channels/${failedChannelId}/messages`)) {
        return jsonResponse({ message: 'Unknown Channel' }, 404);
      }
      if (url.includes(`/channels/${liveChannelId}/messages`)) {
        sentChannels.push(liveChannelId);
        return jsonResponse({ id: uniqueId('message') });
      }
      throw new Error(`Unexpected external fetch: ${url}`);
    }));

    const nowMs = Date.now();
    const terminalJob = await scheduleTestJob(stub, {
      sourceId: 'terminal-job',
      guildId,
      channelId: failedChannelId,
      runAtMs: nowMs - 2000,
    });
    await scheduleTestJob(stub, {
      sourceId: 'later-job',
      guildId,
      channelId: liveChannelId,
      runAtMs: nowMs - 1000,
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
      expect(sentChannels).toEqual([liveChannelId]);

      const log = JSON.parse(consoleError.mock.calls[0][0]);
      expect(log).toMatchObject({
        event: 'scheduler.delivery_failed',
        platform: 'discord',
        correlationId: 'discord:terminal-job',
        groupId: guildId,
        jobKind: DISCORD_JOB_KINDS.SEND_AT,
        jobId: terminalJob.id,
        attempt: 1,
        retryable: false,
        error: {
          name: 'DeliveryError',
          code: 'discord_http_error',
          metadata: { status: 404 },
        },
      });
    });

    const jobsResponse = await stub.fetch('https://do/list');
    expect((await jobsResponse.json()).totalJobs).toBe(0);

    const deadLettersResponse = await stub.fetch('https://do/dead-letters');
    expect(deadLettersResponse.status).toBe(200);
    const deadLettersData = await deadLettersResponse.json();
    expect(deadLettersData.totalDeadLetters).toBe(1);
    expect(deadLettersData.deadLettersPreview).toHaveLength(1);
    expect(deadLettersData.deadLettersPreview[0]).toMatchObject({
      job: {
        id: terminalJob.id,
        delivery: {
          state: 'dead_letter',
          lastError: { code: 'discord_http_error' },
        },
      },
    });

    const commandResult = await commands.doat_dead_letters.exec({
      id: uniqueId('interaction'),
      guild_id: guildId,
    }, env);
    expect(commandResult.flags).toBe(64);
    expect(commandResult.content).toContain('Failed scheduled deliveries (1 total, showing 1)');
    expect(commandResult.content).toContain(terminalJob.id);
    expect(commandResult.content).toContain('discord_http_error');
  });

  it('fails command registration when Discord returns a non-2xx response', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ message: 'Unauthorized' }, 401);
    });

    await expect(putDiscordCommands({
      appId: 'app-id',
      token: 'token',
      commandDescriptors: [],
      fetchImpl,
      log: () => {},
    })).rejects.toThrow('Discord command registration failed with status 401.');
  });

  it('explicitly re-arms retryable delivery failures with backoff', async () => {
    const guildId = uniqueId('guild');
    const stub = schedulerStubFor(guildId);

    vi.stubGlobal('fetch', vi.fn(async () => (
      jsonResponse({ message: 'Temporary failure' }, 503)
    )));

    const retryJob = await scheduleTestJob(stub, {
      sourceId: 'retry-job',
      guildId,
    });
    const beforeAlarm = Date.now();
    await runInDurableObject(stub, async (instance) => instance.alarm());

    const jobs = (await (await stub.fetch('https://do/list')).json()).jobsPreview;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: retryJob.id,
      delivery: {
        state: 'retry_wait',
        attempts: 1,
        lastError: {
          code: 'discord_http_error',
          metadata: { status: 503 },
        },
      },
    });
    expect(jobs[0].delivery.nextAttemptAtMs).toBeGreaterThanOrEqual(
      beforeAlarm + 30_000,
    );

    await runInDurableObject(stub, async (_instance, state) => {
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).toBe(jobs[0].delivery.nextAttemptAtMs);
      await state.storage.deleteAlarm();
    });
  });

  it('dead-letters retryable failures after the fifth attempt', async () => {
    const guildId = uniqueId('guild');
    const stub = schedulerStubFor(guildId);
    let nowMs = 2_000_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    vi.stubGlobal('fetch', vi.fn(async () => (
      jsonResponse({ message: 'Temporary failure' }, 503)
    )));

    const exhaustedJob = await scheduleTestJob(stub, {
      sourceId: 'exhausted-job',
      guildId,
      runAtMs: nowMs - 1000,
    });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await runInDurableObject(stub, async (instance) => instance.alarm());
      if (attempt < 5) {
        const list = await (await stub.fetch('https://do/list')).json();
        expect(list.totalJobs).toBe(1);
        expect(list.jobsPreview[0].delivery.attempts).toBe(attempt);
        nowMs = list.jobsPreview[0].delivery.nextAttemptAtMs;
      }
    }

    expect((await (await stub.fetch('https://do/list')).json()).totalJobs).toBe(0);
    const deadLetters = await (await stub.fetch('https://do/dead-letters')).json();
    expect(deadLetters.totalDeadLetters).toBe(1);
    expect(deadLetters.deadLettersPreview[0].job).toMatchObject({
      id: exhaustedJob.id,
      delivery: {
        state: 'dead_letter',
        attempts: 5,
        lastError: { code: 'discord_http_error' },
      },
    });
  });

  it('composes GIF deliveries using the KLIPY result URL and safe mentions', async () => {
    const fetchMock = vi.fn(async (input, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const url = typeof input === 'string' ? input : String(input);
      if (!url.startsWith('https://api.klipy.com/v2/search')) {
        throw new Error(`Unexpected external fetch: ${url}`);
      }
      return jsonResponse({
        results: [
          {
            media_formats: {
              gif: { url: 'https://cdn.example.com/dance.gif' },
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const composed = await gifMessageCompose(
      {
        innerContent: gifMessageInnerContent,
        allowedMentions: () => ({ parse: [] }),
        outerContent: gifMessageOuterContent,
      },
      { KLIPY_API_KEY: 'k-api', KLIPY_API_KEY_NAME: 'k-client' },
      { subject: 'dance!', extraData: { gif: 'dance cat' } },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const klipyUrl = fetchMock.mock.calls[0][0].toString();
    expect(klipyUrl).toContain('https://api.klipy.com/v2/search?');
    expect(klipyUrl).toContain('q=dance+cat');
    expect(klipyUrl).toContain('key=k-api');
    expect(klipyUrl).toContain('client_key=k-client');
    expect(klipyUrl).toContain('limit=50');
    expect(klipyUrl).toContain('random=true');
    expect(klipyUrl).toContain('media_filter=gif');

    expect(composed).toEqual({
      allowed_mentions: { parse: [] },
      content: 'dance!',
      embeds: [
        { image: { url: 'https://cdn.example.com/dance.gif' } },
      ],
    });
  });

  it('composes repeated GIF deliveries with varied GIF attachments for the same search query', async () => {
    const gifUrls = Array.from(
      { length: 10 },
      (_, index) => `https://cdn.example.com/dance-${index % 3}.gif`,
    );
    let requestIndex = 0;
    const fetchMock = vi.fn(async (input, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const url = new URL(typeof input === 'string' ? input : String(input));
      if (!url.toString().startsWith('https://api.klipy.com/v2/search')) {
        throw new Error(`Unexpected external fetch: ${url}`);
      }

      const gifUrl = gifUrls[requestIndex];
      requestIndex += 1;
      return jsonResponse({
        results: [
          {
            media_formats: {
              gif: { url: gifUrl },
            },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const composer = {
      innerContent: gifMessageInnerContent,
      allowedMentions: () => ({ parse: [] }),
      outerContent: gifMessageOuterContent,
    };
    const composedMessages = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (
        gifMessageCompose(
          composer,
          { KLIPY_API_KEY: 'k-api', KLIPY_API_KEY_NAME: 'k-client' },
          { subject: `dance ${index}`, extraData: { gif: 'dance cat' } },
        )
      )),
    );

    expect(fetchMock).toHaveBeenCalledTimes(10);
    const klipyUrls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(klipyUrls.every((url) => url.searchParams.get('q') === 'dance cat')).toBe(true);
    expect(klipyUrls.every((url) => url.searchParams.get('limit') === '50')).toBe(true);
    expect(klipyUrls.every((url) => url.searchParams.get('random') === 'true')).toBe(true);

    const attachedGifUrls = composedMessages.map((message) => message.embeds[0].image.url);
    expect(new Set(attachedGifUrls).size).toBeGreaterThan(1);
  });
});
