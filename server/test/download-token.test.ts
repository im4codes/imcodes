/**
 * Download token tests — verifies one-time token auth for file downloads.
 * Uses in-memory mocks (no DB/daemon needed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock dependencies before importing the routes
vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    // Simulate: if no Authorization header and no cookie, return 401
    const auth = c.req.header('Authorization');
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    c.set('userId', 'test-user');
    return next();
  },
  resolveServerRole: vi.fn().mockResolvedValue('owner'),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      isDaemonConnected: () => true,
      sendFileTransferRequest: vi.fn().mockResolvedValue({
        type: 'file.download_result',
        content: Buffer.from('hello world').toString('base64'),
        mime: 'text/plain',
        filename: 'test.txt',
      }),
    }),
  },
}));

vi.mock('../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fileTransferRoutes } from '../src/routes/file-transfer.js';

// Mount exactly like the real server does, with env bindings
const app = new Hono();
// Inject fake env.DB so resolveServerRole doesn't crash
app.use('/*', async (c, next) => {
  (c as any).env = { DB: {} };
  return next();
});
app.route('/api/server', fileTransferRoutes);

describe('download-token', () => {
  it('POST download-token returns a token (with auth)', async () => {
    const res = await app.request(
      '/api/server/srv1/uploads/abc123/download-token',
      { method: 'POST', headers: { Authorization: 'Bearer test' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; expiresIn: number };
    expect(body.token).toBeDefined();
    expect(body.token.length).toBe(64); // 32 bytes hex
    expect(body.expiresIn).toBe(300);
  });

  it('POST download-token rejects without auth', async () => {
    const res = await app.request(
      '/api/server/srv1/uploads/abc123/download-token',
      { method: 'POST' },
    );
    expect(res.status).toBe(401);
  });

  it('GET download with valid token succeeds without auth cookies', async () => {
    // Step 1: get token (with auth)
    const tokenRes = await app.request(
      '/api/server/srv1/uploads/abc123/download-token',
      { method: 'POST', headers: { Authorization: 'Bearer test' } },
    );
    const { token } = await tokenRes.json() as { token: string };

    // Step 2: download with token (no auth header)
    const dlRes = await app.request(
      `/api/server/srv1/uploads/abc123/download?token=${token}`,
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('Content-Disposition')).toContain('test.txt');
    const body = await dlRes.text();
    expect(body).toBe('hello world');
  });

  it('token is single-use (second request fails)', async () => {
    const tokenRes = await app.request(
      '/api/server/srv1/uploads/abc123/download-token',
      { method: 'POST', headers: { Authorization: 'Bearer test' } },
    );
    const { token } = await tokenRes.json() as { token: string };

    // First use — success
    const res1 = await app.request(`/api/server/srv1/uploads/abc123/download?token=${token}`);
    expect(res1.status).toBe(200);

    // Second use — token consumed
    const res2 = await app.request(`/api/server/srv1/uploads/abc123/download?token=${token}`);
    expect(res2.status).toBe(401);
  });

  it('expired token is rejected', async () => {
    const tokenRes = await app.request(
      '/api/server/srv1/uploads/abc123/download-token',
      { method: 'POST', headers: { Authorization: 'Bearer test' } },
    );
    const { token } = await tokenRes.json() as { token: string };

    // Fast-forward time past expiry
    vi.useFakeTimers();
    vi.advanceTimersByTime(301_000);

    const res = await app.request(`/api/server/srv1/uploads/abc123/download?token=${token}`);
    expect(res.status).toBe(401);

    vi.useRealTimers();
  });

  it('GET download without token falls back to auth (rejects without cookie)', async () => {
    const res = await app.request('/api/server/srv1/uploads/abc123/download');
    expect(res.status).toBe(401);
  });

  it('invalid token is rejected', async () => {
    const res = await app.request('/api/server/srv1/uploads/abc123/download?token=bogus');
    expect(res.status).toBe(401);
  });

  it('token for file-X rejects when used on file-Y (binding mismatch)', async () => {
    const tokenRes = await app.request(
      '/api/server/srv1/uploads/abc123/download-token',
      { method: 'POST', headers: { Authorization: 'Bearer test' } },
    );
    const { token } = await tokenRes.json() as { token: string };

    // Use token on different attachment
    const res = await app.request(`/api/server/srv1/uploads/def456/download?token=${token}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'token_resource_mismatch' });
  });

  it('token for server-A rejects when used on server-B (binding mismatch)', async () => {
    const tokenRes = await app.request(
      '/api/server/srv1/uploads/abc123/download-token',
      { method: 'POST', headers: { Authorization: 'Bearer test' } },
    );
    const { token } = await tokenRes.json() as { token: string };

    // Use token on different server
    const res = await app.request(`/api/server/srv2/uploads/abc123/download?token=${token}`);
    expect(res.status).toBe(403);
  });
});
