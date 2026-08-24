/**
 * Server privacy engine for canonical-host secret-bearing management.
 *
 * The barrier this enforces: before any client accepts unattended-password
 * input or generates/displays a raw invitation link, remote capture of that
 * desktop must be provably shielded. PostgreSQL is the only authority. No
 * process-local state, pod memory, client companion detection or Worker
 * self-report may open admission or enable secret UI.
 *
 * Phase machine. Wire phases are REMOTE_DESKTOP_PRIVACY_PHASE from the shared
 * contract; `idle` is database-only and means "no epoch exists".
 *
 *   idle ──begin──> starting ──complete ack──> active
 *                      │                          │
 *                      │                    end (secret cleared)
 *                      │                          ▼
 *                      └──lease/deadline──>    ending
 *                         failure   │             │ fresh frame ack
 *                                   ▼             ▼
 *                          recovery_required    idle (admission reopened)
 *
 * `recovery_required` is terminal for the epoch: admission stays closed and
 * capture stays shielded until an operator-driven recovery proves cleanup.
 *
 * Authenticated Owner/Participant route reserve/activate/close is wired through
 * RemoteDesktopRouter. Guest admission and bridge privacy-frame delivery/ack
 * remain explicit integration seams; until they land, secret APIs must remain
 * disabled and this module's fail-closed checks reject incomplete coverage.
 */

import type { Database } from '../db/client.js';
import { REMOTE_DESKTOP_LIMITS } from '../../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_PRIVACY_PHASE,
} from '../../../shared/remote-desktop-access.js';
import type {
  RemoteDesktopActorSource,
  RemoteDesktopPrivacyBegin,
  RemoteDesktopPrivacyEnd,
  RemoteDesktopPresentationSource,
  RemoteDesktopPrivacyPhase,
  RemoteDesktopRouteGeneration,
} from '../../../shared/remote-desktop-access.js';

export interface RemoteDesktopManagementPrivacyCommand {
  executionServerId: string;
  daemonGeneration: number;
  message: RemoteDesktopPrivacyBegin | RemoteDesktopPrivacyEnd;
}

export type RemoteDesktopManagementPrivacyDispatcher = (
  command: RemoteDesktopManagementPrivacyCommand,
) => boolean | Promise<boolean>;

export interface RemoteDesktopPendingRouteCancellationCommand {
  executionServerId: string;
  hostId: string;
  routes: readonly RouteRef[];
}

export type RemoteDesktopPendingRouteCancellationDispatcher = (
  command: RemoteDesktopPendingRouteCancellationCommand,
) => boolean | Promise<boolean>;

let privacyCommandDispatcher: RemoteDesktopManagementPrivacyDispatcher | null = null;
let pendingRouteCancellationDispatcher: RemoteDesktopPendingRouteCancellationDispatcher | null = null;

/** Production installs the authenticated node-channel dispatcher at startup.
 * Tests and embedded callers may leave it unset; durable state then remains
 * closed and the lease worker moves an unacknowledged epoch to recovery. */
export function setRemoteDesktopManagementPrivacyDispatcher(
  dispatcher: RemoteDesktopManagementPrivacyDispatcher | null,
): void {
  privacyCommandDispatcher = dispatcher;
}

/** Install the owning-pod Router/consent cancellation seam.  The database
 * commit remains authoritative even when process delivery fails: cancelled
 * rows can never activate, and clients receive only a generic retryable
 * outcome when the owning process is still present. */
export function setRemoteDesktopPendingRouteCancellationDispatcher(
  dispatcher: RemoteDesktopPendingRouteCancellationDispatcher | null,
): void {
  pendingRouteCancellationDispatcher = dispatcher;
}

async function dispatchPrivacyCommand(command: RemoteDesktopManagementPrivacyCommand): Promise<void> {
  try {
    await privacyCommandDispatcher?.(command);
  } catch {
    // Delivery is deliberately not part of the authority transaction. A send
    // failure must leave the durable admission gate closed; deadline recovery
    // is safer than rolling back into an open gate after route classification.
  }
}

/**
 * Wire phases come from the shared contract. `idle` is database-only: it means
 * "no epoch exists", which has no wire representation because
 * `RemoteDesktopPrivacyEpoch` only describes a live epoch.
 */
export const PRIVACY_DB_PHASE_IDLE = 'idle' as const;
export type PrivacyPhase = RemoteDesktopPrivacyPhase | typeof PRIVACY_DB_PHASE_IDLE;

const PHASE = {
  IDLE: PRIVACY_DB_PHASE_IDLE,
  STARTING: REMOTE_DESKTOP_PRIVACY_PHASE.STARTING,
  ACTIVE: REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE,
  ENDING: REMOTE_DESKTOP_PRIVACY_PHASE.ENDING,
  RECOVERY_REQUIRED: REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED,
} as const;

/**
 * Refusal reasons. These are internal; callers map them to one generic
 * client-facing result so a caller cannot distinguish "routes exist" from
 * "wrong pod" by probing.
 */
export const PRIVACY_REFUSAL = {
  ROUTES_PRESENT: 'routes_present',
  EPOCH_BUSY: 'epoch_busy',
  EPOCH_MISMATCH: 'epoch_mismatch',
  WRONG_POD: 'wrong_pod',
  STALE_GENERATION: 'stale_generation',
  INCOMPLETE_ACK: 'incomplete_ack',
  NOT_SHIELDED: 'not_shielded',
  NOT_RESUMING: 'not_resuming',
  CACHED_FRAME: 'cached_frame',
  RECOVERY_REQUIRED: 'recovery_required',
  ADMISSION_CLOSED: 'admission_closed',
  ROUTE_LIMIT: 'route_limit',
} as const;
export type PrivacyRefusal = (typeof PRIVACY_REFUSAL)[keyof typeof PRIVACY_REFUSAL];

export class PrivacyBarrierError extends Error {
  constructor(readonly refusal: PrivacyRefusal) {
    super(refusal);
    this.name = 'PrivacyBarrierError';
  }
}

/** One remote route as the barrier sees it (shared wire shape). */
export type RouteRef = RemoteDesktopRouteGeneration;

/**
 * Registry lifecycle. `admitting` holds no Worker authority and is therefore
 * cancellable; `active` is capturing and must acknowledge the privacy frame.
 */
export const ROUTE_STATE = {
  ADMITTING: 'admitting',
  SHIELDING: 'shielding',
  ACTIVE: 'active',
  CLOSED: 'closed',
} as const;
export type RouteState = (typeof ROUTE_STATE)[keyof typeof ROUTE_STATE];

/**
 * Actor kind is recorded for audit only. The privacy policy never branches on
 * it: an authenticated Owner route blocks management-Web secret UI exactly as a
 * guest route does.
 */
export type RouteActorSource = RemoteDesktopActorSource;

export interface RegisteredRoute {
  routeId: string;
  routeGeneration: number;
  hostId: string;
  actorSource: RouteActorSource;
  actorAuditId: string | null;
  executionServerId: string | null;
  state: RouteState;
  guestSessionId: string | null;
}

export interface RouteClassification {
  /** Not yet at PREPARE/Worker authority. Cancelled by a shell-initiated epoch. */
  pending: RouteRef[];
  /** Holds Worker authority. Must release input and show the privacy frame. */
  active: RouteRef[];
}

export interface PrivacyState {
  hostId: string;
  epochId: string | null;
  revision: number;
  phase: PrivacyPhase;
  admissionOpen: boolean;
  presentationSource: RemoteDesktopPresentationSource | null;
  executionServerId: string | null;
  daemonGeneration: number | null;
  workerGeneration: number | null;
  routeSnapshot: RouteRef[];
  acknowledgedRoutes: RouteRef[];
  leaseExpiresAt: number | null;
  deadline: number | null;
  recoveryReason: string | null;
  freshFrameGeneration: number | null;
}

interface PrivacyRow {
  host_id: string;
  epoch_id: string | null;
  revision: number;
  phase: string;
  admission_open: boolean;
  presentation_source: string | null;
  execution_server_id: string | null;
  daemon_generation: number | null;
  worker_generation: number | null;
  route_snapshot: unknown;
  acknowledged_routes: unknown;
  lease_expires_at: number | null;
  deadline: number | null;
  recovery_reason: string | null;
  fresh_frame_generation: number | null;
}

const PRIVACY_COLUMNS = `host_id, epoch_id, revision, phase, admission_open,
  presentation_source, execution_server_id, daemon_generation, worker_generation,
  route_snapshot, acknowledged_routes, lease_expires_at, deadline,
  recovery_reason, fresh_frame_generation`;

function parseRoutes(raw: unknown): RouteRef[] {
  if (!Array.isArray(raw)) return [];
  const routes: RouteRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { routeId, routeGeneration } = entry as Partial<RouteRef>;
    if (typeof routeId !== 'string' || !Number.isSafeInteger(routeGeneration)) continue;
    routes.push({ routeId, routeGeneration: routeGeneration as number });
  }
  return routes;
}

/** Canonical ordering so acknowledgement comparison is a stable exact match. */
function sortRoutes(routes: readonly RouteRef[]): RouteRef[] {
  return [...routes].sort((a, b) => (
    a.routeId === b.routeId ? a.routeGeneration - b.routeGeneration : (a.routeId < b.routeId ? -1 : 1)
  ));
}

function routeKey(route: RouteRef): string {
  return `${route.routeId}#${route.routeGeneration}`;
}

/** Exact set equality on route identity *and* generation. */
function sameRouteSet(a: readonly RouteRef[], b: readonly RouteRef[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a.map(routeKey));
  if (left.size !== a.length) return false;
  for (const route of b) if (!left.has(routeKey(route))) return false;
  return true;
}

function toState(row: PrivacyRow): PrivacyState {
  return {
    hostId: row.host_id,
    epochId: row.epoch_id,
    revision: row.revision,
    phase: row.phase as PrivacyPhase,
    admissionOpen: row.admission_open,
    presentationSource: row.presentation_source as RemoteDesktopPresentationSource | null,
    executionServerId: row.execution_server_id,
    daemonGeneration: row.daemon_generation,
    workerGeneration: row.worker_generation,
    routeSnapshot: parseRoutes(row.route_snapshot),
    acknowledgedRoutes: parseRoutes(row.acknowledged_routes),
    leaseExpiresAt: row.lease_expires_at,
    deadline: row.deadline,
    recoveryReason: row.recovery_reason,
    freshFrameGeneration: row.fresh_frame_generation,
  };
}

function assertSafeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
}

function assertGeneration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid_${name}`);
}

/**
 * Ensure the host's privacy row exists so `SELECT ... FOR UPDATE` has something
 * to lock. Without it two concurrent begins would both see "no row" and race.
 */
async function ensurePrivacyRowTx(tx: Database, hostId: string, now: number): Promise<void> {
  await tx.execute(
    `INSERT INTO remote_desktop_management_privacy (host_id, created_at, updated_at)
     VALUES ($1, $2, $2)
     ON CONFLICT (host_id) DO NOTHING`,
    [hostId, now],
  );
}

/** Lock the host's privacy row for the remainder of the caller's transaction. */
async function lockPrivacyRowTx(tx: Database, hostId: string): Promise<PrivacyRow | null> {
  return tx.queryOne<PrivacyRow>(
    `SELECT ${PRIVACY_COLUMNS} FROM remote_desktop_management_privacy
      WHERE host_id = $1 FOR UPDATE`,
    [hostId],
  );
}

/** Non-locking read for status surfaces. */
export async function getPrivacyState(db: Database, hostId: string): Promise<PrivacyState | null> {
  const row = await db.queryOne<PrivacyRow>(
    `SELECT ${PRIVACY_COLUMNS} FROM remote_desktop_management_privacy WHERE host_id = $1`,
    [hostId],
  );
  return row ? toState(row) : null;
}

/**
 * Split the host's live routes into pending and active.
 *
 * `admitting` means the route has not reached PREPARE/Worker authority, so a
 * shell-initiated epoch cancels it rather than waiting for an acknowledgement
 * it can never produce.
 */
export async function classifyHostRoutesTx(tx: Database, hostId: string): Promise<RouteClassification> {
  const rows = await tx.query<{ route_id: string; route_generation: number; state: string }>(
    `SELECT route_id, route_generation, state
       FROM remote_desktop_host_routes
      WHERE host_id = $1 AND state <> 'closed'
      ORDER BY route_id, route_generation`,
    [hostId],
  );
  const pending: RouteRef[] = [];
  const active: RouteRef[] = [];
  for (const row of rows) {
    const ref: RouteRef = { routeId: row.route_id, routeGeneration: row.route_generation };
    // A replacement in `shielding` has not received PREPARE authority yet,
    // but it is already an obligation of the live privacy epoch.  Treating it
    // as ordinary pending would let a second begin cancel it and lose the
    // exact snapshot that the Worker still has to acknowledge.
    if (row.state === ROUTE_STATE.ACTIVE || row.state === ROUTE_STATE.SHIELDING) active.push(ref);
    else pending.push(ref);
  }
  return { pending: sortRoutes(pending), active: sortRoutes(active) };
}

/** Allocate an incarnation independently from daemon/node connection state. */
export async function allocateRemoteDesktopRouteGeneration(db: Database): Promise<number> {
  const row = await db.queryOne<{ generation: string | number }>(
    `SELECT nextval('remote_desktop_route_generation_seq') AS generation`,
  );
  const generation = Number(row?.generation);
  assertGeneration(generation, 'route_generation');
  return generation;
}

/**
 * Live guest sessions that hold a route but were never mirrored into the
 * registry.
 *
 * Classification is registry-only by design, which means an unmirrored guest
 * route would be invisible to the barrier. Rather than read two sources and
 * reintroduce the double-counting this registry exists to remove, `begin`
 * treats any unmirrored route as a hard refusal. The guest track cannot create
 * a silent hole by forgetting to call `reserveRouteTx`; it can only make its
 * own admission fail loudly.
 */
export async function countUnregisteredGuestRoutesTx(tx: Database, hostId: string): Promise<number> {
  const row = await tx.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM remote_desktop_guest_sessions s
      WHERE s.host_id = $1
        AND s.state IN ('admitting', 'active')
        AND s.route_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM remote_desktop_host_routes r
           WHERE r.route_id = s.route_id
             AND r.state <> 'closed'
        )`,
    [hostId],
  );
  return row?.count ?? 0;
}

/**
 * Admission gate for the router. Must be called inside the transaction that
 * inserts the guest session, so a route either lands before the gate closes or
 * is refused — never straddles it.
 */
export async function assertAdmissionOpenTx(tx: Database, hostId: string, now: number): Promise<void> {
  await ensurePrivacyRowTx(tx, hostId, now);
  const row = await lockPrivacyRowTx(tx, hostId);
  if (!row || !row.admission_open) throw new PrivacyBarrierError(PRIVACY_REFUSAL.ADMISSION_CLOSED);
}

/**
 * Reserve a route before it can carry any media.
 *
 * Must run inside the caller's admission transaction. It takes the same privacy
 * row lock `beginPrivacyEpoch` takes, which is what linearizes the two: a route
 * either reserves before the gate closes, or the gate closes first and the
 * reservation is refused. There is no interleaving in which a route exists but
 * the epoch's snapshot missed it.
 */
export async function reserveRouteTx(tx: Database, input: {
  hostId: string;
  routeId: string;
  routeGeneration: number;
  actorSource: RouteActorSource;
  actorAuditId?: string | null;
  executionServerId?: string | null;
  guestSessionId?: string | null;
  now: number;
}): Promise<void> {
  assertSafeTimestamp(input.now, 'route_time');
  if (!Number.isSafeInteger(input.routeGeneration) || input.routeGeneration < 0) {
    throw new Error('invalid_route_generation');
  }
  // Same lock as begin: this is the linearization point.
  await assertAdmissionOpenTx(tx, input.hostId, input.now);
  const live = await tx.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM remote_desktop_host_routes
      WHERE host_id = $1 AND state <> 'closed'`,
    [input.hostId],
  );
  const hostLimit = Math.min(
    REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE,
    REMOTE_DESKTOP_LIMITS.MAX_PEER_CONNECTIONS_PER_WORKER,
    REMOTE_DESKTOP_LIMITS.MAX_TURN_ALLOCATIONS_PER_MACHINE,
  );
  if ((live?.count ?? 0) >= hostLimit) {
    throw new PrivacyBarrierError(PRIVACY_REFUSAL.ROUTE_LIMIT);
  }
  await tx.execute(
    `INSERT INTO remote_desktop_host_routes (
       route_id, route_generation, host_id, actor_source, actor_audit_id,
       execution_server_id, state, guest_session_id, reserved_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'admitting', $7, $8, $8)`,
    [
      input.routeId, input.routeGeneration, input.hostId, input.actorSource,
      input.actorAuditId ?? null, input.executionServerId ?? null,
      input.guestSessionId ?? null, input.now,
    ],
  );
}

/**
 * Promote a reserved route to Worker authority.
 *
 * Refused while any epoch is live. A route that has not reached PREPARE by the
 * time the gate closes was already cancelled, and letting a straggler activate
 * behind a closed gate would put an unshielded capture on screen.
 */
export async function activateRouteTx(tx: Database, input: {
  hostId: string;
  routeId: string;
  routeGeneration: number;
  now: number;
}): Promise<void> {
  const row = await lockPrivacyRowTx(tx, input.hostId);
  if (row && row.phase !== PHASE.IDLE) {
    throw new PrivacyBarrierError(PRIVACY_REFUSAL.ADMISSION_CLOSED);
  }
  const result = await tx.execute(
    `UPDATE remote_desktop_host_routes
        SET state = 'active', activated_at = $4, updated_at = $4
      WHERE route_id = $1 AND route_generation = $2 AND host_id = $3
        AND state = 'admitting'`,
    [input.routeId, input.routeGeneration, input.hostId, input.now],
  );
  if (result.changes === 0) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
}

/**
 * Close a route and repair a barrier that may have been waiting on it.
 *
 * A route that closes while the epoch is `starting` would otherwise deadlock
 * it: the Worker can never acknowledge a route that no longer exists, so the
 * epoch would sit until its lease expired and then fail into
 * `recovery_required`. Removing a closed route from the outstanding set is safe
 * precisely because a closed route is not capturing — this drops a shielding
 * obligation, never a capturing one. If removal empties the outstanding set the
 * barrier is satisfied and the epoch promotes to `active`.
 *
 * The route is removed from `acknowledged_routes` as well, so a later exact-set
 * acknowledgement still has to match the reduced snapshot.
 */
export async function closeRouteTx(tx: Database, input: {
  hostId: string;
  routeId: string;
  routeGeneration: number;
  now: number;
}): Promise<{ closed: boolean; snapshotRepaired: boolean; phase: PrivacyPhase | null }> {
  const row = await lockPrivacyRowTx(tx, input.hostId);
  const result = await tx.execute(
    `UPDATE remote_desktop_host_routes
        SET state = 'closed', closed_at = $4, updated_at = $4
      WHERE route_id = $1 AND route_generation = $2 AND host_id = $3
        AND state <> 'closed'`,
    [input.routeId, input.routeGeneration, input.hostId, input.now],
  );
  const closed = result.changes > 0;
  if (!row || row.phase === PHASE.IDLE) {
    return { closed, snapshotRepaired: false, phase: row ? (row.phase as PrivacyPhase) : null };
  }

  const key = routeKey({ routeId: input.routeId, routeGeneration: input.routeGeneration });
  const snapshot = parseRoutes(row.route_snapshot);
  const nextSnapshot = snapshot.filter((r) => routeKey(r) !== key);
  if (nextSnapshot.length === snapshot.length) {
    return { closed, snapshotRepaired: false, phase: row.phase as PrivacyPhase };
  }

  const nextAcknowledged = parseRoutes(row.acknowledged_routes).filter((r) => routeKey(r) !== key);
  // Only a starting epoch can be satisfied by removal. An epoch already past
  // the barrier keeps its phase; ending/recovery states are never relaxed here.
  const phase = row.phase === PHASE.STARTING && sameRouteSet(nextSnapshot, nextAcknowledged)
    ? PHASE.ACTIVE
    : (row.phase as PrivacyPhase);

  await tx.execute(
    `UPDATE remote_desktop_management_privacy SET
       route_snapshot = $2::jsonb, acknowledged_routes = $3::jsonb, phase = $4, updated_at = $5
     WHERE host_id = $1`,
    [
      input.hostId, JSON.stringify(nextSnapshot), JSON.stringify(nextAcknowledged),
      phase, input.now,
    ],
  );
  return { closed, snapshotRepaired: true, phase };
}

/** Registry read for status surfaces and tests. */
export async function getHostRoutesTx(tx: Database, hostId: string): Promise<RegisteredRoute[]> {
  const rows = await tx.query<{
    route_id: string; route_generation: number; host_id: string; actor_source: string;
    actor_audit_id: string | null; execution_server_id: string | null; state: string;
    guest_session_id: string | null;
  }>(
    `SELECT route_id, route_generation, host_id, actor_source, actor_audit_id,
            execution_server_id, state, guest_session_id
       FROM remote_desktop_host_routes
      WHERE host_id = $1
      ORDER BY route_id, route_generation`,
    [hostId],
  );
  return rows.map((row) => ({
    routeId: row.route_id,
    routeGeneration: row.route_generation,
    hostId: row.host_id,
    actorSource: row.actor_source as RouteActorSource,
    actorAuditId: row.actor_audit_id,
    executionServerId: row.execution_server_id,
    state: row.state as RouteState,
    guestSessionId: row.guest_session_id,
  }));
}

/** Convenience read for surfaces that only need the gate. */
export async function isAdmissionOpen(db: Database, hostId: string): Promise<boolean> {
  const state = await getPrivacyState(db, hostId);
  return state === null ? true : state.admissionOpen;
}

export interface BeginPrivacyEpochInput {
  hostId: string;
  epochId: string;
  presentationSource: RemoteDesktopPresentationSource;
  initiatingSessionHash: string;
  executionServerId: string;
  /** Null is valid only for a no-route management-Web epoch: no Worker command
   * is sent and no generation is being asserted. */
  daemonGeneration: number | null;
  leaseExpiresAt: number;
  deadline: number;
  now: number;
}

export interface BeginPrivacyEpochResult {
  epochId: string;
  revision: number;
  phase: PrivacyPhase;
  /** Routes the epoch cancelled. Caller emits one generic retryable outcome each. */
  cancelledPending: RouteRef[];
  /** Routes that must release input and acknowledge the shield. */
  shieldedActive: RouteRef[];
}

/**
 * Atomically close admission, classify routes and apply presentation policy.
 *
 * Ordering is the whole point: the admission gate closes under the same row
 * lock that classification reads, so a route crossing admission is deterministically
 * on exactly one side of the barrier.
 *
 * Presentation policy (task 4.4):
 *  - `management_web` may begin only when pending and active are both empty.
 *    Any live route is a refusal, whatever the client believes about local
 *    companion detection, and a direct API call reaches the same check.
 *  - `signed_shell` may begin with routes present: pending routes are
 *    cancelled, active routes must acknowledge the shield.
 *
 * With no active routes the barrier is vacuously authoritative and the epoch is
 * `active` immediately; otherwise it waits in `starting`.
 */
export async function beginPrivacyEpochTx(
  tx: Database,
  input: BeginPrivacyEpochInput,
): Promise<BeginPrivacyEpochResult> {
  assertSafeTimestamp(input.leaseExpiresAt, 'privacy_lease');
  assertSafeTimestamp(input.deadline, 'privacy_deadline');
  assertSafeTimestamp(input.now, 'privacy_time');
  if (input.daemonGeneration !== null) {
    assertGeneration(input.daemonGeneration, 'daemon_generation');
  }

  await ensurePrivacyRowTx(tx, input.hostId, input.now);
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_BUSY);
    if (row.phase === PHASE.RECOVERY_REQUIRED) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.RECOVERY_REQUIRED);
    }
    if (row.phase !== PHASE.IDLE) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_BUSY);

    const classification = await classifyHostRoutesTx(tx, input.hostId);

    // A guest route that exists but was never mirrored into the registry would
    // be invisible to classification. Refuse rather than shield over it.
    if (await countUnregisteredGuestRoutesTx(tx, input.hostId) > 0) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.ROUTES_PRESENT);
    }

    // Actor-neutral: an authenticated Owner route blocks management Web exactly
    // as a guest route does.
    if (input.presentationSource === REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB
      && (classification.pending.length > 0 || classification.active.length > 0)) {
      // Refuse without mutating: admission stays open and no epoch is issued.
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.ROUTES_PRESENT);
    }
    if (classification.active.length > 0 && input.daemonGeneration === null) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.STALE_GENERATION);
    }

    // Shell path cancels pending routes. They cannot reach Worker authority
    // under a closed gate, so they can neither satisfy nor delay the barrier.
    const cancelled = classification.pending;
    if (cancelled.length > 0) {
      await tx.execute(
        `UPDATE remote_desktop_host_routes
            SET state = 'closed', closed_at = $2, updated_at = $2
          WHERE host_id = $1 AND state = 'admitting'`,
        [input.hostId, input.now],
      );
      // Keep any mirrored guest session row consistent with its route.
      await tx.execute(
        `UPDATE remote_desktop_guest_sessions
            SET state = 'closed', closed_at = $2, updated_at = $2
          WHERE host_id = $1 AND state IN ('admitting', 'active')
            AND route_id = ANY($3::text[])`,
        [input.hostId, input.now, cancelled.map((route) => route.routeId)],
      );
    }

    const phase = classification.active.length === 0
      ? PHASE.ACTIVE
      : PHASE.STARTING;

    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         epoch_id = $2,
         revision = revision + 1,
         phase = $3,
         admission_open = FALSE,
         presentation_source = $4,
         initiating_session_hash = $5,
         execution_server_id = $6,
         daemon_generation = $7,
         worker_generation = NULL,
         route_snapshot = $8::jsonb,
         acknowledged_routes = '[]'::jsonb,
         lease_expires_at = $9,
         deadline = $10,
         recovery_reason = NULL,
         fresh_frame_generation = NULL,
         updated_at = $11
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [
        input.hostId, input.epochId, phase, input.presentationSource,
        input.initiatingSessionHash, input.executionServerId, input.daemonGeneration,
        JSON.stringify(classification.active), input.leaseExpiresAt, input.deadline, input.now,
      ],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_BUSY);

  return {
    epochId: input.epochId,
    revision: updated.revision,
    phase: updated.phase as PrivacyPhase,
    cancelledPending: cancelled,
    shieldedActive: classification.active,
  };
}

/** Deliver only after the transaction that closed admission has committed. */
export async function dispatchBeginPrivacyEpochEffects(
  input: BeginPrivacyEpochInput,
  result: BeginPrivacyEpochResult,
): Promise<void> {
  if (result.cancelledPending.length > 0) {
    try {
      await pendingRouteCancellationDispatcher?.({
        executionServerId: input.executionServerId,
        hostId: input.hostId,
        routes: result.cancelledPending,
      });
    } catch {
      // The durable close is fail-closed.  Never roll it back because a local
      // browser socket disappeared while the transaction was committing.
    }
  }
  if (result.phase === PHASE.STARTING && input.daemonGeneration !== null) {
    await dispatchPrivacyCommand({
      executionServerId: input.executionServerId,
      daemonGeneration: input.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
        hostId: input.hostId,
        epochId: input.epochId,
        revision: result.revision,
        presentationSource: input.presentationSource,
        deadlineAt: input.deadline,
        routeSnapshot: result.shieldedActive,
      },
    });
  }
}

export async function beginPrivacyEpoch(
  db: Database,
  input: BeginPrivacyEpochInput,
): Promise<BeginPrivacyEpochResult> {
  const result = await db.transaction((tx) => beginPrivacyEpochTx(tx, input));
  await dispatchBeginPrivacyEpochEffects(input, result);
  return result;
}

export interface ShieldedRouteReplacement {
  previous: RouteRef;
  replacement: RouteRef;
}

/**
 * Atomically replace route incarnations inside a live privacy epoch.
 *
 * The old rows are closed, replacement rows enter `shielding`, and the epoch
 * snapshot is replaced in the same PostgreSQL transaction.  A replacement is
 * therefore never absent from both the registry and the barrier.  Every prior
 * acknowledgement is invalidated and the revision advances, forcing a full
 * real Worker acknowledgement for the complete new snapshot.
 */
export async function replaceShieldedRoutes(
  db: Database,
  input: {
    hostId: string;
    epochId: string;
    executionServerId: string;
    daemonGeneration: number;
    replacements: readonly ShieldedRouteReplacement[];
    now: number;
  },
): Promise<PrivacyState> {
  assertGeneration(input.daemonGeneration, 'daemon_generation');
  assertSafeTimestamp(input.now, 'route_time');
  if (input.replacements.length === 0) {
    throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
  }
  const result = await db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if (row.phase !== PHASE.STARTING && row.phase !== PHASE.ACTIVE) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_SHIELDED);
    }
    if (row.execution_server_id !== input.executionServerId) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.WRONG_POD);
    }

    const snapshot = parseRoutes(row.route_snapshot);
    const snapshotByKey = new Map(snapshot.map((route) => [routeKey(route), route]));
    const previousKeys = new Set<string>();
    const replacementKeys = new Set<string>();
    for (const pair of input.replacements) {
      assertGeneration(pair.previous.routeGeneration, 'previous_route_generation');
      assertGeneration(pair.replacement.routeGeneration, 'replacement_route_generation');
      if (pair.previous.routeId !== pair.replacement.routeId) {
        throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
      }
      const previousKey = routeKey(pair.previous);
      const replacementKey = routeKey(pair.replacement);
      if (!snapshotByKey.has(previousKey)
        || previousKeys.has(previousKey)
        || replacementKeys.has(replacementKey)
        || previousKey === replacementKey) {
        throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
      }
      previousKeys.add(previousKey);
      replacementKeys.add(replacementKey);
    }

    for (const pair of input.replacements) {
      const previous = await tx.queryOne<{
        actor_source: string;
        actor_audit_id: string | null;
        guest_session_id: string | null;
        execution_server_id: string | null;
      }>(
        `SELECT actor_source, actor_audit_id, guest_session_id, execution_server_id
           FROM remote_desktop_host_routes
          WHERE host_id = $1 AND route_id = $2 AND route_generation = $3
          FOR UPDATE`,
        [input.hostId, pair.previous.routeId, pair.previous.routeGeneration],
      );
      if (!previous || previous.execution_server_id !== input.executionServerId) {
        throw new PrivacyBarrierError(PRIVACY_REFUSAL.WRONG_POD);
      }
      await tx.execute(
        `UPDATE remote_desktop_host_routes
            SET state = 'closed', closed_at = COALESCE(closed_at, $4), updated_at = $4
          WHERE host_id = $1 AND route_id = $2 AND route_generation = $3`,
        [input.hostId, pair.previous.routeId, pair.previous.routeGeneration, input.now],
      );
      await tx.execute(
        `INSERT INTO remote_desktop_host_routes (
           route_id, route_generation, host_id, actor_source, actor_audit_id,
           execution_server_id, state, guest_session_id, reserved_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'shielding', $7, $8, $8)`,
        [
          pair.replacement.routeId, pair.replacement.routeGeneration, input.hostId,
          previous.actor_source, previous.actor_audit_id, input.executionServerId,
          previous.guest_session_id, input.now,
        ],
      );
      if (previous.guest_session_id) {
        await tx.execute(
          `UPDATE remote_desktop_guest_sessions
              SET route_id = $2, route_generation = $3, updated_at = $4
            WHERE id = $1 AND state <> 'closed'`,
          [
            previous.guest_session_id, pair.replacement.routeId,
            pair.replacement.routeGeneration, input.now,
          ],
        );
      }
    }

    const replacementsByOld = new Map(
      input.replacements.map((pair) => [routeKey(pair.previous), pair.replacement]),
    );
    const nextSnapshot = sortRoutes(snapshot.map((route) => (
      replacementsByOld.get(routeKey(route)) ?? route
    )));
    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         revision = revision + 1,
         phase = $2,
         execution_server_id = $3,
         daemon_generation = $4,
         worker_generation = NULL,
         route_snapshot = $5::jsonb,
         acknowledged_routes = '[]'::jsonb,
         updated_at = $6
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [
        input.hostId, PHASE.STARTING, input.executionServerId,
        input.daemonGeneration, JSON.stringify(nextSnapshot), input.now,
      ],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });

  if (result.deadline === null || result.presentationSource === null) {
    throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
  }
  await dispatchPrivacyCommand({
    executionServerId: input.executionServerId,
    daemonGeneration: input.daemonGeneration,
    message: {
      type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
      hostId: input.hostId,
      epochId: input.epochId,
      revision: result.revision,
      presentationSource: result.presentationSource,
      deadlineAt: result.deadline,
      routeSnapshot: result.routeSnapshot,
    },
  });
  return result;
}

/** Promote only the exact, fully acknowledged replacement snapshot. */
export async function activateShieldedRouteReplacements(
  db: Database,
  input: {
    hostId: string;
    epochId: string;
    revision: number;
    routes: readonly RouteRef[];
    now: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId || row.revision !== input.revision
      || row.phase !== PHASE.ACTIVE
      || !sameRouteSet(parseRoutes(row.route_snapshot), input.routes)
      || !sameRouteSet(parseRoutes(row.acknowledged_routes), input.routes)) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_SHIELDED);
    }
    for (const route of input.routes) {
      const result = await tx.execute(
        `UPDATE remote_desktop_host_routes
            SET state = 'active', activated_at = COALESCE(activated_at, $4), updated_at = $4
          WHERE host_id = $1 AND route_id = $2 AND route_generation = $3
            AND state = 'shielding'`,
        [input.hostId, route.routeId, route.routeGeneration, input.now],
      );
      if (result.changes === 0) {
        const current = await tx.queryOne<{ state: string }>(
          `SELECT state FROM remote_desktop_host_routes
            WHERE host_id = $1 AND route_id = $2 AND route_generation = $3`,
          [input.hostId, route.routeId, route.routeGeneration],
        );
        if (current?.state !== ROUTE_STATE.ACTIVE) {
          throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
        }
      }
    }
  });
}

export interface AcknowledgeShieldInput {
  hostId: string;
  epochId: string;
  revision: number;
  /** Pod claiming to own the daemon channel. */
  executionServerId: string;
  daemonGeneration: number;
  workerGeneration: number;
  /** Complete active route set the Worker proved is showing the privacy frame. */
  acknowledgedRoutes: readonly RouteRef[];
  now: number;
}

/**
 * Owning-pod acknowledgement that the Worker generation and the complete active
 * route set show only the opaque branded privacy frame.
 *
 * Rejects wrong pod, stale daemon generation, epoch/revision mismatch and any
 * partial set. A subset never advances the phase — that is the fence that stops
 * secret UI from appearing while one route is still capturing.
 */
export async function acknowledgeShield(
  db: Database,
  input: AcknowledgeShieldInput,
): Promise<PrivacyState> {
  assertGeneration(input.workerGeneration, 'worker_generation');
  assertGeneration(input.daemonGeneration, 'daemon_generation');
  assertSafeTimestamp(input.now, 'privacy_time');

  return db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    if (row.epoch_id !== input.epochId || row.revision !== input.revision) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if (row.phase !== PHASE.STARTING) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_SHIELDED);
    }
    // Only the pod that currently owns the daemon channel may fence the Worker.
    if (row.execution_server_id !== input.executionServerId) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.WRONG_POD);
    }
    if (row.daemon_generation !== input.daemonGeneration) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.STALE_GENERATION);
    }
    // A later acknowledgement may not regress the Worker generation.
    if (row.worker_generation !== null && input.workerGeneration < row.worker_generation) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.STALE_GENERATION);
    }

    const required = parseRoutes(row.route_snapshot);
    const offered = sortRoutes(input.acknowledgedRoutes);
    if (!sameRouteSet(required, offered)) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.INCOMPLETE_ACK);
    }

    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         phase = $2, worker_generation = $3, acknowledged_routes = $4::jsonb, updated_at = $5
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [input.hostId, PHASE.ACTIVE, input.workerGeneration, JSON.stringify(offered), input.now],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });
}

/**
 * A route that reconnects or takes a new generation during an epoch stays
 * shielded and joins the required set.
 *
 * This deliberately regresses `active` back to `starting`: a newly arrived
 * generation has not yet proven it shows the privacy frame, so the barrier is
 * no longer authoritative and secret UI must stop.
 */
export async function joinShieldedRoute(
  db: Database,
  input:
    | { hostId: string; epochId: string; route: RouteRef; now: number }
    | {
      hostId: string;
      epochId: string;
      executionServerId: string;
      daemonGeneration: number;
      replacements: readonly ShieldedRouteReplacement[];
      now: number;
    },
): Promise<PrivacyState> {
  if ('replacements' in input) return replaceShieldedRoutes(db, input);
  return db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if (row.phase !== PHASE.STARTING && row.phase !== PHASE.ACTIVE) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_SHIELDED);
    }

    const snapshot = parseRoutes(row.route_snapshot);
    const acknowledged = parseRoutes(row.acknowledged_routes);
    const key = routeKey(input.route);
    const nextSnapshot = snapshot.some((r) => routeKey(r) === key)
      ? snapshot
      : sortRoutes([...snapshot, input.route]);
    const nextAcknowledged = acknowledged.filter((r) => routeKey(r) !== key);
    const phase = sameRouteSet(nextSnapshot, nextAcknowledged)
      ? PHASE.ACTIVE
      : PHASE.STARTING;

    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         route_snapshot = $2::jsonb, acknowledged_routes = $3::jsonb, phase = $4, updated_at = $5
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [
        input.hostId, JSON.stringify(nextSnapshot), JSON.stringify(nextAcknowledged),
        phase, input.now,
      ],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });
}

/**
 * Gate every secret-bearing mutation. The epoch must be the exact current one
 * and fully shielded; anything else fails closed.
 *
 * Caller must run this inside the transaction that performs the mutation, so a
 * concurrent route join or lease sweep cannot slip between check and write.
 */
export async function requireShieldedEpochTx(
  tx: Database,
  input: { hostId: string; epochId: string; revision: number },
): Promise<PrivacyState> {
  const row = await lockPrivacyRowTx(tx, input.hostId);
  if (!row
    || row.epoch_id !== input.epochId
    || row.revision !== input.revision
    || row.phase !== PHASE.ACTIVE
    || row.admission_open) {
    throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_SHIELDED);
  }
  return toState(row);
}

/**
 * Step one of ending: secret state is cleared. Admission stays closed and
 * capture stays shielded until a fresh non-secret frame is acknowledged.
 */
export async function beginPrivacyEnd(
  db: Database,
  input: { hostId: string; epochId: string; revision: number; now: number },
): Promise<PrivacyState> {
  const result = await db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId || row.revision !== input.revision) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if (row.phase !== PHASE.ACTIVE) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_SHIELDED);
    }
    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET phase = $2, updated_at = $3
        WHERE host_id = $1
        RETURNING ${PRIVACY_COLUMNS}`,
      [input.hostId, PHASE.ENDING, input.now],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });
  if (result.executionServerId !== null && result.daemonGeneration !== null) {
    await dispatchPrivacyCommand({
      executionServerId: result.executionServerId,
      daemonGeneration: result.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_PRIVACY_MSG.END,
        hostId: input.hostId,
        epochId: input.epochId,
        revision: input.revision,
        freshFrameWorkerGeneration: Math.max(1, (result.workerGeneration ?? 0) + 1),
      },
    });
  }
  return result;
}

/**
 * End the ordinary management-Web no-route gate after the browser has cleared
 * its last raw secret.
 *
 * Management Web is never allowed to begin while a pending or active route
 * exists, so a qualified Web epoch has no Worker generation and no route
 * snapshot to resume. Requiring a synthetic Worker/fresh-frame acknowledgement
 * here would strand an offline host in `ending` even though no capture existed.
 * Keep this as a separate, narrow transition: signed-shell epochs and any epoch
 * that ever acquired Worker authority still use `beginPrivacyEnd` plus the
 * strict fresh-frame acknowledgement.
 */
export async function endManagementWebPrivacy(
  db: Database,
  input: { hostId: string; epochId: string; revision: number; now: number },
): Promise<PrivacyState> {
  return db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId || row.revision !== input.revision) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if (row.phase !== PHASE.ACTIVE
      || row.presentation_source !== REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB
      || row.worker_generation !== null
      || parseRoutes(row.route_snapshot).length !== 0
      || parseRoutes(row.acknowledged_routes).length !== 0) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_RESUMING);
    }
    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         epoch_id = NULL, phase = 'idle', admission_open = TRUE,
         presentation_source = NULL, initiating_session_hash = NULL,
         execution_server_id = NULL, daemon_generation = NULL,
         worker_generation = NULL, route_snapshot = '[]'::jsonb,
         acknowledged_routes = '[]'::jsonb, lease_expires_at = NULL, deadline = NULL,
         recovery_reason = NULL, updated_at = $2
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [input.hostId, input.now],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });
}

/**
 * End a signed-shell epoch. A shell that began with no routes never acquired a
 * Worker generation, so after local secret cleanup it can return directly to
 * idle. Any epoch that did acquire Worker authority must use the full END +
 * fresh-frame acknowledgement path.
 */
export async function endSignedShellPrivacy(
  db: Database,
  input: { hostId: string; epochId: string; revision: number; now: number },
): Promise<PrivacyState> {
  const result = await db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId || row.revision !== input.revision) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if (row.phase !== PHASE.ACTIVE
      || row.presentation_source !== REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_SHIELDED);
    }
    const routes = parseRoutes(row.route_snapshot);
    if (routes.length === 0 && row.worker_generation === null) {
      const cleared = await tx.queryOne<PrivacyRow>(
        `UPDATE remote_desktop_management_privacy SET
           epoch_id = NULL, phase = 'idle', admission_open = TRUE,
           presentation_source = NULL, initiating_session_hash = NULL,
           execution_server_id = NULL, daemon_generation = NULL,
           worker_generation = NULL, route_snapshot = '[]'::jsonb,
           acknowledged_routes = '[]'::jsonb, lease_expires_at = NULL, deadline = NULL,
           recovery_reason = NULL, fresh_frame_generation = NULL, updated_at = $2
         WHERE host_id = $1
         RETURNING ${PRIVACY_COLUMNS}`,
        [input.hostId, input.now],
      );
      if (!cleared) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
      return { state: toState(cleared), dispatch: false };
    }
    const ending = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET phase = $2, updated_at = $3
        WHERE host_id = $1
        RETURNING ${PRIVACY_COLUMNS}`,
      [input.hostId, PHASE.ENDING, input.now],
    );
    if (!ending) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return { state: toState(ending), dispatch: true };
  });
  if (result.dispatch
    && result.state.executionServerId !== null
    && result.state.daemonGeneration !== null) {
    await dispatchPrivacyCommand({
      executionServerId: result.state.executionServerId,
      daemonGeneration: result.state.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_PRIVACY_MSG.END,
        hostId: input.hostId,
        epochId: input.epochId,
        revision: input.revision,
        freshFrameWorkerGeneration: Math.max(1, (result.state.workerGeneration ?? 0) + 1),
      },
    });
  }
  return result.state;
}

/**
 * Step two of ending: the owning pod proves a fresh post-secret frame.
 *
 * The frame generation must be strictly greater than the Worker generation that
 * carried the shield, so a cached pre-end frame cannot satisfy recovery. Only
 * then does admission reopen and the row return to idle.
 */
export async function acknowledgeFreshFrame(
  db: Database,
  input: {
    hostId: string;
    epochId: string;
    revision: number;
    executionServerId: string;
    daemonGeneration: number;
    freshFrameGeneration: number;
    acknowledgedRoutes: readonly RouteRef[];
    now: number;
  },
): Promise<PrivacyState> {
  assertGeneration(input.freshFrameGeneration, 'fresh_frame_generation');

  return db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId || row.revision !== input.revision) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if (row.phase !== PHASE.ENDING) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_RESUMING);
    }
    if (row.execution_server_id !== input.executionServerId) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.WRONG_POD);
    }
    if (row.daemon_generation !== input.daemonGeneration) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.STALE_GENERATION);
    }
    if (row.worker_generation !== null && input.freshFrameGeneration <= row.worker_generation) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.CACHED_FRAME);
    }
    if (!sameRouteSet(parseRoutes(row.route_snapshot), sortRoutes(input.acknowledgedRoutes))) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.INCOMPLETE_ACK);
    }

    // Returning to idle must satisfy the schema CHECK: idle implies open
    // admission and a null epoch.
    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         epoch_id = NULL, phase = 'idle', admission_open = TRUE,
         presentation_source = NULL, initiating_session_hash = NULL,
         worker_generation = NULL, route_snapshot = '[]'::jsonb,
         acknowledged_routes = '[]'::jsonb, lease_expires_at = NULL, deadline = NULL,
         recovery_reason = NULL, fresh_frame_generation = $2, updated_at = $3
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [input.hostId, input.freshFrameGeneration, input.now],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });
}

/**
 * Move an epoch to the terminal failure state. Admission stays closed and
 * capture stays shielded until an authoritative recovery proves cleanup.
 */
export async function markRecoveryRequired(
  db: Database,
  input: {
    hostId: string;
    epochId: string;
    reason: string;
    now: number;
    /** Optional exact fences used by the signed-shell HTTP recovery path. */
    expectedRevision?: number;
    expectedDaemonGeneration?: number;
    expectedPresentationSource?: RemoteDesktopPresentationSource;
  },
): Promise<PrivacyState> {
  return db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row || row.epoch_id !== input.epochId) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    if ((input.expectedRevision !== undefined && row.revision !== input.expectedRevision)
      || (input.expectedDaemonGeneration !== undefined
        && row.daemon_generation !== input.expectedDaemonGeneration)
      || (input.expectedPresentationSource !== undefined
        && row.presentation_source !== input.expectedPresentationSource)) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    }
    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         phase = $2, admission_open = FALSE, recovery_reason = $3, updated_at = $4
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [input.hostId, PHASE.RECOVERY_REQUIRED, input.reason.slice(0, 200), input.now],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });
}

/**
 * Restart/loss recovery. Any non-idle epoch whose lease or deadline has passed
 * becomes `recovery_required` rather than silently reopening admission.
 *
 * This is what makes begin/end message loss safe: durable state, not a pod's
 * memory of an in-flight command, decides whether capture may resume.
 */
export async function sweepExpiredPrivacyEpochs(
  db: Database,
  input: { now: number; limit?: number },
): Promise<{ recovered: string[] }> {
  const limit = input.limit ?? 100;
  const rows = await db.query<{ host_id: string }>(
    `UPDATE remote_desktop_management_privacy SET
       phase = $1, admission_open = FALSE,
       recovery_reason = COALESCE(recovery_reason, 'lease_expired'), updated_at = $2
     WHERE host_id IN (
       SELECT host_id FROM remote_desktop_management_privacy
        WHERE phase NOT IN ('idle', $1)
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at <= $2)
            OR (deadline IS NOT NULL AND deadline <= $2)
          )
        ORDER BY host_id
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     )
     RETURNING host_id`,
    [PHASE.RECOVERY_REQUIRED, input.now, limit],
  );
  return { recovered: rows.map((row) => row.host_id) };
}

/**
 * Clear a terminal epoch after authoritative cleanup has been proven. Separate
 * from the normal end path so recovery is always an explicit act.
 */
export async function clearRecoveredEpoch(
  db: Database,
  input: { hostId: string; now: number },
): Promise<PrivacyState> {
  return db.transaction(async (tx) => {
    const row = await lockPrivacyRowTx(tx, input.hostId);
    if (!row) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    if (row.phase !== PHASE.RECOVERY_REQUIRED) {
      throw new PrivacyBarrierError(PRIVACY_REFUSAL.NOT_RESUMING);
    }
    const updated = await tx.queryOne<PrivacyRow>(
      `UPDATE remote_desktop_management_privacy SET
         epoch_id = NULL, phase = 'idle', admission_open = TRUE,
         presentation_source = NULL, initiating_session_hash = NULL,
         worker_generation = NULL, route_snapshot = '[]'::jsonb,
         acknowledged_routes = '[]'::jsonb, lease_expires_at = NULL, deadline = NULL,
         recovery_reason = NULL, updated_at = $2
       WHERE host_id = $1
       RETURNING ${PRIVACY_COLUMNS}`,
      [input.hostId, input.now],
    );
    if (!updated) throw new PrivacyBarrierError(PRIVACY_REFUSAL.EPOCH_MISMATCH);
    return toState(updated);
  });
}
