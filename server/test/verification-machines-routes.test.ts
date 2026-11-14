import { activeUserAnswer } from './helpers/user-status.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { signJwt } from '../src/security/crypto.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';
const ALIAS_ID = 'b'.repeat(32);
type Row = {
  id: string; user_id: string; scope: 'user' | 'project'; scope_key: string; alias: string;
  kind: 'controlled_node' | 'ssh'; target: string; enabled: boolean; revision: number;
  created_at: number; updated_at: number; last_verified_at: number | null;
  last_verification_status: 'unverified' | 'verified' | 'unreachable' | 'unauthorized'; source: 'web' | 'mcp';
};

function makeMemDb(): Database {
  const rows = new Map<string, Row>();
  return {
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      if (!sql.includes('verification_machine_profiles')) return [] as T[];
      if (sql.includes('WITH listed AS')) {
        const [userId, projectKey, limit, cursorBucket, cursorScopeKey, cursorAlias, cursorId] = params as [
          string, string | null, number, number | null, string, string, string,
        ];
        const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        const mapped = [...rows.values()]
          .filter((row) => row.user_id === userId)
          .map((row) => ({
            ...row,
            sort_bucket: projectKey !== null && row.scope === 'project' && row.scope_key === projectKey
              ? 0
              : row.scope === 'project' ? 1 : 2,
          }))
          .sort((a, b) => (a.sort_bucket - b.sort_bucket)
            || cmpStr(a.scope_key, b.scope_key)
            || cmpStr(a.alias, b.alias)
            || cmpStr(a.id, b.id));
        const filtered = cursorBucket === null
          ? mapped
          : mapped.filter((item) => {
              const cmp = (item.sort_bucket - cursorBucket)
                || cmpStr(item.scope_key, cursorScopeKey)
                || cmpStr(item.alias, cursorAlias)
                || cmpStr(item.id, cursorId);
              return cmp > 0;
            });
        return filtered.slice(0, limit) as T[];
      }
      const [userId, projectKey, limit] = params as [string, string | null, number];
      return [...rows.values()]
        .filter((row) => row.user_id === userId
          && (row.scope === 'user' || (row.scope === 'project' && row.scope_key === projectKey)))
        .slice(0, limit) as T[];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      { const activeUser = activeUserAnswer(sql); if (activeUser) return activeUser as never; }
      if (sql.includes('FROM user_aliases')) {
        return (params[0] === 'user-1' && params[1] === ALIAS_ID ? {
          id: ALIAS_ID, name: '211', value: 'ssh k@172.16.253.211', description: null,
          tags: [], source: 'web', created_at: 1, updated_at: 1,
        } : null) as T | null;
      }
      if (sql.includes('INSERT INTO verification_machine_profiles')) {
        const [id, userId, scope, scopeKey, alias, kind, target, enabled, now, source] = params as [
          string, string, Row['scope'], string, string, Row['kind'], string, boolean, number, Row['source'],
        ];
        const doNothing = sql.includes('ON CONFLICT (id) DO NOTHING');
        const old = rows.get(id);
        if ((old && (doNothing || old.user_id !== userId))) return null;
        for (const existing of rows.values()) {
          if (existing.id !== id && existing.user_id === userId && existing.scope === scope
            && existing.scope_key === scopeKey && existing.alias === alias) {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
        }
        const row: Row = {
          id, user_id: userId, scope, scope_key: scopeKey, alias, kind, target, enabled,
          revision: old ? old.revision + 1 : 1, created_at: old?.created_at ?? now, updated_at: now,
          last_verified_at: old && old.kind === kind && old.target === target ? old.last_verified_at : null,
          last_verification_status: old && old.kind === kind && old.target === target ? old.last_verification_status : 'unverified',
          source,
        };
        rows.set(id, row);
        return row as T;
      }
      if (sql.includes('UPDATE verification_machine_profiles') && sql.includes('SET scope = $3')) {
        const [userId, id, scope, scopeKey, alias, kind, target, enabled, now, source, expectedRevision] = params as [
          string, string, Row['scope'], string, string, Row['kind'], string, boolean, number, Row['source'], number,
        ];
        const row = rows.get(id);
        if (!row || row.user_id !== userId || row.revision !== expectedRevision) return null;
        for (const existing of rows.values()) {
          if (existing.id !== id && existing.user_id === userId && existing.scope === scope
            && existing.scope_key === scopeKey && existing.alias === alias) {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
        }
        const sameTarget = row.kind === kind && row.target === target;
        const updated: Row = {
          ...row,
          scope,
          scope_key: scopeKey,
          alias,
          kind,
          target,
          enabled,
          revision: row.revision + 1,
          updated_at: now,
          last_verified_at: sameTarget ? row.last_verified_at : null,
          last_verification_status: sameTarget ? row.last_verification_status : 'unverified',
          source,
        };
        rows.set(id, updated);
        return updated as T;
      }
      if (sql.includes('UPDATE verification_machine_profiles')) {
        const row = rows.get(params[1] as string);
        if (!row || row.user_id !== params[0]) return null;
        row.last_verified_at = params[2] as number;
        row.last_verification_status = params[3] as Row['last_verification_status'];
        row.updated_at = params[2] as number;
        row.revision += 1;
        return row as T;
      }
      const row = rows.get(params[1] as string);
      return (row?.user_id === params[0] ? row : null) as T | null;
    },
    execute: async (sql: string, params: unknown[] = []) => {
      if (!sql.includes('DELETE FROM verification_machine_profiles')) return { changes: 0 };
      const row = rows.get(params[1] as string);
      if (!row || row.user_id !== params[0] || (params[2] !== null && params[2] !== row.revision)) return { changes: 0 };
      rows.delete(row.id);
      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
  } as unknown as Database;
}

function makeEnv(db: Database): Env {
  return { DB: db, JWT_SIGNING_KEY: JWT_KEY, BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000', ALLOWED_ORIGINS: '', TRUSTED_PROXIES: '', BIND_HOST: '127.0.0.1',
    PORT: '3000', NODE_ENV: 'development', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' } as Env;
}

describe('/api/verification-machines', () => {
  let app: ReturnType<typeof buildApp>;
  const bearer = (userId = 'user-1') => `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}`;
  beforeEach(() => { app = buildApp(makeEnv(makeMemDb())); });
  afterEach(() => { WsBridge.getAll().clear(); });

  it('stores an SSH reference online and renames it without changing its stable id', async () => {
    const create = await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ scope: 'project', scopeKey: 'repo-1', alias: 'Linux rig', kind: 'ssh', target: ALIAS_ID }) });
    expect(create.status).toBe(200);
    const first = (await create.json() as { profile: Row }).profile;
    expect(first).toMatchObject({ alias: 'Linux rig', source: 'web', revision: 1 });
    expect(first.id).toMatch(/^[a-f0-9]{32}$/u);

    const rename = await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ id: first.id, scope: 'project', scopeKey: 'repo-1', alias: 'Build rig', kind: 'ssh', target: ALIAS_ID, expectedRevision: 1 }) });
    expect(await rename.json()).toMatchObject({ profile: { id: first.id, alias: 'Build rig', revision: 2 } });
    const list = await app.request('/api/verification-machines?projectKey=repo-1', { headers: { Authorization: bearer() } });
    expect(await list.json()).toMatchObject({ profiles: [{ id: first.id, alias: 'Build rig' }] });

    const stale = await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ id: first.id, scope: 'project', scopeKey: 'repo-1', alias: 'Stale', kind: 'ssh', target: ALIAS_ID, expectedRevision: 1 }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'revision_conflict' });
  });

  it('keeps default GET project-scoped while includeAllProjects=1 returns all user-owned scopes', async () => {
    await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ scope: 'project', scopeKey: 'repo-1', alias: 'Repo 1 rig', kind: 'ssh', target: ALIAS_ID }) });
    await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ scope: 'user', alias: 'Global rig', kind: 'ssh', target: ALIAS_ID }) });

    const withoutProject = await app.request('/api/verification-machines', { headers: { Authorization: bearer() } });
    expect((await withoutProject.json() as { profiles: Row[] }).profiles.map((p) => p.alias)).toEqual(['Global rig']);

    const otherProject = await app.request('/api/verification-machines?projectKey=repo-2', { headers: { Authorization: bearer() } });
    expect((await otherProject.json() as { profiles: Row[] }).profiles.map((p) => p.alias)).toEqual(['Global rig']);

    const allProjects = await app.request('/api/verification-machines?includeAllProjects=1', { headers: { Authorization: bearer() } });
    expect((await allProjects.json() as { profiles: Row[] }).profiles.map((p) => p.alias)).toEqual(['Repo 1 rig', 'Global rig']);

    const otherUserAll = await app.request('/api/verification-machines?includeAllProjects=1', { headers: { Authorization: bearer('user-2') } });
    expect(await otherUserAll.json()).toEqual({ profiles: [] });
  });

  it('paginates includeAllProjects=1 cleanly across >100 multi-project profiles without 413 and allows editing/deleting page-2 items', async () => {
    for (let i = 0; i < 51; i += 1) {
      const res = await app.request('/api/verification-machines', { method: 'PUT', headers: {
        Authorization: bearer(), 'Content-Type': 'application/json',
      }, body: JSON.stringify({ scope: 'project', scopeKey: 'repo-a', alias: `a-${String(i).padStart(3, '0')}`, kind: 'ssh', target: ALIAS_ID }) });
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 50; i += 1) {
      const res = await app.request('/api/verification-machines', { method: 'PUT', headers: {
        Authorization: bearer(), 'Content-Type': 'application/json',
      }, body: JSON.stringify({ scope: 'project', scopeKey: 'repo-b', alias: `b-${String(i).padStart(3, '0')}`, kind: 'ssh', target: ALIAS_ID }) });
      expect(res.status).toBe(200);
    }

    // Default scoped GETs remain valid and unchanged at 51 and 50 items respectively.
    const scopedA = await app.request('/api/verification-machines?projectKey=repo-a', { headers: { Authorization: bearer() } });
    expect(scopedA.status).toBe(200);
    expect((await scopedA.json() as { profiles: Row[] }).profiles).toHaveLength(51);

    const scopedB = await app.request('/api/verification-machines?projectKey=repo-b', { headers: { Authorization: bearer() } });
    expect(scopedB.status).toBe(200);
    expect((await scopedB.json() as { profiles: Row[] }).profiles).toHaveLength(50);

    // Management GET returns page 1 (100 items + nextCursor) and page 2 (1 item, no nextCursor) with no 413.
    const page1Res = await app.request('/api/verification-machines?includeAllProjects=1', { headers: { Authorization: bearer() } });
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json() as { profiles: Row[]; nextCursor?: string };
    expect(page1.profiles).toHaveLength(100);
    expect(typeof page1.nextCursor).toBe('string');

    const page2Res = await app.request(`/api/verification-machines?includeAllProjects=1&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
      headers: { Authorization: bearer() },
    });
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json() as { profiles: Row[]; nextCursor?: string };
    expect(page2.profiles).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();

    // Another user cannot see any items on either page.
    const otherUserPage = await app.request(`/api/verification-machines?includeAllProjects=1&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
      headers: { Authorization: bearer('user-2') },
    });
    expect(otherUserPage.status).toBe(200);
    expect(await otherUserPage.json()).toEqual({ profiles: [] });

    // Page-2 item can be edited (e.g. switched to user scope / renamed) and deleted.
    const page2Item = page2.profiles[0]!;
    const editRes = await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({
      id: page2Item.id,
      scope: 'user',
      scopeKey: '',
      alias: 'promoted-from-page-2',
      kind: 'ssh',
      target: ALIAS_ID,
      expectedRevision: page2Item.revision,
    }) });
    expect(editRes.status).toBe(200);
    expect(await editRes.json()).toMatchObject({ profile: { id: page2Item.id, scope: 'user', alias: 'promoted-from-page-2', revision: 2 } });

    const delRes = await app.request(`/api/verification-machines/${page2Item.id}?expectedRevision=2`, {
      method: 'DELETE',
      headers: { Authorization: bearer() },
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    // Rejects malformed, oversized, or out-of-range cursor / limit with 400.
    expect((await app.request('/api/verification-machines?includeAllProjects=1&cursor=not-valid!', {
      headers: { Authorization: bearer() },
    })).status).toBe(400);
    expect((await app.request(`/api/verification-machines?includeAllProjects=1&cursor=${'A'.repeat(4000)}`, {
      headers: { Authorization: bearer() },
    })).status).toBe(400);
    const oversizedFieldCursor = Buffer.from(JSON.stringify({
      bucket: 1,
      scopeKey: 'x'.repeat(513),
      alias: 'a',
      id: 'a'.repeat(32),
    }), 'utf8').toString('base64url');
    expect((await app.request(`/api/verification-machines?includeAllProjects=1&cursor=${oversizedFieldCursor}`, {
      headers: { Authorization: bearer() },
    })).status).toBe(400);
    expect((await app.request('/api/verification-machines?includeAllProjects=1&limit=101', {
      headers: { Authorization: bearer() },
    })).status).toBe(400);
    expect((await app.request('/api/verification-machines?includeAllProjects=1&limit=0', {
      headers: { Authorization: bearer() },
    })).status).toBe(400);
  });

  it('round-trips maximum legal ASCII, CJK, and astral Unicode scopeKey and alias cursors across small and default 100-item pages', async () => {
    const cases = [
      { scopeKey: 'A'.repeat(512), alias: 'N'.repeat(80), nodeId: '1000000001' },
      { scopeKey: '项'.repeat(512), alias: '机'.repeat(80), nodeId: '1000000002' },
      { scopeKey: '😀'.repeat(512), alias: '🚀'.repeat(80), nodeId: '1000000003' },
    ];
    for (const c of cases) {
      for (const suffix of ['1', '2']) {
        const res = await app.request('/api/verification-machines', { method: 'PUT', headers: {
          Authorization: bearer(), 'Content-Type': 'application/json',
        }, body: JSON.stringify({
          scope: 'project',
          scopeKey: c.scopeKey,
          alias: `${c.alias.slice(0, -1)}${suffix}`,
          kind: 'ssh',
          target: ALIAS_ID,
        }) });
        expect(res.status).toBe(200);
      }
    }

    // Small-page traversal (limit=1) visits all 6 entries with zero skips/duplicates despite >2840-char cursors.
    const visitedIds: string[] = [];
    let cursor: string | undefined;
    let sawLongCursor = false;
    while (true) {
      const url = `/api/verification-machines?includeAllProjects=1&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await app.request(url, { headers: { Authorization: bearer() } });
      expect(res.status).toBe(200);
      const body = await res.json() as { profiles: Row[]; nextCursor?: string };
      expect(body.profiles).toHaveLength(1);
      visitedIds.push(body.profiles[0]!.id);
      if (body.nextCursor && body.nextCursor.length > 2048) sawLongCursor = true;
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(sawLongCursor).toBe(true);
    expect(visitedIds).toHaveLength(6);
    expect(new Set(visitedIds).size).toBe(6);

    // Fill up to 101 total items using default page size (100) ending on an astral 512/80 boundary item.
    for (let i = 0; i < 95; i += 1) {
      const res = await app.request('/api/verification-machines', { method: 'PUT', headers: {
        Authorization: bearer(), 'Content-Type': 'application/json',
      }, body: JSON.stringify({
        scope: 'project',
        scopeKey: '😀'.repeat(512),
        alias: `${'🚀'.repeat(76)}${String(i).padStart(4, '0')}`,
        kind: 'ssh',
        target: ALIAS_ID,
      }) });
      expect(res.status).toBe(200);
    }

    const defaultPage1Res = await app.request('/api/verification-machines?includeAllProjects=1', {
      headers: { Authorization: bearer() },
    });
    expect(defaultPage1Res.status).toBe(200);
    const defaultPage1 = await defaultPage1Res.json() as { profiles: Row[]; nextCursor?: string };
    expect(defaultPage1.profiles).toHaveLength(100);
    expect(defaultPage1.nextCursor).toBeTruthy();
    expect(defaultPage1.nextCursor!.length).toBeGreaterThan(2048);

    const defaultPage2Res = await app.request(
      `/api/verification-machines?includeAllProjects=1&cursor=${encodeURIComponent(defaultPage1.nextCursor!)}`,
      { headers: { Authorization: bearer() } },
    );
    expect(defaultPage2Res.status).toBe(200);
    const defaultPage2 = await defaultPage2Res.json() as { profiles: Row[]; nextCursor?: string };
    expect(defaultPage2.profiles).toHaveLength(1);
    expect(defaultPage2.nextCursor).toBeUndefined();
    const combinedIds = [...defaultPage1.profiles, ...defaultPage2.profiles].map((p) => p.id);
    expect(new Set(combinedIds).size).toBe(101);
  });

  it('isolates users and rejects unsafe SSH option injection', async () => {
    const bad = await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ scope: 'user', alias: 'bad', kind: 'ssh', target: '-oProxyCommand=evil host' }) });
    expect(bad.status).toBe(400);
    const other = await app.request('/api/verification-machines', { headers: { Authorization: bearer('user-2') } });
    expect(await other.json()).toEqual({ profiles: [] });
    expect((await app.request('/api/verification-machines')).status).toBe(401);
  });

  it('never lets a browser forge the result of a real-machine verification', async () => {
    const result = await app.request(`/api/verification-machines/${'a'.repeat(32)}/verification`, {
      method: 'POST',
      headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'verified' }),
    });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: 'verification_machine_daemon_required' });
  });
});
