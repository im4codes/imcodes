/**
 * Native PostgreSQL database wrapper.
 * Thin convenience layer over pg.Pool — no ORM, no abstraction leaks.
 */

import pg from 'pg';
import logger from '../util/logger.js';
const { Pool } = pg;

export type { Pool };
type Queryable = Pick<pg.Pool, 'query'>;

export const DEFAULT_DB_POOL_MAX = 25;
export const DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 15_000;

export interface DatabasePoolOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  statementTimeoutMs?: number;
}

function parsePositiveInt(value: string | number | undefined, fallback: number, min = 1, max = 600_000): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.trunc(parsed);
  if (int < min || int > max) return fallback;
  return int;
}

/** Resolve pg.Pool configuration from explicit options, environment overrides, and safe defaults. */
export function resolveDatabasePoolConfig(
  databaseUrl: string,
  options?: DatabasePoolOptions,
  env: NodeJS.ProcessEnv = process.env,
): pg.PoolConfig {
  return {
    connectionString: databaseUrl,
    max: parsePositiveInt(options?.max ?? env.DB_POOL_MAX, DEFAULT_DB_POOL_MAX, 1, 500),
    connectionTimeoutMillis: parsePositiveInt(
      options?.connectionTimeoutMillis ?? env.DB_POOL_CONNECTION_TIMEOUT_MS,
      DEFAULT_DB_POOL_CONNECTION_TIMEOUT_MS,
      100,
      120_000,
    ),
    idleTimeoutMillis: parsePositiveInt(
      options?.idleTimeoutMillis ?? env.DB_POOL_IDLE_TIMEOUT_MS,
      DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
      1_000,
      3_600_000,
    ),
    statement_timeout: parsePositiveInt(
      options?.statementTimeoutMs ?? env.DB_STATEMENT_TIMEOUT_MS,
      DEFAULT_DB_STATEMENT_TIMEOUT_MS,
      100,
      600_000,
    ),
  };
}

/**
 * Lightweight database wrapper backed by pg.Pool.
 * All SQL uses native PostgreSQL $1,$2,... placeholders.
 */
export class Database {
  constructor(private queryable: Queryable, private pool?: pg.Pool) {}

  /** Query returning all matching rows. */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await this.queryable.query(sql, params);
    return rows as T[];
  }

  /** Query returning the first row, or null. */
  async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const { rows } = await this.queryable.query(sql, params);
    return (rows[0] as T) ?? null;
  }

  /** Execute a statement, returning the number of affected rows. */
  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await this.queryable.query(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  /** Execute a raw SQL string (used for migrations). */
  async exec(sql: string): Promise<void> {
    await this.queryable.query(sql);
  }

  /** Execute multiple statements atomically on a single connection. */
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this);
    const client = await this.pool.connect();
    const tx = new Database(client as unknown as Queryable);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors and rethrow original failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Close all pool connections (call on graceful shutdown or test teardown). */
  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

/** Create a Database from a DATABASE_URL with tuned pool bounds and error handling. */
export function createDatabase(databaseUrl: string, options?: DatabasePoolOptions): Database {
  // pg returns BIGINT (INT8) as string by default to avoid precision loss.
  // Our timestamps are Date.now() values (~13 digits), safely within JS integers,
  // so parse them as numbers for convenience.
  pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => parseInt(val, 10));

  const pool = new Pool(resolveDatabasePoolConfig(databaseUrl, options));
  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected PostgreSQL pool error');
  });
  return new Database(pool, pool);
}
