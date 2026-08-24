import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  processDueGuestLinks,
  readDatabaseClock,
  REMOTE_DESKTOP_GUEST_DUE_POLL_MS,
} from '../src/services/remote-desktop-guest-due-worker.js';

class ScriptedDatabase {
  readonly calls: Array<{ kind: string; sql: string; params: unknown[] }> = [];
  oneRows: unknown[] = [];
  manyRows: unknown[][] = [];

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.calls.push({ kind: 'one', sql, params });
    return (this.oneRows.shift() as T | undefined) ?? null;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ kind: 'many', sql, params });
    return (this.manyRows.shift() as T[] | undefined) ?? [];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    this.calls.push({ kind: 'execute', sql, params });
    return { changes: 1 };
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    this.calls.push({ kind: 'transaction', sql: '', params: [] });
    return fn(this as unknown as Database);
  }

  asDatabase(): Database { return this as unknown as Database; }
}

describe('remote desktop guest due worker', () => {
  it('uses PostgreSQL clock and a bounded 500ms polling contract', async () => {
    const db = new ScriptedDatabase();
    db.oneRows.push({ now_ms: 4_000 });
    await expect(readDatabaseClock(db.asDatabase())).resolves.toBe(4_000);
    expect(db.calls[0]?.sql).toContain('clock_timestamp()');
    expect(REMOTE_DESKTOP_GUEST_DUE_POLL_MS).toBeLessThanOrEqual(500);
  });

  it('claims with SKIP LOCKED and expires only the current revision', async () => {
    const db = new ScriptedDatabase();
    db.oneRows.push(
      { now_ms: 5_000 },
      { host_id: 'host-1', authority_generation: 3, commit_revision: 8 },
      null,
      { sequence: 8 },
      { sequence: 8 },
    );
    db.manyRows.push([
      { link_id: 'link-current', expiry_revision: 4, expires_at: 4_900 },
      { link_id: 'link-stale', expiry_revision: 2, expires_at: 4_800 },
    ], [{
      route_id: 'route-1', route_generation: 6,
      actor_audit_id: 'audit-link-current', execution_server_id: 'server-1',
    }]);

    await expect(processDueGuestLinks({
      db: db.asDatabase(), workerId: 'pod-a:worker-1', limit: 16,
    })).resolves.toEqual({ databaseNow: 5_000, claimed: 2, expired: 1, stale: 1 });

    const claim = db.calls.find((call) => call.kind === 'many');
    expect(claim?.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim?.sql).toContain("state = 'claimed' AND claim_expires_at <= $1");
    const expire = db.calls.find((call) => call.sql.includes("SET state = 'expired'"));
    expect(expire?.sql).toContain('expiry_revision = $2');
    expect(expire?.sql).toContain('expires_at <= $3');
    expect(expire?.sql).toContain('commit_revision = commit_revision + 1');
    expect(db.calls.some((call) => call.sql.includes("SET state = 'stale'"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes('remote_desktop_guest_outbox'))).toBe(true);
    const outboxInsert = db.calls.find((call) => call.sql.includes('INSERT INTO remote_desktop_guest_outbox'));
    expect(outboxInsert?.params[3]).toBe('server-1');
    expect(JSON.parse(outboxInsert?.params[8] as string)).toMatchObject({
      actorAuditId: 'audit-link-current', authorityGeneration: 3,
      expiryRevision: 4, commitRevision: 8, routeGeneration: 6,
      targetServerId: 'server-1', effect: 'terminal', scope: 'route', sequence: 8,
    });
    expect(db.calls.some((call) => call.sql.includes("SET state = 'completed'"))).toBe(true);
  });

  it('rolls back conceptually by keeping transition and effect inside one transaction callback', async () => {
    const db = new ScriptedDatabase();
    db.oneRows.push({ now_ms: 5_000 });
    db.manyRows.push([]);
    await processDueGuestLinks({ db: db.asDatabase(), workerId: 'worker-1' });
    expect(db.calls[0]?.kind).toBe('transaction');
    expect(db.calls.filter((call) => call.kind === 'transaction')).toHaveLength(1);
  });

  it('writes a host-scoped terminal fact without manufacturing route identity', async () => {
    const db = new ScriptedDatabase();
    db.oneRows.push(
      { now_ms: 5_000 },
      { host_id: 'host-1', authority_generation: 3, commit_revision: 8 },
      null,
      { sequence: 9 },
      { sequence: 9 },
    );
    db.manyRows.push(
      [{ link_id: 'link-idle', expiry_revision: 4, expires_at: 4_900 }],
      [],
    );
    await expect(processDueGuestLinks({
      db: db.asDatabase(), workerId: 'worker-1',
    })).resolves.toMatchObject({ expired: 1, stale: 0 });
    const outboxInsert = db.calls.find((call) => call.sql.includes('INSERT INTO remote_desktop_guest_outbox'));
    expect(outboxInsert?.params[3]).toBeNull();
    expect(outboxInsert?.params[5]).toBeNull();
    expect(JSON.parse(outboxInsert?.params[8] as string)).toMatchObject({
      effect: 'terminal', scope: 'host', targetServerId: null,
      routeGeneration: null, actorAuditId: 'link:link-idle',
    });
  });

  it('fails closed when a live route cannot supply the shared audit/target contract', async () => {
    const db = new ScriptedDatabase();
    db.oneRows.push(
      { now_ms: 5_000 },
      { host_id: 'host-1', authority_generation: 3, commit_revision: 8 },
    );
    db.manyRows.push(
      [{ link_id: 'link-live', expiry_revision: 4, expires_at: 4_900 }],
      [{
        route_id: 'route-1', route_generation: 6,
        actor_audit_id: null, execution_server_id: 'server-1',
      }],
    );
    await expect(processDueGuestLinks({
      db: db.asDatabase(), workerId: 'worker-1',
    })).rejects.toThrow('natural_expiry_route_contract_incomplete');
  });
});
