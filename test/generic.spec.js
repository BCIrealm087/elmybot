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

  it('isolates bounded feature config, atomic state, and cooldowns by namespace', async () => {
    const stub = configStubFor(uniqueId('feature-group'));
    const post = async (operation, body) => {
      const response = await stub.fetch(
        `https://config/internal/framework/${operation}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return { response, data: await response.json() };
    };

    expect((await post('config/set', {
      featureId: 'test.one',
      key: 'label',
      value: { text: 'Wins', enabled: true },
    })).data).toEqual({ ok: true });
    expect((await post('config/get', {
      featureId: 'test.one',
      key: 'label',
    })).data).toEqual({ value: { text: 'Wins', enabled: true } });
    expect((await post('config/get', {
      featureId: 'test.two',
      key: 'label',
    })).data).toEqual({ value: null });

    expect((await post('state/increment', {
      featureId: 'test.one',
      key: 'score',
      amount: 2,
    })).data).toEqual({ value: 2 });
    expect((await post('state/increment', {
      featureId: 'test.one',
      key: 'score',
    })).data).toEqual({ value: 3 });
    expect((await post('state/delete', {
      featureId: 'test.one',
      key: 'score',
    })).data).toEqual({ deleted: true });
    await Promise.all(Array.from({ length: 10 }, () => post('state/increment', {
      featureId: 'test.one',
      key: 'concurrent',
    })));
    expect((await post('state/get', {
      featureId: 'test.one',
      key: 'concurrent',
    })).data).toEqual({ value: 10 });

    const counter = {
      featureId: 'test.one',
      name: 'deaths',
      subject: 'NieR: Automata™ / ending E 🔥',
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      initial: 0,
    };
    expect((await post('state/bounded-counter', {
      ...counter,
      operation: 'get',
    })).data).toEqual({ value: 0 });
    expect((await post('state/bounded-counter', {
      ...counter,
      operation: 'increment',
      amount: 3,
    })).data).toEqual({ value: 3 });
    await Promise.all(Array.from({ length: 10 }, () =>
      post('state/bounded-counter', {
        ...counter,
        operation: 'decrement',
        amount: 1,
      })));
    expect((await post('state/bounded-counter', {
      ...counter,
      operation: 'get',
    })).data).toEqual({ value: 0 });
    expect((await post('state/bounded-counter', {
      ...counter,
      operation: 'set',
      value: 42,
    })).data).toEqual({ value: 42 });

    const lives = {
      featureId: 'test.one',
      name: 'lives',
      subject: 'player/one',
      min: -2,
      max: 2,
      initial: 1,
    };
    expect((await post('state/bounded-counter', {
      ...lives,
      operation: 'increment',
      amount: 10,
    })).data).toEqual({ value: 2 });
    expect((await post('state/bounded-counter', {
      ...lives,
      operation: 'decrement',
      amount: 10,
    })).data).toEqual({ value: -2 });
    expect((await post('state/bounded-counter', {
      ...lives,
      operation: 'reset',
    })).data).toEqual({ value: 1 });
    expect((await post('state/bounded-counter', {
      ...lives,
      subject: 'player/two',
      operation: 'get',
    })).data).toEqual({ value: 1 });

    const invalidCounter = await post('state/bounded-counter', {
      ...counter,
      subject: 'x'.repeat(301),
      operation: 'get',
    });
    expect(invalidCounter.response.status).toBe(422);
    expect(invalidCounter.data.userFacingError).toContain('between 1 and 300');
    const invalidCounterAmount = await post('state/bounded-counter', {
      ...counter,
      operation: 'increment',
      amount: 0,
    });
    expect(invalidCounterAmount.response.status).toBe(422);
    expect(invalidCounterAmount.data.userFacingError).toContain('between 1 and');
    const invalidCounterValue = await post('state/bounded-counter', {
      ...counter,
      operation: 'set',
      value: -1,
    });
    expect(invalidCounterValue.response.status).toBe(422);
    expect(invalidCounterValue.data.userFacingError).toContain('within the configured bounds');

    const cooldown = {
      featureId: 'test.one',
      actionKind: 'test.one.run.v1',
      scopeKey: 'discord:user-1',
      seconds: 30,
    };
    expect((await post('cooldown/claim', cooldown)).data).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect((await post('cooldown/claim', cooldown)).data).toMatchObject({
      allowed: false,
      retryAfterSeconds: expect.any(Number),
    });
    expect((await post('cooldown/claim', {
      ...cooldown,
      scopeKey: 'discord:user-2',
    })).data).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const invalid = await post('state/get', {
      featureId: 'test.one',
      key: '../other',
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.data.userFacingError).toContain('key is invalid');

    const publicList = await stub.fetch('https://config/list');
    expect(await publicList.json()).toEqual({ totalEntries: 0, keys: [] });
  });

  it('constructs an immutable job registry and rejects duplicate kinds', () => {
    const handler = {
      deliver: async () => {},
      calcScheduleTime: () => [1, 1000],
      validateJob: () => null,
    };
    const kind = 'test.message.send.v1';
    const registry = createJobHandlerRegistry({ [kind]: handler });

    expect(registry[kind]).toMatchObject(handler);
    expect(() => {
      registry[kind].deliver = async () => 'replacement';
    }).toThrow(TypeError);
    expect(() => {
      registry['test.other.v1'] = handler;
    }).toThrow(TypeError);
    expect(registry[kind].deliver).toBe(handler.deliver);
    expect(registry['test.other.v1']).toBeUndefined();
    expect(() => createJobHandlerRegistry(
      { [kind]: handler },
      { [kind]: handler },
    )).toThrow(`Duplicate scheduling job kind: \`${kind}\`.`);
  });
});
