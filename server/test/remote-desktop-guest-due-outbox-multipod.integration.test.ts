import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND,
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_OUTBOX_SCOPE,
} from '../../shared/remote-desktop-access.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { appendGuestEffectTx } from '../src/services/remote-desktop-guest-authority.js';
import { processDueGuestLinks } from '../src/services/remote-desktop-guest-due-worker.js';
import {
  PostgresRemoteDesktopGuestOutboxDeliveryAdapter,
  processRemoteDesktopGuestOutbox,
  type RemoteDesktopGuestOutboxExecutionTarget,
} from '../src/services/remote-desktop-guest-outbox-worker.js';

const CLOCK = 1_800_000_000_000;
let primary: Database;
let secondary: Database;

interface ClockHooks {
  afterQuery?: (sql: string, rows: unknown[]) => Promise<void> | void;
}

function withDatabaseClock(base: Database, now: number, hooks: ClockHooks = {}): Database {
  const wrap = (current: Database): Database => ({
    query: async <T>(sql: string, params: unknown[] = []) => {
      const rows = await current.query<T>(sql, params);
      await hooks.afterQuery?.(sql, rows);
      return rows;
    },
    queryOne: async <T>(sql: string, params: unknown[] = []) => {
      if (sql.includes('clock_timestamp()')) return { now_ms: now } as T;
      return current.queryOne<T>(sql, params);
    },
    execute: (sql: string, params: unknown[] = []) => current.execute(sql, params),
    exec: (sql: string) => current.exec(sql),
    transaction: <T>(fn: (tx: Database) => Promise<T>) => (
      current.transaction((tx) => fn(wrap(tx)))
    ),
    close: () => current.close(),
  } as Database);
  return wrap(base);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface DueFixture {
  hostId: string;
  linkId: string;
  serverId: string;
  sessionId: string;
  routeId: string;
  actorAuditId: string;
  expiresAt: number;
  expiryRevision: number;
}

async function seedDueFixture(input: {
  expiresAt: number;
  expiryRevision?: number;
  actorAuditId?: string | null;
}): Promise<DueFixture> {
  const ownerId = `user_${randomUUID()}`;
  const hostId = randomUUID();
  const serverId = `server_${randomUUID()}`;
  const linkId = randomUUID();
  const sessionId = randomUUID();
  const routeId = randomUUID();
  const actorAuditId = `audit_${randomUUID()}`;
  const expiryRevision = input.expiryRevision ?? 1;
  await createUser(primary, ownerId);
  await primary.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, last_heartbeat_at, created_at, node_role)
     VALUES ($1, $2, 'due-target', $3, 'online', $4, $4, 'full')`,
    [serverId, ownerId, randomBytes(32).toString('hex'), CLOCK],
  );
  await primary.execute(
    `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, ownerId, CLOCK],
  );
  await primary.execute(
    `INSERT INTO remote_desktop_host_endpoints
       (server_id, host_id, owner_user_id, endpoint_role, linked_at)
     VALUES ($1, $2, $3, 'full', $4)`,
    [serverId, hostId, ownerId, CLOCK],
  );
  await primary.execute(
    `INSERT INTO remote_desktop_management_privacy
       (host_id, revision, phase, admission_open, created_at, updated_at)
     VALUES ($1, 0, 'idle', TRUE, $2, $2)`,
    [hostId, CLOCK],
  );
  await primary.execute(
    `INSERT INTO remote_desktop_guest_links
       (id, host_id, owner_user_id, token_hash_version, token_hash,
        creation_request_id, normalized_policy_hash, label, attendance,
        access_mode, expires_at, authority_generation, expiry_revision,
        commit_revision, state, created_at, updated_at)
     VALUES ($1, $2, $3, 'v1', $4, $5, $6, 'due', 'unattended',
             'control', $7, 1, $8, 1, 'active', $9, $9)`,
    [
      linkId, hostId, ownerId, randomBytes(32).toString('hex'),
      randomBytes(32).toString('base64url'), randomBytes(32).toString('hex'),
      input.expiresAt, expiryRevision, CLOCK,
    ],
  );
  await primary.execute(
    `INSERT INTO remote_desktop_guest_expiry_due
       (link_id, expiry_revision, expires_at, state, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', $4, $4)`,
    [linkId, expiryRevision, input.expiresAt, CLOCK],
  );
  await primary.execute(
    `INSERT INTO remote_desktop_guest_sessions
       (id, link_id, host_id, browser_key_hash, actor_kind, route_id,
        route_generation, authority_generation, expiry_revision,
        absolute_expires_at, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'unattended_link', $5, 1, 1, $6, $7,
             'active', $8, $8)`,
    [sessionId, linkId, hostId, randomBytes(32).toString('hex'), routeId,
      expiryRevision, input.expiresAt, CLOCK],
  );
  await primary.execute(
    `INSERT INTO remote_desktop_host_routes
       (route_id, route_generation, host_id, actor_source, actor_audit_id,
        execution_server_id, state, guest_session_id, reserved_at,
        activated_at, updated_at)
     VALUES ($1, 1, $2, 'unattended_link', $3, $4, 'active', $5, $6, $6, $6)`,
    [routeId, hostId, input.actorAuditId === undefined ? actorAuditId : input.actorAuditId,
      serverId, sessionId, CLOCK],
  );
  return { hostId, linkId, serverId, sessionId, routeId, actorAuditId,
    expiresAt: input.expiresAt, expiryRevision };
}

function executionTarget() {
  const apply = vi.fn<RemoteDesktopGuestOutboxExecutionTarget['apply']>(
    async () => ({ status: 'applied' }),
  );
  return {
    apply,
    value: { isAvailable: () => true, apply } satisfies RemoteDesktopGuestOutboxExecutionTarget,
  };
}

beforeAll(async () => {
  primary = createDatabase(process.env.TEST_DATABASE_URL!);
  secondary = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(primary);
});

afterAll(async () => {
  await Promise.all([primary.close(), secondary.close()]);
});

beforeEach(async () => {
  // The integration runner intentionally reuses one PostgreSQL container across
  // files. Other suites may leave completed qualification rows behind, while
  // these assertions exercise whole-queue SKIP LOCKED worker semantics. Start
  // each cell with an empty worker queue so counts describe only its fixture.
  await primary.execute('DELETE FROM remote_desktop_guest_outbox');
  await primary.execute('DELETE FROM remote_desktop_guest_expiry_due');
});

describe('remote desktop due/outbox multi-worker qualification', () => {
  it('uses SKIP LOCKED so concurrent due workers commit one semantic expiry', async () => {
    const fixture = await seedDueFixture({ expiresAt: CLOCK });
    const claimed = deferred();
    const release = deferred();
    let held = false;
    const firstDb = withDatabaseClock(primary, CLOCK, {
      afterQuery: async (sql, rows) => {
        if (!held && sql.includes('WITH candidates AS') && rows.length > 0) {
          held = true;
          claimed.resolve();
          await release.promise;
        }
      },
    });
    const first = processDueGuestLinks({ db: firstDb, workerId: 'pod-a' });
    await claimed.promise;
    const second = await processDueGuestLinks({
      db: withDatabaseClock(secondary, CLOCK), workerId: 'pod-b',
    });
    expect(second).toMatchObject({ claimed: 0, expired: 0 });
    release.resolve();
    await expect(first).resolves.toMatchObject({ claimed: 1, expired: 1 });
    const outbox = await primary.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM remote_desktop_guest_outbox WHERE host_id = $1`,
      [fixture.hostId],
    );
    expect(outbox?.count).toBe(1);
    // This cell qualifies the claim transaction only; do not leave its
    // intentionally undelivered row visible to later delivery cells.
    await primary.execute(
      `DELETE FROM remote_desktop_guest_outbox WHERE host_id = $1`,
      [fixture.hostId],
    );
  });

  it('treats an old shortening revision as stale, then terminates by the new deadline within 2s', async () => {
    const fixture = await seedDueFixture({ expiresAt: CLOCK + 1_000, expiryRevision: 2 });
    await primary.execute(
      `INSERT INTO remote_desktop_guest_expiry_due
         (link_id, expiry_revision, expires_at, state, created_at, updated_at)
       VALUES ($1, 1, $2, 'pending', $2, $2)`,
      [fixture.linkId, CLOCK],
    );
    await expect(processDueGuestLinks({
      db: withDatabaseClock(primary, CLOCK), workerId: 'pod-a',
    })).resolves.toMatchObject({ claimed: 1, stale: 1, expired: 0 });
    expect(await primary.queryOne<{ state: string }>(
      `SELECT state FROM remote_desktop_guest_links WHERE id = $1`, [fixture.linkId],
    )).toMatchObject({ state: 'active' });

    await expect(processDueGuestLinks({
      db: withDatabaseClock(primary, CLOCK + 999), workerId: 'pod-a',
    })).resolves.toMatchObject({ claimed: 0 });
    await expect(processDueGuestLinks({
      db: withDatabaseClock(primary, CLOCK + 1_000), workerId: 'pod-a',
    })).resolves.toMatchObject({ claimed: 1, expired: 1 });

    const target = executionTarget();
    const deliveryDb = withDatabaseClock(primary, CLOCK + 2_999);
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      deliveryDb,
      (serverId) => serverId === fixture.serverId ? target.value : null,
    );
    const delivered = await processRemoteDesktopGuestOutbox({
      db: deliveryDb, podId: 'pod-owner', adapter,
    });
    expect(delivered).toMatchObject({ applied: 1, acknowledged: 1, sloViolations: 0 });
    expect(target.apply).toHaveBeenCalledOnce();
    expect(await primary.queryOne<{ state: string }>(
      `SELECT state FROM remote_desktop_guest_sessions WHERE id = $1`, [fixture.sessionId],
    )).toMatchObject({ state: 'closed' });
  });

  it('keeps authority/due/outbox atomic on rollback and catches up after an outage', async () => {
    const fixture = await seedDueFixture({ expiresAt: CLOCK, actorAuditId: null });
    await expect(processDueGuestLinks({
      db: withDatabaseClock(primary, CLOCK), workerId: 'pod-before-crash',
    })).rejects.toThrow('natural_expiry_route_contract_incomplete');
    expect(await primary.queryOne<{ state: string }>(
      `SELECT state FROM remote_desktop_guest_links WHERE id = $1`, [fixture.linkId],
    )).toMatchObject({ state: 'active' });
    expect(await primary.queryOne<{ state: string; claimed_by: string | null }>(
      `SELECT state, claimed_by FROM remote_desktop_guest_expiry_due
        WHERE link_id = $1 AND expiry_revision = $2`,
      [fixture.linkId, fixture.expiryRevision],
    )).toMatchObject({ state: 'pending', claimed_by: null });
    expect((await primary.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM remote_desktop_guest_outbox WHERE host_id = $1`,
      [fixture.hostId],
    ))?.count).toBe(0);

    await primary.execute(
      `UPDATE remote_desktop_host_routes SET actor_audit_id = $2 WHERE route_id = $1`,
      [fixture.routeId, fixture.actorAuditId],
    );
    const catchupAt = CLOCK + 10_000;
    await expect(processDueGuestLinks({
      db: withDatabaseClock(secondary, catchupAt), workerId: 'pod-after-restart',
    })).resolves.toMatchObject({ claimed: 1, expired: 1 });
    const target = executionTarget();
    const catchupDb = withDatabaseClock(secondary, catchupAt);
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      catchupDb,
      (serverId) => serverId === fixture.serverId ? target.value : null,
    );
    const violation = vi.fn();
    const delivered = await processRemoteDesktopGuestOutbox({
      db: catchupDb, podId: 'pod-after-restart', adapter, onSloViolation: violation,
    });
    expect(delivered).toMatchObject({ applied: 1, acknowledged: 1, sloViolations: 1 });
    expect(violation).toHaveBeenCalledWith(expect.objectContaining({ sloAnchorAt: CLOCK }), 10_000);
  });

  it('delivers an explicit commit by 2s after a wrong-pod observation', async () => {
    const fixture = await seedDueFixture({ expiresAt: CLOCK + 60_000 });
    await primary.transaction(async (tx) => {
      await tx.execute(
        `UPDATE remote_desktop_guest_links
            SET access_mode = 'view', authority_generation = 2,
                commit_revision = 2, updated_at = $2
          WHERE id = $1`,
        [fixture.linkId, CLOCK],
      );
      await appendGuestEffectTx(tx, {
        id: randomUUID(),
        targetRouteId: fixture.routeId,
        event: {
          idempotencyKey: `downgrade:${fixture.linkId}:2`,
          authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
          effect: REMOTE_DESKTOP_OUTBOX_EFFECT.DOWNGRADE,
          scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
          hostId: fixture.hostId,
          targetServerId: fixture.serverId,
          actorAuditId: fixture.actorAuditId,
          authorityGeneration: 2,
          expiryRevision: 1,
          commitRevision: 2,
          routeGeneration: 1,
        },
        now: CLOCK,
        sloAnchorAt: CLOCK,
        retainUntil: CLOCK + 60_000,
      });
    });
    const wrongPod = {
      ownsTarget: async () => false,
      deliver: async () => ({ status: 'not_owner' as const }),
    };
    await expect(processRemoteDesktopGuestOutbox({
      db: withDatabaseClock(primary, CLOCK + 500), podId: 'pod-wrong', adapter: wrongPod,
    })).resolves.toMatchObject({ notOwner: 1, acknowledged: 0 });

    const target = executionTarget();
    const ownerDb = withDatabaseClock(secondary, CLOCK + 2_000);
    const adapter = new PostgresRemoteDesktopGuestOutboxDeliveryAdapter(
      ownerDb,
      (serverId) => serverId === fixture.serverId ? target.value : null,
    );
    await expect(processRemoteDesktopGuestOutbox({
      db: ownerDb, podId: 'pod-owner', adapter,
    })).resolves.toMatchObject({ applied: 1, acknowledged: 1, sloViolations: 0 });
    expect(target.apply).toHaveBeenCalledOnce();
  });
});
