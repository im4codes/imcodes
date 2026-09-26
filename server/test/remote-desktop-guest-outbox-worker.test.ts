import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  REMOTE_DESKTOP_GUEST_EFFECT_SLO_MS,
  REMOTE_DESKTOP_GUEST_OUTBOX_CLAIM_MS,
  REMOTE_DESKTOP_GUEST_OUTBOX_POLL_MS,
  RemoteDesktopGuestOutboxWorker,
  applyRemoteDesktopGuestDeadline,
  parseRemoteDesktopGuestOutboxRow,
  processRemoteDesktopGuestOutbox,
  sweepAcknowledgedGuestOutbox,
  type RemoteDesktopGuestOutboxDeliveryAdapter,
  type RemoteDesktopGuestOutboxEnvelope,
  type RemoteDesktopGuestOutboxWakeListener,
} from '../src/services/remote-desktop-guest-outbox-worker.js';

type MemoryRow = {
  id: string;
  idempotency_key: string;
  host_id: string;
  target_server_id: string | null;
  target_route_id: string | null;
  target_route_generation: number | null;
  sequence: number;
  effect_type: 'terminal' | 'downgrade' | 'deadline_update';
  payload: Record<string, unknown>;
  state: 'pending' | 'acknowledged';
  created_at: number;
  slo_anchor_at: number;
  available_at: number;
  acknowledged_at: number | null;
  retain_until: number;
  claimed_by: string | null;
  claim_expires_at: number | null;
  attempt_count: number;
  last_attempt_at: number | null;
  last_error: string | null;
  acknowledged_by: string | null;
};

function terminalRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const row: MemoryRow = {
    id: 'event-1', idempotency_key: 'expiry:link-1:2', host_id: 'host-1',
    target_server_id: 'server-1', target_route_id: 'route-1', target_route_generation: 3,
    sequence: 1, effect_type: 'terminal',
    payload: {},
    state: 'pending', created_at: 1_000, available_at: 1_000, acknowledged_at: null,
    slo_anchor_at: 1_000,
    retain_until: 20_000, claimed_by: null, claim_expires_at: null,
    attempt_count: 0, last_attempt_at: null, last_error: null, acknowledged_by: null,
    ...overrides,
  };
  if (!overrides.payload) {
    row.payload = {
      idempotencyKey: row.idempotency_key,
      sequence: row.sequence,
      authorityKind: 'link',
      effect: row.effect_type,
      scope: 'route',
      hostId: row.host_id,
      targetServerId: row.target_server_id,
      actorAuditId: 'audit-link-1',
      authorityGeneration: 4,
      expiryRevision: 2,
      commitRevision: 5,
      routeGeneration: row.target_route_generation,
      ...(row.effect_type === 'deadline_update' ? { deadlineAt: 4_000 } : {}),
    };
  }
  return row;
}

function passwordTerminalRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const row = terminalRow({
    id: 'password-event-1',
    idempotency_key: 'password-terminal:host-1:5:route-password-1:3',
    target_route_id: 'route-password-1',
    ...overrides,
  });
  if (!overrides.payload) {
    row.payload = {
      idempotencyKey: row.idempotency_key,
      sequence: row.sequence,
      authorityKind: 'password',
      effect: 'terminal',
      scope: 'route',
      hostId: row.host_id,
      targetServerId: row.target_server_id,
      actorAuditId: 'password-audit-1',
      sessionAuditId: 'password-session-1',
      passwordGeneration: 5,
      routeGeneration: row.target_route_generation,
    };
  }
  return row;
}

class MemoryOutboxDatabase {
  now = 1_500;
  rows = new Map<string, MemoryRow>();
  calls: string[] = [];
  failAckOnce = false;

  constructor(rows: MemoryRow[] = []) {
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
  }

  private normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const normalized = this.normalize(sql);
    this.calls.push(normalized);
    if (normalized.includes('clock_timestamp()')) return { now_ms: this.now } as T;
    if (normalized.startsWith('with candidate as')) {
      const [now, podId, claimExpiresAt, excludedIds] = params as [number, string, number, string[]];
      const candidate = Array.from(this.rows.values())
        .filter((row) => row.state === 'pending' && row.available_at <= now
          && !excludedIds.includes(row.id)
          && (row.claimed_by === null || (row.claim_expires_at ?? 0) <= now)
          && !Array.from(this.rows.values()).some((prior) => (
            prior.host_id === row.host_id && prior.sequence < row.sequence && prior.state === 'pending'
          )))
        .sort((a, b) => a.available_at - b.available_at
          || a.host_id.localeCompare(b.host_id) || a.sequence - b.sequence)[0];
      if (!candidate) return null;
      candidate.claimed_by = podId;
      candidate.claim_expires_at = claimExpiresAt;
      candidate.attempt_count += 1;
      candidate.last_attempt_at = now;
      candidate.last_error = null;
      return structuredClone(candidate) as T;
    }
    throw new Error(`Unhandled queryOne: ${normalized}`);
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const normalized = this.normalize(sql);
    this.calls.push(normalized);
    if (normalized.startsWith('update remote_desktop_guest_outbox')
      && normalized.includes('target_server_id = coalesce')) {
      const [id, podId, targetServerId, now] = params as [string, string, string | null, number];
      const row = this.rows.get(id);
      if (!row || row.state !== 'pending' || row.claimed_by !== podId
        || (row.claim_expires_at ?? 0) <= now
        || (row.target_server_id !== null && row.target_server_id !== targetServerId)) return { changes: 0 };
      row.target_server_id ??= targetServerId;
      return { changes: 1 };
    }
    if (normalized.startsWith('update remote_desktop_guest_outbox')
      && normalized.includes("state = 'acknowledged'")) {
      if (this.failAckOnce) {
        this.failAckOnce = false;
        throw new Error('ack_write_failed');
      }
      const [id, podId, targetServerId, now] = params as [string, string, string | null, number];
      const row = this.rows.get(id);
      if (!row || row.state !== 'pending' || row.claimed_by !== podId
        || (row.claim_expires_at ?? 0) <= now || row.target_server_id !== targetServerId) return { changes: 0 };
      row.state = 'acknowledged';
      row.acknowledged_at = now;
      row.acknowledged_by = podId;
      row.claimed_by = null;
      row.claim_expires_at = null;
      row.last_error = null;
      return { changes: 1 };
    }
    if (normalized.startsWith('update remote_desktop_guest_outbox')
      && normalized.includes('last_error = $4')) {
      const [id, podId, availableAt, errorCode] = params as [string, string, number, string];
      const row = this.rows.get(id);
      if (!row || row.state !== 'pending' || row.claimed_by !== podId) return { changes: 0 };
      row.claimed_by = null;
      row.claim_expires_at = null;
      if (errorCode !== 'not_owner') row.available_at = availableAt;
      row.last_error = errorCode;
      return { changes: 1 };
    }
    if (normalized.startsWith('delete from remote_desktop_guest_outbox')) {
      const [now, limit] = params as [number, number];
      const candidates = Array.from(this.rows.values())
        .filter((row) => row.state === 'acknowledged' && row.retain_until <= now)
        .sort((a, b) => a.retain_until - b.retain_until || a.id.localeCompare(b.id))
        .slice(0, limit);
      for (const row of candidates) this.rows.delete(row.id);
      return { changes: candidates.length };
    }
    throw new Error(`Unhandled execute: ${normalized}`);
  }

  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.rows);
    try {
      return await fn(this as unknown as Database);
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }

  asDatabase(): Database {
    return this as unknown as Database;
  }
}

class MemoryDeliveryAdapter implements RemoteDesktopGuestOutboxDeliveryAdapter {
  ownedServers = new Set(['server-1']);
  applied = new Set<string>();
  calls: RemoteDesktopGuestOutboxEnvelope[] = [];

  async ownsTarget(targetServerId: string): Promise<boolean> {
    return this.ownedServers.has(targetServerId);
  }

  async resolveHostTarget(): Promise<string | null> {
    return this.ownedServers.has('server-1') ? 'server-1' : null;
  }

  async deliver(
    _targetServerId: string,
    event: RemoteDesktopGuestOutboxEnvelope,
  ): Promise<{ status: 'applied' } | { status: 'duplicate' }> {
    this.calls.push(event);
    if (this.applied.has(event.idempotencyKey)) return { status: 'duplicate' };
    this.applied.add(event.idempotencyKey);
    return { status: 'applied' };
  }
}

describe('remote desktop guest typed outbox', () => {
  afterEach(() => vi.useRealTimers());

  it('parses all three typed effects and enforces absolute minimum deadlines', () => {
    const terminal = parseRemoteDesktopGuestOutboxRow(terminalRow({ attempt_count: 1 }));
    const initialRoute = parseRemoteDesktopGuestOutboxRow(terminalRow({
      target_route_generation: 0, attempt_count: 1,
    }));
    const downgrade = parseRemoteDesktopGuestOutboxRow(terminalRow({
      id: 'event-2', idempotency_key: 'down:1', sequence: 2, effect_type: 'downgrade',
      attempt_count: 1,
    }));
    const deadline = parseRemoteDesktopGuestOutboxRow(terminalRow({
      id: 'event-3', idempotency_key: 'deadline:1', sequence: 3, effect_type: 'deadline_update',
      attempt_count: 1,
    })) as RemoteDesktopGuestOutboxEnvelope<'deadline_update'> & { deadlineAt: number };
    expect(terminal.effect).toBe('terminal');
    expect(initialRoute.routeGeneration).toBe(0);
    expect(downgrade.effect).toBe('downgrade');
    expect(applyRemoteDesktopGuestDeadline(6_000, deadline)).toBe(4_000);
    expect(applyRemoteDesktopGuestDeadline(3_000, deadline)).toBe(3_000);
  });

  it('accepts only the password terminal discriminant and rejects fabricated link generations', () => {
    const password = parseRemoteDesktopGuestOutboxRow(passwordTerminalRow({ attempt_count: 1 }));
    expect(password).toMatchObject({
      authorityKind: 'password',
      actorAuditId: 'password-audit-1',
      sessionAuditId: 'password-session-1',
      passwordGeneration: 5,
    });
    expect(password).not.toHaveProperty('authorityGeneration');
    expect(password).not.toHaveProperty('expiryRevision');

    const withFakeLinkGeneration = passwordTerminalRow({ attempt_count: 1 });
    withFakeLinkGeneration.payload = {
      ...withFakeLinkGeneration.payload,
      authorityGeneration: 5,
      expiryRevision: 1,
    };
    expect(() => parseRemoteDesktopGuestOutboxRow(withFakeLinkGeneration))
      .toThrow('invalid_outbox_keys');

    const downgrade = passwordTerminalRow({ attempt_count: 1, effect_type: 'downgrade' });
    downgrade.payload = { ...downgrade.payload, effect: 'downgrade' };
    expect(() => parseRemoteDesktopGuestOutboxRow(downgrade))
      .toThrow('invalid_outbox_payload');
  });

  it('rejects extra keys, deeply nested secrets and depth exhaustion', () => {
    const valid = terminalRow({ attempt_count: 1 });
    expect(() => parseRemoteDesktopGuestOutboxRow({
      ...valid,
      payload: { ...valid.payload, reason: 'revoked' },
    })).toThrow('invalid_outbox_keys');

    let nested: Record<string, unknown> = { rawToken: 'secret' };
    for (let depth = 0; depth < 10; depth += 1) nested = { child: nested };
    expect(() => parseRemoteDesktopGuestOutboxRow({
      ...valid,
      payload: { ...valid.payload, nested },
    })).toThrow('invalid_outbox_payload');

    let exhausted: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) exhausted = { child: exhausted };
    expect(() => parseRemoteDesktopGuestOutboxRow({
      ...valid,
      payload: exhausted,
    })).toThrow('invalid_outbox_payload');
  });

  it('rejects storage projections that disagree with shared generations or revisions', () => {
    const valid = terminalRow({ attempt_count: 1 });
    expect(() => parseRemoteDesktopGuestOutboxRow({
      ...valid,
      target_route_generation: valid.target_route_generation + 1,
    })).toThrow('outbox_projection_mismatch');
    expect(() => parseRemoteDesktopGuestOutboxRow({
      ...valid,
      payload: { ...valid.payload, expiryRevision: 0 },
    })).toThrow('invalid_outbox_payload');
    expect(() => parseRemoteDesktopGuestOutboxRow({
      ...valid,
      payload: { ...valid.payload, commitRevision: 0 },
    })).toThrow('invalid_outbox_payload');
  });

  it('leaves a wrong-pod event pending and never acknowledges observation', async () => {
    const db = new MemoryOutboxDatabase([terminalRow()]);
    const adapter = new MemoryDeliveryAdapter();
    adapter.ownedServers.clear();
    const result = await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-wrong', adapter,
    });
    expect(result).toMatchObject({ claimed: 1, notOwner: 1, acknowledged: 0 });
    expect(db.rows.get('event-1')).toMatchObject({
      state: 'pending', acknowledged_by: null, claimed_by: null,
      available_at: 1_000, last_error: 'not_owner',
    });
    expect(adapter.calls).toHaveLength(0);
  });

  it('resolves and acknowledges a host-scoped terminal event without fake route projections', async () => {
    const hostEvent = terminalRow({
      id: 'host-expiry', idempotency_key: 'link-1:2:1000',
      target_server_id: null, target_route_id: null, target_route_generation: null,
      payload: {
        idempotencyKey: 'link-1:2:1000', sequence: 1, effect: 'terminal', scope: 'host',
        authorityKind: 'link',
        hostId: 'host-1', targetServerId: null, actorAuditId: 'link:link-1',
        authorityGeneration: 4, expiryRevision: 2, commitRevision: 5,
        routeGeneration: null,
      },
    });
    const db = new MemoryOutboxDatabase([hostEvent]);
    const adapter = new MemoryDeliveryAdapter();
    await expect(processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-a', adapter,
    })).resolves.toMatchObject({ applied: 1, acknowledged: 1, notOwner: 0 });
    expect(adapter.calls[0]).toMatchObject({ scope: 'host', targetServerId: null });
    expect(db.rows.get('host-expiry')).toMatchObject({
      state: 'acknowledged', target_server_id: null, target_route_generation: null,
    });
  });

  it('reclaims an expired claim after restart but preserves per-host sequence order', async () => {
    const first = terminalRow({
      claimed_by: 'dead-pod', claim_expires_at: 2_000,
    });
    const second = terminalRow({
      id: 'event-2', idempotency_key: 'terminal:2', sequence: 2,
      target_route_id: 'route-2',
    });
    const db = new MemoryOutboxDatabase([first, second]);
    const adapter = new MemoryDeliveryAdapter();
    db.now = 1_900;
    expect((await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-new', adapter,
    })).claimed).toBe(0);
    db.now = 2_001;
    const recovered = await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-new', adapter,
    });
    expect(recovered).toMatchObject({ claimed: 2, applied: 2, acknowledged: 2 });
    expect(adapter.calls.map((event) => event.sequence)).toEqual([1, 2]);
    expect(db.calls.some((sql) => sql.includes('for update of outbox skip locked'))).toBe(true);
    expect(db.calls.some((sql) => sql.includes('prior.sequence < outbox.sequence'))).toBe(true);
  });

  it('redelivers idempotently after acknowledgement rollback/failure', async () => {
    const db = new MemoryOutboxDatabase([terminalRow()]);
    const adapter = new MemoryDeliveryAdapter();
    db.failAckOnce = true;
    const first = await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-a', adapter,
    });
    expect(first).toMatchObject({ applied: 1, acknowledged: 0, failed: 1 });
    expect(db.rows.get('event-1')?.state).toBe('pending');
    db.now += 500;
    const retry = await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-a', adapter,
    });
    expect(retry).toMatchObject({ duplicates: 1, acknowledged: 1 });
    expect(adapter.calls).toHaveLength(2);
    expect(db.rows.get('event-1')).toMatchObject({
      state: 'acknowledged', acknowledged_by: 'pod-a', attempt_count: 2,
    });
  });

  it('backs off a failed delivery and retries after the database-clock deadline', async () => {
    const db = new MemoryOutboxDatabase([terminalRow()]);
    const adapter = new MemoryDeliveryAdapter();
    vi.spyOn(adapter, 'deliver').mockRejectedValueOnce(new Error('bridge_send_failed'));
    expect(await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-a', adapter,
    })).toMatchObject({ failed: 1, acknowledged: 0 });
    expect(db.rows.get('event-1')).toMatchObject({
      state: 'pending', available_at: 1_750, last_error: 'delivery_failed',
    });

    db.now = 1_749;
    expect((await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-a', adapter,
    })).claimed).toBe(0);
    db.now = 1_750;
    expect(await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-a', adapter,
    })).toMatchObject({ applied: 1, acknowledged: 1 });
  });

  it('measures explicit and natural-expiry effects against the two-second SLO', async () => {
    const atBoundary = terminalRow({ created_at: 1_000, slo_anchor_at: 1_000 });
    const db = new MemoryOutboxDatabase([atBoundary]);
    db.now = 1_000 + REMOTE_DESKTOP_GUEST_EFFECT_SLO_MS;
    const adapter = new MemoryDeliveryAdapter();
    expect((await processRemoteDesktopGuestOutbox({
      db: db.asDatabase(), podId: 'pod-a', adapter,
    })).sloViolations).toBe(0);

    const expiry = terminalRow({
      id: 'expiry-late', idempotency_key: 'expiry:late',
      created_at: 5_100, slo_anchor_at: 5_000, available_at: 5_000,
    });
    const lateDb = new MemoryOutboxDatabase([expiry]);
    lateDb.now = 5_000 + REMOTE_DESKTOP_GUEST_EFFECT_SLO_MS + 1;
    const violation = vi.fn();
    expect((await processRemoteDesktopGuestOutbox({
      db: lateDb.asDatabase(), podId: 'pod-a', adapter: new MemoryDeliveryAdapter(),
      onSloViolation: violation,
    })).sloViolations).toBe(1);
    expect(violation).toHaveBeenCalledWith(expect.objectContaining({ id: 'expiry-late' }), 2_001);
  });

  it('retains pending events and deletes only acknowledged rows after retainUntil', async () => {
    const pending = terminalRow({ retain_until: 1_000 });
    const acknowledged = terminalRow({
      id: 'acked', idempotency_key: 'acked:1', state: 'acknowledged',
      acknowledged_at: 900, acknowledged_by: 'pod-a', retain_until: 1_000,
    });
    const db = new MemoryOutboxDatabase([pending, acknowledged]);
    db.now = 1_500;
    await expect(sweepAcknowledgedGuestOutbox({ db: db.asDatabase() })).resolves.toBe(1);
    expect(db.rows.has('event-1')).toBe(true);
    expect(db.rows.has('acked')).toBe(false);
  });

  it('uses listener wakeups as acceleration but still polls after a lost wakeup', async () => {
    vi.useFakeTimers();
    const db = new MemoryOutboxDatabase();
    const adapter = new MemoryDeliveryAdapter();
    let wake: (() => void) | null = null;
    const listener: RemoteDesktopGuestOutboxWakeListener = {
      start: vi.fn(async (onWake) => { wake = onWake; }),
      stop: vi.fn(async () => undefined),
    };
    const worker = new RemoteDesktopGuestOutboxWorker(
      db.asDatabase(), 'pod-a', adapter, listener,
    );
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    db.rows.set('event-1', terminalRow());
    wake?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(db.rows.get('event-1')?.state).toBe('acknowledged');

    db.rows.set('event-2', terminalRow({
      id: 'event-2', idempotency_key: 'lost-wakeup', sequence: 2,
      available_at: db.now,
    }));
    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_GUEST_OUTBOX_POLL_MS);
    expect(db.rows.get('event-2')?.state).toBe('acknowledged');
    await worker.stop();
    expect(listener.stop).toHaveBeenCalledOnce();
  });

  it('adds durable lease/ack fields and transactional NOTIFY producer wakeup', () => {
    const migration = readFileSync(new URL(
      '../src/db/migrations/075_remote_desktop_guest_outbox_delivery.sql', import.meta.url,
    ), 'utf8');
    const producer = readFileSync(new URL(
      '../src/services/remote-desktop-guest-authority.ts', import.meta.url,
    ), 'utf8');
    expect(migration).toContain('claim_expires_at BIGINT');
    expect(migration).toContain('acknowledged_by TEXT');
    expect(migration).toContain('attempt_count INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('slo_anchor_at BIGINT');
    expect(migration).toContain('remote_desktop_guest_outbox_shared_target_check');
    expect(migration).toContain('commit_revision BIGINT NOT NULL DEFAULT 1');
    expect(producer).toContain("tx.execute('SELECT pg_notify($1, $2)'");
    expect(REMOTE_DESKTOP_GUEST_OUTBOX_CLAIM_MS).toBeGreaterThan(REMOTE_DESKTOP_GUEST_OUTBOX_POLL_MS);
  });
});
