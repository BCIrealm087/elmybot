import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src';

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeSignedDiscordRequest({ body, secretKey, timestamp = `${Math.floor(Date.now() / 1000)}` }) {
  const message = new TextEncoder().encode(timestamp + body);
  const signature = nacl.sign.detached(message, secretKey);

  return new Request('https://example.com', {
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

function mockDiscordApi({ ownerId = 'owner-id' } = {}) {
  const patches = [];
  const sentMessages = [];
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url.startsWith('https://discord.com/api/v10/guilds/')) {
      return jsonResponse({ owner_id: ownerId });
    }

    if (url.includes('/webhooks/') && url.endsWith('/messages/@original')) {
      patches.push(JSON.parse(init.body));
      return jsonResponse({ ok: true });
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
  const id = env.SCHEDULER.idFromName(guildId);
  return env.SCHEDULER.get(id);
}

function configStubFor(guildId) {
  const id = env.CONFIG.idFromName(guildId);
  return env.CONFIG.get(id);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Discord interaction worker', () => {
  it('returns OK for health check GET', async () => {
    const response = await worker.fetch(new Request('https://example.com', { method: 'GET' }), env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
  });

  it('rejects non-POST/GET methods', async () => {
    const response = await worker.fetch(new Request('https://example.com', { method: 'PUT' }), env, createExecutionContext());
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method Not Allowed');
  });

  it('returns 400 when signature headers are missing', async () => {
    const response = await worker.fetch(
      new Request('https://example.com', {
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
      new Request('https://example.com', {
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
      type: 2,
      data: { name: 'alive' },
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
      data: { content: "I'm here!!1" },
    });
  });

  it('stores config values through the GuildConfig durable object', async () => {
    const guildId = uniqueId('guild');
    const stub = configStubFor(guildId);

    let response = await stub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles' }),
    });
    expect(await response.json()).toEqual({ value: null });

    response = await stub.fetch('https://config/append-to', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles', value: 'role-1' }),
    });
    expect(await response.json()).toEqual({ ok: true });

    response = await stub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles' }),
    });
    expect(await response.json()).toEqual({ value: ['role-1'] });

    response = await stub.fetch('https://config/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles', entries: ['role-1'] }),
    });
    expect(await response.json()).toEqual({ ok: true });

    response = await stub.fetch('https://config/remove-from', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles', value: 'role-1' }),
    });
    expect(await response.json()).toEqual({ ok: true });

    response = await stub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'allowedRoles' }),
    });
    expect(await response.json()).toEqual({ value: [] });
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
        guildId,
        channelId: 'channel-1',
        type: 'sayat',
        subject: 'later',
        timestamp: laterTs,
        repeats: false,
        extraData: {},
      }),
    });
    const laterJob = await laterResponse.json();

    const soonerResponse = await stub.fetch('https://do/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        guildId,
        channelId: 'channel-1',
        type: 'sayat',
        subject: 'sooner',
        timestamp: soonerTs,
        repeats: false,
        extraData: {},
      }),
    });
    const soonerJob = await soonerResponse.json();

    let listResponse = await stub.fetch('https://do/list');
    let listData = await listResponse.json();

    expect(listData.jobsPreview).toHaveLength(2);
    expect(listData.jobsPreview.map((job) => job.id)).toEqual([soonerJob.id, laterJob.id]);
    expect(listData.jobsPreview.map((job) => job.subject)).toEqual(['sooner', 'later']);

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
    expect(scheduledJob.subject).toBe('hello future');

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
    const { patches } = mockDiscordApi({ ownerId });

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

    const schedulerState = await schedulerStubFor(guildId).fetch('https://do/list');
    const schedulerData = await schedulerState.json();
    expect(schedulerData.totalJobs).toBe(1);
    expect(schedulerData.jobsPreview[0]).toMatchObject({
      type: 'sayat',
      subject: 'role-authorized message',
      channelId,
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
      type: 'sayat_random',
      repeats: true,
      extraData: {
        minInterval: 600,
        maxInterval: 900,
      },
    });
  });
});
