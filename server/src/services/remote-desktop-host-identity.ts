/**
 * Canonical physical-host identity for remote desktop.
 *
 * One physical desktop can appear in `servers` twice: as a FULL daemon and as
 * the controlled-node endpoint that daemon enrolled (`servers.host_server_id`).
 * Public identity, password authority, link authority and the collaboration
 * budget belong to the desktop, so every operation here keys on a canonical
 * host principal rather than on either endpoint row.
 *
 * Nothing in this module enables guest access. It provides the persistence and
 * allocation primitives the access track consumes later.
 *
 * Public-ID range and rejection rules are authoritative in the shared access
 * contract. This module only keeps compatibility wrappers for existing Server
 * callers and tests; it must not restate those rules.
 */

import { randomInt, randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { REMOTE_DESKTOP_CAPABILITY, REMOTE_DESKTOP_LIMITS } from '../../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_PUBLIC_ID,
  isAcceptableRemoteDesktopPublicNodeId,
  isProhibitedRemoteDesktopPublicIdPattern,
} from '../../../shared/remote-desktop-access.js';
import type { RemoteDesktopActorSource } from '../../../shared/remote-desktop-access.js';

/** Inclusive lower bound of the public node ID range. */
export const PUBLIC_NODE_ID_MIN = REMOTE_DESKTOP_PUBLIC_ID.MIN;
/** Inclusive upper bound of the public node ID range. */
export const PUBLIC_NODE_ID_MAX = REMOTE_DESKTOP_PUBLIC_ID.MAX;
/** Bounded retry budget for pattern rejection plus collision retry. */
export const PUBLIC_NODE_ID_ALLOCATION_ATTEMPTS = REMOTE_DESKTOP_PUBLIC_ID.MAX_ALLOCATION_ATTEMPTS;

/** Endpoint kinds that can back a canonical host. */
export const HOST_ENDPOINT_ROLE = { FULL: 'full', CONTROLLED: 'controlled' } as const;
export type HostEndpointRole = (typeof HOST_ENDPOINT_ROLE)[keyof typeof HOST_ENDPOINT_ROLE];

/** Guest admission stays closed while a linkage conflict is unresolved. */
export const HOST_MERGE_STATE = { RESOLVED: 'resolved', CONFLICT_PENDING: 'conflict_pending' } as const;
export type HostMergeState = (typeof HOST_MERGE_STATE)[keyof typeof HOST_MERGE_STATE];

/** Typed failures. Callers map these to wire errors; no reason text is public. */
export const HOST_IDENTITY_ERROR = {
  ALLOCATION_EXHAUSTED: 'allocation_exhausted',
  HOST_NOT_FOUND: 'host_not_found',
  NO_ACTIVE_PUBLIC_ID: 'no_active_public_id',
  CONFLICT_NOT_FOUND: 'conflict_not_found',
  SURVIVOR_NOT_IN_CONFLICT: 'survivor_not_in_conflict',
} as const;
export type HostIdentityErrorCode = (typeof HOST_IDENTITY_ERROR)[keyof typeof HOST_IDENTITY_ERROR];

export class HostIdentityError extends Error {
  constructor(readonly code: HostIdentityErrorCode) {
    super(code);
    this.name = 'HostIdentityError';
  }
}

/**
 * Injectable uniform sampler over an inclusive integer range.
 *
 * Production uses `crypto.randomInt`. Tests inject a deterministic sequence so
 * prohibited patterns and collisions can be forced rather than waited for.
 */
export type PublicNodeIdRandom = (minInclusive: number, maxExclusive: number) => number;
export type FullEndpointEligibility = (serverId: string) => boolean | Promise<boolean>;

export const PRINCIPAL_GUEST_SESSION_LIMIT = Math.min(
  REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE,
  REMOTE_DESKTOP_LIMITS.MAX_PEER_CONNECTIONS_PER_WORKER,
  REMOTE_DESKTOP_LIMITS.MAX_TURN_ALLOCATIONS_PER_MACHINE,
);

export const defaultPublicNodeIdRandom: PublicNodeIdRandom = (min, max) => randomInt(min, max);

/**
 * Deterministic rejection rules. A candidate is prohibited when it contains:
 *   1. four or more zero digits in total;
 *   2. a run of four identical digits;
 *   3. a strictly ascending or descending run of four digits, no wrap;
 *   4. a two- or three-digit motif repeated across six or more consecutive digits.
 *
 * These are exact. Do not add implementation-local notions of "obvious".
 */
export function isProhibitedPublicNodeId(candidate: string): boolean {
  if (!/^\d{10}$/.test(candidate)) return true;
  return isProhibitedRemoteDesktopPublicIdPattern(Number(candidate));
}

/** True when a value is a syntactically well-formed, non-prohibited public ID. */
export function isAllocatablePublicNodeId(candidate: string): boolean {
  if (!/^[5-9]\d{9}$/.test(candidate)) return false;
  return isAcceptableRemoteDesktopPublicNodeId(Number(candidate));
}

/**
 * Rejection-sample one candidate that passes the shared pattern rules.
 * Uniqueness is the database's job; this only filters shape.
 */
export function samplePublicNodeId(
  random: PublicNodeIdRandom = defaultPublicNodeIdRandom,
  attempts: number = PUBLIC_NODE_ID_ALLOCATION_ATTEMPTS,
): string | null {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = String(random(PUBLIC_NODE_ID_MIN, PUBLIC_NODE_ID_MAX + 1));
    if (isAllocatablePublicNodeId(candidate)) return candidate;
  }
  return null;
}

interface ServerIdentityRow {
  id: string;
  user_id: string;
  node_role: string;
  host_server_id: string | null;
  controlled_capabilities: unknown;
}

interface EndpointRow {
  server_id: string;
  host_id: string;
  endpoint_role: string;
}

function hasRemoteDesktopCapability(raw: unknown): boolean {
  return Array.isArray(raw) && raw.includes(REMOTE_DESKTOP_CAPABILITY);
}

/**
 * Controlled endpoints persist this capability in `controlled_capabilities`.
 * FULL-daemon capability is live bridge state and is deliberately supplied to
 * `resolveExecutionEndpoint` as a callback rather than inferred from this row.
 */
export function isEligibleEndpoint(row: Pick<ServerIdentityRow, 'controlled_capabilities'>): boolean {
  return hasRemoteDesktopCapability(row.controlled_capabilities);
}

/**
 * Resolve the canonical host a `servers` row should belong to, creating it when
 * absent. Idempotent: repeated calls for the same endpoint return the same host.
 *
 * A controlled endpoint enrolled from a FULL daemon (`host_server_id`) joins
 * that daemon's host. Where both endpoints already carry different hosts the
 * caller receives a conflict rather than a silent merge.
 */
export async function ensureCanonicalHostForServer(input: {
  db: Database;
  serverId: string;
  now: number;
}): Promise<{ hostId: string; created: boolean; conflict: boolean }> {
  const { db, serverId, now } = input;

  return db.transaction(async (tx) => {
    const server = await tx.queryOne<ServerIdentityRow>(
      `SELECT id, user_id, node_role, host_server_id, controlled_capabilities
         FROM servers WHERE id = $1`,
      [serverId],
    );
    if (!server) throw new HostIdentityError(HOST_IDENTITY_ERROR.HOST_NOT_FOUND);

    const existing = await tx.queryOne<EndpointRow>(
      'SELECT server_id, host_id, endpoint_role FROM remote_desktop_host_endpoints WHERE server_id = $1',
      [serverId],
    );

    // The daemon this endpoint was enrolled from, when there is one.
    const peerId = server.host_server_id;
    const peer = peerId
      ? await tx.queryOne<EndpointRow>(
        'SELECT server_id, host_id, endpoint_role FROM remote_desktop_host_endpoints WHERE server_id = $1',
        [peerId],
      )
      : null;

    if (existing && peer && existing.host_id !== peer.host_id) {
      await recordMergeConflictTx(tx, {
        ownerUserId: server.user_id,
        hostA: existing.host_id,
        hostB: peer.host_id,
        now,
      });
      return { hostId: existing.host_id, created: false, conflict: true };
    }

    if (existing) return { hostId: existing.host_id, created: false, conflict: false };

    const role: HostEndpointRole = server.node_role === HOST_ENDPOINT_ROLE.CONTROLLED
      ? HOST_ENDPOINT_ROLE.CONTROLLED
      : HOST_ENDPOINT_ROLE.FULL;

    if (peer) {
      await attachEndpointTx(tx, {
        serverId, hostId: peer.host_id, ownerUserId: server.user_id, role, now,
      });
      return { hostId: peer.host_id, created: false, conflict: false };
    }

    const hostId = randomUUID();
    await tx.execute(
      `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [hostId, server.user_id, HOST_MERGE_STATE.RESOLVED, now],
    );
    await attachEndpointTx(tx, { serverId, hostId, ownerUserId: server.user_id, role, now });

    // A daemon that already enrolled a controlled endpoint adopts it, so the
    // desktop keeps one principal no matter which side is seen first.
    if (peerId === null) {
      const hosted = await tx.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM servers
          WHERE host_server_id = $1
            AND id NOT IN (SELECT server_id FROM remote_desktop_host_endpoints)`,
        [serverId],
      );
      for (const row of hosted) {
        if (row.user_id !== server.user_id) continue;
        await attachEndpointTx(tx, {
          serverId: row.id,
          hostId,
          ownerUserId: row.user_id,
          role: HOST_ENDPOINT_ROLE.CONTROLLED,
          now,
        });
      }
    }

    return { hostId, created: true, conflict: false };
  });
}

async function attachEndpointTx(tx: Database, input: {
  serverId: string; hostId: string; ownerUserId: string; role: HostEndpointRole; now: number;
}): Promise<void> {
  await tx.execute(
    `INSERT INTO remote_desktop_host_endpoints
       (server_id, host_id, owner_user_id, endpoint_role, linked_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (server_id) DO NOTHING`,
    [input.serverId, input.hostId, input.ownerUserId, input.role, input.now],
  );
}

/**
 * Allocate the host's active public ID. Idempotent: a host that already holds an
 * active ID keeps it, so retrying a partially applied backfill never rotates an
 * identity that was already committed.
 */
export async function allocateActivePublicNodeId(input: {
  db: Database;
  hostId: string;
  now: number;
  random?: PublicNodeIdRandom;
  attempts?: number;
}): Promise<{ publicId: string; created: boolean }> {
  const { db, hostId, now } = input;
  const random = input.random ?? defaultPublicNodeIdRandom;
  const attempts = input.attempts ?? PUBLIC_NODE_ID_ALLOCATION_ATTEMPTS;

  const current = await db.queryOne<{ public_id: string }>(
    "SELECT public_id FROM remote_desktop_public_ids WHERE host_id = $1 AND status = 'active'",
    [hostId],
  );
  if (current) return { publicId: current.public_id, created: false };

  for (let i = 0; i < attempts; i += 1) {
    const candidate = samplePublicNodeId(random, 1);
    if (!candidate) continue;

    // Untargeted ON CONFLICT DO NOTHING absorbs both conflict kinds without
    // raising, so this stays safe when called inside a caller's transaction:
    // a collision with an active OR retired value, and a concurrent allocator
    // winning the one-active-per-host index.
    const inserted = await db.queryOne<{ public_id: string }>(
      `INSERT INTO remote_desktop_public_ids (public_id, host_id, status, activated_at)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT DO NOTHING
       RETURNING public_id`,
      [candidate, hostId, now],
    );
    if (inserted) return { publicId: inserted.public_id, created: true };

    // Adopt a concurrent winner rather than allocating a second identity.
    const raced = await db.queryOne<{ public_id: string }>(
      "SELECT public_id FROM remote_desktop_public_ids WHERE host_id = $1 AND status = 'active'",
      [hostId],
    );
    if (raced) return { publicId: raced.public_id, created: false };
  }

  // No sequential fallback: exhaustion fails identity creation outright.
  throw new HostIdentityError(HOST_IDENTITY_ERROR.ALLOCATION_EXHAUSTED);
}

/**
 * Which endpoint currently executes for this host. Prefers a qualified hosted
 * controlled endpoint, otherwise the qualified FULL daemon. Returns null when no
 * attached endpoint advertises the capability, which is how a host without
 * remote-desktop eligibility stays out of guest advertisement.
 */
export async function resolveExecutionEndpoint(input: {
  db: Database;
  hostId: string;
  fullEndpointEligible?: FullEndpointEligibility;
}): Promise<{ serverId: string; role: HostEndpointRole } | null> {
  const rows = await input.db.query<EndpointRow & { controlled_capabilities: unknown }>(
    `SELECT e.server_id, e.host_id, e.endpoint_role, s.controlled_capabilities
       FROM remote_desktop_host_endpoints e
       JOIN servers s ON s.id = e.server_id
      WHERE e.host_id = $1`,
    [input.hostId],
  );
  const controlled = rows.find((row) => (
    row.endpoint_role === HOST_ENDPOINT_ROLE.CONTROLLED && isEligibleEndpoint(row)
  ));
  if (controlled) return { serverId: controlled.server_id, role: HOST_ENDPOINT_ROLE.CONTROLLED };

  if (!input.fullEndpointEligible) return null;
  for (const row of rows) {
    if (row.endpoint_role === HOST_ENDPOINT_ROLE.FULL
      && await input.fullEndpointEligible(row.server_id)) {
      return { serverId: row.server_id, role: HOST_ENDPOINT_ROLE.FULL };
    }
  }
  return null;
}

/** Canonical host for a `servers` row, so accounting keys on the desktop. */
export async function resolveHostIdForServer(db: Database, serverId: string): Promise<string | null> {
  const row = await db.queryOne<{ host_id: string }>(
    'SELECT host_id FROM remote_desktop_host_endpoints WHERE server_id = $1',
    [serverId],
  );
  return row?.host_id ?? null;
}

/**
 * Guest admission readiness. Every condition is principal-scoped: canonical
 * mapping committed, no unresolved linkage conflict, an active public ID, and a
 * currently qualified execution endpoint.
 */
export async function isGuestAdmissionReady(input: {
  db: Database;
  hostId: string;
  fullEndpointEligible?: FullEndpointEligibility;
}): Promise<boolean> {
  const host = await input.db.queryOne<{ merge_state: string }>(
    'SELECT merge_state FROM remote_desktop_hosts WHERE id = $1',
    [input.hostId],
  );
  if (!host || host.merge_state !== HOST_MERGE_STATE.RESOLVED) return false;

  const active = await input.db.queryOne<{ public_id: string }>(
    "SELECT public_id FROM remote_desktop_public_ids WHERE host_id = $1 AND status = 'active'",
    [input.hostId],
  );
  if (!active) return false;

  return (await resolveExecutionEndpoint({
    db: input.db,
    hostId: input.hostId,
    fullEndpointEligible: input.fullEndpointEligible,
  })) !== null;
}

type GuestActorSource = Exclude<RemoteDesktopActorSource, typeof REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT>;

/**
 * Reserve one guest route against the canonical physical-host budget.
 *
 * The host row lock serializes reservations made through either linked endpoint,
 * while the session row makes the reservation durable across pods. Callers may
 * publish PREPARE only after this function returns true.
 */
export async function reservePrincipalGuestSession(input: {
  db: Database;
  sessionId: string;
  hostId: string;
  linkId: string | null;
  browserKeyHash: string | null;
  actorSource: GuestActorSource;
  authorityGeneration: number;
  expiryRevision: number | null;
  passwordGeneration: number | null;
  absoluteExpiresAt: number | null;
  now: number;
}): Promise<boolean> {
  return input.db.transaction(async (tx) => {
    const host = await tx.queryOne<{ id: string }>(
      'SELECT id FROM remote_desktop_hosts WHERE id = $1 FOR UPDATE',
      [input.hostId],
    );
    if (!host) throw new HostIdentityError(HOST_IDENTITY_ERROR.HOST_NOT_FOUND);
    const live = await tx.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM remote_desktop_guest_sessions
        WHERE host_id = $1 AND state IN ('admitting', 'active')`,
      [input.hostId],
    );
    if ((live?.count ?? 0) >= PRINCIPAL_GUEST_SESSION_LIMIT) return false;
    const inserted = await tx.execute(
      `INSERT INTO remote_desktop_guest_sessions
         (id, link_id, host_id, browser_key_hash, actor_kind,
          authority_generation, expiry_revision, password_generation,
          absolute_expires_at, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'admitting', $10, $10)`,
      [
        input.sessionId,
        input.linkId,
        input.hostId,
        input.browserKeyHash,
        input.actorSource,
        input.authorityGeneration,
        input.expiryRevision,
        input.passwordGeneration,
        input.absoluteExpiresAt,
        input.now,
      ],
    );
    if (inserted.changes !== 1) throw new Error('guest_session_reservation_failed');
    return true;
  });
}

async function recordMergeConflictTx(tx: Database, input: {
  ownerUserId: string; hostA: string; hostB: string; now: number;
}): Promise<void> {
  // Normalized order keeps one pending row per unordered pair.
  const [low, high] = input.hostA < input.hostB
    ? [input.hostA, input.hostB]
    : [input.hostB, input.hostA];

  await tx.execute(
    `INSERT INTO remote_desktop_host_merge_conflicts
       (id, owner_user_id, host_id, other_host_id, resolution, detected_at)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), input.ownerUserId, low, high, input.now],
  );

  // Both principals close admission until the owner picks a survivor.
  await tx.execute(
    `UPDATE remote_desktop_hosts
        SET merge_state = $1, updated_at = $2
      WHERE id = ANY($3::text[])`,
    [HOST_MERGE_STATE.CONFLICT_PENDING, input.now, [low, high]],
  );
}

/**
 * Owner-visible resolution. The survivor keeps its active public ID and its own
 * links/passwords; the losing host's active ID is retired permanently and its
 * endpoints re-attach to the survivor. Credentials are never combined — the
 * loser's link and password rows stay with the retired principal for the owner
 * to inspect or discard explicitly.
 */
export async function resolveMergeConflict(input: {
  db: Database;
  conflictId: string;
  survivingHostId: string;
  now: number;
}): Promise<{ survivingHostId: string; retiredPublicIds: string[] }> {
  const { db, conflictId, survivingHostId, now } = input;

  return db.transaction(async (tx) => {
    const conflict = await tx.queryOne<{
      host_id: string; other_host_id: string; owner_user_id: string; resolution: string;
    }>(
      `SELECT host_id, other_host_id, owner_user_id, resolution
         FROM remote_desktop_host_merge_conflicts
        WHERE id = $1 FOR UPDATE`,
      [conflictId],
    );
    if (!conflict || conflict.resolution !== 'pending') {
      throw new HostIdentityError(HOST_IDENTITY_ERROR.CONFLICT_NOT_FOUND);
    }
    if (survivingHostId !== conflict.host_id && survivingHostId !== conflict.other_host_id) {
      throw new HostIdentityError(HOST_IDENTITY_ERROR.SURVIVOR_NOT_IN_CONFLICT);
    }

    const losingHostId = survivingHostId === conflict.host_id
      ? conflict.other_host_id
      : conflict.host_id;

    const retired = await tx.query<{ public_id: string }>(
      `UPDATE remote_desktop_public_ids
          SET status = 'retired', retired_at = $2
        WHERE host_id = $1 AND status = 'active'
        RETURNING public_id`,
      [losingHostId, now],
    );

    await tx.execute(
      `UPDATE remote_desktop_host_endpoints
          SET host_id = $1, linked_at = $3
        WHERE host_id = $2`,
      [survivingHostId, losingHostId, now],
    );

    await tx.execute(
      `UPDATE remote_desktop_hosts SET merge_state = $1, updated_at = $2 WHERE id = ANY($3::text[])`,
      [HOST_MERGE_STATE.RESOLVED, now, [survivingHostId, losingHostId]],
    );

    await tx.execute(
      `UPDATE remote_desktop_host_merge_conflicts
          SET resolution = 'resolved', surviving_host_id = $1, resolved_at = $2
        WHERE id = $3`,
      [survivingHostId, now, conflictId],
    );

    return { survivingHostId, retiredPublicIds: retired.map((r) => r.public_id) };
  });
}

/**
 * Rotate the host's public ID.
 *
 * Atomically retires the old value and activates a new one. The public ID is a
 * lookup handle, not established authority, so nothing here touches link
 * authority generation, expiry revision or password generation — an already
 * admitted route keeps running. Cancelling old-ID challenges and unredeemed
 * bootstraps is the caller's step, performed inside this transaction once those
 * tables exist; `onRotatedTx` is the seam for it.
 */
export async function rotatePublicNodeId(input: {
  db: Database;
  hostId: string;
  now: number;
  random?: PublicNodeIdRandom;
  attempts?: number;
  onRotatedTx?: (tx: Database, rotated: { hostId: string; previousPublicId: string; publicId: string }) => Promise<void>;
}): Promise<{ previousPublicId: string; publicId: string }> {
  const { db, hostId, now } = input;
  const random = input.random ?? defaultPublicNodeIdRandom;
  const attempts = input.attempts ?? PUBLIC_NODE_ID_ALLOCATION_ATTEMPTS;

  return db.transaction(async (tx) => {
    const current = await tx.queryOne<{ public_id: string }>(
      `SELECT public_id FROM remote_desktop_public_ids
        WHERE host_id = $1 AND status = 'active' FOR UPDATE`,
      [hostId],
    );
    if (!current) throw new HostIdentityError(HOST_IDENTITY_ERROR.NO_ACTIVE_PUBLIC_ID);

    await tx.execute(
      `UPDATE remote_desktop_public_ids SET status = 'retired', retired_at = $2 WHERE public_id = $1`,
      [current.public_id, now],
    );

    let next: string | null = null;
    for (let i = 0; i < attempts && next === null; i += 1) {
      const candidate = samplePublicNodeId(random, 1);
      if (!candidate) continue;
      const inserted = await tx.queryOne<{ public_id: string }>(
        `INSERT INTO remote_desktop_public_ids (public_id, host_id, status, activated_at)
         VALUES ($1, $2, 'active', $3)
         ON CONFLICT DO NOTHING
         RETURNING public_id`,
        [candidate, hostId, now],
      );
      if (inserted) next = inserted.public_id;
    }
    if (next === null) throw new HostIdentityError(HOST_IDENTITY_ERROR.ALLOCATION_EXHAUSTED);

    await tx.execute('UPDATE remote_desktop_hosts SET updated_at = $2 WHERE id = $1', [hostId, now]);

    const rotated = { hostId, previousPublicId: current.public_id, publicId: next };
    if (input.onRotatedTx) await input.onRotatedTx(tx, rotated);
    return { previousPublicId: rotated.previousPublicId, publicId: rotated.publicId };
  });
}

/**
 * Bounded, resumable backfill.
 *
 * Each pass processes at most `limit` eligible endpoints that have no canonical
 * mapping yet, so an interrupted run resumes by simply running again: committed
 * hosts and IDs are skipped because the selecting predicate no longer matches
 * them. No cursor is stored, which removes the failure mode where a saved cursor
 * outlives the rows it pointed at.
 */
export async function backfillCanonicalHosts(input: {
  db: Database;
  limit: number;
  now: number;
  random?: PublicNodeIdRandom;
  /** Restrict the pass to one account. Omit for the fleet-wide migration. */
  ownerUserId?: string;
}): Promise<{ processed: number; hostsCreated: number; publicIdsAssigned: number; conflicts: number; remaining: number }> {
  const { db, limit, now, ownerUserId } = input;
  const capability = JSON.stringify([REMOTE_DESKTOP_CAPABILITY]);

  const pendingFilter = `
      WHERE s.controlled_capabilities @> $1::jsonb
        AND ($2::text IS NULL OR s.user_id = $2)
        AND NOT EXISTS (
          SELECT 1 FROM remote_desktop_host_endpoints e WHERE e.server_id = s.id
        )`;

  const pending = await db.query<{ id: string }>(
    `SELECT s.id FROM servers s ${pendingFilter} ORDER BY s.id LIMIT $3`,
    [capability, ownerUserId ?? null, limit],
  );

  let hostsCreated = 0;
  let publicIdsAssigned = 0;
  let conflicts = 0;

  for (const row of pending) {
    const mapped = await ensureCanonicalHostForServer({ db, serverId: row.id, now });
    if (mapped.created) hostsCreated += 1;
    if (mapped.conflict) { conflicts += 1; continue; }
    const allocated = await allocateActivePublicNodeId({
      db, hostId: mapped.hostId, now, random: input.random,
    });
    if (allocated.created) publicIdsAssigned += 1;
  }

  const remainingRow = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM servers s ${pendingFilter}`,
    [capability, ownerUserId ?? null],
  );

  return {
    processed: pending.length,
    hostsCreated,
    publicIdsAssigned,
    conflicts,
    remaining: remainingRow?.count ?? 0,
  };
}
