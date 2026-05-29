import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLocalPreviewAccess, commitAuthorizedAccess } from '../src/preview/access.js';
import { LocalWebPreviewRegistry } from '../src/preview/registry.js';
import { PREVIEW_ERROR, PREVIEW_LIMITS } from '../../shared/preview-types.js';
import type { Database } from '../src/db/client.js';

/**
 * Mock DB whose `resolveServerRole` answer is controlled by a mutable `owner`
 * (server.user_id) — flipping it simulates revocation/downgrade.
 */
function makeDb(state: { ownerUserId: string }) {
  return {
    queryOne: async <T = unknown>(sql: string) => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('select team_id, user_id from servers where id = $1')) {
        return { team_id: null, user_id: state.ownerUserId } as unknown as T;
      }
      if (s.includes('select role from team_members')) return null;
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;
}

describe('local web preview access (resolveLocalPreviewAccess / commitAuthorizedAccess)', () => {
  let now = 1_800_000_000_000;
  let serverId: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    serverId = `srv-access-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedPreview(userId: string) {
    const registry = LocalWebPreviewRegistry.get(serverId);
    return registry.create(userId, 3000, '/');
  }

  it('authorizes an owner with a valid token (ok:true with role)', async () => {
    const userId = 'user-a';
    const { preview, accessToken } = seedPreview(userId);
    const res = await resolveLocalPreviewAccess({
      db: makeDb({ ownerUserId: userId }),
      serverId,
      previewId: preview.id,
      previewAccessToken: accessToken,
      session: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.userId).toBe(userId);
      expect(res.role).not.toBe('none');
      expect(res.preview.id).toBe(preview.id);
    }
  });

  it('rejects with 401 when neither session nor a valid token is present', async () => {
    const { preview } = seedPreview('user-a');
    const res = await resolveLocalPreviewAccess({
      db: makeDb({ ownerUserId: 'user-a' }),
      serverId,
      previewId: preview.id,
      previewAccessToken: 'wrong-token',
      session: null,
    });
    expect(res).toMatchObject({ ok: false, status: 401, error: PREVIEW_ERROR.FORBIDDEN });
  });

  it('rejects with 404 for an unknown preview', async () => {
    const res = await resolveLocalPreviewAccess({
      db: makeDb({ ownerUserId: 'user-a' }),
      serverId,
      previewId: 'does-not-exist',
      previewAccessToken: null,
      session: { userId: 'user-a' },
    });
    expect(res).toMatchObject({ ok: false, status: 404, error: PREVIEW_ERROR.PREVIEW_EXPIRED });
  });

  it('rejects with 403 when the user is not the owner', async () => {
    const { preview } = seedPreview('owner-user');
    const res = await resolveLocalPreviewAccess({
      db: makeDb({ ownerUserId: 'owner-user' }),
      serverId,
      previewId: preview.id,
      previewAccessToken: null,
      session: { userId: 'someone-else' },
    });
    expect(res).toMatchObject({ ok: false, status: 403, error: PREVIEW_ERROR.FORBIDDEN });
  });

  // ── V-revoke-ttl (run 8a975732-23a P0.5.4) ───────────────────────────────────
  it('V-revoke-ttl: role=none holding a valid token is rejected 403 with NO touch/renewal side effect', async () => {
    const userId = 'user-a';
    const { preview, accessToken } = seedPreview(userId);
    const registry = LocalWebPreviewRegistry.get(serverId);
    const before = registry.peek(preview.id)!;
    const lastAccessBefore = before.lastAccessAt;
    const expiresBefore = before.expiresAt;

    // Advance time so a touch (if it wrongly happened) would visibly move both.
    vi.setSystemTime(now + 60_000);

    // Revoke: the server is now owned by a DIFFERENT user → resolveServerRole === 'none'.
    const res = await resolveLocalPreviewAccess({
      db: makeDb({ ownerUserId: 'a-different-owner' }),
      serverId,
      previewId: preview.id,
      previewAccessToken: accessToken,
      session: null,
    });
    expect(res).toMatchObject({ ok: false, status: 403, error: PREVIEW_ERROR.FORBIDDEN });

    // PURE verify must NOT have touched / renewed.
    const after = registry.peek(preview.id)!;
    expect(after.lastAccessAt).toBe(lastAccessBefore);
    expect(after.expiresAt).toBe(expiresBefore);
  });

  it('peek/verify is side-effect free even on the happy path (commit is separate)', async () => {
    const userId = 'user-a';
    const { preview, accessToken } = seedPreview(userId);
    const registry = LocalWebPreviewRegistry.get(serverId);
    const expiresBefore = registry.peek(preview.id)!.expiresAt;

    vi.setSystemTime(now + 60_000);
    const res = await resolveLocalPreviewAccess({
      db: makeDb({ ownerUserId: userId }),
      serverId,
      previewId: preview.id,
      previewAccessToken: accessToken,
      session: null,
    });
    expect(res.ok).toBe(true);
    // resolve alone did NOT renew.
    expect(registry.peek(preview.id)!.expiresAt).toBe(expiresBefore);

    // Only the explicit commit slides expiresAt.
    commitAuthorizedAccess(serverId, preview.id);
    const afterCommit = registry.peek(preview.id)!;
    expect(afterCommit.lastAccessAt).toBe(now + 60_000);
    expect(afterCommit.expiresAt).toBe((now + 60_000) + PREVIEW_LIMITS.DEFAULT_TTL_MS);
  });
});
