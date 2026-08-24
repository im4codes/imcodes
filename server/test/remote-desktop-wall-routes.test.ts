import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn() }));

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set(key: string, value: string): void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
}));

vi.mock('../src/services/remote-desktop-wall.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/remote-desktop-wall.js')>();
  return {
    ...original,
    getRemoteDesktopWall: (...args: unknown[]) => mocks.get(...args),
    mutateRemoteDesktopWall: (...args: unknown[]) => mocks.mutate(...args),
  };
});

import { remoteDesktopWallRoutes } from '../src/routes/remote-desktop-wall.js';
import {
  RemoteDesktopWallAuthorizationError,
  RemoteDesktopWallConflictError,
} from '../src/services/remote-desktop-wall.js';

const empty = { revision: 0, layout: 'grid' as const, hostIds: [], hosts: [] };
const HOST_ID = '00000000-0000-4000-8000-000000000001';

function app() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api', remoteDesktopWallRoutes);
  return app;
}

describe('remote desktop wall routes', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(empty); });

  it('returns a no-store authoritative snapshot', async () => {
    const response = await app().request('/api/remote-desktop/wall', {}, { DB: {} } as Env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(empty);
    expect(mocks.get).toHaveBeenCalledWith(expect.anything(), 'user-1');
  });

  it('rejects invalid and over-limit mutations before service admission', async () => {
    const response = await app().request('/api/remote-desktop/wall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'add', expectedRevision: 0, hostIds: Array.from({ length: 17 }, (_, i) => `host-${i}`) }),
    }, { DB: {} } as Env);
    expect(response.status).toBe(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('returns conflict and authorization snapshots without merging', async () => {
    const conflictSnapshot = { ...empty, revision: 4 };
    mocks.mutate.mockRejectedValueOnce(new RemoteDesktopWallConflictError(conflictSnapshot));
    const conflict = await app().request('/api/remote-desktop/wall', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'add', expectedRevision: 3, hostIds: [HOST_ID] }),
    }, { DB: {} } as Env);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'wall_revision_conflict', snapshot: conflictSnapshot });

    mocks.mutate.mockRejectedValueOnce(new RemoteDesktopWallAuthorizationError(empty));
    const revoked = await app().request('/api/remote-desktop/wall', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'add', expectedRevision: 0, hostIds: [HOST_ID] }),
    }, { DB: {} } as Env);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({ error: 'wall_host_unavailable', snapshot: empty });
  });
});
