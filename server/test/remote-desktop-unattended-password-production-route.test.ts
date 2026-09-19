import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';

const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
const browserPublicKeySpki = (key.export({ format: 'der', type: 'spki' }) as Buffer)
  .toString('base64url');
const browserKeyThumbprint = createHash('sha256')
  .update(Buffer.from(browserPublicKeySpki, 'base64url'))
  .digest('base64url');
const requestBody = {
  publicNodeId: 5_837_462_190,
  password: 'Correct horse 4! battery',
  browserPublicKeySpki,
  browserKeyThumbprint,
};

function env(): Env {
  return {
    DATABASE_URL: 'postgres://unused',
    JWT_SIGNING_KEY: 'production-route-test-jwt-key-at-least-32-bytes',
    BOT_ENCRYPTION_KEY: 'production-route-test-bot-key-at-least-32-bytes',
    SERVER_URL: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    NODE_ENV: 'test',
    DB: {} as Database,
  };
}

function proofRequest(): Request {
  return new Request('https://app.example.test/api/remote-desktop/unattended-password/proof', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

describe('production unattended-password public route mount', () => {
  it('does not initialize the PostgreSQL/KDF proof stack during app startup', async () => {
    const unavailableDb = new Proxy({}, {
      get: () => { throw new Error('proof_stack_initialized_eagerly'); },
    }) as Database;
    const lazyEnv = env();
    lazyEnv.DB = unavailableDb;
    const app = buildApp(lazyEnv);

    await expect(app.request('https://app.example.test/health').then((response) => response.status))
      .resolves.toBe(200);
  });

  it('mounts the flat proof route and returns only the post-proof bootstrap', async () => {
    const prove = vi.fn(async () => ({
      ok: true as const,
      serverId: 'server-password-1',
      hostId: 'host-password-1',
      bootstrapTicket: 'bootstrap-password-1',
      expiresAt: Date.now() + 30_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
    }));
    const response = await buildApp(env(), {
      unattendedPasswordProofService: { prove },
    }).request(proofRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      serverId: 'server-password-1',
      hostId: 'host-password-1',
      bootstrapTicket: 'bootstrap-password-1',
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
    });
    expect(prove).toHaveBeenCalledOnce();
    expect(prove).toHaveBeenCalledWith(expect.objectContaining({
      publicNodeId: String(requestBody.publicNodeId),
      password: requestBody.password,
      browserPublicKeySpki,
      browserKeyThumbprint,
      source: '127.0.0.1',
    }));
  });

  it('keeps lazy initialization and service failures in the uniform public class', async () => {
    const prove = vi.fn(async () => {
      throw new Error('synthetic_initialization_failure');
    });
    const app = buildApp(env(), { unattendedPasswordProofService: { prove } });
    const failed = await app.request(proofRequest());
    const malformed = await app.request(
      'https://app.example.test/api/remote-desktop/unattended-password/proof',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicNodeId: requestBody.publicNodeId }),
      },
    );

    expect(failed.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await failed.text()).toBe('{"status":"unavailable"}');
    expect(await malformed.text()).toBe('{"status":"unavailable"}');
    expect(failed.headers.get('content-length')).toBe(malformed.headers.get('content-length'));
    expect(prove).toHaveBeenCalledOnce();
  });
});
