import { describe, expect, it } from 'vitest';
import {
  createExecutionContext,
  env,
} from 'cloudflare:test';
import worker from '../src/index.js';
import {
  EXTERNAL_REQUEST_TIMEOUT_MS,
  withExternalRequestTimeout,
} from '../src/common.js';
import { createJobHandlerRegistry } from '../src/message-scheduling/index.js';

let idCounter = 0;

function uniqueId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function configStubFor(groupId) {
  const id = env.CONFIG.idFromName(groupId);
  return env.CONFIG.get(id);
}

describe('Platform-independent worker behavior', () => {
  it('adds a ten-second timeout to external requests without replacing caller signals', () => {
    const timed = withExternalRequestTimeout({ method: 'POST' });
    expect(timed.method).toBe('POST');
    expect(timed.signal).toBeInstanceOf(AbortSignal);
    expect(timed.signal.aborted).toBe(false);
    expect(EXTERNAL_REQUEST_TIMEOUT_MS).toBe(10_000);

    const callerController = new AbortController();
    const callerInit = { signal: callerController.signal };
    expect(withExternalRequestTimeout(callerInit)).toBe(callerInit);
  });

  it('returns 404 outside registered platform routes', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/', { method: 'GET' }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('stores config values through the GroupConfig durable object', async () => {
    const groupId = uniqueId('group');
    const stub = configStubFor(groupId);

    let response = await stub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'testEntries' }),
    });
    expect(await response.json()).toEqual({ value: null });

    response = await stub.fetch('https://config/append-to', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'testEntries', value: 'entry-1' }),
    });
    expect(await response.json()).toEqual({ ok: true });

    response = await stub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'testEntries' }),
    });
    expect(await response.json()).toEqual({ value: ['entry-1'] });

    response = await stub.fetch('https://config/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'testEntries', entries: ['entry-1'] }),
    });
    expect(await response.json()).toEqual({ ok: true });

    response = await stub.fetch('https://config/remove-from', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'testEntries', value: 'entry-1' }),
    });
    expect(await response.json()).toEqual({ ok: true });

    response = await stub.fetch('https://config/get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'testEntries' }),
    });
    expect(await response.json()).toEqual({ value: [] });
  });

  it('constructs an immutable job registry and rejects duplicate kinds', () => {
    const handler = {
      deliver: async () => {},
      calcScheduleTime: () => [1, 1000],
      validateJob: () => null,
    };
    const kind = 'test.message.send.v1';
    const registry = createJobHandlerRegistry({ [kind]: handler });

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry[kind])).toBe(true);
    expect(registry[kind]).toMatchObject(handler);
    expect(() => createJobHandlerRegistry(
      { [kind]: handler },
      { [kind]: handler },
    )).toThrow(`Duplicate scheduling job kind: \`${kind}\`.`);
  });
});

