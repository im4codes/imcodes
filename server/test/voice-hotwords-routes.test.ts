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
  VOICE_HOTWORDS_PREF_KEY,
} from '../../shared/voice-hotwords.js';
import { activeUserAnswer } from './helpers/user-status.js';

const JWT_KEY = 'test-signing-key-32chars-padding!!';
const BOT_KEY = 'test-bot-encryption-key-32chars!!';
const DAEMON_TOKEN = 'daemon-token-voice-hotwords-test';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function makeMemDb(): { db: Database; prefs: Map<string, string> } {
  const prefs = new Map<string, string>();
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
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(db),
  } as unknown as Database;

  return { db, prefs };
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

  it('requires authentication and isolates users while reusing user_preferences', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    expect((await app.request(VOICE_HOTWORDS_API_PATH)).status).toBe(401);

    const putA = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-a', true),
      body: JSON.stringify({
        user: { raw: 'Antigravity', clientUpdatedAt: 100 },
        project: { projectKey: 'srv:srv-1::codedeck', raw: 'IM.codes', clientUpdatedAt: 100 },
        shareWithOthers: { enabled: true, clientUpdatedAt: 100 },
      }),
    });
    expect(putA.status).toBe(200);

    const getA = await app.request(`${VOICE_HOTWORDS_API_PATH}?projectKey=${encodeURIComponent('srv:srv-1::codedeck')}`, {
      headers: cookieHeaders('user-a'),
    });
    expect(getA.status).toBe(200);
    const bodyA = await getA.json() as { record: any; projectKey: string; project: { raw: string; updatedAt: number } };
    expect(bodyA.record.user).toEqual({ raw: 'Antigravity', updatedAt: 100, source: 'web' });
    expect(bodyA.projectKey).toBe('srv:srv-1::codedeck');
    expect(bodyA.project).toEqual({ raw: 'IM.codes', updatedAt: 100, source: 'web' });
    expect(bodyA.record.shareWithOthers).toEqual({ enabled: true, updatedAt: 100 });

    const getB = await app.request(VOICE_HOTWORDS_API_PATH, {
      headers: cookieHeaders('user-b'),
    });
    expect(getB.status).toBe(200);
    expect((await getB.json() as { record: any }).record).toEqual({
      version: 1,
      user: { raw: '', updatedAt: 0 },
      projects: {},
      shareWithOthers: { enabled: false, updatedAt: 0 },
    });
  });

  it('supports LWW per-scope updates, merge deduplication, and empty tombstones without resurrecting cleared entries', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    // Initial write at t=200
    await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        user: { raw: 'IM.codes', clientUpdatedAt: 200 },
        project: { projectKey: 'codedeck', raw: 'WorkTree\n错别词 => IM.codes', clientUpdatedAt: 200 },
      }),
    });

    // Stale write at t=150 must NOT overwrite t=200
    const staleRes = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        user: { raw: 'StaleWord', clientUpdatedAt: 150 },
      }),
    });
    expect(staleRes.status).toBe(200);
    expect((await staleRes.json() as { record: any }).record.user.raw).toBe('IM.codes');

    // Explicit clear at t=300 writes an empty tombstone; stale non-empty at t=250 cannot resurrect it
    await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        user: { raw: '', mode: 'replace', clientUpdatedAt: 300 },
      }),
    });
    const staleResurrect = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        user: { raw: 'ResurrectedWord', mode: 'replace', clientUpdatedAt: 250 },
      }),
    });
    expect((await staleResurrect.json() as { record: any }).record.user).toEqual({
      raw: '',
      updatedAt: 300,
      source: 'web',
    });

    // Daemon MCP merge write marks source='mcp' and deduplicates lines cleanly
    const mcpMerge = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: daemonHeaders,
      body: JSON.stringify({
        project: {
          projectKey: 'codedeck',
          raw: 'worktree\n错别词 -> IM.codes\ncodex-sdk',
          mode: 'merge',
        },
      }),
    });
    expect(mcpMerge.status).toBe(200);
    const mergedJson = await mcpMerge.json() as { record: any };
    expect(mergedJson.record.projects.codedeck.raw).toBe('WorkTree\n错别词 => IM.codes\ncodex-sdk');
    expect(mergedJson.record.projects.codedeck.source).toBe('mcp');
  });

  it('rejects shared-session participant turns and blocks /api/preferences/voice_hotwords_v1', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    // Participant turn on daemon credential must be denied (403)
    const participantAuthority = signJwt(
      {
        typ: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: 'guest-user',
        ownerUserId: 'user-1',
        sourceServerId: 'srv-1',
        projectName: 'codedeck',
      },
      JWT_KEY,
      300,
    );
    const getParticipant = await app.request(VOICE_HOTWORDS_API_PATH, {
      headers: {
        ...daemonHeaders,
        [SHARED_MACHINE_AUTHORITY_HEADER]: participantAuthority,
      },
    });
    expect(getParticipant.status).toBe(403);

    const putParticipant = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: {
        ...daemonHeaders,
        [SHARED_MACHINE_AUTHORITY_HEADER]: participantAuthority,
      },
      body: JSON.stringify({ user: { raw: 'TamperWord' } }),
    });
    expect(putParticipant.status).toBe(403);

    // Direct /api/preferences/:key access to reserved VOICE_HOTWORDS_PREF_KEY must be denied (403)
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

  it('validates input sizes, invalid project keys, and compacts empty tombstones before rejecting excess projects', async () => {
    const { db } = makeMemDb();
    const app = buildApp(makeEnv(db));

    const badRaw = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        user: { raw: 'x'.repeat(VOICE_HOTWORDS_MAX_RAW_CHARS + 1) },
      }),
    });
    expect(badRaw.status).toBe(400);

    const badKey = await app.request(`${VOICE_HOTWORDS_API_PATH}?projectKey=${encodeURIComponent('bad\nkey')}`, {
      headers: cookieHeaders('user-1'),
    });
    expect(badKey.status).toBe(400);

    // Seed VOICE_HOTWORDS_MAX_PROJECTS projects (99 active + 1 empty tombstone), then adding a new active project compacts the empty tombstone cleanly
    const seedProjects: Record<string, { raw: string; clientUpdatedAt: number }> = {
      tombstone: { raw: '', clientUpdatedAt: 10 },
    };
    for (let i = 0; i < VOICE_HOTWORDS_MAX_PROJECTS - 1; i += 1) {
      seedProjects[`proj-${i}`] = { raw: `Term${i}`, clientUpdatedAt: 100 + i };
    }
    const seedRes = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({ projects: seedProjects }),
    });
    expect(seedRes.status).toBe(200);

    const addOneMore = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        project: { projectKey: 'proj-extra', raw: 'ExtraTerm', clientUpdatedAt: 500 },
      }),
    });
    expect(addOneMore.status).toBe(200);
    const addedBody = await addOneMore.json() as { record: any };
    expect(addedBody.record.projects.tombstone).toBeUndefined();
    expect(addedBody.record.projects['proj-extra'].raw).toBe('ExtraTerm');

    // Adding another active project with no empty tombstones left must return 400
    const overflow = await app.request(VOICE_HOTWORDS_API_PATH, {
      method: 'PUT',
      headers: cookieHeaders('user-1', true),
      body: JSON.stringify({
        project: { projectKey: 'proj-overflow', raw: 'TooMany', clientUpdatedAt: 600 },
      }),
    });
    expect(overflow.status).toBe(400);
    expect(await overflow.json()).toEqual({ error: 'too_many_projects' });
  });
});
