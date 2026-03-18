import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger to suppress output during tests
vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock audit logger
vi.mock('../../src/security/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import { healthCheckCron } from '../../src/cron/health-check.js';

function makeStmt(rows: unknown[] = []) {
  return {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: rows }),
    run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
  };
}

function mockDb(staleServers: unknown[] = []) {
  const staleStmt = makeStmt(staleServers);
  const updateStmt = makeStmt();

  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT')) return staleStmt;
    return updateStmt;
  });

  return { prepare, _updateStmt: updateStmt, _staleStmt: staleStmt };
}

describe('healthCheckCron', () => {
  it('is a function', () => {
    expect(typeof healthCheckCron).toBe('function');
  });

  it('completes without error when no stale servers', async () => {
    const db = mockDb([]);
    const env = { DB: db } as never;

    await expect(healthCheckCron(env)).resolves.toBeUndefined();
  });

  it('queries for servers with stale heartbeats', async () => {
    const db = mockDb([]);
    const env = { DB: db } as never;

    await healthCheckCron(env);

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('last_heartbeat_at'),
    );
  });

  it('marks stale servers offline and calls logAudit', async () => {
    const staleServers = [
      { id: 'srv-1', name: 'Server One', user_id: 'u1', last_heartbeat_at: 1000 },
      { id: 'srv-2', name: 'Server Two', user_id: 'u2', last_heartbeat_at: null },
    ];
    const db = mockDb(staleServers);
    const env = { DB: db } as never;

    await healthCheckCron(env);

    // UPDATE should be called once per stale server
    expect(db._updateStmt.run).toHaveBeenCalledTimes(staleServers.length);

    const { logAudit } = await import('../../src/security/audit.js');
    expect(logAudit).toHaveBeenCalledTimes(staleServers.length);
  });

  it('passes cutoff timestamp to the DB query', async () => {
    const db = mockDb([]);
    const before = Date.now();
    const env = { DB: db } as never;

    await healthCheckCron(env);

    const after = Date.now();
    const boundArg = db._staleStmt.bind.mock.calls[0]?.[0] as number;
    // cutoff = now - 10min, so it should be between (before - 10min) and (after - 10min)
    const tenMin = 10 * 60 * 1000;
    expect(boundArg).toBeGreaterThanOrEqual(before - tenMin - 100);
    expect(boundArg).toBeLessThanOrEqual(after - tenMin + 100);
  });
});
