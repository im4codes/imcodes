import { describe, it, expect, beforeEach } from 'vitest';
import {
  createUser,
  getUserById,
  upsertPlatformIdentity,
  getUserByPlatformId,
  createServer,
  getServerById,
  updateServerHeartbeat,
  updateServerStatus,
  upsertChannelBinding,
  getChannelBinding,
  getDueCronJobs,
  updateCronJobRun,
} from '../../src/db/queries.js';

// Mock D1Database for unit tests
function mockD1(rows: Record<string, unknown>[] = []) {
  const stored: Record<string, Record<string, unknown>[]> = {};
  let lastRun: { sql: string; params: unknown[] } | null = null;

  const makeStmt = (sql: string) => ({
    _sql: sql,
    _params: [] as unknown[],
    bind(...args: unknown[]) {
      this._params = args;
      return this;
    },
    async first<T>(): Promise<T | null> {
      // Match rows where all bound params appear as values in the row
      const result = rows.find((r) => {
        if (this._params.length === 0) return true;
        const vals = Object.values(r);
        return this._params.every((p) => p === undefined || vals.includes(p));
      });
      return (result as T) ?? null;
    },
    async all<T>(): Promise<{ results: T[] }> {
      return { results: rows as T[] };
    },
    async run() {
      lastRun = { sql, params: this._params };
      return { success: true, meta: {} };
    },
  });

  return {
    prepare: (sql: string) => makeStmt(sql),
    _getLastRun: () => lastRun,
  } as unknown as D1Database & { _getLastRun: () => typeof lastRun };
}

describe('createUser', () => {
  it('returns user with id and created_at', async () => {
    const db = mockD1();
    const user = await createUser(db, 'user-1');
    expect(user.id).toBe('user-1');
    expect(user.created_at).toBeGreaterThan(0);
  });
});

describe('getUserById', () => {
  it('returns user when found', async () => {
    const db = mockD1([{ id: 'user-1', created_at: 123 }]);
    const user = await getUserById(db, 'user-1');
    expect(user).not.toBeNull();
  });

  it('returns null when not found', async () => {
    const db = mockD1([]);
    const user = await getUserById(db, 'nonexistent');
    expect(user).toBeNull();
  });
});

describe('createServer', () => {
  it('returns server record with correct fields', async () => {
    const db = mockD1();
    const server = await createServer(db, 'srv-1', 'user-1', 'My Server', 'hash123');
    expect(server).toMatchObject({
      id: 'srv-1',
      user_id: 'user-1',
      name: 'My Server',
      token_hash: 'hash123',
      status: 'offline',
      team_id: null,
    });
    expect(server.created_at).toBeGreaterThan(0);
  });
});

describe('getServerById', () => {
  it('returns server when found', async () => {
    const db = mockD1([{ id: 'srv-1', user_id: 'u1', name: 'Server', token_hash: 'h', status: 'online', created_at: 1 }]);
    const server = await getServerById(db, 'srv-1');
    expect(server).not.toBeNull();
    expect(server?.id).toBe('srv-1');
  });
});

describe('updateServerHeartbeat', () => {
  it('runs UPDATE query', async () => {
    const db = mockD1();
    // Should not throw
    await expect(updateServerHeartbeat(db, 'srv-1')).resolves.toBeUndefined();
  });
});

describe('updateServerStatus', () => {
  it('runs UPDATE query', async () => {
    const db = mockD1();
    await expect(updateServerStatus(db, 'srv-1', 'offline')).resolves.toBeUndefined();
  });
});

describe('upsertChannelBinding / getChannelBinding', () => {
  it('upsert runs without error', async () => {
    const db = mockD1();
    await expect(
      upsertChannelBinding(db, 'cb-1', 'srv-1', 'discord', 'ch-123', 'project', 'my-project', 'bot-1'),
    ).resolves.toBeUndefined();
  });

  it('returns binding when found', async () => {
    const db = mockD1([{
      id: 'cb-1', server_id: 'srv-1', platform: 'discord',
      channel_id: 'ch-123', binding_type: 'project', target: 'my-project', created_at: 1,
    }]);
    const binding = await getChannelBinding(db, 'discord', 'ch-123', 'srv-1');
    expect(binding).not.toBeNull();
    expect(binding?.target).toBe('my-project');
  });
});

describe('getDueCronJobs', () => {
  it('returns empty array when no jobs due', async () => {
    const db = mockD1([]);
    const jobs = await getDueCronJobs(db);
    expect(jobs).toEqual([]);
  });

  it('returns jobs from DB', async () => {
    const db = mockD1([{ id: 'job-1', cron_expr: '* * * * *', enabled: 1 }]);
    const jobs = await getDueCronJobs(db);
    expect(jobs).toHaveLength(1);
  });
});
