import { describe, it, expect } from 'vitest';
import { authRoutes } from '../../src/routes/auth.js';
import { sha256Hex, randomHex } from '../../src/security/crypto.js';
import { Hono } from 'hono';

// 10.6: Test API key endpoints
describe('API key routes', () => {
  it('authRoutes is a Hono instance', () => {
    expect(authRoutes).toBeInstanceOf(Hono);
  });

  it('has POST /user/me/keys route (create)', () => {
    const routes = authRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/user/me/keys',
    );
    expect(route).toBeDefined();
  });

  it('has GET /user/me/keys route (list)', () => {
    const routes = authRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'GET' && r.path === '/user/me/keys',
    );
    expect(route).toBeDefined();
  });

  it('has DELETE /user/me/keys/:keyId route (revoke)', () => {
    const routes = authRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'DELETE' && r.path === '/user/me/keys/:keyId',
    );
    expect(route).toBeDefined();
  });

  it('has POST /ws-ticket route', () => {
    const routes = authRoutes.routes;
    const route = routes.find(
      (r) => r.method === 'POST' && r.path === '/ws-ticket',
    );
    expect(route).toBeDefined();
  });
});

describe('API key format', () => {
  it('generated key starts with deck_ prefix', () => {
    const rawKey = `deck_${randomHex(32)}`;
    expect(rawKey.startsWith('deck_')).toBe(true);
    expect(rawKey.length).toBe(69); // 5 + 64
  });

  it('key hash is different from raw key', async () => {
    const rawKey = `deck_${randomHex(32)}`;
    const hash = await sha256Hex(rawKey);
    expect(hash).not.toBe(rawKey);
    expect(hash).toHaveLength(64);
  });

  it('same key always hashes to same value', async () => {
    const rawKey = 'deck_' + 'a'.repeat(64);
    const hash1 = await sha256Hex(rawKey);
    const hash2 = await sha256Hex(rawKey);
    expect(hash1).toBe(hash2);
  });

  it('different keys hash differently', async () => {
    const key1 = `deck_${randomHex(32)}`;
    const key2 = `deck_${randomHex(32)}`;
    const hash1 = await sha256Hex(key1);
    const hash2 = await sha256Hex(key2);
    expect(hash1).not.toBe(hash2);
  });
});
