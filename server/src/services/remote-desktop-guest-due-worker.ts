import { randomUUID } from 'node:crypto';
import {
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND,
  REMOTE_DESKTOP_OUTBOX_SCOPE,
  remoteDesktopExpiryIdempotencyKey,
  type RemoteDesktopOutboxEventWithoutSequence,
} from '../../../shared/remote-desktop-access.js';
import type { Database } from '../db/client.js';
import { appendGuestEffectTx } from './remote-desktop-guest-authority.js';

export const REMOTE_DESKTOP_GUEST_DUE_POLL_MS = 500;
export const REMOTE_DESKTOP_GUEST_DUE_CLAIM_MS = 5_000;
export const REMOTE_DESKTOP_GUEST_DUE_BATCH = 64;
export const REMOTE_DESKTOP_GUEST_EFFECT_RETENTION_MS = 2 * 60 * 60_000;

interface DatabaseClockRow { now_ms: number }
interface DueClaimRow {
  link_id: string;
  expiry_revision: number;
  expires_at: number;
}
interface ExpiredLinkRow {
  host_id: string;
  authority_generation: number;
  commit_revision: number;
}
interface ExpiredRouteRow {
  route_id: string;
  route_generation: number;
  actor_audit_id: string | null;
  execution_server_id: string | null;
}

export interface DueRunResult {
  databaseNow: number;
  claimed: number;
  expired: number;
  stale: number;
}

export async function readDatabaseClock(tx: Database): Promise<number> {
  const row = await tx.queryOne<DatabaseClockRow>(
    `SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
  );
  if (!row || !Number.isSafeInteger(row.now_ms) || row.now_ms < 0) {
    throw new Error('database_clock_unavailable');
  }
  return row.now_ms;
}

/**
 * Claim due records with PostgreSQL row locks and expire only the link revision
 * that is still authoritative. Link transition, terminal outbox and due
 * completion share one transaction; a crash before commit changes nothing.
 */
export async function processDueGuestLinks(input: {
  db: Database;
  workerId: string;
  limit?: number;
  claimMs?: number;
}): Promise<DueRunResult> {
  const limit = input.limit ?? REMOTE_DESKTOP_GUEST_DUE_BATCH;
  const claimMs = input.claimMs ?? REMOTE_DESKTOP_GUEST_DUE_CLAIM_MS;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 512) throw new Error('invalid_due_limit');
  if (!Number.isSafeInteger(claimMs) || claimMs <= 0) throw new Error('invalid_due_claim');

  return input.db.transaction(async (tx) => {
    const databaseNow = await readDatabaseClock(tx);
    const claimed = await tx.query<DueClaimRow>(
      `WITH candidates AS (
         SELECT link_id, expiry_revision
           FROM remote_desktop_guest_expiry_due
          WHERE expires_at <= $1
            AND (state = 'pending'
              OR (state = 'claimed' AND claim_expires_at <= $1))
          ORDER BY expires_at, link_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE remote_desktop_guest_expiry_due AS due
          SET state = 'claimed', claimed_by = $3, claim_expires_at = $4,
              updated_at = $1
         FROM candidates
        WHERE due.link_id = candidates.link_id
          AND due.expiry_revision = candidates.expiry_revision
       RETURNING due.link_id, due.expiry_revision, due.expires_at`,
      [databaseNow, limit, input.workerId, databaseNow + claimMs],
    );

    let expired = 0;
    let stale = 0;
    for (const due of claimed) {
      const link = await tx.queryOne<ExpiredLinkRow>(
        `UPDATE remote_desktop_guest_links
            SET state = 'expired', expired_at = $3, updated_at = $3,
                commit_revision = commit_revision + 1
          WHERE id = $1 AND expiry_revision = $2 AND state = 'active'
            AND expires_at IS NOT NULL AND expires_at <= $3
        RETURNING host_id, authority_generation, commit_revision`,
        [due.link_id, due.expiry_revision, databaseNow],
      );
      if (!link) {
        stale += 1;
        await tx.execute(
          `UPDATE remote_desktop_guest_expiry_due
              SET state = 'stale', claimed_by = NULL, claim_expires_at = NULL,
                  updated_at = $3
            WHERE link_id = $1 AND expiry_revision = $2 AND state = 'claimed'`,
          [due.link_id, due.expiry_revision, databaseNow],
        );
        continue;
      }

      const routes = await tx.query<ExpiredRouteRow>(
        `SELECT routes.route_id, routes.route_generation,
                routes.actor_audit_id, routes.execution_server_id
           FROM remote_desktop_guest_sessions AS sessions
           JOIN remote_desktop_host_routes AS routes
             ON routes.guest_session_id = sessions.id
          WHERE sessions.link_id = $1
            AND sessions.state IN ('admitting', 'active')
            AND routes.state <> 'closed'
          ORDER BY routes.updated_at DESC
          FOR UPDATE OF sessions, routes`,
        [due.link_id],
      );
      if (routes.length > 1) throw new Error('natural_expiry_multiple_live_routes');
      const route = routes[0];
      let event: RemoteDesktopOutboxEventWithoutSequence;
      let targetRouteId: string | null = null;
      if (route) {
        if (!route.actor_audit_id || !route.execution_server_id) {
          throw new Error('natural_expiry_route_contract_incomplete');
        }
        event = {
          idempotencyKey: remoteDesktopExpiryIdempotencyKey(
            due.link_id,
            due.expiry_revision,
            due.expires_at,
          ),
          effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
          authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
          scope: REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE,
          hostId: link.host_id,
          targetServerId: route.execution_server_id,
          actorAuditId: route.actor_audit_id,
          authorityGeneration: link.authority_generation,
          expiryRevision: due.expiry_revision,
          commitRevision: link.commit_revision,
          routeGeneration: route.route_generation,
        } satisfies RemoteDesktopOutboxEventWithoutSequence;
        targetRouteId = route.route_id;
      } else {
        event = {
          idempotencyKey: remoteDesktopExpiryIdempotencyKey(
            due.link_id,
            due.expiry_revision,
            due.expires_at,
          ),
          effect: REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL,
          authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
          scope: REMOTE_DESKTOP_OUTBOX_SCOPE.HOST,
          hostId: link.host_id,
          targetServerId: null,
          actorAuditId: `link:${due.link_id}`,
          authorityGeneration: link.authority_generation,
          expiryRevision: due.expiry_revision,
          commitRevision: link.commit_revision,
          routeGeneration: null,
        } satisfies RemoteDesktopOutboxEventWithoutSequence;
      }
      await appendGuestEffectTx(tx, {
        id: randomUUID(),
        targetRouteId,
        event,
        now: databaseNow,
        sloAnchorAt: due.expires_at,
        retainUntil: databaseNow + REMOTE_DESKTOP_GUEST_EFFECT_RETENTION_MS,
      });
      await tx.execute(
        `UPDATE remote_desktop_guest_expiry_due
            SET state = 'completed', claimed_by = NULL, claim_expires_at = NULL,
                updated_at = $3
          WHERE link_id = $1 AND expiry_revision = $2 AND state = 'claimed'`,
        [due.link_id, due.expiry_revision, databaseNow],
      );
      expired += 1;
    }
    return { databaseNow, claimed: claimed.length, expired, stale };
  });
}

export class RemoteDesktopGuestDueWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly db: Database,
    private readonly workerId: string,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) {
      await new Promise<void>((resolve) => { this.idleWaiters.push(resolve); });
    }
  }

  async runOnce(): Promise<DueRunResult> {
    return processDueGuestLinks({ db: this.db, workerId: this.workerId });
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      this.schedule(REMOTE_DESKTOP_GUEST_DUE_POLL_MS);
    }
  }
}
