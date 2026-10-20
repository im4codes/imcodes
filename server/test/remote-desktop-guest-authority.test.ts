import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_OUTBOX_SCOPE,
} from '../../shared/remote-desktop-access.js';
import type { Database } from '../src/db/client.js';
import {
  appendGuestEffectTx,
  beginManagementPrivacyEpochTx,
  createGuestLinkRowsTx,
  requireShieldedPrivacyEpochTx,
} from '../src/services/remote-desktop-guest-authority.js';
import { parseRemoteDesktopGuestOutboxRow } from '../src/services/remote-desktop-guest-outbox-worker.js';

class RecordingDatabase {
  readonly calls: Array<{ kind: 'one' | 'execute'; sql: string; params: unknown[] }> = [];
  rows: unknown[] = [];

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.calls.push({ kind: 'one', sql, params });
    return (this.rows.shift() as T | undefined) ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    this.calls.push({ kind: 'execute', sql, params });
    return { changes: 1 };
  }

  asDatabase(): Database {
    return this as unknown as Database;
  }
}

describe('remote desktop guest authority repository', () => {
  it('closes admission while beginning a monotonic privacy epoch', async () => {
    const db = new RecordingDatabase();
    db.rows.push({
      epoch_id: 'epoch-1', revision: 4, phase: 'starting',
      presentation_source: 'signed_shell', admission_open: false,
    });
    const result = await beginManagementPrivacyEpochTx(db.asDatabase(), {
      hostId: 'host-1', epochId: 'epoch-1',
      presentationSource: 'signed_shell',
      initiatingSessionHash: 'session-hash', executionServerId: 'server-1',
      daemonGeneration: 2, routeSnapshot: [{ routeId: 'route-1', generation: 3 }],
      leaseExpiresAt: 2_000, deadline: 1_900, now: 1_000,
    });
    expect(result).toMatchObject({ epochId: 'epoch-1', revision: 4, phase: 'starting' });
    expect(db.calls[0]?.sql).toContain("phase = 'starting', admission_open = FALSE");
    expect(db.calls[0]?.sql).toContain("WHERE remote_desktop_management_privacy.phase = 'idle'");
  });

  it('rejects mutation unless the exact locked epoch is shielded', async () => {
    const ok = new RecordingDatabase();
    ok.rows.push({
      epoch_id: 'epoch-1', revision: 5, phase: 'active',
      presentation_source: 'signed_shell', admission_open: false,
    });
    await expect(requireShieldedPrivacyEpochTx(ok.asDatabase(), {
      hostId: 'host-1', epochId: 'epoch-1', revision: 5, now: 1_000,
    })).resolves.toMatchObject({ phase: 'active' });
    expect(ok.calls[0]?.sql).toContain('FOR UPDATE');

    const stale = new RecordingDatabase();
    stale.rows.push({
      epoch_id: 'epoch-1', revision: 4, phase: 'active',
      presentation_source: 'signed_shell', admission_open: false,
    });
    await expect(requireShieldedPrivacyEpochTx(stale.asDatabase(), {
      hostId: 'host-1', epochId: 'epoch-1', revision: 5, now: 1_000,
    })).rejects.toThrow('privacy_epoch_not_shielded');
  });

  it('creates unattended link and due row through one caller transaction', async () => {
    const db = new RecordingDatabase();
    await createGuestLinkRowsTx(db.asDatabase(), {
      id: 'link-1', hostId: 'host-1', ownerUserId: 'owner-1', tokenHash: 'hash-1',
      creationRequestId: 'request-1', normalizedPolicyHash: 'policy-1', label: 'Desk',
      attendance: 'unattended', accessMode: 'control', expiresAt: 7_000, now: 1_000,
    });
    // Three, not two: `replaceExpiryDueTx` supersedes any stale due row and then
    // inserts the current one. They are separate `execute` calls because the
    // extended query protocol `pg` uses for parameterized statements refuses
    // multiple commands in one prepared statement — a fake DB accepts the
    // combined form, real PostgreSQL does not.
    expect(db.calls).toHaveLength(3);
    expect(db.calls[0]?.sql).toContain('remote_desktop_guest_links');
    expect(db.calls[1]?.sql).toContain('remote_desktop_guest_expiry_due');
    expect(db.calls[2]?.sql).toContain('remote_desktop_guest_expiry_due');
    // Every statement carries its own parameters, so none of them can be the
    // multi-command form that fails at runtime.
    for (const call of db.calls) expect(call.sql.trim().replace(/;$/, '')).not.toContain(';');
    expect(db.calls.some((call) => call.params.includes('raw-secret'))).toBe(false);
  });

  it('allocates a monotonic host sequence before appending a typed effect', async () => {
    const db = new RecordingDatabase();
    db.rows.push(null, { sequence: 9 }, { sequence: 9 });
    await expect(appendGuestEffectTx(db.asDatabase(), {
      id: 'effect-1', targetRouteId: 'route-1',
      event: {
        idempotencyKey: 'terminal:link-1:3',
        authorityKind: 'link',
        effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
        scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
        hostId: 'host-1', targetServerId: 'server-1', actorAuditId: 'audit-link-1',
        authorityGeneration: 3, expiryRevision: 2, commitRevision: 7,
        routeGeneration: 6,
      },
      now: 1_000, sloAnchorAt: 1_000, retainUntil: 9_000,
    })).resolves.toBe(9);
    expect(db.calls[0]?.sql).toContain('idempotency_key = $1');
    expect(db.calls[1]?.sql).toContain('next_sequence + 1');
    expect(db.calls[2]?.sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(db.calls[2]?.params).toContain(JSON.stringify({
      idempotencyKey: 'terminal:link-1:3',
      authorityKind: 'link',
      effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
      scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
      hostId: 'host-1', targetServerId: 'server-1', actorAuditId: 'audit-link-1',
      authorityGeneration: 3, expiryRevision: 2, commitRevision: 7,
      routeGeneration: 6, sequence: 9,
    }));
    expect(db.calls[2]?.sql).toContain('slo_anchor_at');
    const inserted = db.calls[2]!;
    const parsed = parseRemoteDesktopGuestOutboxRow({
      id: inserted.params[0] as string,
      idempotency_key: inserted.params[1] as string,
      host_id: inserted.params[2] as string,
      target_server_id: inserted.params[3] as string,
      target_route_id: inserted.params[4] as string,
      target_route_generation: inserted.params[5] as number,
      sequence: inserted.params[6] as number,
      effect_type: inserted.params[7] as string,
      payload: inserted.params[8] as string,
      created_at: inserted.params[9] as number,
      slo_anchor_at: inserted.params[10] as number,
      retain_until: inserted.params[11] as number,
      attempt_count: 1,
    });
    expect(parsed).toMatchObject({
      id: 'effect-1', effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
      actorAuditId: 'audit-link-1', commitRevision: 7, routeGeneration: 6,
    });
  });

  it('persists and reparses the exact password authority variant without link generations', async () => {
    const db = new RecordingDatabase();
    db.rows.push(null, { sequence: 10 }, { sequence: 10 });
    const event = {
      idempotencyKey: 'password-terminal:host-1:5:route-password-1:6',
      authorityKind: 'password' as const,
      effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
      scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
      hostId: 'host-1',
      targetServerId: 'server-1',
      actorAuditId: 'password-audit-1',
      sessionAuditId: 'password-session-1',
      passwordGeneration: 5,
      routeGeneration: 6,
    };
    await expect(appendGuestEffectTx(db.asDatabase(), {
      id: 'effect-password-1', targetRouteId: 'route-password-1', event,
      now: 1_000, sloAnchorAt: 1_000, retainUntil: 9_000,
    })).resolves.toBe(10);

    const inserted = db.calls[2]!;
    expect(inserted.params).toContain(JSON.stringify({ ...event, sequence: 10 }));
    const parsed = parseRemoteDesktopGuestOutboxRow({
      id: inserted.params[0] as string,
      idempotency_key: inserted.params[1] as string,
      host_id: inserted.params[2] as string,
      target_server_id: inserted.params[3] as string,
      target_route_id: inserted.params[4] as string,
      target_route_generation: inserted.params[5] as number,
      sequence: inserted.params[6] as number,
      effect_type: inserted.params[7] as string,
      payload: inserted.params[8] as string,
      created_at: inserted.params[9] as number,
      slo_anchor_at: inserted.params[10] as number,
      retain_until: inserted.params[11] as number,
      attempt_count: 1,
    });
    expect(parsed).toMatchObject({
      authorityKind: 'password',
      sessionAuditId: 'password-session-1',
      passwordGeneration: 5,
    });
    expect(parsed).not.toHaveProperty('authorityGeneration');
    expect(parsed).not.toHaveProperty('expiryRevision');
    expect(parsed).not.toHaveProperty('commitRevision');
  });

  it('rejects a producer event that is not the exact shared shape before touching storage', async () => {
    const db = new RecordingDatabase();
    await expect(appendGuestEffectTx(db.asDatabase(), {
      id: 'effect-invalid', targetRouteId: 'route-1',
      event: {
        idempotencyKey: 'terminal:invalid',
        authorityKind: 'link',
        effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
        scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
        hostId: 'host-1', targetServerId: 'server-1', actorAuditId: 'audit-1',
        authorityGeneration: 3, expiryRevision: 2, commitRevision: 7,
        routeGeneration: 6,
        deadlineAt: 5_000,
      },
      now: 1_000, sloAnchorAt: 1_000, retainUntil: 9_000,
    })).rejects.toThrow('invalid_outbox_keys');
    expect(db.calls).toHaveLength(0);
  });

  it('rejects missing and cross-kind authority fields before allocating a sequence', async () => {
    const common = {
      idempotencyKey: 'terminal:cross-kind',
      effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
      scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
      hostId: 'host-1', targetServerId: 'server-1', actorAuditId: 'audit-1',
      routeGeneration: 6,
    };
    const malformed = [
      {
        ...common,
        authorityGeneration: 3, expiryRevision: 2, commitRevision: 7,
      },
      {
        ...common,
        authorityKind: 'password', sessionAuditId: 'session-1', passwordGeneration: 5,
        authorityGeneration: 3, expiryRevision: 2, commitRevision: 7,
      },
      {
        ...common,
        authorityKind: 'link', authorityGeneration: 3, expiryRevision: 2, commitRevision: 7,
        sessionAuditId: 'session-1', passwordGeneration: 5,
      },
      {
        ...common,
        authorityKind: 'password', passwordGeneration: 5,
      },
    ];

    for (const event of malformed) {
      const db = new RecordingDatabase();
      await expect(appendGuestEffectTx(db.asDatabase(), {
        id: 'effect-cross-kind', targetRouteId: 'route-1', event: event as never,
        now: 1_000, sloAnchorAt: 1_000, retainUntil: 9_000,
      })).rejects.toThrow(/invalid_outbox_(authority|keys)/u);
      expect(db.calls).toHaveLength(0);
    }
  });
});
