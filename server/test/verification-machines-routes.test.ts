import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { signJwt } from '../src/security/crypto.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';
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
      const [userId, projectKey] = params as [string, string | null, number];
      return [...rows.values()].filter((row) => row.user_id === userId
        && (row.scope === 'user' || (row.scope === 'project' && row.scope_key === projectKey))) as T[];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO verification_machine_profiles')) {
        const [id, userId, scope, scopeKey, alias, kind, target, enabled, now, source, expected] = params as [
          string, string, Row['scope'], string, string, Row['kind'], string, boolean, number, Row['source'], number | null,
        ];
        const old = rows.get(id);
        if ((old && old.user_id !== userId) || (!old && expected !== null && expected !== 0)
          || (old && expected !== null && old.revision !== expected)) return null;
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
    }, body: JSON.stringify({ scope: 'project', scopeKey: 'repo-1', alias: 'Linux rig', kind: 'ssh', target: '211' }) });
    expect(create.status).toBe(200);
    const first = (await create.json() as { profile: Row }).profile;
    expect(first).toMatchObject({ alias: 'Linux rig', source: 'web', revision: 1 });
    expect(first.id).toMatch(/^[a-f0-9]{32}$/u);

    const rename = await app.request('/api/verification-machines', { method: 'PUT', headers: {
      Authorization: bearer(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ id: first.id, scope: 'project', scopeKey: 'repo-1', alias: 'Build rig', kind: 'ssh', target: '211', expectedRevision: 1 }) });
    expect(await rename.json()).toMatchObject({ profile: { id: first.id, alias: 'Build rig', revision: 2 } });
    const list = await app.request('/api/verification-machines?projectKey=repo-1', { headers: { Authorization: bearer() } });
    expect(await list.json()).toMatchObject({ profiles: [{ id: first.id, alias: 'Build rig' }] });
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
