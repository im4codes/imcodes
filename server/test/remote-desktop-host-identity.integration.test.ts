/**
 * Canonical physical-host identity — real PostgreSQL (testcontainers via
 * integration-global).
 *
 * Covers the persistence contract for OpenSpec tasks 3.1–3.8: endpoint mapping,
 * active/retired identity history, allocation under forced patterns and forced
 * collisions, endpoint selection, merge conflict and resolution, resumable
 * backfill, rotation, and transactional rollback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';
import {
  HOST_ENDPOINT_ROLE,
  HOST_IDENTITY_ERROR,
  HOST_MERGE_STATE,
  PRINCIPAL_GUEST_SESSION_LIMIT,
  HostIdentityError,
  allocateActivePublicNodeId,
  backfillCanonicalHosts,
  ensureCanonicalHostForServer,
  isGuestAdmissionReady,
  resolveExecutionEndpoint,
  resolveHostIdForServer,
  resolveMergeConflict,
  reservePrincipalGuestSession,
  rotatePublicNodeId,
  type PublicNodeIdRandom,
} from '../src/services/remote-desktop-host-identity.js';

let db: Database;
const NOW = 1_700_000_000_000;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => { await db.close(); });

/** Replays a fixed candidate sequence so patterns/collisions are forced, not awaited. */
function sequence(values: string[]): PublicNodeIdRandom {
  let index = 0;
  return () => Number(values[Math.min(index++, values.length - 1)]);
}

async function seedUser(): Promise<string> {
  const id = `u_${randomUUID()}`;
  await createUser(db, id);
  return id;
}

async function seedEndpoint(input: {
  userId: string;
  role: 'full' | 'controlled';
  eligible?: boolean;
  hostServerId?: string;
}): Promise<string> {
  const id = `s_${randomUUID()}`;
  await createServer(
    db, id, input.userId, `srv-${id.slice(0, 8)}`, `hash-${id}`, undefined,
    input.role === 'controlled' ? NODE_ROLE.CONTROLLED : NODE_ROLE.FULL,
  );
  if (input.eligible !== false) {
    await db.execute(
      'UPDATE servers SET controlled_capabilities = $2::jsonb WHERE id = $1',
      [id, JSON.stringify([REMOTE_DESKTOP_CAPABILITY])],
    );
  }
  if (input.hostServerId) {
    await db.execute('UPDATE servers SET host_server_id = $2 WHERE id = $1', [id, input.hostServerId]);
  }
  return id;
}

describe('canonical host mapping (3.1)', () => {
  it('gives a standalone endpoint exactly one principal and is idempotent', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });

    const first = await ensureCanonicalHostForServer({ db, serverId, now: NOW });
    const second = await ensureCanonicalHostForServer({ db, serverId, now: NOW + 1 });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.hostId).toBe(first.hostId);
    expect(await resolveHostIdForServer(db, serverId)).toBe(first.hostId);
  });

  it('unifies a FULL daemon with the controlled endpoint it hosts', async () => {
    const userId = await seedUser();
    const daemonId = await seedEndpoint({ userId, role: 'full' });
    const controlledId = await seedEndpoint({ userId, role: 'controlled', hostServerId: daemonId });

    const daemonHost = await ensureCanonicalHostForServer({ db, serverId: daemonId, now: NOW });
    const controlledHost = await ensureCanonicalHostForServer({ db, serverId: controlledId, now: NOW });

    expect(controlledHost.hostId).toBe(daemonHost.hostId);
    expect(controlledHost.conflict).toBe(false);

    const rows = await db.query<{ endpoint_role: string }>(
      'SELECT endpoint_role FROM remote_desktop_host_endpoints WHERE host_id = $1 ORDER BY endpoint_role',
      [daemonHost.hostId],
    );
    expect(rows.map((r) => r.endpoint_role)).toEqual(['controlled', 'full']);
  });

  it('adopts an already-enrolled controlled endpoint when the daemon is mapped second', async () => {
    const userId = await seedUser();
    const daemonId = await seedEndpoint({ userId, role: 'full' });
    const controlledId = await seedEndpoint({ userId, role: 'controlled', hostServerId: daemonId });

    // Daemon first this time; its hosted endpoint must join the same principal.
    const host = await ensureCanonicalHostForServer({ db, serverId: daemonId, now: NOW });
    expect(await resolveHostIdForServer(db, controlledId)).toBe(host.hostId);
  });

  it('refuses to attach an endpoint to another account host at the schema level', async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const serverA = await seedEndpoint({ userId: ownerA, role: 'controlled' });
    const serverB = await seedEndpoint({ userId: ownerB, role: 'controlled' });
    const hostA = await ensureCanonicalHostForServer({ db, serverId: serverA, now: NOW });

    await expect(db.execute(
      `INSERT INTO remote_desktop_host_endpoints
         (server_id, host_id, owner_user_id, endpoint_role, linked_at)
       VALUES ($1, $2, $3, 'controlled', $4)`,
      [serverB, hostA.hostId, ownerB, NOW],
    )).rejects.toThrow();
  });
});

describe('public identity allocation (3.2, 3.3)', () => {
  it('skips prohibited candidates and commits the first acceptable value', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    const random = sequence(['5000000000', '5271111382', '5712345839', '5836294175']);
    const allocated = await allocateActivePublicNodeId({ db, hostId, now: NOW, random });

    expect(allocated.publicId).toBe('5836294175');
    expect(allocated.created).toBe(true);
  });

  it('retries past a value already present in history and never reuses it', async () => {
    const userId = await seedUser();
    const first = await seedEndpoint({ userId, role: 'controlled' });
    const second = await seedEndpoint({ userId, role: 'controlled' });
    const hostOne = await ensureCanonicalHostForServer({ db, serverId: first, now: NOW });
    const hostTwo = await ensureCanonicalHostForServer({ db, serverId: second, now: NOW });

    const taken = '5836294176';
    await allocateActivePublicNodeId({ db, hostId: hostOne.hostId, now: NOW, random: sequence([taken]) });
    // Forced collision: the sampler offers the taken value twice before a free one.
    const other = await allocateActivePublicNodeId({
      db, hostId: hostTwo.hostId, now: NOW, random: sequence([taken, taken, '5836294177']),
    });

    expect(other.publicId).toBe('5836294177');
  });

  it('is idempotent for a host that already committed an identity', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    const a = await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294178']) });
    const b = await allocateActivePublicNodeId({ db, hostId, now: NOW + 1, random: sequence(['5836294179']) });

    expect(b.publicId).toBe(a.publicId);
    expect(b.created).toBe(false);
  });

  it('fails identity creation on exhaustion instead of falling back to a sequence', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    await expect(allocateActivePublicNodeId({
      db, hostId, now: NOW, random: sequence(['5000000000']), attempts: 4,
    })).rejects.toBeInstanceOf(HostIdentityError);

    const rows = await db.query('SELECT 1 FROM remote_desktop_public_ids WHERE host_id = $1', [hostId]);
    expect(rows).toHaveLength(0);
  });

  it('keeps at most one active identity per host and enforces global uniqueness', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });
    await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294181']) });

    await expect(db.execute(
      `INSERT INTO remote_desktop_public_ids (public_id, host_id, status, activated_at)
       VALUES ($1, $2, 'active', $3)`,
      ['5836294182', hostId, NOW],
    )).rejects.toThrow();

    await expect(db.execute(
      `INSERT INTO remote_desktop_public_ids (public_id, host_id, status, activated_at)
       VALUES ($1, $2, 'active', $3)`,
      ['5836294181', randomUUID(), NOW],
    )).rejects.toThrow();
  });

  it('resolves concurrent allocation for one host to a single identity', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    const results = await Promise.all([
      allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294183']) }),
      allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294184']) }),
    ]);

    expect(new Set(results.map((r) => r.publicId)).size).toBe(1);
    const active = await db.query(
      "SELECT public_id FROM remote_desktop_public_ids WHERE host_id = $1 AND status = 'active'",
      [hostId],
    );
    expect(active).toHaveLength(1);
  });
});

describe('endpoint selection and admission readiness (3.4)', () => {
  it('prefers the qualified hosted controlled endpoint over the daemon', async () => {
    const userId = await seedUser();
    const daemonId = await seedEndpoint({ userId, role: 'full' });
    const controlledId = await seedEndpoint({ userId, role: 'controlled', hostServerId: daemonId });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId: daemonId, now: NOW });

    const selected = await resolveExecutionEndpoint({
      db, hostId, fullEndpointEligible: (serverId) => serverId === daemonId,
    });
    expect(selected).toEqual({ serverId: controlledId, role: HOST_ENDPOINT_ROLE.CONTROLLED });
  });

  it('falls back to the daemon when the controlled endpoint loses eligibility, keeping the identity', async () => {
    const userId = await seedUser();
    const daemonId = await seedEndpoint({ userId, role: 'full' });
    const controlledId = await seedEndpoint({ userId, role: 'controlled', hostServerId: daemonId });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId: daemonId, now: NOW });
    const before = await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294185']) });

    await db.execute("UPDATE servers SET controlled_capabilities = '[]'::jsonb WHERE id = $1", [controlledId]);

    const selected = await resolveExecutionEndpoint({
      db, hostId, fullEndpointEligible: (serverId) => serverId === daemonId,
    });
    expect(selected).toEqual({ serverId: daemonId, role: HOST_ENDPOINT_ROLE.FULL });

    const after = await db.queryOne<{ public_id: string }>(
      "SELECT public_id FROM remote_desktop_public_ids WHERE host_id = $1 AND status = 'active'",
      [hostId],
    );
    expect(after?.public_id).toBe(before.publicId);
  });

  it('reports no execution endpoint when nothing attached is eligible', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled', eligible: false });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    expect(await resolveExecutionEndpoint({ db, hostId })).toBeNull();
    expect(await isGuestAdmissionReady({ db, hostId })).toBe(false);
  });

  it('is admission-ready only once mapping, identity and a qualified endpoint all exist', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    expect(await isGuestAdmissionReady({ db, hostId })).toBe(false); // no identity yet
    await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294186']) });
    expect(await isGuestAdmissionReady({ db, hostId })).toBe(true);
  });

  it('serializes guest reservations across the canonical host budget', async () => {
    const userId = await seedUser();
    const daemonId = await seedEndpoint({ userId, role: 'full' });
    const controlledId = await seedEndpoint({ userId, role: 'controlled', hostServerId: daemonId });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId: controlledId, now: NOW });

    const results = await Promise.all(Array.from({ length: PRINCIPAL_GUEST_SESSION_LIMIT + 2 }, (_, index) => (
      reservePrincipalGuestSession({
        db,
        sessionId: `guest_${randomUUID()}`,
        hostId,
        linkId: null,
        browserKeyHash: `browser_${index}`,
        actorSource: 'node_password',
        authorityGeneration: 1,
        expiryRevision: null,
        passwordGeneration: 1,
        absoluteExpiresAt: NOW + 60_000,
        now: NOW + index,
      })
    )));

    expect(results.filter(Boolean)).toHaveLength(PRINCIPAL_GUEST_SESSION_LIMIT);
    const rows = await db.query<{ state: string }>(
      `SELECT state FROM remote_desktop_guest_sessions
        WHERE host_id = $1 AND state IN ('admitting', 'active')`,
      [hostId],
    );
    expect(rows).toHaveLength(PRINCIPAL_GUEST_SESSION_LIMIT);
  });
});

describe('merge conflict and resolution (3.5)', () => {
  it('closes admission on both principals and never silently merges', async () => {
    const userId = await seedUser();
    const daemonId = await seedEndpoint({ userId, role: 'full' });
    const controlledId = await seedEndpoint({ userId, role: 'controlled' });

    const daemonHost = await ensureCanonicalHostForServer({ db, serverId: daemonId, now: NOW });
    const controlledHost = await ensureCanonicalHostForServer({ db, serverId: controlledId, now: NOW });
    await allocateActivePublicNodeId({ db, hostId: daemonHost.hostId, now: NOW, random: sequence(['5836294187']) });
    await allocateActivePublicNodeId({ db, hostId: controlledHost.hostId, now: NOW, random: sequence(['5836294188']) });

    // The endpoints are only now declared to be one desktop.
    await db.execute('UPDATE servers SET host_server_id = $2 WHERE id = $1', [controlledId, daemonId]);
    const linked = await ensureCanonicalHostForServer({ db, serverId: controlledId, now: NOW + 5 });

    expect(linked.conflict).toBe(true);
    expect(await isGuestAdmissionReady({ db, hostId: daemonHost.hostId })).toBe(false);
    expect(await isGuestAdmissionReady({ db, hostId: controlledHost.hostId })).toBe(false);

    const pending = await db.query<{ id: string }>(
      "SELECT id FROM remote_desktop_host_merge_conflicts WHERE owner_user_id = $1 AND resolution = 'pending'",
      [userId],
    );
    expect(pending).toHaveLength(1);
    // Repeated detection must not create a second pending row.
    await ensureCanonicalHostForServer({ db, serverId: controlledId, now: NOW + 6 });
    const stillOne = await db.query(
      "SELECT id FROM remote_desktop_host_merge_conflicts WHERE owner_user_id = $1 AND resolution = 'pending'",
      [userId],
    );
    expect(stillOne).toHaveLength(1);

    const resolved = await resolveMergeConflict({
      db, conflictId: pending[0].id, survivingHostId: daemonHost.hostId, now: NOW + 10,
    });

    expect(resolved.retiredPublicIds).toEqual(['5836294188']);
    expect(await isGuestAdmissionReady({ db, hostId: daemonHost.hostId })).toBe(true);
    expect(await resolveHostIdForServer(db, controlledId)).toBe(daemonHost.hostId);

    const retired = await db.queryOne<{ status: string; host_id: string | null }>(
      'SELECT status, host_id FROM remote_desktop_public_ids WHERE public_id = $1',
      ['5836294188'],
    );
    expect(retired?.status).toBe('retired');
  });

  it('rejects a survivor that is not part of the conflict', async () => {
    const userId = await seedUser();
    const a = await seedEndpoint({ userId, role: 'full' });
    const b = await seedEndpoint({ userId, role: 'controlled' });
    const hostA = await ensureCanonicalHostForServer({ db, serverId: a, now: NOW });
    await ensureCanonicalHostForServer({ db, serverId: b, now: NOW });
    await db.execute('UPDATE servers SET host_server_id = $2 WHERE id = $1', [b, a]);
    await ensureCanonicalHostForServer({ db, serverId: b, now: NOW + 1 });

    const conflict = await db.queryOne<{ id: string }>(
      "SELECT id FROM remote_desktop_host_merge_conflicts WHERE owner_user_id = $1 AND resolution = 'pending'",
      [userId],
    );

    await expect(resolveMergeConflict({
      db, conflictId: conflict!.id, survivingHostId: randomUUID(), now: NOW + 2,
    })).rejects.toMatchObject({ code: HOST_IDENTITY_ERROR.SURVIVOR_NOT_IN_CONFLICT });

    // Rollback: the conflict is untouched and both principals stay closed.
    const after = await db.queryOne<{ resolution: string }>(
      'SELECT resolution FROM remote_desktop_host_merge_conflicts WHERE id = $1', [conflict!.id],
    );
    expect(after?.resolution).toBe('pending');
    expect(await isGuestAdmissionReady({ db, hostId: hostA.hostId })).toBe(false);
  });
});

describe('resumable backfill (3.6)', () => {
  it('processes bounded batches, resumes after interruption and never duplicates', async () => {
    const userId = await seedUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedEndpoint({ userId, role: 'controlled' }));
    await seedEndpoint({ userId, role: 'controlled', eligible: false }); // ineligible, must be skipped

    // Distinct candidate per draw, so the assertions test resumption rather
    // than an artificially short pool. Backfill is fleet-wide by default; scope
    // this pass to the account so sibling test fixtures cannot perturb counts.
    let cursor = 0;
    const random: PublicNodeIdRandom = () => 5_836_295_000 + (cursor++);

    const firstPass = await backfillCanonicalHosts({ db, limit: 2, now: NOW, random, ownerUserId: userId });
    expect(firstPass.processed).toBe(2);
    expect(firstPass.hostsCreated).toBe(2);
    expect(firstPass.publicIdsAssigned).toBe(2);

    const committed = await db.query<{ public_id: string }>(
      `SELECT p.public_id FROM remote_desktop_public_ids p
         JOIN remote_desktop_host_endpoints e ON e.host_id = p.host_id
        WHERE e.owner_user_id = $1 ORDER BY p.public_id`,
      [userId],
    );

    // Resume.
    const secondPass = await backfillCanonicalHosts({ db, limit: 10, now: NOW + 1, random, ownerUserId: userId });
    expect(secondPass.processed).toBe(3);
    expect(secondPass.remaining).toBe(0);

    const after = await db.query<{ public_id: string }>(
      `SELECT p.public_id FROM remote_desktop_public_ids p
         JOIN remote_desktop_host_endpoints e ON e.host_id = p.host_id
        WHERE e.owner_user_id = $1 ORDER BY p.public_id`,
      [userId],
    );
    // Already-committed identities are unchanged.
    for (const row of committed) expect(after.map((r) => r.public_id)).toContain(row.public_id);
    expect(after).toHaveLength(5);

    // A third pass is a no-op.
    const third = await backfillCanonicalHosts({ db, limit: 10, now: NOW + 2, random, ownerUserId: userId });
    expect(third).toMatchObject({ processed: 0, hostsCreated: 0, publicIdsAssigned: 0, remaining: 0 });
  });
});

describe('rotation (3.7)', () => {
  it('activates a new ID, retires the old one and blocks its reuse forever', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });
    const before = await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294195']) });

    const rotated = await rotatePublicNodeId({
      db, hostId, now: NOW + 100, random: sequence(['5836294196']),
    });

    expect(rotated.previousPublicId).toBe(before.publicId);
    expect(rotated.publicId).toBe('5836294196');

    const history = await db.query<{ public_id: string; status: string }>(
      'SELECT public_id, status FROM remote_desktop_public_ids WHERE host_id = $1 ORDER BY status',
      [hostId],
    );
    expect(history).toEqual([
      { public_id: '5836294196', status: 'active' },
      { public_id: '5836294195', status: 'retired' },
    ]);

    // A later allocation offered the retired value must skip it.
    const otherServer = await seedEndpoint({ userId, role: 'controlled' });
    const otherHost = await ensureCanonicalHostForServer({ db, serverId: otherServer, now: NOW });
    const reallocated = await allocateActivePublicNodeId({
      db, hostId: otherHost.hostId, now: NOW, random: sequence(['5836294195', '5836294197']),
    });
    expect(reallocated.publicId).toBe('5836294197');
  });

  it('runs the caller cancellation seam inside the rotation transaction', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });
    await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294198']) });

    const seen: string[] = [];
    await rotatePublicNodeId({
      db, hostId, now: NOW + 1, random: sequence(['5836294199']),
      onRotatedTx: async (_tx, r) => { seen.push(r.previousPublicId); },
    });
    expect(seen).toEqual(['5836294198']);
  });

  it('rolls back completely when the cancellation seam fails', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });
    await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294201']) });

    await expect(rotatePublicNodeId({
      db, hostId, now: NOW + 1, random: sequence(['5836294202']),
      onRotatedTx: async () => { throw new Error('cancellation failed'); },
    })).rejects.toThrow('cancellation failed');

    const active = await db.query<{ public_id: string }>(
      "SELECT public_id FROM remote_desktop_public_ids WHERE host_id = $1 AND status = 'active'",
      [hostId],
    );
    expect(active.map((r) => r.public_id)).toEqual(['5836294201']);
    // The abandoned candidate must not have been reserved.
    const orphan = await db.query('SELECT 1 FROM remote_desktop_public_ids WHERE public_id = $1', ['5836294202']);
    expect(orphan).toHaveLength(0);
  });

  it('refuses to rotate a host with no active identity', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    await expect(rotatePublicNodeId({ db, hostId, now: NOW }))
      .rejects.toMatchObject({ code: HOST_IDENTITY_ERROR.NO_ACTIVE_PUBLIC_ID });
  });
});

describe('retired identity permanence', () => {
  it('keeps a retired value reserved after its host is deleted', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });
    await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294203']) });
    await rotatePublicNodeId({ db, hostId, now: NOW + 1, random: sequence(['5836294204']) });

    await db.execute('DELETE FROM remote_desktop_hosts WHERE id = $1', [hostId]);

    const rows = await db.query<{ public_id: string; host_id: string | null }>(
      'SELECT public_id, host_id FROM remote_desktop_public_ids WHERE public_id = ANY($1::text[]) ORDER BY public_id',
      [['5836294203', '5836294204']],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.host_id).toBeNull();

    // Both values remain globally unavailable for a new host.
    const otherServer = await seedEndpoint({ userId, role: 'controlled' });
    const otherHost = await ensureCanonicalHostForServer({ db, serverId: otherServer, now: NOW });
    const allocated = await allocateActivePublicNodeId({
      db, hostId: otherHost.hostId, now: NOW,
      random: sequence(['5836294203', '5836294204', '5836294205']),
    });
    expect(allocated.publicId).toBe('5836294205');
  });

  it('rejects a malformed identifier at the schema level', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });

    for (const bad of ['4999999999', '583629420', '58362942055']) {
      await expect(db.execute(
        `INSERT INTO remote_desktop_public_ids (public_id, host_id, status, activated_at)
         VALUES ($1, $2, 'active', $3)`,
        [bad, hostId, NOW],
      )).rejects.toThrow();
    }
  });
});

describe('merge state gate', () => {
  it('treats an unresolved conflict as not admission-ready even with an active identity', async () => {
    const userId = await seedUser();
    const serverId = await seedEndpoint({ userId, role: 'controlled' });
    const { hostId } = await ensureCanonicalHostForServer({ db, serverId, now: NOW });
    await allocateActivePublicNodeId({ db, hostId, now: NOW, random: sequence(['5836294206']) });
    expect(await isGuestAdmissionReady({ db, hostId })).toBe(true);

    await db.execute(
      'UPDATE remote_desktop_hosts SET merge_state = $2 WHERE id = $1',
      [hostId, HOST_MERGE_STATE.CONFLICT_PENDING],
    );
    expect(await isGuestAdmissionReady({ db, hostId })).toBe(false);
  });
});
