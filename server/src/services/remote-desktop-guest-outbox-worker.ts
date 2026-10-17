import { performance } from 'node:perf_hooks';
import pg from 'pg';
import {
  resolveRemoteDesktopDeadline,
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND,
  REMOTE_DESKTOP_OUTBOX_EFFECT,
  REMOTE_DESKTOP_OUTBOX_SCOPE,
  type RemoteDesktopOutboxEvent,
  type RemoteDesktopOutboxEffect,
} from '../../../shared/remote-desktop-access.js';
import type { Database } from '../db/client.js';
import {
  REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL,
  parseRemoteDesktopOutboxEvent,
} from './remote-desktop-guest-authority.js';
import {
  readDatabaseClock,
  type RemoteDesktopGuestDueWorker,
} from './remote-desktop-guest-due-worker.js';
import { closeRouteTx } from './remote-desktop-management-privacy.js';

export const REMOTE_DESKTOP_GUEST_OUTBOX_POLL_MS = 500;
export const REMOTE_DESKTOP_GUEST_OUTBOX_CLAIM_MS = 5_000;
export const REMOTE_DESKTOP_GUEST_OUTBOX_RETRY_BASE_MS = 250;
export const REMOTE_DESKTOP_GUEST_OUTBOX_RETRY_MAX_MS = 5_000;
export const REMOTE_DESKTOP_GUEST_OUTBOX_BATCH = 64;
export const REMOTE_DESKTOP_GUEST_EFFECT_SLO_MS = 2_000;

interface OutboxRow {
  id: string;
  idempotency_key: string;
  host_id: string;
  target_server_id: string | null;
  target_route_id: string | null;
  target_route_generation: number | null;
  sequence: number;
  effect_type: string;
  payload: unknown;
  created_at: number;
  slo_anchor_at: number;
  retain_until: number;
  attempt_count: number;
}

export type RemoteDesktopGuestOutboxEnvelope<
  T extends RemoteDesktopOutboxEffect = RemoteDesktopOutboxEffect,
> = RemoteDesktopOutboxEvent & {
  id: string;
  targetRouteId: string | null;
  effect: T;
  createdAt: number;
  sloAnchorAt: number;
  retainUntil: number;
  attempt: number;
};

export type RemoteDesktopGuestDeliveryResult =
  | { status: 'applied' }
  | { status: 'duplicate' }
  | { status: 'not_owner' };

/**
 * Bridge-facing seam. `ownsTarget` re-checks the shared event's explicit target
 * immediately before delivery. Implementations deduplicate by
 * `event.idempotencyKey`, enforce `targetRouteId`/`routeGeneration`, terminate
 * or downgrade only matching authority, and apply deadline updates as
 * `min(currentDeadline, event.deadlineAt)` (the helper below is canonical).
 */
export interface RemoteDesktopGuestOutboxDeliveryAdapter {
  /** Resolve a host-scoped event only to an endpoint currently owned by this
   * pod. Returning null leaves the event pending for reconnect/another pod. */
  resolveHostTarget?(
    event: RemoteDesktopGuestOutboxEnvelope,
  ): Promise<string | null>;
  ownsTarget(targetServerId: string, event: RemoteDesktopGuestOutboxEnvelope): Promise<boolean>;
  deliver(
    targetServerId: string,
    event: RemoteDesktopGuestOutboxEnvelope,
  ): Promise<RemoteDesktopGuestDeliveryResult>;
}

/** Narrow bridge seam used by the production adapter. It deliberately exposes
 * no socket/capability material to the durable worker. */
export interface RemoteDesktopGuestOutboxExecutionTarget {
  isAvailable(): boolean;
  apply(
    event: RemoteDesktopGuestOutboxEnvelope,
    routeId: string,
    routeGeneration: number,
    authority: RemoteDesktopGuestOutboxAuthorityMatch,
  ): Promise<RemoteDesktopGuestDeliveryResult> | RemoteDesktopGuestDeliveryResult;
}

export type RemoteDesktopGuestOutboxAuthorityMatch =
  | {
    authorityKind: typeof REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK;
    actorAuditId: string;
    authorityGeneration: number;
    expiryRevision: number;
    commitRevision: number;
  }
  | {
    authorityKind: typeof REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD;
    actorAuditId: string;
    sessionAuditId: string;
    passwordGeneration: number;
  };

interface RouteAuthorityRow {
  route_state: 'admitting' | 'active' | 'closed';
  session_state: 'admitting' | 'active' | 'closed';
  session_id: string;
  session_actor_kind: string;
  actor_audit_id: string | null;
  execution_server_id: string | null;
  session_authority_generation: number;
  session_expiry_revision: number | null;
  session_password_generation: number | null;
  password_credential_generation: number | null;
  link_id: string | null;
  link_state: 'active' | 'revoked' | 'expired' | null;
  link_access_mode: 'view' | 'control' | null;
  link_authority_generation: number | null;
  link_expiry_revision: number | null;
  link_commit_revision: number | null;
  link_expires_at: number | null;
}

interface HostAuthorityRow {
  link_id: string;
  state: 'active' | 'revoked' | 'expired';
  authority_generation: number;
  expiry_revision: number;
  commit_revision: number;
}

interface LiveHostRouteRow {
  route_id: string;
  route_generation: number;
  execution_server_id: string | null;
  actor_audit_id: string | null;
  authority_generation: number;
  expiry_revision: number | null;
}

function routeAuthorityMatches(
  row: RouteAuthorityRow,
  event: RemoteDesktopGuestOutboxEnvelope,
): RemoteDesktopGuestOutboxAuthorityMatch | null {
  if (event.authorityKind === REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD) {
    if (event.effect !== REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL
      || row.link_id !== null
      || row.session_actor_kind !== REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD
      || row.actor_audit_id !== event.actorAuditId
      || row.session_id !== event.sessionAuditId
      || row.session_password_generation === null
      || row.password_credential_generation === null
      || row.session_password_generation >= event.passwordGeneration
      || row.password_credential_generation < event.passwordGeneration) return null;
    return {
      authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD,
      actorAuditId: event.actorAuditId,
      sessionAuditId: event.sessionAuditId,
      passwordGeneration: event.passwordGeneration,
    };
  }
  if (!row.link_id
    || row.actor_audit_id !== event.actorAuditId
    || row.link_authority_generation === null
    || row.link_expiry_revision === null
    || row.link_commit_revision === null
    || row.link_authority_generation < event.authorityGeneration
    || row.link_expiry_revision < event.expiryRevision
    || row.link_commit_revision < event.commitRevision) return null;

  if (event.effect === REMOTE_DESKTOP_OUTBOX_EFFECT.DOWNGRADE) {
    if (row.link_access_mode !== 'view'
      || row.session_authority_generation >= event.authorityGeneration) return null;
  }
  if (event.effect === REMOTE_DESKTOP_OUTBOX_EFFECT.DEADLINE_UPDATE
    && (event.deadlineAt === undefined
      || row.link_expires_at === null
      || row.link_expires_at > event.deadlineAt
      || row.session_authority_generation !== event.authorityGeneration
      || row.session_expiry_revision === null
      || row.session_expiry_revision >= event.expiryRevision)) return null;
  if (event.effect === REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL
    && (row.session_authority_generation > event.authorityGeneration
      || row.session_expiry_revision === null
      || row.session_expiry_revision > event.expiryRevision)) return null;
  return {
    authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
    actorAuditId: event.actorAuditId,
    authorityGeneration: event.authorityGeneration,
    expiryRevision: event.expiryRevision,
    commitRevision: event.commitRevision,
  };
}

function constrainDeadlineToAuthoritativeDatabaseExpiry(
  row: RouteAuthorityRow,
  event: RemoteDesktopGuestOutboxEnvelope,
): RemoteDesktopGuestOutboxEnvelope {
  if (event.effect !== REMOTE_DESKTOP_OUTBOX_EFFECT.DEADLINE_UPDATE
    || event.deadlineAt === undefined
    || row.link_expires_at === null) return event;
  const deadlineAt = resolveRemoteDesktopDeadline(event.deadlineAt, row.link_expires_at);
  return deadlineAt === event.deadlineAt ? event : { ...event, deadlineAt };
}

/**
 * PostgreSQL-backed production delivery adapter. The outbox is a committed
 * authority fact, but it is not itself proof that this process owns the live
 * execution endpoint. Every attempt re-resolves canonical-host ownership and
 * the exact durable route/session authority before touching a bridge.
 */
export class PostgresRemoteDesktopGuestOutboxDeliveryAdapter
implements RemoteDesktopGuestOutboxDeliveryAdapter {
  constructor(
    private readonly db: Database,
    private readonly resolveTarget: (
      targetServerId: string,
    ) => RemoteDesktopGuestOutboxExecutionTarget | null,
  ) {}

  async resolveHostTarget(event: RemoteDesktopGuestOutboxEnvelope): Promise<string | null> {
    if (event.scope !== REMOTE_DESKTOP_OUTBOX_SCOPE.HOST) return null;
    const authority = await this.readHostAuthority(event);
    if (!authority) return null;
    const liveRoutes = await this.readLiveHostRoutes(authority.link_id, event.hostId);
    if (liveRoutes.length > 0) {
      const serverIds = [...new Set(liveRoutes.map((row) => row.execution_server_id))];
      if (serverIds.some((serverId) => serverId === null)) return null;
      for (const serverId of serverIds as string[]) {
        if (this.resolveTarget(serverId)?.isAvailable()) return serverId;
      }
      return null;
    }
    const endpoints = await this.db.query<{ server_id: string }>(
      `SELECT server_id FROM remote_desktop_host_endpoints
        WHERE host_id = $1 ORDER BY endpoint_role = 'controlled' DESC, server_id`,
      [event.hostId],
    );
    for (const endpoint of endpoints) {
      if (this.resolveTarget(endpoint.server_id)?.isAvailable()) return endpoint.server_id;
    }
    return null;
  }

  async ownsTarget(
    targetServerId: string,
    event: RemoteDesktopGuestOutboxEnvelope,
  ): Promise<boolean> {
    const target = this.resolveTarget(targetServerId);
    if (!target?.isAvailable()) return false;
    if (event.scope === REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE
      && event.targetServerId !== targetServerId) return false;
    const endpoint = await this.db.queryOne<{ host_id: string }>(
      `SELECT host_id FROM remote_desktop_host_endpoints
        WHERE server_id = $1 AND host_id = $2`,
      [targetServerId, event.hostId],
    );
    return endpoint?.host_id === event.hostId;
  }

  async deliver(
    targetServerId: string,
    event: RemoteDesktopGuestOutboxEnvelope,
  ): Promise<RemoteDesktopGuestDeliveryResult> {
    const target = this.resolveTarget(targetServerId);
    if (!target?.isAvailable()) return { status: 'not_owner' };
    if (event.scope === REMOTE_DESKTOP_OUTBOX_SCOPE.HOST) {
      return this.deliverHostTerminal(targetServerId, target, event);
    }
    if (!event.targetRouteId) return { status: 'not_owner' };
    const row = await this.readRouteAuthority(event, event.targetRouteId, event.routeGeneration);
    const authority = row ? routeAuthorityMatches(row, event) : null;
    if (!row || !authority) return { status: 'not_owner' };
    if (row.route_state === 'closed' || row.session_state === 'closed') {
      return { status: 'duplicate' };
    }
    // A later shortening may have committed while this older deadline event
    // was delayed. Delivery must never temporarily widen the route beyond the
    // current database expiry while the newer event waits behind it.
    const deliveryEvent = constrainDeadlineToAuthoritativeDatabaseExpiry(row, event);
    const delivered = await target.apply(
      deliveryEvent,
      event.targetRouteId,
      event.routeGeneration,
      authority,
    );
    if (delivered.status !== 'applied' || event.effect !== REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL) {
      return delivered;
    }
    await this.closeDeliveredRoute(event, event.targetRouteId, event.routeGeneration);
    return delivered;
  }

  private async readRouteAuthority(
    event: RemoteDesktopGuestOutboxEnvelope,
    routeId: string,
    routeGeneration: number,
  ): Promise<RouteAuthorityRow | null> {
    return this.db.queryOne<RouteAuthorityRow>(
      `SELECT routes.state AS route_state, sessions.state AS session_state,
              sessions.id AS session_id, sessions.actor_kind AS session_actor_kind,
              routes.actor_audit_id, routes.execution_server_id,
              sessions.authority_generation AS session_authority_generation,
              sessions.expiry_revision AS session_expiry_revision,
              sessions.password_generation AS session_password_generation,
              passwords.generation AS password_credential_generation,
              links.id AS link_id, links.state AS link_state,
              links.access_mode AS link_access_mode,
              links.authority_generation AS link_authority_generation,
              links.expiry_revision AS link_expiry_revision,
              links.commit_revision AS link_commit_revision,
              links.expires_at AS link_expires_at
         FROM remote_desktop_host_routes AS routes
         JOIN remote_desktop_guest_sessions AS sessions
           ON sessions.id = routes.guest_session_id
         LEFT JOIN remote_desktop_guest_links AS links ON links.id = sessions.link_id
         LEFT JOIN remote_desktop_unattended_passwords AS passwords
           ON passwords.host_id = sessions.host_id
        WHERE routes.route_id = $1 AND routes.route_generation = $2
          AND routes.host_id = $3 AND routes.execution_server_id = $4`,
      [routeId, routeGeneration, event.hostId, event.targetServerId],
    );
  }

  private async readHostAuthority(
    event: RemoteDesktopGuestOutboxEnvelope,
  ): Promise<HostAuthorityRow | null> {
    if (event.authorityKind !== REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK) return null;
    const row = await this.db.queryOne<HostAuthorityRow>(
      `SELECT id AS link_id, state, authority_generation, expiry_revision, commit_revision
         FROM remote_desktop_guest_links
        WHERE host_id = $1 AND ('link:' || id) = $2
          AND authority_generation = $3 AND expiry_revision = $4
          AND commit_revision = $5 AND state = 'expired'`,
      [
        event.hostId,
        event.actorAuditId,
        event.authorityGeneration,
        event.expiryRevision,
        event.commitRevision,
      ],
    );
    return row?.state === 'expired' ? row : null;
  }

  private readLiveHostRoutes(linkId: string, hostId: string): Promise<LiveHostRouteRow[]> {
    return this.db.query<LiveHostRouteRow>(
      `SELECT routes.route_id, routes.route_generation,
              routes.execution_server_id, routes.actor_audit_id,
              sessions.authority_generation, sessions.expiry_revision
         FROM remote_desktop_host_routes AS routes
         JOIN remote_desktop_guest_sessions AS sessions
           ON sessions.id = routes.guest_session_id
        WHERE sessions.link_id = $1 AND routes.host_id = $2
          AND routes.state <> 'closed' AND sessions.state <> 'closed'
        ORDER BY routes.route_id, routes.route_generation`,
      [linkId, hostId],
    );
  }

  private async deliverHostTerminal(
    targetServerId: string,
    target: RemoteDesktopGuestOutboxExecutionTarget,
    event: RemoteDesktopGuestOutboxEnvelope,
  ): Promise<RemoteDesktopGuestDeliveryResult> {
    if (event.authorityKind !== REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK) {
      return { status: 'not_owner' };
    }
    const authority = await this.readHostAuthority(event);
    if (!authority) return { status: 'not_owner' };
    const routes = await this.readLiveHostRoutes(authority.link_id, event.hostId);
    if (routes.length === 0) return { status: 'duplicate' };
    if (routes.some((row) => row.execution_server_id !== targetServerId
      || row.actor_audit_id !== event.actorAuditId
      || row.authority_generation > event.authorityGeneration
      || row.expiry_revision === null
      || row.expiry_revision > event.expiryRevision)) return { status: 'not_owner' };

    for (const route of routes) {
      const delivered = await target.apply(event, route.route_id, route.route_generation, {
        authorityKind: REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK,
        actorAuditId: event.actorAuditId,
        authorityGeneration: event.authorityGeneration,
        expiryRevision: event.expiryRevision,
        commitRevision: event.commitRevision,
      });
      if (delivered.status === 'not_owner') return delivered;
      if (delivered.status === 'applied') {
        await this.closeDeliveredRoute(event, route.route_id, route.route_generation);
      }
    }
    return { status: 'applied' };
  }

  private async closeDeliveredRoute(
    event: RemoteDesktopGuestOutboxEnvelope,
    routeId: string,
    routeGeneration: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = await readDatabaseClock(tx);
      await closeRouteTx(tx, { hostId: event.hostId, routeId, routeGeneration, now });
      await tx.execute(
        `UPDATE remote_desktop_guest_sessions
            SET state = 'closed', closed_at = COALESCE(closed_at, $3), updated_at = $3
          WHERE route_id = $1 AND route_generation = $2 AND state <> 'closed'`,
        [routeId, routeGeneration, now],
      );
    });
  }
}

/** On daemon reconnect no process-local capability survives. Close every old
 * durable endpoint route before the bridge becomes remote-desktop-ready; a
 * later start must establish and revalidate fresh authority. */
export async function reconcileRemoteDesktopEndpointOnReconnect(
  db: Database,
  targetServerId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const now = await readDatabaseClock(tx);
    const rows = await tx.query<{ host_id: string; route_id: string; route_generation: number }>(
      `SELECT host_id, route_id, route_generation
         FROM remote_desktop_host_routes
        WHERE execution_server_id = $1 AND state <> 'closed'
        ORDER BY host_id, route_id, route_generation
        FOR UPDATE`,
      [targetServerId],
    );
    for (const row of rows) {
      await closeRouteTx(tx, {
        hostId: row.host_id,
        routeId: row.route_id,
        routeGeneration: row.route_generation,
        now,
      });
      await tx.execute(
        `UPDATE remote_desktop_guest_sessions
            SET state = 'closed', closed_at = COALESCE(closed_at, $3), updated_at = $3
          WHERE route_id = $1 AND route_generation = $2 AND state <> 'closed'`,
        [row.route_id, row.route_generation, now],
      );
    }
    return rows.length;
  });
}

export interface RemoteDesktopGuestOutboxWakeListener {
  start(onWake: () => void, onError: (error: unknown) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface OutboxRunResult {
  claimed: number;
  applied: number;
  duplicates: number;
  notOwner: number;
  failed: number;
  acknowledged: number;
  sloViolations: number;
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseRemoteDesktopGuestOutboxRow(row: OutboxRow): RemoteDesktopGuestOutboxEnvelope {
  const event = parseRemoteDesktopOutboxEvent(row.payload);
  if (!row.id || !row.idempotency_key || !row.host_id
    || !isPositiveInteger(row.sequence) || !isSafeTimestamp(row.created_at)
    || !isSafeTimestamp(row.slo_anchor_at) || !isSafeTimestamp(row.retain_until)
    || row.slo_anchor_at > row.created_at
    || !isPositiveInteger(row.attempt_count)
    || (row.target_server_id !== null && row.target_server_id.length === 0)
    || (row.target_route_id !== null && row.target_route_id.length === 0)
    || (row.target_route_generation !== null && !isNonNegativeInteger(row.target_route_generation))) {
    throw new Error('invalid_outbox_row');
  }
  if (
    row.idempotency_key !== event.idempotencyKey
    || row.host_id !== event.hostId
    || row.target_server_id !== event.targetServerId
    || row.target_route_generation !== event.routeGeneration
    || row.sequence !== event.sequence
    || row.effect_type !== event.effect
  ) throw new Error('outbox_projection_mismatch');
  return {
    ...event,
    id: row.id,
    targetRouteId: row.target_route_id,
    createdAt: row.created_at,
    sloAnchorAt: row.slo_anchor_at,
    retainUntil: row.retain_until,
    attempt: row.attempt_count,
  };
}

export function applyRemoteDesktopGuestDeadline(
  currentDeadlineAt: number,
  effect: RemoteDesktopGuestOutboxEnvelope<'deadline_update'> & { deadlineAt: number },
): number {
  if (!isSafeTimestamp(currentDeadlineAt)) throw new Error('invalid_current_deadline');
  return resolveRemoteDesktopDeadline(currentDeadlineAt, effect.deadlineAt);
}

function retryDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(10, attempt - 1));
  return Math.min(
    REMOTE_DESKTOP_GUEST_OUTBOX_RETRY_MAX_MS,
    REMOTE_DESKTOP_GUEST_OUTBOX_RETRY_BASE_MS * (2 ** exponent),
  );
}

async function claimNextOutboxRow(input: {
  db: Database;
  podId: string;
  claimMs: number;
  excludedIds: readonly string[];
}): Promise<{ databaseNow: number; row: OutboxRow } | null> {
  return input.db.transaction(async (tx) => {
    const databaseNow = await readDatabaseClock(tx);
    const row = await tx.queryOne<OutboxRow>(
      `WITH candidate AS (
         SELECT outbox.id
           FROM remote_desktop_guest_outbox AS outbox
          WHERE outbox.state = 'pending'
            AND outbox.available_at <= $1
            AND (outbox.claimed_by IS NULL OR outbox.claim_expires_at <= $1)
            AND NOT (outbox.id = ANY($4::text[]))
            AND NOT EXISTS (
              SELECT 1 FROM remote_desktop_guest_outbox AS prior
               WHERE prior.host_id = outbox.host_id
                 AND prior.sequence < outbox.sequence
                 AND prior.state = 'pending'
            )
          ORDER BY outbox.available_at, outbox.host_id, outbox.sequence
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT 1
       )
       UPDATE remote_desktop_guest_outbox AS outbox
          SET claimed_by = $2, claim_expires_at = $3,
              attempt_count = outbox.attempt_count + 1,
              last_attempt_at = $1, last_error = NULL
         FROM candidate
        WHERE outbox.id = candidate.id
       RETURNING outbox.id, outbox.idempotency_key, outbox.host_id,
                 outbox.target_server_id, outbox.target_route_id,
                 outbox.target_route_generation, outbox.sequence,
                 outbox.effect_type, outbox.payload, outbox.created_at,
                 outbox.slo_anchor_at, outbox.retain_until,
                 outbox.attempt_count`,
      [databaseNow, input.podId, databaseNow + input.claimMs, input.excludedIds],
    );
    return row ? { databaseNow, row } : null;
  });
}

async function releaseClaimForRetry(input: {
  db: Database;
  podId: string;
  event: Pick<RemoteDesktopGuestOutboxEnvelope, 'id' | 'attempt'>;
  errorCode: 'delivery_failed' | 'not_owner' | 'invalid_effect';
}): Promise<void> {
  await input.db.transaction(async (tx) => {
    const databaseNow = await readDatabaseClock(tx);
    await tx.execute(
      `UPDATE remote_desktop_guest_outbox
          SET claimed_by = NULL, claim_expires_at = NULL,
              available_at = CASE WHEN $4 = 'not_owner' THEN available_at ELSE $3 END,
              last_error = $4
        WHERE id = $1 AND state = 'pending' AND claimed_by = $2`,
      [
        input.event.id,
        input.podId,
        databaseNow + (input.errorCode === 'not_owner'
          ? REMOTE_DESKTOP_GUEST_OUTBOX_POLL_MS
          : retryDelay(input.event.attempt)),
        input.errorCode,
      ],
    );
  });
}

async function acknowledgeClaim(input: {
  db: Database;
  podId: string;
  event: RemoteDesktopGuestOutboxEnvelope;
  targetServerId: string | null;
}): Promise<{ acknowledged: boolean; databaseNow: number }> {
  return input.db.transaction(async (tx) => {
    const databaseNow = await readDatabaseClock(tx);
    const updated = await tx.execute(
      `UPDATE remote_desktop_guest_outbox
          SET state = 'acknowledged', acknowledged_at = $4,
              acknowledged_by = $2, claimed_by = NULL,
              claim_expires_at = NULL, last_error = NULL
        WHERE id = $1 AND state = 'pending' AND claimed_by = $2
          AND claim_expires_at > $4
          AND target_server_id IS NOT DISTINCT FROM $3`,
      [input.event.id, input.podId, input.targetServerId, databaseNow],
    );
    return { acknowledged: updated.changes === 1, databaseNow };
  });
}

function effectSloAnchor(event: RemoteDesktopGuestOutboxEnvelope): number {
  return event.sloAnchorAt;
}

export async function sweepAcknowledgedGuestOutbox(input: {
  db: Database;
  limit?: number;
}): Promise<number> {
  const limit = input.limit ?? REMOTE_DESKTOP_GUEST_OUTBOX_BATCH;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 512) throw new Error('invalid_outbox_limit');
  return input.db.transaction(async (tx) => {
    const databaseNow = await readDatabaseClock(tx);
    const removed = await tx.execute(
      `DELETE FROM remote_desktop_guest_outbox
        WHERE id IN (
          SELECT id FROM remote_desktop_guest_outbox
           WHERE state = 'acknowledged' AND retain_until <= $1
           ORDER BY retain_until, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )`,
      [databaseNow, limit],
    );
    return removed.changes;
  });
}

export async function processRemoteDesktopGuestOutbox(input: {
  db: Database;
  podId: string;
  adapter: RemoteDesktopGuestOutboxDeliveryAdapter;
  limit?: number;
  claimMs?: number;
  onError?: (error: unknown, event?: RemoteDesktopGuestOutboxEnvelope) => void;
  onSloViolation?: (event: RemoteDesktopGuestOutboxEnvelope, latencyMs: number) => void;
}): Promise<OutboxRunResult> {
  const limit = input.limit ?? REMOTE_DESKTOP_GUEST_OUTBOX_BATCH;
  const claimMs = input.claimMs ?? REMOTE_DESKTOP_GUEST_OUTBOX_CLAIM_MS;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 512) throw new Error('invalid_outbox_limit');
  if (!Number.isSafeInteger(claimMs) || claimMs <= 0) throw new Error('invalid_outbox_claim');
  const result: OutboxRunResult = {
    claimed: 0, applied: 0, duplicates: 0, notOwner: 0,
    failed: 0, acknowledged: 0, sloViolations: 0,
  };
  const skippedIds: string[] = [];

  for (let index = 0; index < limit; index += 1) {
    let claimed: Awaited<ReturnType<typeof claimNextOutboxRow>>;
    try {
      claimed = await claimNextOutboxRow({
        db: input.db,
        podId: input.podId,
        claimMs,
        excludedIds: skippedIds,
      });
    } catch (error) {
      input.onError?.(error);
      result.failed += 1;
      break;
    }
    if (!claimed) break;
    result.claimed += 1;
    let event: RemoteDesktopGuestOutboxEnvelope;
    try {
      event = parseRemoteDesktopGuestOutboxRow(claimed.row);
    } catch (error) {
      result.failed += 1;
      input.onError?.(error);
      await releaseClaimForRetry({
        db: input.db,
        podId: input.podId,
        event: { id: claimed.row.id, attempt: claimed.row.attempt_count },
        errorCode: 'invalid_effect',
      });
      continue;
    }

    try {
      const projectedTargetServerId = event.targetServerId;
      const targetServerId = event.scope === REMOTE_DESKTOP_OUTBOX_SCOPE.HOST
        ? await input.adapter.resolveHostTarget?.(event) ?? null
        : event.targetServerId;
      if (targetServerId === null) {
        result.notOwner += 1;
        skippedIds.push(event.id);
        await releaseClaimForRetry({
          db: input.db, podId: input.podId, event, errorCode: 'not_owner',
        });
        continue;
      }
      if (!await input.adapter.ownsTarget(targetServerId, event)) {
        result.notOwner += 1;
        skippedIds.push(event.id);
        await releaseClaimForRetry({
          db: input.db, podId: input.podId, event, errorCode: 'not_owner',
        });
        continue;
      }
      const delivered = await input.adapter.deliver(targetServerId, event);
      if (delivered.status === 'not_owner') {
        result.notOwner += 1;
        skippedIds.push(event.id);
        await releaseClaimForRetry({
          db: input.db, podId: input.podId, event, errorCode: 'not_owner',
        });
        continue;
      }
      if (delivered.status === 'duplicate') result.duplicates += 1;
      else result.applied += 1;

      const ack = await acknowledgeClaim({
        db: input.db, podId: input.podId, event, targetServerId: projectedTargetServerId,
      });
      if (!ack.acknowledged) {
        result.failed += 1;
        continue;
      }
      result.acknowledged += 1;
      const latencyMs = ack.databaseNow - effectSloAnchor(event);
      if (latencyMs > REMOTE_DESKTOP_GUEST_EFFECT_SLO_MS) {
        result.sloViolations += 1;
        input.onSloViolation?.(event, latencyMs);
      }
    } catch (error) {
      result.failed += 1;
      input.onError?.(error, event);
      try {
        await releaseClaimForRetry({
          db: input.db, podId: input.podId, event, errorCode: 'delivery_failed',
        });
      } catch (releaseError) {
        input.onError?.(releaseError, event);
      }
    }
  }
  return result;
}

/** Dedicated pg connection: LISTEN cannot safely share a transaction pool. */
export class PostgresRemoteDesktopGuestOutboxListener implements RemoteDesktopGuestOutboxWakeListener {
  private client: pg.Client | null = null;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onWake: (() => void) | null = null;
  private onError: ((error: unknown) => void) | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly reconnectMs = 1_000,
  ) {}

  async start(onWake: () => void, onError: (error: unknown) => void): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.onWake = onWake;
    this.onError = onError;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    this.client = client;
    client.on('notification', (notification) => {
      if (notification.channel === REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL) this.onWake?.();
    });
    client.on('error', (error) => {
      this.onError?.(error);
      void this.reconnect(client);
    });
    client.on('end', () => {
      if (!this.stopped) void this.reconnect(client);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL}`);
    } catch (error) {
      this.onError?.(error);
      await this.reconnect(client);
    }
  }

  private async reconnect(client: pg.Client): Promise<void> {
    if (this.client !== client) return;
    this.client = null;
    await client.end().catch(() => undefined);
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectMs);
  }
}

export class RemoteDesktopGuestOutboxWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private nextPollAt = 0;

  constructor(
    private readonly db: Database,
    private readonly podId: string,
    private readonly adapter: RemoteDesktopGuestOutboxDeliveryAdapter,
    private readonly listener?: RemoteDesktopGuestOutboxWakeListener,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly onSloViolation: (
      event: RemoteDesktopGuestOutboxEnvelope,
      latencyMs: number,
    ) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.nextPollAt = performance.now();
    this.schedule(0);
    // Listener establishment is acceleration only. Never let a slow/broken
    // dedicated LISTEN connection delay the authoritative pool poller.
    if (this.listener) {
      void this.listener.start(() => this.wake(), this.onError).catch(this.onError);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.listener) await this.listener.stop();
    if (this.running) {
      await new Promise<void>((resolve) => { this.idleWaiters.push(resolve); });
    }
  }

  wake(): void {
    if (this.stopped || this.running) return;
    this.schedule(0);
  }

  async runOnce(): Promise<OutboxRunResult> {
    const result = await processRemoteDesktopGuestOutbox({
      db: this.db,
      podId: this.podId,
      adapter: this.adapter,
      onError: this.onError,
      onSloViolation: this.onSloViolation,
    });
    await sweepAcknowledgedGuestOutbox({ db: this.db });
    return result;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, delayMs));
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
      const now = performance.now();
      if (this.nextPollAt <= now) {
        const missed = Math.floor((now - this.nextPollAt) / REMOTE_DESKTOP_GUEST_OUTBOX_POLL_MS) + 1;
        this.nextPollAt += missed * REMOTE_DESKTOP_GUEST_OUTBOX_POLL_MS;
      }
      this.schedule(this.nextPollAt - now);
    }
  }
}

/** One pod-local lifecycle for both authoritative pollers. */
export class RemoteDesktopGuestBackgroundRuntime {
  constructor(
    private readonly dueWorker: Pick<RemoteDesktopGuestDueWorker, 'start' | 'stop'>,
    private readonly outboxWorker: Pick<RemoteDesktopGuestOutboxWorker, 'start' | 'stop'>,
  ) {}

  async start(): Promise<void> {
    this.dueWorker.start();
    try {
      await this.outboxWorker.start();
    } catch (error) {
      await this.dueWorker.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.dueWorker.stop(),
      this.outboxWorker.stop(),
    ]);
  }
}
