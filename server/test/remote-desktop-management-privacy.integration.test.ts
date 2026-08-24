/**
 * Server privacy engine — real PostgreSQL (testcontainers via integration-global).
 *
 * Tasks 4.3/4.4. The barrier is only worth anything if it holds under
 * concurrency, wrong-pod delivery, stale generations, partial acknowledgement
 * and process restart, so those are tested against the real database rather
 * than a mock: the atomicity claims here are `FOR UPDATE` claims.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_PRIVACY_PHASE,
} from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_LIMITS } from '../../shared/remote-desktop.js';
import {
  PRIVACY_REFUSAL,
  PrivacyBarrierError,
  acknowledgeFreshFrame,
  acknowledgeShield,
  activateShieldedRouteReplacements,
  allocateRemoteDesktopRouteGeneration,
  assertAdmissionOpenTx,
  beginPrivacyEnd,
  beginPrivacyEpoch,
  activateRouteTx,
  classifyHostRoutesTx,
  clearRecoveredEpoch,
  closeRouteTx,
  countUnregisteredGuestRoutesTx,
  endManagementWebPrivacy,
  endSignedShellPrivacy,
  getHostRoutesTx,
  getPrivacyState,
  isAdmissionOpen,
  joinShieldedRoute,
  markRecoveryRequired,
  replaceShieldedRoutes,
  requireShieldedEpochTx,
  reserveRouteTx,
  setRemoteDesktopManagementPrivacyDispatcher,
  setRemoteDesktopPendingRouteCancellationDispatcher,
  sweepExpiredPrivacyEpochs,
  type RouteRef,
} from '../src/services/remote-desktop-management-privacy.js';

let db: Database;
const NOW = 1_700_000_000_000;
const LEASE = NOW + 300_000;
const DEADLINE = NOW + 60_000;
const POD = 'srv-owning-pod';
const DAEMON_GEN = 7;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  await createUser(db, 'privacy-route-owner');
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at)
     VALUES ($1, 'privacy-route-owner', 'privacy route pod', 'test-token-hash', 'online', $2)
     ON CONFLICT (id) DO NOTHING`,
    [POD, NOW],
  );
});
afterAll(async () => { await db.close(); });

async function seedHost(): Promise<string> {
  const userId = `u_${randomUUID()}`;
  await createUser(db, userId);
  const hostId = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, userId, NOW],
  );
  return hostId;
}

/** Seed a route in the canonical-host registry — the classification source. */
async function seedRoute(input: {
  hostId: string;
  state: 'admitting' | 'active';
  routeId?: string;
  routeGeneration?: number;
  actorSource?: 'account' | 'attended_link' | 'unattended_link' | 'node_password';
  executionServerId?: string | null;
  guestSessionId?: string | null;
}): Promise<RouteRef> {
  const routeId = input.routeId
    ? `${input.routeId}-${input.hostId.slice(0, 8)}`
    : `route-${randomUUID()}`;
  const routeGeneration = input.routeGeneration ?? 1;
  await db.execute(
    `INSERT INTO remote_desktop_host_routes (
       route_id, route_generation, host_id, actor_source, actor_audit_id,
       execution_server_id, state, guest_session_id,
       reserved_at, activated_at, closed_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'audit-id', $5, $6, $7, $8, $9, NULL, $8)`,
    [
      routeId, routeGeneration, input.hostId,
      input.actorSource ?? REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
      input.executionServerId ?? null, input.state, input.guestSessionId ?? null,
      NOW, input.state === 'active' ? NOW : null,
    ],
  );
  return { routeId, routeGeneration };
}

/** Seed only a guest session row, with no registry mirror. */
async function seedUnmirroredGuestSession(input: {
  hostId: string; routeId: string;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO remote_desktop_guest_sessions
       (id, host_id, actor_kind, route_id, route_generation, authority_generation,
        state, created_at, updated_at)
     VALUES ($1, $2, 'node_password', $3, 1, 1, 'active', $4, $4)`,
    [id, input.hostId, input.routeId, NOW],
  );
  return id;
}

function begin(hostId: string, source: 'management_web' | 'signed_shell', epochId = randomUUID()) {
  return beginPrivacyEpoch(db, {
    hostId,
    epochId,
    presentationSource: source,
    initiatingSessionHash: 'session-hash',
    executionServerId: POD,
    daemonGeneration: DAEMON_GEN,
    leaseExpiresAt: LEASE,
    deadline: DEADLINE,
    now: NOW,
  });
}

async function expectRefusal(promise: Promise<unknown>, refusal: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PrivacyBarrierError);
  await promise.catch((err: PrivacyBarrierError) => expect(err.refusal).toBe(refusal));
}

describe('route classification (4.3)', () => {
  it('splits pending from active on registry Worker authority', async () => {
    const hostId = await seedHost();
    await seedRoute({ hostId, state: 'admitting' });
    const live = await seedRoute({ hostId, state: 'active', routeId: 'r-live', routeGeneration: 3 });
    await seedRoute({ hostId, state: 'admitting' });

    const classified = await db.transaction((tx) => classifyHostRoutesTx(tx, hostId));

    expect(classified.active).toEqual([live]);
    expect(classified.pending).toHaveLength(2);
  });

  it('ignores closed routes entirely', async () => {
    const hostId = await seedHost();
    const route = await seedRoute({ hostId, state: 'active', routeId: 'r-gone', routeGeneration: 1 });
    await db.transaction((tx) => closeRouteTx(tx, { hostId, ...route, now: NOW + 1 }));

    const classified = await db.transaction((tx) => classifyHostRoutesTx(tx, hostId));
    expect(classified.active).toHaveLength(0);
    expect(classified.pending).toHaveLength(0);
  });
});

describe('presentation policy (4.4)', () => {
  it('refuses ordinary management Web while any route is pending, leaving admission open', async () => {
    const hostId = await seedHost();
    await seedRoute({ hostId, state: 'admitting' });

    await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.ROUTES_PRESENT);

    // The refusal rolls back its whole transaction, so it leaves no trace at
    // all — not even the idle row it had to insert in order to take the lock.
    expect(await isAdmissionOpen(db, hostId)).toBe(true);
    expect(await getPrivacyState(db, hostId)).toBeNull();
  });

  it('leaves a pre-existing idle epoch record untouched when it refuses', async () => {
    const hostId = await seedHost();
    // Complete one epoch so the host carries a durable row with a revision.
    const epochId = randomUUID();
    const first = await begin(hostId, 'management_web', epochId);
    await beginPrivacyEnd(db, { hostId, epochId, revision: first.revision, now: NOW + 1 });
    await acknowledgeFreshFrame(db, {
      hostId, epochId, revision: first.revision, executionServerId: POD,
      daemonGeneration: DAEMON_GEN, freshFrameGeneration: 50,
      acknowledgedRoutes: [], now: NOW + 2,
    });
    const before = await getPrivacyState(db, hostId);

    await seedRoute({ hostId, state: 'active', routeId: 'r-late', routeGeneration: 1 });
    await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.ROUTES_PRESENT);

    // No revision bump, no phase change, gate still open.
    const after = await getPrivacyState(db, hostId);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.phase).toBe('idle');
    expect(after?.epochId).toBeNull();
    expect(after?.admissionOpen).toBe(true);
  });

  it('refuses ordinary management Web while a route is active', async () => {
    const hostId = await seedHost();
    await seedRoute({ hostId, state: 'active', routeId: 'r1', routeGeneration: 1 });
    await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.ROUTES_PRESENT);
    expect(await isAdmissionOpen(db, hostId)).toBe(true);
  });

  it('lets ordinary management Web begin with no routes and shields immediately', async () => {
    const hostId = await seedHost();
    const result = await begin(hostId, 'management_web');

    expect(result.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);
    expect(result.cancelledPending).toHaveLength(0);
    expect(await isAdmissionOpen(db, hostId)).toBe(false);
  });

  it('ends a no-route signed-shell epoch directly after local secret cleanup', async () => {
    const hostId = await seedHost();
    const started = await begin(hostId, 'signed_shell');
    expect(started.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);
    const ended = await endSignedShellPrivacy(db, {
      hostId,
      epochId: started.epochId,
      revision: started.revision,
      now: NOW + 1,
    });
    expect(ended.phase).toBe('idle');
    expect(ended.admissionOpen).toBe(true);
  });

  it('allows a no-route management Web epoch without a fake daemon generation and ends directly', async () => {
    const hostId = await seedHost();
    const epochId = randomUUID();
    const started = await beginPrivacyEpoch(db, {
      hostId,
      epochId,
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB,
      initiatingSessionHash: 'management-web-session-hash',
      executionServerId: POD,
      daemonGeneration: null,
      leaseExpiresAt: LEASE,
      deadline: DEADLINE,
      now: NOW,
    });
    expect(started.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);
    expect((await getPrivacyState(db, hostId))?.daemonGeneration).toBeNull();

    const ended = await endManagementWebPrivacy(db, {
      hostId,
      epochId,
      revision: started.revision,
      now: NOW + 1,
    });
    expect(ended.phase).toBe('idle');
    expect(ended.admissionOpen).toBe(true);
    expect(ended.epochId).toBeNull();
  });

  it('lets the signed shell begin with routes present, cancelling pending and shielding active', async () => {
    const hostId = await seedHost();
    const pending = await seedRoute({ hostId, state: 'admitting' });
    const live = await seedRoute({ hostId, state: 'active', routeId: 'r-live', routeGeneration: 2 });

    const result = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);

    expect(result.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
    expect(result.cancelledPending).toHaveLength(1);
    expect(result.shieldedActive).toEqual([live]);

    // The cancelled pending route is closed and cannot contribute an ack.
    const routes = await db.transaction((tx) => getHostRoutesTx(tx, hostId));
    expect(routes.find((r) => r.routeId === pending.routeId)?.state).toBe('closed');
    // The active route is untouched.
    expect(routes.find((r) => r.routeId === live.routeId)?.state).toBe('active');
  });

  it('dispatches exact begin/end commands after durable transitions', async () => {
    const hostId = await seedHost();
    const live = await seedRoute({ hostId, state: 'active', routeId: 'r-dispatch', routeGeneration: 4 });
    const sent: unknown[] = [];
    setRemoteDesktopManagementPrivacyDispatcher((command) => {
      sent.push(command);
      return true;
    });
    try {
      const epochId = randomUUID();
      const started = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
      expect(sent).toEqual([{
        executionServerId: POD,
        daemonGeneration: DAEMON_GEN,
        message: {
          type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
          hostId,
          epochId,
          revision: started.revision,
          presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
          deadlineAt: DEADLINE,
          routeSnapshot: [live],
        },
      }]);

      await acknowledgeShield(db, {
        hostId, epochId, revision: started.revision, executionServerId: POD,
        daemonGeneration: DAEMON_GEN, workerGeneration: 40,
        acknowledgedRoutes: [live], now: NOW + 1,
      });
      await beginPrivacyEnd(db, { hostId, epochId, revision: started.revision, now: NOW + 2 });
      expect(sent.at(-1)).toEqual({
        executionServerId: POD,
        daemonGeneration: DAEMON_GEN,
        message: {
          type: REMOTE_DESKTOP_PRIVACY_MSG.END,
          hostId,
          epochId,
          revision: started.revision,
          freshFrameWorkerGeneration: 41,
        },
      });
    } finally {
      setRemoteDesktopManagementPrivacyDispatcher(null);
    }
  });
});

describe('admission gate atomicity (4.3)', () => {
  it('closes admission so a later route cannot join behind the barrier', async () => {
    const hostId = await seedHost();
    await begin(hostId, 'management_web');

    await expectRefusal(
      db.transaction((tx) => assertAdmissionOpenTx(tx, hostId, NOW)),
      PRIVACY_REFUSAL.ADMISSION_CLOSED,
    );
  });

  it('admits while idle', async () => {
    const hostId = await seedHost();
    await expect(db.transaction((tx) => assertAdmissionOpenTx(tx, hostId, NOW))).resolves.toBeUndefined();
  });

  it('serializes concurrent begins to exactly one epoch', async () => {
    const hostId = await seedHost();
    const results = await Promise.allSettled([
      begin(hostId, 'management_web', 'epoch-a'),
      begin(hostId, 'management_web', 'epoch-b'),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const state = await getPrivacyState(db, hostId);
    expect(state?.revision).toBe(1);
    expect(['epoch-a', 'epoch-b']).toContain(state?.epochId);
  });

  it('refuses a second epoch while one is live', async () => {
    const hostId = await seedHost();
    await begin(hostId, 'management_web');
    await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.EPOCH_BUSY);
  });
});

describe('owning-pod acknowledgement (4.3)', () => {
  interface ShellEpoch { hostId: string; epochId: string; revision: number; routes: RouteRef[] }

  async function shellEpoch(): Promise<ShellEpoch> {
    const hostId = await seedHost();
    const routes = [
      await seedRoute({ hostId, state: 'active', routeId: 'r1', routeGeneration: 1 }),
      await seedRoute({ hostId, state: 'active', routeId: 'r2', routeGeneration: 4 }),
    ];
    const epochId = randomUUID();
    const result = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    return { hostId, epochId, revision: result.revision, routes };
  }

  function ack(ctx: ShellEpoch, overrides: Partial<{
    executionServerId: string; daemonGeneration: number; workerGeneration: number; routes: RouteRef[];
  }> = {}) {
    return acknowledgeShield(db, {
      hostId: ctx.hostId,
      epochId: ctx.epochId,
      revision: ctx.revision,
      executionServerId: overrides.executionServerId ?? POD,
      daemonGeneration: overrides.daemonGeneration ?? DAEMON_GEN,
      workerGeneration: overrides.workerGeneration ?? 11,
      acknowledgedRoutes: overrides.routes ?? ctx.routes,
      now: NOW,
    });
  }

  it('advances to active only on an exact complete route set', async () => {
    const ctx = await shellEpoch();
    const state = await ack(ctx);
    expect(state.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);
    expect(state.workerGeneration).toBe(11);
  });

  it('rejects a partial acknowledgement and does not advance', async () => {
    const ctx = await shellEpoch();
    await expectRefusal(ack(ctx, { routes: [ctx.routes[0]] }), PRIVACY_REFUSAL.INCOMPLETE_ACK);
    const state = await getPrivacyState(db, ctx.hostId);
    expect(state?.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
  });

  it('rejects a set with the right route ids but a wrong generation', async () => {
    const ctx = await shellEpoch();
    await expectRefusal(
      ack(ctx, { routes: [ctx.routes[0], { routeId: ctx.routes[1].routeId, routeGeneration: 5 }] }),
      PRIVACY_REFUSAL.INCOMPLETE_ACK,
    );
  });

  it('rejects a superset that pads the required set', async () => {
    const ctx = await shellEpoch();
    await expectRefusal(
      ack(ctx, { routes: [...ctx.routes, { routeId: 'r3-pad', routeGeneration: 1 }] }),
      PRIVACY_REFUSAL.INCOMPLETE_ACK,
    );
  });

  it('rejects acknowledgement from a pod that does not own the daemon channel', async () => {
    const ctx = await shellEpoch();
    await expectRefusal(ack(ctx, { executionServerId: 'srv-other-pod' }), PRIVACY_REFUSAL.WRONG_POD);
    const state = await getPrivacyState(db, ctx.hostId);
    expect(state?.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
  });

  it('rejects a stale daemon generation', async () => {
    const ctx = await shellEpoch();
    await expectRefusal(ack(ctx, { daemonGeneration: DAEMON_GEN - 1 }), PRIVACY_REFUSAL.STALE_GENERATION);
  });

  it('rejects a stale epoch revision', async () => {
    const ctx = await shellEpoch();
    await expectRefusal(
      acknowledgeShield(db, {
        hostId: ctx.hostId, epochId: ctx.epochId, revision: ctx.revision + 1,
        executionServerId: POD, daemonGeneration: DAEMON_GEN, workerGeneration: 11,
        acknowledgedRoutes: ctx.routes, now: NOW,
      }),
      PRIVACY_REFUSAL.EPOCH_MISMATCH,
    );
  });

  it('rejects acknowledgement for a different epoch id', async () => {
    const ctx = await shellEpoch();
    await expectRefusal(
      acknowledgeShield(db, {
        hostId: ctx.hostId, epochId: randomUUID(), revision: ctx.revision,
        executionServerId: POD, daemonGeneration: DAEMON_GEN, workerGeneration: 11,
        acknowledgedRoutes: ctx.routes, now: NOW,
      }),
      PRIVACY_REFUSAL.EPOCH_MISMATCH,
    );
  });

  it('shields a route that reconnects with a new generation and stops secret UI', async () => {
    const ctx = await shellEpoch();
    await ack(ctx);
    expect((await getPrivacyState(db, ctx.hostId))?.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);

    const rejoined = await joinShieldedRoute(db, {
      hostId: ctx.hostId, epochId: ctx.epochId,
      route: { routeId: ctx.routes[1].routeId, routeGeneration: 5 }, now: NOW + 1,
    });

    // The new generation has not proven the privacy frame, so the barrier is no
    // longer authoritative.
    expect(rejoined.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
    expect(rejoined.routeSnapshot).toContainEqual({ routeId: ctx.routes[1].routeId, routeGeneration: 5 });

    // Secret mutation is refused while the rejoined route is unshielded.
    await expectRefusal(
      db.transaction((tx) => requireShieldedEpochTx(tx, {
        hostId: ctx.hostId, epochId: ctx.epochId, revision: ctx.revision,
      })),
      PRIVACY_REFUSAL.NOT_SHIELDED,
    );
  });
});

describe('independent route generation and epoch replacement (4.3/4.4)', () => {
  it('caps the global route-generation sequence at the JavaScript safe-integer boundary', async () => {
    const sequence = await db.queryOne<{ max_value: string | number }>(
      `SELECT max_value
         FROM pg_sequences
        WHERE schemaname = current_schema()
          AND sequencename = 'remote_desktop_route_generation_seq'`,
    );
    expect(sequence).not.toBeNull();
    expect(Number(sequence!.max_value)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('allocates route incarnations independently from daemon generations', async () => {
    const first = await allocateRemoteDesktopRouteGeneration(db);
    const second = await allocateRemoteDesktopRouteGeneration(db);
    expect(second).toBe(first + 1);
    expect(first).not.toBe(DAEMON_GEN);
  });

  it('atomically replaces the snapshot, rejects the stale ACK, and activates only after the full new ACK', async () => {
    const hostId = await seedHost();
    const previous = await seedRoute({
      hostId,
      state: 'active',
      routeId: 'replace-route',
      routeGeneration: await allocateRemoteDesktopRouteGeneration(db),
      executionServerId: POD,
    });
    const epochId = randomUUID();
    const begun = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    await acknowledgeShield(db, {
      hostId, epochId, revision: begun.revision,
      executionServerId: POD, daemonGeneration: DAEMON_GEN, workerGeneration: 10,
      acknowledgedRoutes: [previous], now: NOW,
    });

    const replacement = {
      routeId: previous.routeId,
      routeGeneration: await allocateRemoteDesktopRouteGeneration(db),
    };
    const replaced = await replaceShieldedRoutes(db, {
      hostId,
      epochId,
      executionServerId: POD,
      daemonGeneration: DAEMON_GEN + 1,
      replacements: [{ previous, replacement }],
      now: NOW + 1,
    });
    expect(replaced.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
    expect(replaced.revision).toBe(begun.revision + 1);
    expect(replaced.routeSnapshot).toEqual([replacement]);
    expect(replaced.acknowledgedRoutes).toEqual([]);
    const rows = await getHostRoutesTx(db, hostId);
    expect(rows.find((row) => row.routeGeneration === previous.routeGeneration)?.state).toBe('closed');
    expect(rows.find((row) => row.routeGeneration === replacement.routeGeneration)?.state).toBe('shielding');

    await expectRefusal(
      acknowledgeShield(db, {
        hostId, epochId, revision: replaced.revision,
        executionServerId: POD, daemonGeneration: DAEMON_GEN + 1, workerGeneration: 11,
        acknowledgedRoutes: [previous], now: NOW + 2,
      }),
      PRIVACY_REFUSAL.INCOMPLETE_ACK,
    );
    await acknowledgeShield(db, {
      hostId, epochId, revision: replaced.revision,
      executionServerId: POD, daemonGeneration: DAEMON_GEN + 1, workerGeneration: 11,
      acknowledgedRoutes: [replacement], now: NOW + 2,
    });
    await activateShieldedRouteReplacements(db, {
      hostId, epochId, revision: replaced.revision, routes: [replacement], now: NOW + 3,
    });
    expect((await getHostRoutesTx(db, hostId)).find(
      (row) => row.routeGeneration === replacement.routeGeneration,
    )?.state).toBe('active');
  });

  it('rejects a replacement from a non-owning pod without changing the snapshot', async () => {
    const hostId = await seedHost();
    const previous = await seedRoute({
      hostId, state: 'active', routeId: 'wrong-pod-route', routeGeneration: 41,
      executionServerId: POD,
    });
    const epochId = randomUUID();
    const begun = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    await expectRefusal(
      replaceShieldedRoutes(db, {
        hostId, epochId, executionServerId: 'different-pod', daemonGeneration: DAEMON_GEN + 1,
        replacements: [{
          previous,
          replacement: { routeId: previous.routeId, routeGeneration: 42 },
        }],
        now: NOW + 1,
      }),
      PRIVACY_REFUSAL.WRONG_POD,
    );
    expect((await getPrivacyState(db, hostId))?.routeSnapshot).toEqual(begun.shieldedActive);
  });

  it('rolls back the old close and snapshot replacement when the new incarnation conflicts', async () => {
    const hostId = await seedHost();
    const conflicting = await seedRoute({
      hostId, state: 'active', routeId: 'rollback-route', routeGeneration: 92,
      executionServerId: POD,
    });
    await closeRouteTx(db, { hostId, ...conflicting, now: NOW });
    const previous = await seedRoute({
      hostId, state: 'active', routeId: 'rollback-route', routeGeneration: 91,
      executionServerId: POD,
    });
    const epochId = randomUUID();
    const begun = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    await acknowledgeShield(db, {
      hostId, epochId, revision: begun.revision,
      executionServerId: POD, daemonGeneration: DAEMON_GEN, workerGeneration: 12,
      acknowledgedRoutes: [previous], now: NOW,
    });
    await expect(replaceShieldedRoutes(db, {
      hostId, epochId, executionServerId: POD, daemonGeneration: DAEMON_GEN + 1,
      replacements: [{ previous, replacement: conflicting }], now: NOW + 1,
    })).rejects.toBeTruthy();
    expect((await getPrivacyState(db, hostId))?.routeSnapshot).toEqual([previous]);
    expect((await getHostRoutesTx(db, hostId)).find(
      (row) => row.routeGeneration === previous.routeGeneration,
    )?.state).toBe('active');
  });

  it('delivers committed pending cancellations only after their durable rows are closed', async () => {
    const hostId = await seedHost();
    const pending = await seedRoute({
      hostId, state: 'admitting', routeId: 'pending-cancel', routeGeneration: 73,
      executionServerId: POD,
    });
    const observed: Array<{ state: string | undefined; routes: readonly RouteRef[] }> = [];
    setRemoteDesktopPendingRouteCancellationDispatcher(async (command) => {
      const rows = await getHostRoutesTx(db, command.hostId);
      observed.push({
        state: rows.find((row) => row.routeGeneration === pending.routeGeneration)?.state,
        routes: command.routes,
      });
      return true;
    });
    try {
      await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, randomUUID());
    } finally {
      setRemoteDesktopPendingRouteCancellationDispatcher(null);
    }
    expect(observed).toEqual([{ state: 'closed', routes: [pending] }]);
  });
});

describe('secret mutation gate (4.3)', () => {
  it('permits a secret mutation only under the exact current shielded epoch', async () => {
    const hostId = await seedHost();
    const epochId = randomUUID();
    const { revision } = await begin(hostId, 'management_web', epochId);

    const state = await db.transaction((tx) => requireShieldedEpochTx(tx, { hostId, epochId, revision }));
    expect(state.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);

    // Wrong epoch id and wrong revision both fail closed — a direct API call
    // cannot bypass the barrier by guessing.
    await expectRefusal(
      db.transaction((tx) => requireShieldedEpochTx(tx, { hostId, epochId: randomUUID(), revision })),
      PRIVACY_REFUSAL.NOT_SHIELDED,
    );
    await expectRefusal(
      db.transaction((tx) => requireShieldedEpochTx(tx, { hostId, epochId, revision: revision + 1 })),
      PRIVACY_REFUSAL.NOT_SHIELDED,
    );
  });

  it('refuses a secret mutation while the epoch is still starting', async () => {
    const hostId = await seedHost();
    await seedRoute({ hostId, state: 'active', routeId: 'r1', routeGeneration: 1 });
    const epochId = randomUUID();
    const { revision } = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);

    await expectRefusal(
      db.transaction((tx) => requireShieldedEpochTx(tx, { hostId, epochId, revision })),
      PRIVACY_REFUSAL.NOT_SHIELDED,
    );
  });
});

describe('ending the epoch (4.3)', () => {
  async function shieldedEpoch(): Promise<{ hostId: string; epochId: string; revision: number }> {
    const hostId = await seedHost();
    const epochId = randomUUID();
    const { revision } = await begin(hostId, 'management_web', epochId);
    return { hostId, epochId, revision };
  }

  it('clears secret state first and keeps admission closed until a fresh frame', async () => {
    const ctx = await shieldedEpoch();

    const ending = await beginPrivacyEnd(db, { ...ctx, now: NOW + 10 });
    expect(ending.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ENDING);
    expect(ending.admissionOpen).toBe(false);
    expect(await isAdmissionOpen(db, ctx.hostId)).toBe(false);

    const resumed = await acknowledgeFreshFrame(db, {
      ...ctx, executionServerId: POD, daemonGeneration: DAEMON_GEN,
      freshFrameGeneration: 99, acknowledgedRoutes: [], now: NOW + 20,
    });
    expect(resumed.phase).toBe('idle');
    expect(resumed.admissionOpen).toBe(true);
    expect(resumed.epochId).toBeNull();
    expect(await isAdmissionOpen(db, ctx.hostId)).toBe(true);
  });

  it('rejects a cached pre-end frame generation', async () => {
    const hostId = await seedHost();
    const route = await seedRoute({ hostId, state: 'active', routeId: 'r1', routeGeneration: 1 });
    const epochId = randomUUID();
    const { revision } = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    await acknowledgeShield(db, {
      hostId, epochId, revision, executionServerId: POD, daemonGeneration: DAEMON_GEN,
      workerGeneration: 40, acknowledgedRoutes: [route], now: NOW,
    });
    await beginPrivacyEnd(db, { hostId, epochId, revision, now: NOW + 1 });

    // Equal to the shield generation is still the shielded frame.
    await expectRefusal(
      acknowledgeFreshFrame(db, {
        hostId, epochId, revision, executionServerId: POD, daemonGeneration: DAEMON_GEN,
        freshFrameGeneration: 40, acknowledgedRoutes: [route], now: NOW + 2,
      }),
      PRIVACY_REFUSAL.CACHED_FRAME,
    );
    expect(await isAdmissionOpen(db, hostId)).toBe(false);
  });

  it('rejects a fresh frame that omits a route from the captured snapshot', async () => {
    const hostId = await seedHost();
    const route = await seedRoute({ hostId, state: 'active', routeId: 'r-partial-end', routeGeneration: 2 });
    const epochId = randomUUID();
    const { revision } = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    await acknowledgeShield(db, {
      hostId, epochId, revision, executionServerId: POD, daemonGeneration: DAEMON_GEN,
      workerGeneration: 40, acknowledgedRoutes: [route], now: NOW,
    });
    await beginPrivacyEnd(db, { hostId, epochId, revision, now: NOW + 1 });
    await expectRefusal(
      acknowledgeFreshFrame(db, {
        hostId, epochId, revision, executionServerId: POD, daemonGeneration: DAEMON_GEN,
        freshFrameGeneration: 41, acknowledgedRoutes: [], now: NOW + 2,
      }),
      PRIVACY_REFUSAL.INCOMPLETE_ACK,
    );
    expect(await isAdmissionOpen(db, hostId)).toBe(false);
  });

  it('refuses a fresh-frame acknowledgement from the wrong pod', async () => {
    const ctx = await shieldedEpoch();
    await beginPrivacyEnd(db, { ...ctx, now: NOW + 1 });
    await expectRefusal(
      acknowledgeFreshFrame(db, {
        ...ctx, executionServerId: 'srv-other-pod', daemonGeneration: DAEMON_GEN,
        freshFrameGeneration: 99, acknowledgedRoutes: [], now: NOW + 2,
      }),
      PRIVACY_REFUSAL.WRONG_POD,
    );
    expect(await isAdmissionOpen(db, ctx.hostId)).toBe(false);
  });

  it('refuses to end an epoch that never reached active', async () => {
    const hostId = await seedHost();
    await seedRoute({ hostId, state: 'active', routeId: 'r1', routeGeneration: 1 });
    const epochId = randomUUID();
    const { revision } = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    await expectRefusal(
      beginPrivacyEnd(db, { hostId, epochId, revision, now: NOW + 1 }),
      PRIVACY_REFUSAL.NOT_SHIELDED,
    );
  });
});

describe('failure, loss and restart recovery (4.3, 4.4)', () => {
  it('marks only the exact current signed-shell epoch as recovery-required and is idempotent', async () => {
    const hostId = await seedHost();
    const epochId = randomUUID();
    const { revision } = await begin(
      hostId,
      REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      epochId,
    );
    const input = {
      hostId,
      epochId,
      reason: 'clipboard_cleanup_unproven',
      now: NOW + 5,
      expectedRevision: revision,
      expectedDaemonGeneration: DAEMON_GEN,
      expectedPresentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
    } as const;

    const recovered = await markRecoveryRequired(db, input);
    expect(recovered).toMatchObject({
      hostId,
      epochId,
      revision,
      phase: REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED,
      admissionOpen: false,
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      daemonGeneration: DAEMON_GEN,
      recoveryReason: 'clipboard_cleanup_unproven',
    });

    const duplicate = await markRecoveryRequired(db, input);
    expect(duplicate).toEqual(recovered);
    expect(await getPrivacyState(db, hostId)).toEqual(recovered);
  });

  it.each([
    {
      name: 'stale revision',
      source: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      override: (epochId: string, revision: number) => ({
        epochId,
        expectedRevision: revision - 1,
        expectedDaemonGeneration: DAEMON_GEN,
        expectedPresentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      }),
    },
    {
      name: 'wrong daemon generation',
      source: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      override: (epochId: string, revision: number) => ({
        epochId,
        expectedRevision: revision,
        expectedDaemonGeneration: DAEMON_GEN + 1,
        expectedPresentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      }),
    },
    {
      name: 'management-web presentation source',
      source: REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB,
      override: (epochId: string, revision: number) => ({
        epochId,
        expectedRevision: revision,
        expectedDaemonGeneration: DAEMON_GEN,
        expectedPresentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      }),
    },
    {
      name: 'wrong epoch',
      source: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      override: (_epochId: string, revision: number) => ({
        epochId: randomUUID(),
        expectedRevision: revision,
        expectedDaemonGeneration: DAEMON_GEN,
        expectedPresentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      }),
    },
  ])('rejects $name without changing durable state', async ({ source, override }) => {
    const hostId = await seedHost();
    const epochId = randomUUID();
    const { revision } = await begin(hostId, source, epochId);
    const before = await getPrivacyState(db, hostId);

    await expectRefusal(
      markRecoveryRequired(db, {
        hostId,
        reason: 'must_not_commit',
        now: NOW + 5,
        ...override(epochId, revision),
      }),
      PRIVACY_REFUSAL.EPOCH_MISMATCH,
    );

    expect(await getPrivacyState(db, hostId)).toEqual(before);
  });

  it('turns an expired lease into recovery_required without reopening admission', async () => {
    const hostId = await seedHost();
    await seedRoute({ hostId, state: 'active', routeId: 'r1', routeGeneration: 1 });
    await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);

    // Simulates a lost begin/ack: nothing ever acknowledged and the lease ran out.
    const swept = await sweepExpiredPrivacyEpochs(db, { now: LEASE + 1 });

    expect(swept.recovered).toContain(hostId);
    const state = await getPrivacyState(db, hostId);
    expect(state?.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED);
    expect(state?.admissionOpen).toBe(false);
    expect(await isAdmissionOpen(db, hostId)).toBe(false);
  });

  it('leaves a live epoch alone when the lease has not expired', async () => {
    const hostId = await seedHost();
    await begin(hostId, 'management_web');
    const swept = await sweepExpiredPrivacyEpochs(db, { now: DEADLINE - 1 });
    expect(swept.recovered).not.toContain(hostId);
    expect((await getPrivacyState(db, hostId))?.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);
  });

  it('is idempotent across repeated sweeps', async () => {
    const hostId = await seedHost();
    await begin(hostId, 'management_web');
    await sweepExpiredPrivacyEpochs(db, { now: LEASE + 1 });
    const second = await sweepExpiredPrivacyEpochs(db, { now: LEASE + 2 });
    expect(second.recovered).not.toContain(hostId);
  });

  it('blocks a new epoch and secret mutation while recovery is required', async () => {
    const hostId = await seedHost();
    const epochId = randomUUID();
    const { revision } = await begin(hostId, 'management_web', epochId);
    await markRecoveryRequired(db, { hostId, epochId, reason: 'cleanup_unproven', now: NOW + 5 });

    await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.RECOVERY_REQUIRED);
    await expectRefusal(
      db.transaction((tx) => requireShieldedEpochTx(tx, { hostId, epochId, revision })),
      PRIVACY_REFUSAL.NOT_SHIELDED,
    );
    await expectRefusal(
      db.transaction((tx) => assertAdmissionOpenTx(tx, hostId, NOW)),
      PRIVACY_REFUSAL.ADMISSION_CLOSED,
    );
  });

  it('reopens only through an explicit recovery clear', async () => {
    const hostId = await seedHost();
    const epochId = randomUUID();
    await begin(hostId, 'management_web', epochId);
    await markRecoveryRequired(db, { hostId, epochId, reason: 'watchdog_failed', now: NOW + 5 });

    const cleared = await clearRecoveredEpoch(db, { hostId, now: NOW + 10 });
    expect(cleared.phase).toBe('idle');
    expect(cleared.admissionOpen).toBe(true);
    expect(cleared.recoveryReason).toBeNull();
    await expect(begin(hostId, 'management_web')).resolves.toMatchObject({
      phase: REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE,
    });
  });

  it('refuses to clear an epoch that is not in recovery', async () => {
    const hostId = await seedHost();
    await begin(hostId, 'management_web');
    await expectRefusal(clearRecoveredEpoch(db, { hostId, now: NOW + 1 }), PRIVACY_REFUSAL.NOT_RESUMING);
  });

  it('survives a simulated restart: durable state, not process memory, decides', async () => {
    const hostId = await seedHost();
    await seedRoute({ hostId, state: 'active', routeId: 'r1', routeGeneration: 1 });
    const epochId = randomUUID();
    await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);

    // A fresh connection stands in for a restarted pod with no local memory.
    const reconnected = createDatabase(process.env.TEST_DATABASE_URL!);
    try {
      const state = await getPrivacyState(reconnected, hostId);
      expect(state?.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
      expect(state?.admissionOpen).toBe(false);
      expect(await isAdmissionOpen(reconnected, hostId)).toBe(false);
    } finally {
      await reconnected.close();
    }
  });
});

describe('actor-neutral registry barrier (privacy gap fix)', () => {
  it('blocks management Web while an authenticated Owner route is active', async () => {
    const hostId = await seedHost();
    // The gap: this route lives in the Router, not in guest sessions. Before the
    // registry, classification could not see it and management Web was allowed
    // to shield while a real remote desktop was still capturing.
    await seedRoute({
      hostId, state: 'active', routeId: 'owner-route', routeGeneration: 1,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT,
    });

    await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.ROUTES_PRESENT);
    expect(await isAdmissionOpen(db, hostId)).toBe(true);
  });

  it('blocks management Web for every actor kind identically', async () => {
    for (const actorSource of Object.values(REMOTE_DESKTOP_ACTOR_SOURCE)) {
      const hostId = await seedHost();
      await seedRoute({ hostId, state: 'active', actorSource });
      await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.ROUTES_PRESENT);
    }
  });

  it('puts authenticated and guest routes in one signed-shell snapshot', async () => {
    const hostId = await seedHost();
    const owner = await seedRoute({
      hostId, state: 'active', routeId: 'acct', routeGeneration: 1,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT,
    });
    const guest = await seedRoute({
      hostId, state: 'active', routeId: 'guest', routeGeneration: 2,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
    });

    const result = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);

    expect(result.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
    expect(result.shieldedActive).toHaveLength(2);
    expect(result.shieldedActive).toContainEqual(owner);
    expect(result.shieldedActive).toContainEqual(guest);

    // Both must acknowledge; the authenticated one is not exempt.
    await expectRefusal(
      acknowledgeShield(db, {
        hostId, epochId: (await getPrivacyState(db, hostId))!.epochId!,
        revision: result.revision, executionServerId: POD, daemonGeneration: DAEMON_GEN,
        workerGeneration: 5, acknowledgedRoutes: [guest], now: NOW,
      }),
      PRIVACY_REFUSAL.INCOMPLETE_ACK,
    );
  });

  it('unifies routes from different endpoints of one canonical host', async () => {
    const hostId = await seedHost();
    const onDaemon = await seedRoute({
      hostId, state: 'active', routeId: 'ep-full', routeGeneration: 1,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT, executionServerId: null,
    });
    const onControlled = await seedRoute({
      hostId, state: 'active', routeId: 'ep-controlled', routeGeneration: 1,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD, executionServerId: null,
    });

    const classified = await db.transaction((tx) => classifyHostRoutesTx(tx, hostId));
    expect(classified.active).toHaveLength(2);
    expect(classified.active).toContainEqual(onDaemon);
    expect(classified.active).toContainEqual(onControlled);
  });
});

describe('reserve / activate / close under the privacy lock', () => {
  it('enforces one canonical-host collaboration budget across actor kinds', async () => {
    const hostId = await seedHost();
    const limit = Math.min(
      REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE,
      REMOTE_DESKTOP_LIMITS.MAX_PEER_CONNECTIONS_PER_WORKER,
      REMOTE_DESKTOP_LIMITS.MAX_TURN_ALLOCATIONS_PER_MACHINE,
    );
    for (let index = 0; index < limit; index += 1) {
      await db.transaction((tx) => reserveRouteTx(tx, {
        hostId,
        routeId: `budget-${index}`,
        routeGeneration: 1,
        actorSource: index % 2 === 0
          ? REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT
          : REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
        now: NOW,
      }));
    }
    await expectRefusal(
      db.transaction((tx) => reserveRouteTx(tx, {
        hostId,
        routeId: 'budget-overflow',
        routeGeneration: 1,
        actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT,
        now: NOW,
      })),
      PRIVACY_REFUSAL.ROUTE_LIMIT,
    );
  });

  it('reserves while idle and refuses once the gate closes', async () => {
    const hostId = await seedHost();
    await db.transaction((tx) => reserveRouteTx(tx, {
      hostId, routeId: `res-${randomUUID()}`, routeGeneration: 1,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT, now: NOW,
    }));

    // That reservation is a pending route, so management Web is now refused.
    await expectRefusal(begin(hostId, 'management_web'), PRIVACY_REFUSAL.ROUTES_PRESENT);

    await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);
    await expectRefusal(
      db.transaction((tx) => reserveRouteTx(tx, {
        hostId, routeId: `late-${randomUUID()}`, routeGeneration: 1,
        actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT, now: NOW + 1,
      })),
      PRIVACY_REFUSAL.ADMISSION_CLOSED,
    );
  });

  it('linearizes a concurrent begin and reserve to exactly one winner', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const hostId = await seedHost();
      const routeId = `race-${randomUUID()}`;

      const [beginResult, reserveResult] = await Promise.allSettled([
        begin(hostId, 'management_web'),
        db.transaction((tx) => reserveRouteTx(tx, {
          hostId, routeId, routeGeneration: 1,
          actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT, now: NOW,
        })),
      ]);

      const routes = await db.transaction((tx) => getHostRoutesTx(tx, hostId));
      const live = routes.filter((r) => r.state !== 'closed');
      const state = await getPrivacyState(db, hostId);

      if (beginResult.status === 'fulfilled') {
        // Begin won: the gate closed first, so the reservation was refused and
        // the shielded epoch cannot be hiding an unseen route.
        expect(reserveResult.status).toBe('rejected');
        expect(live).toHaveLength(0);
        expect(state?.admissionOpen).toBe(false);
      } else {
        // Reserve won: the route existed before the snapshot, so management Web
        // was correctly refused and admission stayed open.
        expect(reserveResult.status).toBe('fulfilled');
        expect(live).toHaveLength(1);
        expect(await isAdmissionOpen(db, hostId)).toBe(true);
      }
    }
  });

  it('refuses to activate a straggler behind a closed gate', async () => {
    const hostId = await seedHost();
    const routeId = `strag-${randomUUID()}`;
    await db.transaction((tx) => reserveRouteTx(tx, {
      hostId, routeId, routeGeneration: 1,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT, now: NOW,
    }));
    await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);

    // Begin cancelled it as pending; activating it now would put an unshielded
    // capture on screen behind the barrier.
    await expectRefusal(
      db.transaction((tx) => activateRouteTx(tx, { hostId, routeId, routeGeneration: 1, now: NOW + 1 })),
      PRIVACY_REFUSAL.ADMISSION_CLOSED,
    );
  });

  it('cancels reserved routes when the signed shell begins', async () => {
    const hostId = await seedHost();
    const routeId = `pend-${randomUUID()}`;
    await db.transaction((tx) => reserveRouteTx(tx, {
      hostId, routeId, routeGeneration: 1,
      actorSource: REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK, now: NOW,
    }));

    const result = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);

    // No active routes remain, so the barrier is vacuously satisfied.
    expect(result.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);
    expect(result.cancelledPending).toHaveLength(1);
    const routes = await db.transaction((tx) => getHostRoutesTx(tx, hostId));
    expect(routes.find((r) => r.routeId === routeId)?.state).toBe('closed');
  });
});

describe('route close during starting', () => {
  it('does not deadlock the barrier when the only active route closes', async () => {
    const hostId = await seedHost();
    const route = await seedRoute({ hostId, state: 'active', routeId: 'solo', routeGeneration: 1 });
    const result = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);
    expect(result.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);

    // The route disconnects before it can acknowledge. Waiting for an ack it can
    // never send would strand the epoch until its lease expired.
    const closed = await db.transaction((tx) => closeRouteTx(tx, { hostId, ...route, now: NOW + 1 }));

    expect(closed.closed).toBe(true);
    expect(closed.snapshotRepaired).toBe(true);
    expect(closed.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);

    const state = await getPrivacyState(db, hostId);
    expect(state?.routeSnapshot).toHaveLength(0);
    // Dropping a shielding obligation must not reopen the gate.
    expect(state?.admissionOpen).toBe(false);
  });

  it('keeps waiting when another active route is still outstanding', async () => {
    const hostId = await seedHost();
    const leaving = await seedRoute({ hostId, state: 'active', routeId: 'leaving', routeGeneration: 1 });
    const staying = await seedRoute({ hostId, state: 'active', routeId: 'staying', routeGeneration: 1 });
    await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);

    const closed = await db.transaction((tx) => closeRouteTx(tx, { hostId, ...leaving, now: NOW + 1 }));

    expect(closed.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
    const state = await getPrivacyState(db, hostId);
    expect(state?.routeSnapshot).toEqual([staying]);
    expect(state?.admissionOpen).toBe(false);
  });

  it('still requires an exact ack against the reduced snapshot', async () => {
    const hostId = await seedHost();
    const leaving = await seedRoute({ hostId, state: 'active', routeId: 'leaving', routeGeneration: 1 });
    const staying = await seedRoute({ hostId, state: 'active', routeId: 'staying', routeGeneration: 1 });
    const epochId = randomUUID();
    const { revision } = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL, epochId);
    await db.transaction((tx) => closeRouteTx(tx, { hostId, ...leaving, now: NOW + 1 }));

    // The stale set including the departed route is no longer acceptable.
    await expectRefusal(
      acknowledgeShield(db, {
        hostId, epochId, revision, executionServerId: POD, daemonGeneration: DAEMON_GEN,
        workerGeneration: 3, acknowledgedRoutes: [leaving, staying], now: NOW + 2,
      }),
      PRIVACY_REFUSAL.INCOMPLETE_ACK,
    );

    const ok = await acknowledgeShield(db, {
      hostId, epochId, revision, executionServerId: POD, daemonGeneration: DAEMON_GEN,
      workerGeneration: 3, acknowledgedRoutes: [staying], now: NOW + 3,
    });
    expect(ok.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE);
  });

  it('leaves an idle host untouched when a route closes', async () => {
    const hostId = await seedHost();
    const route = await seedRoute({ hostId, state: 'active' });
    const closed = await db.transaction((tx) => closeRouteTx(tx, { hostId, ...route, now: NOW + 1 }));
    expect(closed.snapshotRepaired).toBe(false);
    expect(await isAdmissionOpen(db, hostId)).toBe(true);
  });
});

describe('unregistered guest route safety net', () => {
  it('refuses to begin while a live guest session has no registry mirror', async () => {
    const hostId = await seedHost();
    await seedUnmirroredGuestSession({ hostId, routeId: `orphan-${randomUUID()}` });

    expect(await db.transaction((tx) => countUnregisteredGuestRoutesTx(tx, hostId))).toBe(1);
    // Classification is registry-only, so this route is invisible to it — the
    // engine must refuse rather than shield over something it cannot see.
    const classified = await db.transaction((tx) => classifyHostRoutesTx(tx, hostId));
    expect(classified.active).toHaveLength(0);
    await expectRefusal(
      begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL),
      PRIVACY_REFUSAL.ROUTES_PRESENT,
    );
  });

  it('proceeds once the guest session is mirrored into the registry', async () => {
    const hostId = await seedHost();
    const routeId = `mirrored-${randomUUID()}`;
    const sessionId = await seedUnmirroredGuestSession({ hostId, routeId });
    await db.execute(
      `INSERT INTO remote_desktop_host_routes (
         route_id, route_generation, host_id, actor_source, state,
         guest_session_id, reserved_at, activated_at, updated_at)
       VALUES ($1, 1, $2, 'node_password', 'active', $3, $4, $4, $4)`,
      [routeId, hostId, sessionId, NOW],
    );

    expect(await db.transaction((tx) => countUnregisteredGuestRoutesTx(tx, hostId))).toBe(0);
    const result = await begin(hostId, REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL);
    expect(result.shieldedActive).toEqual([{ routeId, routeGeneration: 1 }]);
  });
});
