import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { DAEMON_TOKEN_ROUTE_NOT_ALLOWED } from '../../shared/daemon-token-routes.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { activeUserAnswer } from './helpers/user-status.js';

const USER_ID = 'user-owner-1';
const OTHER_USER_ID = 'user-other-2';
const API_KEY = 'deck_0123456789abcdef0123456789abcdef';
const OTHER_API_KEY = 'deck_fedcba9876543210fedcba9876543210';
const KEY_ID = 'key-desktop-1';
const OTHER_KEY_ID = 'key-desktop-2';
const DAEMON_TOKEN = 'daemon-secret-token-123';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

interface ServerRow {
  id: string;
  user_id: string;
  name: string;
  display_name: string | null;
  node_id: string | null;
  token_hash: string;
  node_role: string;
  os: string | null;
  arch: string | null;
  abi_profile: string | null;
  host_server_id: string | null;
  bound_with_key_id: string | null;
  revoked_at: number | null;
  created_at: number;
}

function createMemoryDb(seedServers: ServerRow[] = [], options: { asyncYieldMs?: number } = {}) {
  const servers: ServerRow[] = [...seedServers];
  const audits: Array<{ userId: string; action: string; details: unknown }> = [];
  const advisoryLockChains = new Map<string, Promise<void>>();
  const lockEvents: Array<{ key: string; phase: 'acquire' | 'acquired' | 'release' }> = [];

  const yieldTick = async () => {
    if (options.asyncYieldMs && options.asyncYieldMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.asyncYieldMs));
    }
  };

  const makeTx = (heldLocks: Array<{ key: string; release: () => void }>) => {
    const execQueryOne = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      {
        const activeUser = activeUserAnswer(sql);
        if (activeUser) return activeUser as T;
      }
      const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.includes('pg_advisory_xact_lock')) {
        const key = String(params[0] ?? '');
        lockEvents.push({ key, phase: 'acquire' });
        const prev = advisoryLockChains.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = prev.then(() => current);
        advisoryLockChains.set(key, tail);
        await prev;
        heldLocks.push({ key, release });
        lockEvents.push({ key, phase: 'acquired' });
        return { locked: '' } as T;
      }
      if (s.includes('from api_keys')) {
        if (params[0] === sha(API_KEY)) {
          return { id: KEY_ID, user_id: USER_ID, user_status: 'active' } as T | null;
        }
        if (params[0] === sha(OTHER_API_KEY)) {
          return { id: OTHER_KEY_ID, user_id: OTHER_USER_ID, user_status: 'active' } as T | null;
        }
        return null;
      }
      if (s.includes('from users where id')) {
        const uid = params[0] === OTHER_USER_ID ? OTHER_USER_ID : USER_ID;
        return { id: uid, is_admin: false, status: 'active', sessions_valid_after: 0 } as T | null;
      }
    if (s.includes('as owner_status') && s.includes('from servers where id = $1')) {
      // requireAuth daemon token lookup
      const row = servers.find((srv) => srv.id === params[0]);
      if (!row) return null;
      return {
        token_hash: row.token_hash,
        owner_status: 'active',
        user_id: row.user_id,
        node_role: row.node_role,
        revoked_at: row.revoked_at,
      } as T | null;
    }
    if (s.includes('from servers') && s.includes('where token_hash = $1')) {
      await yieldTick();
      const matches = servers
        .filter((srv) => srv.token_hash === params[0])
        .sort((a, b) => b.created_at - a.created_at);
      return (matches[0] ?? null) as T | null;
    }
    if (s.includes('from servers') && s.includes('where node_id = $1')) {
      const row = servers.find((srv) => srv.node_id === params[0]);
      return (row ? { id: row.id } : null) as T | null;
    }
    if (s.startsWith('insert into servers')) {
      const stripped = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
      const colMatch = /insert into servers\s*\(([^)]+)\)\s*values/i.exec(stripped);
      const cols = colMatch ? colMatch[1].split(',').map((c) => c.trim().toLowerCase()) : [];
      const rowMap: Record<string, unknown> = {};
      let pIdx = 0;
      const valSection = stripped.slice(stripped.toLowerCase().indexOf('values'));
      const tupleMatch = /\(([^)]+)\)/i.exec(valSection);
      const valTokens = tupleMatch ? tupleMatch[1].split(',').map((v) => v.trim()) : [];
      cols.forEach((col, i) => {
        const tok = valTokens[i] ?? '';
        if (tok.startsWith('$')) {
          rowMap[col] = params[pIdx++];
        } else if (tok === 'false') {
          rowMap[col] = false;
        } else if (tok === 'true') {
          rowMap[col] = true;
        } else if (/^'.*'$/.test(tok)) {
          rowMap[col] = tok.slice(1, -1);
        }
      });
      const nodeId = String(rowMap.node_id ?? '');
      if (nodeId && servers.some((srv) => srv.node_id === nodeId && srv.node_role === 'controlled')) {
        return null;
      }
      servers.push({
        id: String(rowMap.id ?? ''),
        user_id: String(rowMap.user_id ?? ''),
        name: String(rowMap.name ?? ''),
        display_name: (rowMap.display_name as string | null) ?? String(rowMap.name ?? ''),
        node_id: nodeId || null,
        token_hash: String(rowMap.token_hash ?? ''),
        node_role: String(rowMap.node_role ?? 'controlled'),
        os: (rowMap.os as string | null) ?? null,
        arch: (rowMap.arch as string | null) ?? null,
        abi_profile: (rowMap.abi_profile as string | null) ?? null,
        host_server_id: (rowMap.host_server_id as string | null) ?? null,
        bound_with_key_id: (rowMap.bound_with_key_id as string | null) ?? null,
        revoked_at: null,
        created_at: Number(rowMap.created_at ?? Date.now()),
      });
      return (s.includes('returning node_id') ? { node_id: nodeId } : null) as T | null;
    }
    if (s.includes('from servers') && s.includes('where id = $1')) {
      const row = servers.find((srv) => srv.id === params[0]);
      if (!row) return null;
      if (s.includes('user_id = $2') && row.user_id !== params[1]) return null;
      if (s.includes('node_role is distinct from $3') && row.node_role === params[2]) return null;
      if (s.includes("node_role = 'full'") && row.node_role !== 'full') return null;
      if (s.includes("node_role <> 'controlled'") && row.node_role === 'controlled') return null;
      if (s.includes('revoked_at is null') && row.revoked_at !== null) return null;
      return { ...row } as T | null;
    }
    if (s.includes('from servers') && s.includes('user_id = $1') && s.includes('revoked_at is null')) {
      // insertControlledServer / isOwnedHostDaemon or name uniqueness lookup
      return null;
    }
    return null;
  };

  const execQuery = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (s.includes('from servers') && s.includes('where id in')) {
      const rows = servers.filter((srv) => srv.id === params[0] || srv.id === params[1]);
      return rows as T[];
    }
    return [];
  };

  const execRun = async (sql: string, params: unknown[] = []) => {
    const s = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (s.startsWith('insert into audit_log')) {
      audits.push({
        userId: String(params[1] ?? ''),
        action: String(params[3] ?? ''),
        details: params[4] ? JSON.parse(String(params[4])) : null,
      });
      return { changes: 1 };
    }
    if (s.startsWith('insert into servers')) {
      // Expected column list from insertControlledServerWithNodeId
      const id = String(params[0]);
      const userId = String(params[1]);
      const name = String(params[2]);
      const nodeId = String(params[3] ?? params.find((p) => typeof p === 'string' && /^\d{10}$/.test(p)) ?? '');
      // Let's parse column list accurately
      const colMatch = /\(([^)]+)\)\s*values/i.exec(sql);
      const cols = colMatch ? colMatch[1].split(',').map((c) => c.trim().toLowerCase()) : [];
      const rowMap: Record<string, unknown> = {};
      cols.forEach((col, i) => {
        rowMap[col] = params[i];
      });
      // Detect inline SQL literals too (e.g. 'controlled' or 'offline')
      servers.push({
        id: String(rowMap.id ?? id),
        user_id: String(rowMap.user_id ?? userId),
        name: String(rowMap.name ?? name),
        display_name: (rowMap.display_name as string | null) ?? String(rowMap.name ?? name),
        node_id: (rowMap.node_id as string | null) ?? nodeId,
        token_hash: String(rowMap.token_hash ?? ''),
        node_role: s.includes("'controlled'") ? 'controlled' : String(rowMap.node_role ?? 'controlled'),
        os: (rowMap.os as string | null) ?? null,
        arch: (rowMap.arch as string | null) ?? null,
        abi_profile: (rowMap.abi_profile as string | null) ?? null,
        host_server_id: (rowMap.host_server_id as string | null) ?? null,
        bound_with_key_id: (rowMap.bound_with_key_id as string | null) ?? null,
        revoked_at: null,
        created_at: Number(rowMap.created_at ?? Date.now()),
      });
      return { changes: 1 };
    }
    if (s.startsWith('update servers set host_server_id = null')) {
      const [hostId, uid, keepId] = params as [string, string, string];
      let changes = 0;
      for (const srv of servers) {
        if (srv.host_server_id === hostId && srv.user_id === uid && srv.node_role === 'controlled' && srv.id !== keepId) {
          srv.host_server_id = null;
          changes += 1;
        }
      }
      return { changes };
    }
    if (s.startsWith('update servers set host_server_id = $2')) {
      const [id, hostId, uid] = params as [string, string, string];
      const srv = servers.find((row) => row.id === id && row.user_id === uid);
      if (!srv) return { changes: 0 };
      srv.host_server_id = hostId;
      return { changes: 1 };
    }
    if (s.startsWith('update servers set abi_profile = $2')) {
      const [id, abi] = params as [string, string];
      const srv = servers.find((row) => row.id === id);
      if (srv) srv.abi_profile = abi;
      return { changes: srv ? 1 : 0 };
    }
    if (s.startsWith('update servers set bound_with_key_id = $2')) {
      const [id, kid] = params as [string, string];
      const srv = servers.find((row) => row.id === id);
      if (srv) srv.bound_with_key_id = kid;
      return { changes: srv ? 1 : 0 };
    }
    return { changes: 1 };
  };

    return {
      queryOne: execQueryOne,
      query: execQuery,
      execute: execRun,
      exec: async () => undefined,
      close: async () => undefined,
    };
  };

  const rootTx = makeTx([]);
  const db = {
    ...rootTx,
    transaction: async <T>(fn: (tx: typeof rootTx) => Promise<T>) => {
      const heldLocks: Array<{ key: string; release: () => void }> = [];
      try {
        return await fn(makeTx(heldLocks));
      } finally {
        for (const held of heldLocks.reverse()) {
          lockEvents.push({ key: held.key, phase: 'release' });
          held.release();
        }
      }
    },
  } as unknown as Database;

  return { db, servers, audits, lockEvents };
}

function makeTestApp(seedServers: ServerRow[] = [], options: { asyncYieldMs?: number } = {}) {
  const mem = createMemoryDb(seedServers, options);
  const app = buildApp({
    DB: mem.db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  } as Env);
  return { app, ...mem };
}

const VALID_BODY = {
  installId: 'install-uuid-123',
  nodeTokenHash: 'b'.repeat(64),
  hostname: 'macbook-pro.local',
  os: 'mac',
  arch: 'arm64',
  abiProfile: 'modern',
};

describe('POST /api/enroll/v2/direct', () => {
  const prevExeDir = process.env.IMCODES_NODE_EXE_DIR;

  afterEach(() => {
    if (prevExeDir === undefined) delete process.env.IMCODES_NODE_EXE_DIR;
    else process.env.IMCODES_NODE_EXE_DIR = prevExeDir;
  });

  it('rejects unauthenticated requests (401)', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('refuses daemon credentials (403)', async () => {
    const { app } = makeTestApp([{
      id: 'srv-daemon-1',
      user_id: USER_ID,
      name: 'daemon-1',
      display_name: 'daemon-1',
      node_id: null,
      token_hash: sha(DAEMON_TOKEN),
      node_role: 'full',
      os: 'mac',
      arch: 'arm64',
      abi_profile: null,
      host_server_id: null,
      bound_with_key_id: null,
      revoked_at: null,
      created_at: 1000,
    }]);
    const res = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DAEMON_TOKEN}`,
        [SERVER_ID_HEADER]: 'srv-daemon-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: DAEMON_TOKEN_ROUTE_NOT_ALLOWED });
  });

  it('rejects malformed body and unknown fields with 400', async () => {
    const { app } = makeTestApp();
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

    const badHash = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, nodeTokenHash: 'not-hex' }),
    });
    expect(badHash.status).toBe(400);

    const extraField = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, unexpected: true }),
    });
    expect(extraField.status).toBe(400);

    const badPair = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, os: 'win', arch: 'arm64' }),
    });
    expect(badPair.status).toBe(400);
  });

  it('rejects hostServerId owned by another user or non-daemon with 403', async () => {
    const { app } = makeTestApp([
      {
        id: 'srv-foreign-1',
        user_id: OTHER_USER_ID,
        name: 'foreign',
        display_name: 'foreign',
        node_id: null,
        token_hash: 'c'.repeat(64),
        node_role: 'full',
        os: 'mac',
        arch: 'arm64',
        abi_profile: null,
        host_server_id: null,
        bound_with_key_id: null,
        revoked_at: null,
        created_at: 1000,
      },
      {
        id: 'srv-controlled-target',
        user_id: USER_ID,
        name: 'ctrl',
        display_name: 'ctrl',
        node_id: '1234567890',
        token_hash: 'd'.repeat(64),
        node_role: 'controlled',
        os: 'mac',
        arch: 'arm64',
        abi_profile: 'modern',
        host_server_id: null,
        bound_with_key_id: null,
        revoked_at: null,
        created_at: 1000,
      },
    ]);
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

    const foreignRes = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, hostServerId: 'srv-foreign-1' }),
    });
    expect(foreignRes.status).toBe(403);

    const ctrlTargetRes = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, hostServerId: 'srv-controlled-target' }),
    });
    expect(ctrlTargetRes.status).toBe(403);
  });

  it('enrolls without IMCODES_NODE_EXE_DIR, links hostServerId cleanly, clears prior host links, and replays idempotently', async () => {
    delete process.env.IMCODES_NODE_EXE_DIR;
    const { app, servers, audits } = makeTestApp([
      {
        id: 'srv-daemon-owned',
        user_id: USER_ID,
        name: 'my-mac',
        display_name: 'my-mac',
        node_id: null,
        token_hash: 'e'.repeat(64),
        node_role: 'full',
        os: 'mac',
        arch: 'arm64',
        abi_profile: null,
        host_server_id: null,
        bound_with_key_id: null,
        revoked_at: null,
        created_at: 1000,
      },
      {
        id: 'srv-stale-controlled',
        user_id: USER_ID,
        name: 'old-node',
        display_name: 'old-node',
        node_id: '1111111111',
        token_hash: 'f'.repeat(64),
        node_role: 'controlled',
        os: 'mac',
        arch: 'arm64',
        abi_profile: 'modern',
        host_server_id: 'srv-daemon-owned',
        bound_with_key_id: null,
        revoked_at: null,
        created_at: 1500,
      },
    ]);
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

    const first = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, hostServerId: 'srv-daemon-owned' }),
    });
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created).toMatchObject({
      ok: true,
      nodeRole: 'controlled',
      idempotent: false,
      hostServerId: 'srv-daemon-owned',
    });
    expect(created.serverId).toMatch(/^[0-9a-f]{32}$/);
    expect(created.nodeId).toMatch(/^\d{10}$/);

    // Old controlled node's host_server_id cleared
    const staleRow = servers.find((s) => s.id === 'srv-stale-controlled');
    expect(staleRow?.host_server_id).toBeNull();

    // New row has abi_profile & bound_with_key_id
    const newRow = servers.find((s) => s.id === created.serverId);
    expect(newRow?.abi_profile).toBe('modern');
    expect(newRow?.bound_with_key_id).toBe(KEY_ID);
    expect(newRow?.host_server_id).toBe('srv-daemon-owned');
    expect(audits.some((a) => a.action === 'enroll.v2.direct' && (a.details as { serverId?: string }).serverId === created.serverId)).toBe(true);

    // Idempotent replay with same tokenHash
    const replay = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, hostServerId: 'srv-daemon-owned' }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      serverId: created.serverId,
      nodeId: created.nodeId,
      idempotent: true,
      hostServerId: 'srv-daemon-owned',
    });
    expect(audits.some((a) => a.action === 'enroll.v2.direct.idempotent')).toBe(true);
  });

  it('returns 409 on tokenHash owned by another user or mismatched arch/os or hostServerId conflict', async () => {
    const { app } = makeTestApp([
      {
        id: 'srv-existing-ctrl',
        user_id: USER_ID,
        name: 'mac',
        display_name: 'mac',
        node_id: '2222222222',
        token_hash: VALID_BODY.nodeTokenHash,
        node_role: 'controlled',
        os: 'mac',
        arch: 'arm64',
        abi_profile: 'modern',
        host_server_id: 'srv-daemon-a',
        bound_with_key_id: KEY_ID,
        revoked_at: null,
        created_at: 2000,
      },
      {
        id: 'srv-daemon-b',
        user_id: USER_ID,
        name: 'daemon-b',
        display_name: 'daemon-b',
        node_id: null,
        token_hash: '9'.repeat(64),
        node_role: 'full',
        os: 'mac',
        arch: 'arm64',
        abi_profile: null,
        host_server_id: null,
        bound_with_key_id: null,
        revoked_at: null,
        created_at: 1000,
      },
    ]);
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

    const archMismatch = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, arch: 'x64' }),
    });
    expect(archMismatch.status).toBe(409);

    const hostConflict = await app.request('/api/enroll/v2/direct', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...VALID_BODY, hostServerId: 'srv-daemon-b' }),
    });
    expect(hostConflict.status).toBe(409);
  });

  it('serializes concurrent direct enrollments for the same nodeTokenHash (201 create + 200 idempotent replay, single row)', async () => {
    const { app, servers, lockEvents } = makeTestApp([], { asyncYieldMs: 15 });
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
    const reqInit: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(VALID_BODY),
    };

    const [r1, r2] = await Promise.all([
      app.request('/api/enroll/v2/direct', reqInit),
      app.request('/api/enroll/v2/direct', reqInit),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 201]);

    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.serverId).toBe(b2.serverId);
    expect(b1.nodeId).toBe(b2.nodeId);
    expect([b1.idempotent, b2.idempotent].sort()).toEqual([false, true]);
    expect(servers.filter((s) => s.node_role === 'controlled')).toHaveLength(1);

    const expectedLockKey = `enroll:v2:direct:${VALID_BODY.nodeTokenHash}`;
    const eventsForKey = lockEvents.filter((e) => e.key === expectedLockKey);
    // Mutual exclusion: second transaction cannot acquire until first releases
    expect(eventsForKey.filter((e) => e.phase !== 'acquire').map((e) => e.phase)).toEqual([
      'acquired', 'release', 'acquired', 'release',
    ]);
  });

  it('serializes concurrent conflicting users with the same nodeTokenHash (201 + 409, single row)', async () => {
    const { app, servers } = makeTestApp([], { asyncYieldMs: 15 });
    const [r1, r2] = await Promise.all([
      app.request('/api/enroll/v2/direct', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      }),
      app.request('/api/enroll/v2/direct', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OTHER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      }),
    ]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([201, 409]);
    expect(servers.filter((s) => s.node_role === 'controlled')).toHaveLength(1);
  });

  it('uses per-nodeTokenHash advisory lock keys so distinct tokens create distinct controlled servers', async () => {
    const { app, servers, lockEvents } = makeTestApp([], { asyncYieldMs: 10 });
    const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
    const hashA = '1'.repeat(64);
    const hashB = '2'.repeat(64);

    const [r1, r2] = await Promise.all([
      app.request('/api/enroll/v2/direct', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...VALID_BODY, nodeTokenHash: hashA }),
      }),
      app.request('/api/enroll/v2/direct', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...VALID_BODY, nodeTokenHash: hashB }),
      }),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.serverId).not.toBe(b2.serverId);
    expect(b1.nodeId).not.toBe(b2.nodeId);
    expect(servers.filter((s) => s.node_role === 'controlled')).toHaveLength(2);
    expect(new Set(lockEvents.map((e) => e.key))).toEqual(new Set([
      `enroll:v2:direct:${hashA}`,
      `enroll:v2:direct:${hashB}`,
    ]));
  });
});
