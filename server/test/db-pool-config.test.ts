import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS,
  DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_DB_POOL_MAX,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  resolveDatabasePoolConfig,
} from '../src/db/client.js';
import { loadEnv } from '../src/env.js';

describe('database pool configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('uses tuned defaults when no options or env overrides are provided', () => {
    const config = resolveDatabasePoolConfig('postgres://user:pass@localhost:5432/imcodes', undefined, {});
    expect(config).toEqual({
      connectionString: 'postgres://user:pass@localhost:5432/imcodes',
      max: DEFAULT_DB_POOL_MAX,
      connectionTimeoutMillis: DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      statement_timeout: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    });
  });

  it('honors DB_POOL_* and DB_STATEMENT_TIMEOUT_MS environment variables and explicit options', () => {
    const fromEnv = resolveDatabasePoolConfig('postgres://user:pass@localhost:5432/imcodes', undefined, {
      DB_POOL_MAX: '40',
      DB_POOL_CONNECTION_TIMEOUT_MS: '7500',
      DB_POOL_IDLE_TIMEOUT_MS: '45000',
      DB_STATEMENT_TIMEOUT_MS: '20000',
    });
    expect(fromEnv).toMatchObject({
      max: 40,
      connectionTimeoutMillis: 7500,
      idleTimeoutMillis: 45000,
      statement_timeout: 20000,
    });

    const explicit = resolveDatabasePoolConfig(
      'postgres://user:pass@localhost:5432/imcodes',
      { max: 12, connectionTimeoutMillis: 2500, idleTimeoutMillis: 15000, statementTimeoutMs: 8000 },
      { DB_POOL_MAX: '40' },
    );
    expect(explicit).toMatchObject({
      max: 12,
      connectionTimeoutMillis: 2500,
      idleTimeoutMillis: 15000,
      statement_timeout: 8000,
    });
  });

  it('falls back to safe defaults when env overrides are invalid or out of bounds', () => {
    const config = resolveDatabasePoolConfig('postgres://user:pass@localhost:5432/imcodes', undefined, {
      DB_POOL_MAX: '0',
      DB_POOL_CONNECTION_TIMEOUT_MS: 'not-a-number',
      DB_POOL_IDLE_TIMEOUT_MS: '250',
      DB_STATEMENT_TIMEOUT_MS: '-100',
    });
    expect(config).toMatchObject({
      max: DEFAULT_DB_POOL_MAX,
      connectionTimeoutMillis: DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      statement_timeout: DEFAULT_DB_STATEMENT_TIMEOUT_MS,
    });
  });

  it('registers a pool error listener and preserves 1-arg createDatabase(databaseUrl) compatibility', async () => {
    process.env.DB_POOL_MAX = '32';
    const db = createDatabase('postgres://user:pass@localhost:5432/imcodes');
    try {
      const pool = (db as unknown as { pool: { options: Record<string, unknown>; listenerCount: (ev: string) => number } }).pool;
      expect(pool.options.max).toBe(32);
      expect(pool.options.connectionTimeoutMillis).toBe(DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS);
      expect(pool.options.idleTimeoutMillis).toBe(DEFAULT_DB_POOL_IDLE_TIMEOUT_MS);
      expect(pool.options.statement_timeout).toBe(DEFAULT_DB_STATEMENT_TIMEOUT_MS);
      expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    } finally {
      await db.close();
    }
  });

  it('exposes DB_POOL_* and DB_STATEMENT_TIMEOUT_MS in loadEnv()', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/imcodes';
    process.env.JWT_SIGNING_KEY = 'test-signing-key-32chars-padding!!';
    process.env.DB_POOL_MAX = '28';
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS = '6000';
    process.env.DB_POOL_IDLE_TIMEOUT_MS = '35000';
    process.env.DB_STATEMENT_TIMEOUT_MS = '12000';
    const loaded = loadEnv();
    expect(loaded.DB_POOL_MAX).toBe('28');
    expect(loaded.DB_POOL_CONNECTION_TIMEOUT_MS).toBe('6000');
    expect(loaded.DB_POOL_IDLE_TIMEOUT_MS).toBe('35000');
    expect(loaded.DB_STATEMENT_TIMEOUT_MS).toBe('12000');
  });
});
