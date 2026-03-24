/**
 * D1-compatible PostgreSQL wrapper.
 * Implements prepare().bind().first()/all()/run() API backed by pg.Pool.
 * Auto-converts D1-style `?` placeholders to PostgreSQL `$N` placeholders,
 * skipping `?` inside quoted strings or identifiers.
 */

import pg from 'pg';
const { Pool } = pg;

export type { Pool };

/** Convert D1-style `?` placeholders to PG `$1, $2, ...`, skipping quoted contexts. */
export function convertPlaceholders(sql: string): string {
  let result = '';
  let idx = 1;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    // Single-quoted string literal: skip until closing '
    if (ch === "'") {
      result += ch;
      i++;
      while (i < sql.length) {
        const c2 = sql[i];
        result += c2;
        i++;
        if (c2 === "'") {
          // escaped quote '' — peek ahead
          if (i < sql.length && sql[i] === "'") {
            result += sql[i];
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Double-quoted identifier: skip until closing "
    if (ch === '"') {
      result += ch;
      i++;
      while (i < sql.length) {
        const c2 = sql[i];
        result += c2;
        i++;
        if (c2 === '"') break;
      }
      continue;
    }

    // Unquoted `?` → `$N`
    if (ch === '?') {
      result += `$${idx++}`;
      i++;
      continue;
    }

    result += ch;
    i++;
  }
  return result;
}

/** D1 .run() result */
export interface D1RunResult {
  changes: number;
}

/** D1 .all() result */
export interface D1AllResult<T> {
  results: T[];
}

/** Bound statement ready to execute */
export class BoundStatement<_T = unknown> {
  constructor(
    private pool: pg.Pool,
    private sql: string,
    private params: unknown[],
  ) {}

  async first<T = unknown>(): Promise<T | null> {
    const { rows } = await this.pool.query<pg.QueryResultRow>(this.sql, this.params as pg.QueryResultRow[]);
    return (rows[0] as T) ?? null;
  }

  async all<T = unknown>(): Promise<D1AllResult<T>> {
    const { rows } = await this.pool.query<pg.QueryResultRow>(this.sql, this.params as pg.QueryResultRow[]);
    return { results: rows as T[] };
  }

  async run(): Promise<D1RunResult> {
    const result = await this.pool.query(this.sql, this.params as pg.QueryResultRow[]);
    return { changes: result.rowCount ?? 0 };
  }
}

/** Prepared statement (sql converted, not yet bound) */
export class PgStatement {
  private pgSql: string;
  constructor(private pool: pg.Pool, sql: string) {
    this.pgSql = convertPlaceholders(sql);
  }

  bind(...params: unknown[]): BoundStatement {
    // PostgreSQL integer is 32-bit signed (max 2147483647). JS numbers exceeding
    // this (e.g. Date.now() timestamps) must be passed as strings so pg driver
    // doesn't try to fit them into int4. PG auto-coerces strings to bigint columns.
    const safe = params.map(p =>
      typeof p === 'number' && (p > 2147483647 || p < -2147483648) ? String(p) : p
    );
    return new BoundStatement(this.pool, this.pgSql, safe);
  }
}

/** D1-compatible database wrapper backed by pg.Pool */
export class PgDatabase {
  constructor(private pool: pg.Pool) {}

  prepare(sql: string): PgStatement {
    return new PgStatement(this.pool, sql);
  }

  /** Execute a raw SQL string (used for migrations) */
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /** Close all pool connections (call on graceful shutdown or test teardown) */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Create a PgDatabase from a DATABASE_URL */
export function createDatabase(databaseUrl: string): PgDatabase {
  // pg returns BIGINT (INT8) as string by default to avoid precision loss.
  // Our timestamps are Date.now() values (~13 digits), safely within JS integers,
  // so parse them as numbers to match the D1 API contract.
  pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => parseInt(val, 10));

  const pool = new Pool({ connectionString: databaseUrl });
  return new PgDatabase(pool);
}
