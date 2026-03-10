import nacl from 'tweetnacl';
import { describe, it, expect } from 'vitest';
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
});