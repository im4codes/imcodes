/**
 * Tests for the cloud memory pruning cron handler.
 *
 * Verifies that memoryPruningCron deletes only archived projections
 * older than 90 days, leaving active and recently archived rows untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

// ── Mock DB ─────────────────────────────────────────────────────────────────

interface ExecuteCall {
  sql: string;
  params: unknown[];
}

function makeMockDb(deletedCount = 0) {
  const executeCalls: ExecuteCall[] = [];

  const db: Database = {
    queryOne: async () => null,
    query: async () => [],
    execute: async (sql: string, params: unknown[] = []) => {
      executeCalls.push({ sql, params });
      return { changes: deletedCount };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;

  return { db, executeCalls };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'test',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('memoryPruningCron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes archived projections older than 90 days', async () => {
    const { db, executeCalls } = makeMockDb(3);
    const env = makeEnv(db);

    const { memoryPruningCron } = await import('../src/cron/memory-pruning.js');
    await memoryPruningCron(env);

    expect(executeCalls).toHaveLength(1);
    const call = executeCalls[0];

    // Should target archived rows only
    expect(call.sql.toLowerCase()).toContain("status = 'archived'");
    expect(call.sql.toLowerCase()).toContain('delete from shared_context_projections');

    // The cutoff param should be approximately now - 90 days
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = call.params[0] as number;
    const expectedCutoff = Date.now() - NINETY_DAYS_MS;
    // Allow 5 seconds of clock drift
    expect(cutoff).toBeGreaterThan(expectedCutoff - 5000);
    expect(cutoff).toBeLessThanOrEqual(expectedCutoff + 5000);
  });

  it('does not delete active projections', async () => {
    const { db, executeCalls } = makeMockDb(0);
    const env = makeEnv(db);

    const { memoryPruningCron } = await import('../src/cron/memory-pruning.js');
    await memoryPruningCron(env);

    expect(executeCalls).toHaveLength(1);
    const call = executeCalls[0];

    // The SQL filters on status = 'archived', so active rows are never touched
    expect(call.sql.toLowerCase()).toContain("status = 'archived'");
    expect(call.sql.toLowerCase()).not.toContain("status = 'active'");
  });

  it('does not delete recently archived projections', async () => {
    const { db, executeCalls } = makeMockDb(0);
    const env = makeEnv(db);

    const { memoryPruningCron } = await import('../src/cron/memory-pruning.js');
    await memoryPruningCron(env);

    expect(executeCalls).toHaveLength(1);
    const call = executeCalls[0];

    // The query uses updated_at < cutoff, so recently archived items (with
    // updated_at close to now) are excluded.
    expect(call.sql.toLowerCase()).toContain('updated_at');
    const cutoff = call.params[0] as number;
    // Cutoff should be in the past (90 days ago), not in the future
    expect(cutoff).toBeLessThan(Date.now());
    // A recently archived row (e.g., today) has updated_at > cutoff, so it survives
    expect(Date.now()).toBeGreaterThan(cutoff);
  });
});
