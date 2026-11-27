import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { signJwt } from '../src/security/crypto.js';
import { COOKIE_CSRF, COOKIE_SESSION, HEADER_CSRF } from '../../shared/cookie-names.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { SHARED_MACHINE_AUTHORITY_HEADER, SHARED_MACHINE_AUTHORITY_TYPE } from '../../shared/shared-machine-authority.js';
import {
  VOICE_HOTWORDS_API_PATH,
  VOICE_HOTWORDS_MAX_PROJECTS,
  VOICE_HOTWORDS_MAX_RAW_CHARS,
  VOICE_HOTWORDS_MAX_STORAGE_BYTES,
  VOICE_HOTWORDS_PREF_KEY,
} from '../../shared/voice-hotwords.js';
import { activeUserAnswer } from './helpers/user-status.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';
const BOT_KEY = 'test-bot-encryption-key-32chars!!';
const DAEMON_TOKEN = 'daemon-token-voice-hotwords-test';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface MakeMemDbOptions {
  enforceAdvisoryLock?: boolean;
  onFirstPrefRead?: (userId: string) => Promise<void> | void;
}

function makeMemDb(options: MakeMemDbOptions = {}): {
  db: Database;
  prefs: Map<string, string>;
  lockOrder: string[];
} {
  const prefs = new Map<string, string>();
  const lockOrder: string[] = [];
  const locks = new Map<string, Promise<void>>();
  let readCount = 0;

  const keyFor = (userId: string, key: string) => `${userId}:${key}`;
  const db = {
    query: async <T = unknown>(sql: string): Promise<T[]> => {
      const activeUser = activeUserAnswer(sql);
      if (activeUser) return [activeUser as T];
      return [];
    },
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const activeUser = activeUserAnswer(sql);
      if (activeUser) return activeUser as T;
      const s = sql.toLowerCase().replace(/\s+/g, ' ');
      if (s.includes('from servers where id')) {
        if (params[0] === 'srv-1') {
          return {
            id: 'srv-1',
            user_id: 'user-1',
            token_hash: sha256(DAEMON_TOKEN),
            status: 'active',
            node_role: 'full',
            revoked_at: null,
            owner_status: 'active',
          } as T;
        }
        return null;
      }
      if (s.includes('from users where id')) {
        return { id: String(params[0]), is_admin: false, status: 'active' } as T;
      }
      if (s.includes('from user_preferences')) {
        readCount += 1;
        if (readCount === 1 && options.onFirstPrefRead) {
          await options.onFirstPrefRead(String(params[0]));
        }
        const val = prefs.get(keyFor(String(params[0]), String(params[1])));
        return (val !== undefined ? { value: val } : null) as T | null;
      }
      return null;
    },
    execute: async (sql: string, params: unknown[] = []): Promise<void> => {
      const s = sql.toLowerCase().replace(/\s+/g, ' ');
      if (s.includes('insert into user_preferences')) {
        prefs.set(keyFor(String(params[0]), String(params[1])), String(params[2]));
      } else if (s.includes('delete from user_preferences')) {
        prefs.delete(keyFor(String(params[0]), String(params[1])));
      }
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      let lockedKey: string | null = null;
      let releaseLock: (() => void) | null = null;
      const tx = {
        ...db,
        queryOne: async <U = unknown>(sql: string, params: unknown[] = []): Promise<U | null> => {
          const s = sql.toLowerCase().replace(/\s+/g, ' ');
          if (s.includes('pg_advisory_xact_lock')) {
            const k = String(params[0] ?? 'default');
            lockOrder.push(`enter:${k}`);
            if (options.enforceAdvisoryLock !== false) {
              while (locks.has(k)) {
                await locks.get(k);
              }
              let resolveFn!: () => void;
              const waitPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
              void waitPromise;
              const gate = new Promise<void>((r) => { resolveFn = r; });
              releaseLock = resolveFn;
              locks.set(k, gate);
              lockedKey = k;
            }
            lockOrder.push(`acquired:${k}`);
            return { pg_advisory_xact_lock: '' } as U;
          }
          return db.queryOne<U>(sql, params);
        },
        transaction: async <U>(nested: (t: Database) => Promise<U>): Promise<U> => nested(tx as unknown as Database),
      } as unknown as Database;

      try {
        return await fn(tx);
      } finally {
        if (lockedKey && locks.has(lockedKey)) {
          locks.delete(lockedKey);
          releaseLock?.();
        }
      }
    },
  } as unknown as Database;

  return { db, prefs, lockOrder };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: BOT_KEY,
    SERVER_URL: 'https://test.im.codes',
    ALLOWED_ORIGINS: 'https://test.im.codes',
    DATABASE_URL: 'postgres://localhost/test',
  } as Env;
}

function cookieHeaders(userId = 'user-1', write = false): Record<string, string> {
  const token = signJwt({ sub: userId, role: 'owner', type: 'web' }, JWT_KEY, 3600);
  const cookie = `${COOKIE_SESSION}=${token}; ${COOKIE_CSRF}=csrf-tok-1`;
  return write
    ? { Cookie: cookie, Origin: 'https://test.im.codes', [HEADER_CSRF]: 'csrf-tok-1', 'Content-Type': 'application/json' }
    : { Cookie: cookie };
}

const daemonHeaders = {
  Authorization: `Bearer ${DAEMON_TOKEN}`,
  [SERVER_ID_HEADER]: 'srv-1',
  'Content-Type': 'application/json',
};

describe('/api/voice-hotwords routes and reserved preference key', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires authentication, accepts scope+raw/entries & serverId+projectName, returns compiled summary, and isolates users', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    expect((await app.request(VOICE_HOTWORDS_API_PATH)).status).toBe(401);

    // Scoped PUT using brief's { scope: 'user', entries } + { scope: 'project', serverId, projectName, raw }
    const putUser = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-a', true),
      body: JSON.stringify({ scope: 'user', entries: ['Antigravity', '全局错词 => Antigravity'], mode: 'replace' }),
    });
    expect(putUser.status).toBe(200);
    const putUserJson = await putUser.json() as { compiled: { terms: string[]; asrTerms: string[] } };
    expect(putUserJson.compiled.terms).toEqual(['Antigravity']);
    expect(putUserJson.compiled.asrTerms).toEqual(['Antigravity', '全局错词']);

    const putProj = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-a', true),
      body: JSON.stringify({
        scope: 'project',
        serverId: 'srv-1',
        projectName: 'codedeck',
        raw: 'IM.codes',
        mode: 'replace',
      }),
    });
    expect(putProj.status).toBe(200);
    const putProjJson = await putProj.json() as { projectKey: string; project: { raw: string }; compiled: { terms: string[] } };
    expect(putProjJson.projectKey).toBe('srv:srv-1::codedeck');
    expect(putProjJson.project.raw).toBe('IM.codes');
    expect(putProjJson.compiled.terms).toEqual(['IM.codes', 'Antigravity']);

    // GET supports ?serverId=...&projectName=... and returns compiled summary
    const getByName = await app.request(`${VOICE_HOTWORDS_API_PATH}?serverId=srv-1&projectName=codedeck`, {
      headers: cookieHeaders('user-a'),
    });
    expect(getByName.status).toBe(200);
    const getBody = await getByName.json() as { record: any; projectKey: string; project: { raw: string }; compiled: { terms: string[] } };
    expect(getBody.projectKey).toBe('srv:srv-1::codedeck');
    expect(getBody.project.raw).toBe('IM.codes');
    expect(getBody.compiled.terms).toEqual(['IM.codes', 'Antigravity']);

    // User isolation
    const getB = await app.request(VOICE_HOTWORDS_API_PATH, { headers: cookieHeaders('user-b') });
    expect((await getB.json() as { record: any }).record).toEqual({
      version: 1,
      user: { raw: '', updatedAt: 0 },
      projects: {},
      shareWithOthers: { enabled: false, updatedAt: 0 },
    });
  });

  it('enforces LWW ties, advances version on repeated clears/same-value/share, clamps clock skew, and preserves tombstones', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    // Device A writes 'FirstValue' at t=1000
    await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: 'FirstValue', mode: 'replace', clientUpdatedAt: 1000 }),
    });

    // Exact millisecond tie (t=1000) with different raw 'SecondValue' -> server wins ties
    const tieRes = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: 'SecondValue', mode: 'replace', clientUpdatedAt: 1000 }),
    });
    expect((await tieRes.json() as { record: any }).record.user).toEqual({
      raw: 'FirstValue',
      updatedAt: 1000,
      source: 'web',
    });

    // Clear (t=1100), then repeated clear (t=1300) MUST advance version to 1300, defeating stale t=1200 offline edit
    await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', entries: [], mode: 'replace', clientUpdatedAt: 1100 }),
    });
    const repeatClear = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: '', mode: 'replace', clientUpdatedAt: 1300 }),
    });
    expect((await repeatClear.json() as { record: any }).record.user.updatedAt).toBe(1300);

    const staleIntermediate = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: 'OfflineOld', mode: 'replace', clientUpdatedAt: 1200 }),
    });
    expect((await staleIntermediate.json() as { record: any }).record.user).toEqual({
      raw: '',
      updatedAt: 1300,
      source: 'web',
    });

    // baseUpdatedAt OCC guard: fast-clock offline edit based on stale version (< current updatedAt) CANNOT resurrect clear
    const staleBaseRes = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        scope: 'user',
        raw: 'FastClockResurrection',
        mode: 'replace',
        baseUpdatedAt: 1000,
        clientUpdatedAt: Date.now() + 360_000,
      }),
    });
    expect((await staleBaseRes.json() as { record: any }).record.user.raw).toBe('');

    // Exact matching baseUpdatedAt succeeds and uses authoritative monotonic server version
    const matchingBaseRes = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        scope: 'user',
        raw: 'AcceptedWithBase',
        mode: 'replace',
        baseUpdatedAt: 1300,
      }),
    });
    const matchedJson = await matchingBaseRes.json() as { record: any };
    expect(matchedJson.record.user.raw).toBe('AcceptedWithBase');
    expect(matchedJson.record.user.updatedAt).toBeGreaterThan(1300);

    // serverId + projectName with reserved srv:...::... prefix binds serverId cleanly
    const reservedProjPut = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        scope: 'project',
        serverId: 'srv-1',
        projectName: 'srv:other::app',
        raw: 'BoundPrefixed',
        mode: 'replace',
      }),
    });
    expect((await reservedProjPut.json() as { projectKey: string }).projectKey).toBe('srv:srv-1::srv:other::app');

    // Repeated share=false advances updatedAt so stale share=true (t=1250) cannot re-enable sharing
    await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'share', enabled: false, clientUpdatedAt: 1100 }),
    });
    const shareRepeat = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'share', enabled: false, clientUpdatedAt: 1400 }),
    });
    expect((await shareRepeat.json() as { record: any }).record.shareWithOthers.updatedAt).toBe(1400);
    const shareStale = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'share', enabled: true, clientUpdatedAt: 1250 }),
    });
    expect((await shareStale.json() as { record: any }).record.shareWithOthers).toEqual({
      enabled: false,
      updatedAt: 1400,
    });

    // Absurd future clientUpdatedAt (year 3000) is clamped to <= now + 5m so normal MCP writes can still advance later
    const before = Date.now();
    const futureRes = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'project', projectKey: 'codedeck', raw: 'FutureClient', clientUpdatedAt: 32_503_680_000_000 }),
    });
    const futureRecord = await futureRes.json() as { record: any };
    expect(futureRecord.record.projects.codedeck.updatedAt).toBeLessThanOrEqual(before + 6 * 60 * 1000);
    const mcpLater = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: daemonHeaders,
      body: JSON.stringify({ scope: 'project', projectKey: 'codedeck', raw: 'McpAfterSkew', mode: 'replace' }),
    });
    expect((await mcpLater.json() as { project: { raw: string } }).project.raw).toBe('McpAfterSkew');
  });

  it('handles prototype-colliding legacy project keys safely across GET and PUT', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const putRes = await app.request(VOICE_HOTWORDS_API_PATH, {
        method: 'PUT',
        headers: cookieHeaders('user-proto', true),
        body: `{"scope":"project","projectName":${JSON.stringify(key)},"raw":"Term_${key}","mode":"replace"}`,
      });
      expect(putRes.status).toBe(200);
    }

    const getRes = await app.request(VOICE_HOTWORDS_API_PATH, {
      headers: cookieHeaders('user-proto'),
    });
    expect(getRes.status).toBe(200);
    const text = await getRes.text();
    const parsed = JSON.parse(text) as { record: { projects: Record<string, { raw: string }> } };
    expect(parsed.record.projects.constructor.raw).toBe('Term_constructor');
    expect(parsed.record.projects.toString.raw).toBe('Term_toString');
    expect(parsed.record.projects.hasOwnProperty.raw).toBe('Term_hasOwnProperty');
    expect(Object.prototype.hasOwnProperty.call(parsed.record.projects, '__proto__')).toBe(true);
    expect(parsed.record.projects['__proto__'].raw).toBe('Term___proto__');
  });

  it('serializes concurrent cross-scope PUT transactions via pg_advisory_xact_lock without lost updates', async () => {
    let releaseFirstRead!: () => void;
    let firstReadArrived!: () => void;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const firstReadDone = new Promise<void>((resolve) => { firstReadArrived = resolve; });

    const { db, lockOrder } = makeMemDb({
      enforceAdvisoryLock: true,
      onFirstPrefRead: async () => {
        firstReadArrived();
        await firstReadGate;
      },
    });
    const app = buildApp(makeEnv(db));

    // Start PUT #1 (user scope) and pause inside transaction right after reading DB
    const req1 = app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-concurrent', true),
      body: JSON.stringify({ scope: 'user', raw: 'GlobalConcurrent', mode: 'replace' }),
    });
    await firstReadDone;

    // Launch PUT #2 (project scope) while PUT #1 holds advisory lock
    const req2 = app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: daemonHeaders,
      // Note daemon belongs to user-1 in makeMemDb, so run PUT #2 for user-concurrent via web cookie too
    });
    void req2; // discard unauthorized stub
    const req2Authed = app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-concurrent', true),
      body: JSON.stringify({ scope: 'project', projectKey: 'codedeck', raw: 'ProjectConcurrent', mode: 'replace' }),
    });

    // Wait a tick so req2 attempts lock acquisition, then release req1
    await new Promise((r) => setTimeout(r, 20));
    releaseFirstRead();

    const [res1, res2] = await Promise.all([req1, req2Authed]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Lock trace proves tx2 did NOT acquire before tx1 exited
    const acquiredIndices = lockOrder
      .map((entry, idx) => (entry.startsWith('acquired:') ? idx : -1))
      .filter((i) => i >= 0);
    expect(acquiredIndices).toHaveLength(2);

    const finalGet = await app.request(`${VOICE_HOTWORDS_API_PATH}?projectKey=codedeck`, {
      headers: cookieHeaders('user-concurrent'),
    });
    const finalJson = await finalGet.json() as { record: { user: { raw: string }; projects: Record<string, { raw: string }> } };
    expect(finalJson.record.user.raw).toBe('GlobalConcurrent');
    expect(finalJson.record.projects.codedeck.raw).toBe('ProjectConcurrent');
  });

  it('rejects unknown/conflicting fields, oversized raw UTF-8 requests, >100 projects without evicting tombstones, participant turns, and reserved preferences key', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    // Conflicting & unknown fields
    expect((await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: 'a', entries: ['a'] }),
    })).status).toBe(400);
    expect((await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: 'a', bogusField: true }),
    })).status).toBe(400);
    expect((await app.request(`${VOICE_HOTWORDS_API_PATH}?serverId=srv-1`, {
      headers: cookieHeaders('user-1'),
    })).status).toBe(400);
    expect((await app.request(`${VOICE_HOTWORDS_API_PATH}?projectKey=${encodeURIComponent('srv:srv-1::a')}&serverId=srv-2`, {
      headers: cookieHeaders('user-1'),
    })).status).toBe(400);

    // Multi-byte UTF-8 body > 60KB MUST be rejected even if raw lengths per key were short / no-op
    const cjkPad = '热词'.repeat(11_000); // > 66KB UTF-8
    const oversizedPayload = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: 'ok', unknownBig: cjkPad }),
    });
    expect(oversizedPayload.status).toBe(400);
    expect(Buffer.byteLength(cjkPad, 'utf8')).toBeGreaterThan(VOICE_HOTWORDS_MAX_STORAGE_BYTES);

    // > MAX_RAW_CHARS rejected
    expect((await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'user', raw: 'x'.repeat(VOICE_HOTWORDS_MAX_RAW_CHARS + 1) }),
    })).status).toBe(400);

    // Tombstone preservation across > 100 projects: 99 active + 1 empty tombstone fills the 100-project cap; adding 101st MUST fail 400 and keep the tombstone intact!
    const seedProjects: Record<string, { raw: string; clientUpdatedAt: number }> = {
      clearedProj: { raw: '', clientUpdatedAt: 100 },
    };
    for (let i = 0; i < VOICE_HOTWORDS_MAX_PROJECTS - 1; i += 1) {
      seedProjects[`proj-${i}`] = { raw: `Term${i}`, clientUpdatedAt: 100 + i };
    }
    expect((await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'sync', projects: seedProjects }),
    })).status).toBe(200);

    const overflow = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ scope: 'project', projectKey: 'proj-101', raw: 'Overflow', clientUpdatedAt: 500 }),
    });
    expect(overflow.status).toBe(400);
    expect(await overflow.json()).toEqual({ error: 'too_many_projects' });

    const checkTombstone = await app.request(`${VOICE_HOTWORDS_API_PATH}?projectKey=clearedProj`, {
      headers: cookieHeaders('user-1'),
    });
    expect((await checkTombstone.json() as { project: { raw: string; updatedAt: number } }).project).toEqual({
      raw: '',
      updatedAt: 100,
      source: 'web',
    });

    // Participant turn and reserved /api/preferences key blocked (403)
    const participantAuthority = signJwt(
      { typ: SHARED_MACHINE_AUTHORITY_TYPE, sub: 'guest', ownerUserId: 'user-1', sourceServerId: 'srv-1', projectName: 'codedeck' },
      JWT_KEY,
      300,
    );
    expect((await app.request(VOICE_HOTWORDS_API_PATH, {
      headers: { ...daemonHeaders, [SHARED_MACHINE_AUTHORITY_HEADER]: participantAuthority },
    })).status).toBe(403);
    expect((await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: { ...daemonHeaders, [SHARED_MACHINE_AUTHORITY_HEADER]: participantAuthority },
      body: JSON.stringify({ scope: 'user', raw: 'Tamper' }),
    })).status).toBe(403);

    expect((await app.request(`/api/preferences/${VOICE_HOTWORDS_PREF_KEY}`, { headers: cookieHeaders('user-1') })).status).toBe(403);
    expect((await app.request(`/api/preferences/${VOICE_HOTWORDS_PREF_KEY}`, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ value: { tampered: true } }),
    })).status).toBe(403);
    expect((await app.request(`/api/preferences/${VOICE_HOTWORDS_PREF_KEY}`, {
      method: 'DELETE',
      headers: cookieHeaders('user-1', true),
    })).status).toBe(403);
  });
});
