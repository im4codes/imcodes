import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { signJwt } from '../src/security/crypto.js';
import { SESSION_IDENTITY_WS } from '../../shared/session-identity-ws.js';
import {
  SESSION_IDENTITY_PROJECT_MAX_CHARS,
  SESSION_IDENTITY_SESSION_MAX_CHARS,
  SESSION_IDENTITY_USER_MAX_CHARS,
} from '../../shared/session-identity.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';
const DAEMON_TOKEN = 'daemon-token';
const DAEMON_TOKEN_HASH = createHash('sha256').update(DAEMON_TOKEN).digest('hex');

interface Row {
  user_id: string;
  scope: 'user' | 'project' | 'session';
  scope_key: string;
  content: string | null;
  content_hash: string;
  revision: number;
  updated_at: number;
  source: 'web' | 'mcp';
}

interface MetadataRow {
  user_id: string;
  scope: string;
  scope_key: string;
  content_hash: string;
  content_length: number;
  revision: number;
  updated_at: number;
  source: 'web' | 'mcp';
  source_file: string | null;
}

function makeMemDb(options: { serverUserId?: string } = {}): Database {
  const rows = new Map<string, Row>();
  const metadata = new Map<string, MetadataRow>();
  const key = (userId: string, scope: string, scopeKey: string) => `${userId}\0${scope}\0${scopeKey}`;
  return {
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      if (!sql.toLowerCase().includes('from session_identity_profiles')) return [] as T[];
      return [...rows.values()].filter((row) => row.user_id === params[0]) as T[];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ');
      if (normalized.includes('from servers where id')) {
        return {
          token_hash: DAEMON_TOKEN_HASH, user_id: options.serverUserId ?? 'user-1', node_role: null, revoked_at: null, os: null,
        } as T;
      }
      if (normalized.includes('insert into session_identity_metadata')) {
        const [userId, scope, scopeKey, contentHash, contentLength, source, updatedAt, sourceFile] = params as [
          string, string, string, string, number, MetadataRow['source'], number, string | null,
        ];
        const rowKey = key(userId, scope, scopeKey);
        const existing = metadata.get(rowKey);
        const next: MetadataRow = {
          user_id: userId, scope, scope_key: scopeKey, content_hash: contentHash, content_length: contentLength,
          source, source_file: sourceFile, revision: existing ? existing.revision + 1 : 1, updated_at: updatedAt,
        };
        metadata.set(rowKey, next);
        return next as T;
      }
      if (normalized.includes('from session_identity_metadata')) {
        return (metadata.get(key(params[0] as string, params[1] as string, params[2] as string)) ?? null) as T | null;
      }
      if (normalized.includes('insert into session_identity_profiles')) {
        const [userId, scope, scopeKey, content, contentHash, source, updatedAt, expected] = params as [
          string, Row['scope'], string, string, string, Row['source'], number, number | null,
        ];
        const rowKey = key(userId, scope, scopeKey);
        const existing = rows.get(rowKey);
        if ((!existing && expected !== null && expected !== 0)
          || (existing && expected !== null && existing.revision !== expected)) return null;
        const next: Row = {
          user_id: userId,
          scope,
          scope_key: scopeKey,
          content,
          content_hash: contentHash,
          source,
          revision: existing ? existing.revision + 1 : 1,
          updated_at: updatedAt,
        };
        rows.set(rowKey, next);
        return next as T;
      }
      if (normalized.includes('from session_identity_profiles')) {
        return (rows.get(key(params[0] as string, params[1] as string, params[2] as string)) ?? null) as T | null;
      }
      return null;
    },
    execute: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase();
      if (normalized.includes('delete from session_identity_metadata')) {
        const rowKey = key(params[0] as string, params[1] as string, params[2] as string);
        const existed = metadata.delete(rowKey);
        return { changes: existed ? 1 : 0 };
      }
      if (!normalized.includes('delete from session_identity_profiles')) return { changes: 0 };
      const rowKey = key(params[0] as string, params[1] as string, params[2] as string);
      const existing = rows.get(rowKey);
      const expected = params[3] as number | null;
      if (!existing || (expected !== null && expected !== existing.revision)) return { changes: 0 };
      rows.delete(rowKey);
      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
  } as unknown as Database;
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  } as Env;
}

/**
 * Local daemon-side identity store, standing in for
 * src/daemon/session-identity-local-store.ts: PROJECT/SESSION content now
 * lives only here (never in `Row.content` above -- see makeMemDb), the
 * server's PUT/GET/DELETE for those scopes is purely a WS round trip.
 */
class MockDaemonWs extends EventEmitter {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  content = new Map<string, { content: string; revision: number }>();
  send(data: string | Buffer, _opts?: unknown, callback?: (err?: Error) => void) {
    if (this.closed) { const err = new Error('socket closed'); if (callback) { callback(err); return; } throw err; }
    const str = typeof data === 'string' ? data : data.toString();
    this.sent.push(str);
    callback?.();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(str); } catch { return; }
    if (parsed.type !== SESSION_IDENTITY_WS.LOCAL_REQUEST) return;
    const key = `${parsed.scope}\0${parsed.scopeKey}`;
    setImmediate(() => {
      if (parsed.op === 'get') {
        const existing = this.content.get(key);
        this.emit('message', Buffer.from(JSON.stringify({
          type: SESSION_IDENTITY_WS.LOCAL_RESPONSE, requestId: parsed.requestId, status: 'ok',
          ...(existing ? { content: existing.content, contentHash: `hash-${existing.revision}`, revision: existing.revision, updatedAt: 1 } : {}),
        })));
        return;
      }
      if (parsed.op === 'set') {
        const previous = this.content.get(key);
        const revision = (previous?.revision ?? 0) + 1;
        this.content.set(key, { content: parsed.content as string, revision });
        this.emit('message', Buffer.from(JSON.stringify({
          type: SESSION_IDENTITY_WS.LOCAL_RESPONSE, requestId: parsed.requestId, status: 'ok',
          contentHash: `hash-${revision}`, revision, updatedAt: 1,
        })));
        return;
      }
      if (parsed.op === 'delete') {
        this.content.delete(key);
        this.emit('message', Buffer.from(JSON.stringify({
          type: SESSION_IDENTITY_WS.LOCAL_RESPONSE, requestId: parsed.requestId, status: 'ok',
        })));
      }
    });
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
}

async function flushAsync() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => process.nextTick(resolve));
}

async function connectDaemon(serverId: string, db: Database, userId = 'user-1'): Promise<MockDaemonWs> {
  const bridge = WsBridge.get(serverId);
  const daemon = new MockDaemonWs();
  bridge.handleDaemonConnection(daemon as never, db, {} as never);
  daemon.emit('message', Buffer.from(JSON.stringify({
    type: 'auth', serverId, token: DAEMON_TOKEN,
  })));
  await flushAsync();
  return daemon;
}

describe('/api/session-identities', () => {
  let app: ReturnType<typeof buildApp>;
  let db: Database;
  const bearer = (userId = 'user-1') => `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}`;

  beforeEach(() => { db = makeMemDb(); app = buildApp(makeEnv(db)); });
  afterEach(() => { WsBridge.getAll().clear(); vi.restoreAllMocks(); });

  it('stores online profiles with strict user isolation and returns one sync snapshot', async () => {
    const put = await app.request('/api/session-identities', {
      method: 'PUT',
      headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'user', scopeKey: '', content: 'Global identity' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ profile: { scope: 'user', revision: 1, content: 'Global identity' } });

    const own = await app.request('/api/session-identities/all', { headers: { Authorization: bearer() } });
    expect(await own.json()).toMatchObject({ profiles: [{ scope: 'user', content: 'Global identity' }] });
    const other = await app.request('/api/session-identities/all', { headers: { Authorization: bearer('user-2') } });
    expect(await other.json()).toEqual({ profiles: [], truncated: false });
  });

  it('rejects a PROJECT/SESSION save with no serverId and no daemon offline', async () => {
    const noServerId = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', scopeKey: 'repo-1', content: 'x' }),
    });
    expect(noServerId.status).toBe(400);
    expect(await noServerId.json()).toEqual({ error: 'identity_server_required' });

    const daemonOffline = await app.request('/api/session-identities?serverId=srv-offline', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', scopeKey: 'repo-1', content: 'x' }),
    });
    expect(daemonOffline.status).toBe(409);
    expect(await daemonOffline.json()).toEqual({ error: 'daemon_offline' });
  });

  it('routes PROJECT/SESSION get/set/delete to the daemon over WS, never to the content table', async () => {
    const serverId = `srv-${Math.random().toString(36).slice(2)}`;
    await connectDaemon(serverId, db);
    const body = { scope: 'project', scopeKey: 'repo-1', content: 'Project identity' };
    const put = await app.request(`/api/session-identities?serverId=${serverId}`, {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ profile: { content: 'Project identity', contentHash: 'hash-1' } });

    const get = await app.request(`/api/session-identities?serverId=${serverId}&scope=project&scopeKey=repo-1`, {
      headers: { Authorization: bearer() },
    });
    expect(await get.json()).toMatchObject({ profile: { content: 'Project identity' } });

    const deleted = await app.request(`/api/session-identities?serverId=${serverId}&scope=project&scopeKey=repo-1`, {
      method: 'DELETE', headers: { Authorization: bearer() },
    });
    expect(await deleted.json()).toEqual({ deleted: true });

    // The content table itself was never touched -- the fake DB's own INSERT
    // detector would have created a Row; confirm the online snapshot (USER
    // scope only, from Postgres) never picked up this PROJECT write.
    const snapshot = await app.request('/api/session-identities/all', { headers: { Authorization: bearer() } });
    expect(await snapshot.json()).toEqual({ profiles: [], truncated: false });
  });

  it('rejects unauthenticated, invalid scope keys, and oversized identity content', async () => {
    expect((await app.request('/api/session-identities/all')).status).toBe(401);
    const badKey = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'session', scopeKey: '', content: 'x' }),
    });
    expect(badKey.status).toBe(400);
    const oversized = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'user', content: 'x'.repeat(SESSION_IDENTITY_USER_MAX_CHARS + 1) }),
    });
    expect(oversized.status).toBe(400);
  });

  it('stores the USER scope at exactly its raised limit and rejects one character more', async () => {
    const atLimit = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'user', content: 'y'.repeat(SESSION_IDENTITY_USER_MAX_CHARS) }),
    });
    expect(atLimit.status).toBe(200);
    const overLimit = await app.request('/api/session-identities', {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'user', content: 'y'.repeat(SESSION_IDENTITY_USER_MAX_CHARS + 1) }),
    });
    expect(overLimit.status).toBe(400);
  });

  it('validates PROJECT/SESSION content length before ever reaching the daemon', async () => {
    const serverId = `srv-${Math.random().toString(36).slice(2)}`;
    const daemon = await connectDaemon(serverId, db);
    const overLimit = await app.request(`/api/session-identities?serverId=${serverId}`, {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', scopeKey: 'repo-1', content: 'y'.repeat(SESSION_IDENTITY_PROJECT_MAX_CHARS + 1) }),
    });
    expect(overLimit.status).toBe(400);
    expect(daemon.sent.filter((raw) => JSON.parse(raw).type === SESSION_IDENTITY_WS.LOCAL_REQUEST)).toHaveLength(0);
    const atLimit = await app.request(`/api/session-identities?serverId=${serverId}`, {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'session', scopeKey: 'server-1:deck_limit_brain', content: 'y'.repeat(SESSION_IDENTITY_SESSION_MAX_CHARS) }),
    });
    expect(atLimit.status).toBe(200);
  });

  it('round-trips a full 200k session identity of 4-byte code points over the daemon WS', async () => {
    const serverId = `srv-${Math.random().toString(36).slice(2)}`;
    await connectDaemon(serverId, db);
    const content = '😀'.repeat(SESSION_IDENTITY_SESSION_MAX_CHARS);
    const body = JSON.stringify({ scope: 'session', scopeKey: 'server-1:deck_emoji_brain', content });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(800_000);
    const put = await app.request(`/api/session-identities?serverId=${serverId}`, {
      method: 'PUT', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body,
    });
    expect(put.status).toBe(200);
    const result = await put.json() as { profile: { content: string } };
    expect(Array.from(result.profile.content)).toHaveLength(SESSION_IDENTITY_SESSION_MAX_CHARS);
  });
});
