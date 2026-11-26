import type { Database } from './client.js';
import { isActorAndServerOwnerActive } from '../security/user-status.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
import {
  buildShareAuditIdempotencyKey,
  isActiveShareGrant as isSharedActiveShareGrant,
  normalizeShareTargetInput as normalizeSharedShareTargetInput,
  rawSubSessionIdFromDisplayName,
  resolveEffectiveCoverageForTarget,
  shareTargetKey,
  type EffectiveActorRole,
  type EffectiveCoverage,
  type ShareAuthorizationSnapshot,
  type ShareDenialReason,
  type ShareGrantLike,
  type ShareRole,
  type ShareScopedTicketClaims,
  type ShareTarget,
  type ShareTargetInput,
} from '../../../shared/tab-sharing.js';

export type {
  EffectiveActorRole,
  EffectiveCoverage,
  ShareAuthorizationSnapshot,
  ShareDenialReason,
  ShareRole,
  ShareScopedTicketClaims,
  ShareTarget,
  ShareTargetInput,
};

export type ShareTargetKind = ShareTarget['kind'];

export type ShareAuditActionType =
  | 'share.create'
  | 'share.update'
  | 'share.revoke'
  | 'share.downgrade'
  | 'share.expire'
  | 'share.target_delete'
  | 'session.send'
  | 'session.supervision'
  | 'session.cancel'
  | 'discussion.comment'
  | 'p2p.orchestration'
  | 'rate_limit';

export type ShareAuditDecision = 'accepted' | 'rejected' | 'updated' | 'teardown';

const ACTIVE_SQL = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $1)';
const SUBSESSION_PREFIX = 'deck_sub_';

export interface ShareRow {
  id: string;
  targetKind: ShareTargetKind;
  target: ShareTarget;
  serverId: string;
  targetUserId: string;
  role: ShareRole;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface DbShareRow {
  id: string;
  target_kind: ShareTargetKind;
  server_id: string;
  session_name: string | null;
  sub_session_id: string | null;
  target_user_id: string;
  role: ShareRole;
  created_by: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export function isActiveShareGrant(row: { revokedAt?: number | null; revoked_at?: number | null; expiresAt?: number | null; expires_at?: number | null }, now: number): boolean {
  const revokedAt = row.revokedAt ?? row.revoked_at ?? null;
  const expiresAt = row.expiresAt ?? row.expires_at ?? null;
  return isSharedActiveShareGrant({ revokedAt, expiresAt }, now);
}

export function shareTargetRef(target: ShareTarget): string {
  if (target.kind === 'server') return target.serverId;
  if (target.kind === 'main') return target.sessionName;
  return target.subSessionId;
}

export function shareTargetSessionName(target: ShareTarget): string | null {
  if (target.kind === 'main') return target.sessionName;
  if (target.kind === 'subsession') return `${SUBSESSION_PREFIX}${target.subSessionId}`;
  return null;
}

export function shareTargetFromSessionName(serverId: string, sessionName: string): ShareTarget | null {
  const trimmed = sessionName.trim();
  if (!trimmed) return null;
  const subSessionId = rawSubSessionIdFromDisplayName(trimmed);
  if (subSessionId) return { kind: 'subsession', serverId, subSessionId };
  if (trimmed.startsWith(SUBSESSION_PREFIX)) return null;
  return { kind: 'main', serverId, sessionName: trimmed };
}

export function normalizeShareTargetInput(input: ShareTargetInput): ShareTarget | null {
  const normalized = normalizeSharedShareTargetInput(input);
  return normalized.ok ? normalized.target : null;
}

export async function normalizeExistingShareTarget(db: Database, input: ShareTargetInput): Promise<ShareTarget | null> {
  const target = normalizeShareTargetInput(input);
  if (!target) return null;
  if (target.kind === 'server') {
    const row = await db.queryOne<{ id: string }>('SELECT id FROM servers WHERE id = $1', [target.serverId]);
    return row ? target : null;
  }
  if (target.kind === 'main') {
    const row = await db.queryOne<{ name: string }>(
      'SELECT name FROM sessions WHERE server_id = $1 AND name = $2',
      [target.serverId, target.sessionName],
    );
    return row ? target : null;
  }
  const row = await db.queryOne<{ id: string }>(
    'SELECT id FROM sub_sessions WHERE server_id = $1 AND id = $2 AND closed_at IS NULL',
    [target.serverId, target.subSessionId],
  );
  return row ? target : null;
}

/** Invalid execute combinations are rejected before any mutation, also for DB callers. */
export class InvalidShareExecGrantError extends Error {
  constructor() { super('exec_grant_requires_controlled_device_participant'); }
}

async function validateShareExecGrant(db: Database, target: ShareTarget, role: ShareRole, granted?: boolean): Promise<void> {
  if (granted !== true) return;
  if (target.kind !== 'server' || role !== 'participant') throw new InvalidShareExecGrantError();
  const server = await db.queryOne<{ node_role: string }>('SELECT node_role FROM servers WHERE id = $1', [target.serverId]);
  if (server?.node_role !== NODE_ROLE.CONTROLLED) throw new InvalidShareExecGrantError();
}

// RETURNING captures exactly the committed mutation, not a later concurrent writer's row.
function mutationProjection(target: ShareTarget): string {
  return `'${target.kind}' AS target_kind, id, server_id,
    ${target.kind === 'main' ? 'session_name' : 'NULL::TEXT AS session_name'},
    ${target.kind === 'subsession' ? 'sub_session_id' : 'NULL::TEXT AS sub_session_id'},
    target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at,
    ${target.kind === 'server' ? 'exec_granted' : 'FALSE AS exec_granted'}`;
}

type ShareMutationRow = ShareRow & { execGranted: boolean };
type DbShareMutationRow = DbShareRow & { exec_granted: boolean };
function mapShareMutation(row: DbShareMutationRow): ShareMutationRow {
  return { ...mapShareRow(row), execGranted: row.exec_granted };
}

export async function createOrUpdateShare(
  db: Database,
  params: {
    id: string;
    target: ShareTarget;
    targetUserId: string;
    role: ShareRole;
    createdBy: string;
    expiresAt?: number | null;
    execGranted?: boolean;
    now: number;
  },
): Promise<ShareMutationRow> {
  await validateShareExecGrant(db, params.target, params.role, params.execGranted);
  const { table } = tableForTarget(params.target);
  const targetColumn = params.target.kind === 'main' ? 'session_name' : 'sub_session_id';
  const targetValue = params.target.kind === 'main' ? params.target.sessionName
    : params.target.kind === 'subsession' ? params.target.subSessionId : null;
  const isServer = params.target.kind === 'server';
  const row = await db.queryOne<DbShareMutationRow>(
    `INSERT INTO ${table} (id, server_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at,
       ${isServer ? 'exec_granted' : targetColumn})
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NULL, $8)
     ON CONFLICT (server_id, ${isServer ? '' : `${targetColumn}, `}target_user_id) DO UPDATE SET
       role = EXCLUDED.role,
       ${isServer ? 'exec_granted = EXCLUDED.exec_granted,' : ''}
       expires_at = EXCLUDED.expires_at,
       updated_at = EXCLUDED.updated_at,
       revoked_at = NULL,
       created_at = CASE WHEN ${table}.revoked_at IS NULL THEN ${table}.created_at ELSE EXCLUDED.created_at END,
       created_by = EXCLUDED.created_by
     RETURNING ${mutationProjection(params.target)}`,
    [params.id, params.target.serverId, params.targetUserId, params.role, params.createdBy,
      params.now, params.expiresAt ?? null, isServer ? params.execGranted === true : targetValue],
  );
  if (!row) throw new Error('share_upsert_failed');
  return mapShareMutation(row);
}

export async function updateShare(
  db: Database,
  params: { shareId: string; serverId: string; role?: ShareRole; expiresAt?: number | null; execGranted?: boolean; now: number },
): Promise<ShareMutationRow | null> {
  // Target identity cannot be patched. Lock its concrete table row before deriving
  // omitted values or validating role+grant, so concurrent patches cannot use stale roles.
  const identity = await getShareById(db, params.serverId, params.shareId);
  if (!identity) return null;
  const { table } = tableForTarget(identity.target);
  return db.transaction(async (tx) => {
    const current = await tx.queryOne<DbShareMutationRow>(
      `SELECT ${mutationProjection(identity.target)} FROM ${table} WHERE id = $1 AND server_id = $2 FOR UPDATE`,
      [params.shareId, params.serverId],
    );
    if (!current) return null;
    const role = params.role ?? current.role;
    await validateShareExecGrant(tx, identity.target, role, params.execGranted);
    // undefined (including a route's explicit undefined property) means omitted;
    // null alone clears expiration. A role downgrade always revokes execute atomically.
    const expiresAt = params.expiresAt === undefined ? current.expires_at : params.expiresAt;
    const execGranted = role === 'participant' && (params.execGranted ?? current.exec_granted);
    const row = await tx.queryOne<DbShareMutationRow>(
      `UPDATE ${table} SET role = $1, expires_at = $2, updated_at = $3
         ${identity.target.kind === 'server' ? ', exec_granted = $6' : ''}
       WHERE id = $4 AND server_id = $5 RETURNING ${mutationProjection(identity.target)}`,
      [role, expiresAt, params.now, params.shareId, params.serverId,
        ...(identity.target.kind === 'server' ? [execGranted] : [])],
    );
    return row ? mapShareMutation(row) : null;
  });
}

export async function revokeShare(db: Database, params: { shareId: string; serverId: string; now: number }): Promise<ShareRow | null> {
  const current = await getShareById(db, params.serverId, params.shareId);
  if (!current) return null;
  const { table } = tableForTarget(current.target);
  await db.execute(
    `UPDATE ${table} SET revoked_at = $1, updated_at = $1 WHERE id = $2 AND server_id = $3`,
    [params.now, params.shareId, params.serverId],
  );
  return getShareById(db, params.serverId, params.shareId);
}

/**
 * Revoke every active share pointing at a sub-session.
 *
 * Closing a shared sub-session already tears the recipient's socket down —
 * `targetExists` requires `closed_at IS NULL`, so coverage resolves to null and
 * `revalidateShareSocketsForTarget` closes the socket. From the owner's side
 * that looks like revocation. It was not: the grant row survived, and the
 * daemon's sub-session upsert sets `closed_at = NULL` again
 * (`queries.ts` ON CONFLICT ... closed_at = NULL), so reopening the same id
 * silently restored the recipient's access with no new authorization event.
 *
 * Revoking here makes the observed behaviour the real one. Re-opening the tab
 * now requires re-sharing it, which matches what the owner already saw happen.
 */
export async function revokeSharesForSubSession(
  db: Database,
  params: { serverId: string; subSessionId: string; now: number },
): Promise<number> {
  const result = await db.execute(
    'UPDATE sub_session_shares SET revoked_at = $1, updated_at = $1 WHERE sub_session_id = $2 AND server_id = $3 AND revoked_at IS NULL',
    [params.now, params.subSessionId, params.serverId],
  );
  return result?.changes ?? 0;
}

export async function listManagedShares(db: Database, serverId: string): Promise<ShareRow[]> {
  return mapShareRows(await db.query<DbShareRow>(allSharesSql('WHERE server_id = $1 ORDER BY created_at DESC'), [serverId]));
}

export async function listActiveSharesForUser(db: Database, userId: string, now: number): Promise<ShareRow[]> {
  return mapShareRows(await db.query<DbShareRow>(
    allSharesSql(`WHERE target_user_id = $2 AND ${ACTIVE_SQL} ORDER BY created_at ASC`),
    [now, userId],
  ));
}

export async function getShareById(db: Database, serverId: string, shareId: string): Promise<ShareRow | null> {
  const rows = await db.query<DbShareRow>(
    allSharesSql('WHERE server_id = $1 AND id = $2 LIMIT 1'),
    [serverId, shareId],
  );
  return mapShareRows(rows)[0] ?? null;
}

export async function resolveEffectiveShareCoverage(
  db: Database,
  params: { userId: string; target: ShareTarget; now: number },
): Promise<EffectiveCoverage | null> {
  if (!await targetExists(db, params.target)) return null;
  // A disabled grantee operates nothing, and a server whose owner is disabled is out of service for everyone it was shared with.
  if (!await isActorAndServerOwnerActive(db, params.userId, params.target.serverId)) return null;
  const rows = await coveringShareRows(db, params.userId, params.target, params.now);
  if (rows.length === 0) return null;
  const grants: ShareGrantLike[] = rows.map((row) => ({
    id: row.id,
    target: row.target,
    role: row.role,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  }));
  return resolveEffectiveCoverageForTarget(params.target, grants, params.now);
}

export async function targetExists(db: Database, target: ShareTarget): Promise<boolean> {
  if (target.kind === 'server') {
    const row = await db.queryOne<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM servers WHERE id = $1) AS exists', [target.serverId]);
    return row?.exists === true;
  }
  if (target.kind === 'main') {
    const row = await db.queryOne<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2) AS exists', [target.serverId, target.sessionName]);
    return row?.exists === true;
  }
  const row = await db.queryOne<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM sub_sessions WHERE server_id = $1 AND id = $2 AND closed_at IS NULL) AS exists', [target.serverId, target.subSessionId]);
  return row?.exists === true;
}

export interface ShareAuditWrite {
  id: string;
  serverId: string;
  actorKind: 'user' | 'system';
  actorUserId?: string | null;
  targetUserId?: string | null;
  effectiveActorRole: EffectiveActorRole;
  target: ShareTarget;
  actionType: ShareAuditActionType;
  decision: ShareAuditDecision;
  reason?: ShareDenialReason | null;
  snapshot: Record<string, unknown> | ShareAuthorizationSnapshot;
  primaryShareId?: string | null;
  actionId?: string | null;
  idempotencyKey: string;
  createdAt: number;
}

export async function writeShareAuditEvent(db: Database, event: ShareAuditWrite): Promise<{ inserted: boolean }> {
  const result = await db.execute(
    `INSERT INTO share_audit_events (
       id, server_id, actor_kind, actor_user_id, target_user_id, effective_actor_role,
       target_kind, target_ref, action_type, decision, reason, snapshot,
       primary_share_id, action_id, idempotency_key, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [
      event.id,
      event.serverId,
      event.actorKind,
      event.actorUserId ?? null,
      event.targetUserId ?? null,
      event.effectiveActorRole,
      event.target.kind,
      shareTargetRef(event.target),
      event.actionType,
      event.decision,
      event.reason ?? null,
      JSON.stringify(event.snapshot),
      event.primaryShareId ?? null,
      event.actionId ?? null,
      event.idempotencyKey,
      event.createdAt,
    ],
  );
  return { inserted: result.changes > 0 };
}

export function deriveShareTransitionKey(params: {
  actionType: ShareAuditActionType;
  target: ShareTarget;
  primaryShareId?: string | null;
  transitionEpochMs: number;
  decision?: string | null;
  attemptId?: string | null;
}): string {
  return buildShareAuditIdempotencyKey({
    actionType: params.actionType,
    targetKind: params.target.kind,
    targetRef: shareTargetKey(params.target),
    primaryShareId: params.primaryShareId ?? null,
    transitionEpochMs: params.transitionEpochMs,
    decision: params.decision ?? null,
    attemptId: params.attemptId ?? null,
  });
}

async function coveringShareRows(db: Database, userId: string, target: ShareTarget, now: number): Promise<ShareRow[]> {
  const rows: DbShareRow[] = [];
  rows.push(...await db.query<DbShareRow>(
    `SELECT 'server' AS target_kind, id, server_id, NULL::TEXT AS session_name, NULL::TEXT AS sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
       FROM server_shares
      WHERE ${ACTIVE_SQL} AND target_user_id = $2 AND server_id = $3`,
    [now, userId, target.serverId],
  ));

  if (target.kind === 'main') {
    rows.push(...await db.query<DbShareRow>(
      `SELECT 'main' AS target_kind, id, server_id, session_name, NULL::TEXT AS sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
         FROM session_shares
        WHERE ${ACTIVE_SQL} AND target_user_id = $2 AND server_id = $3 AND session_name = $4`,
      [now, userId, target.serverId, target.sessionName],
    ));
  } else if (target.kind === 'subsession') {
    rows.push(...await db.query<DbShareRow>(
      `SELECT 'subsession' AS target_kind, id, server_id, NULL::TEXT AS session_name, sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
         FROM sub_session_shares
        WHERE ${ACTIVE_SQL} AND target_user_id = $2 AND server_id = $3 AND sub_session_id = $4`,
      [now, userId, target.serverId, target.subSessionId],
    ));
  }

  return mapShareRows(rows);
}

function allSharesSql(whereClause: string): string {
  return `
    SELECT * FROM (
      SELECT 'server' AS target_kind, id, server_id, NULL::TEXT AS session_name, NULL::TEXT AS sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
        FROM server_shares
      UNION ALL
      SELECT 'main' AS target_kind, id, server_id, session_name, NULL::TEXT AS sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
        FROM session_shares
      UNION ALL
      SELECT 'subsession' AS target_kind, id, server_id, NULL::TEXT AS session_name, sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
        FROM sub_session_shares
    ) shares ${whereClause}
  `;
}

function mapShareRows(rows: DbShareRow[]): ShareRow[] {
  return rows.map(mapShareRow);
}

function mapShareRow(row: DbShareRow): ShareRow {
  const target = row.target_kind === 'server'
    ? { kind: 'server' as const, serverId: row.server_id }
    : row.target_kind === 'main'
      ? { kind: 'main' as const, serverId: row.server_id, sessionName: row.session_name ?? '' }
      : { kind: 'subsession' as const, serverId: row.server_id, subSessionId: row.sub_session_id ?? '' };
  return {
    id: row.id,
    targetKind: row.target_kind,
    target,
    serverId: row.server_id,
    targetUserId: row.target_user_id,
    role: row.role,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function tableForTarget(target: ShareTarget): { table: 'server_shares' | 'session_shares' | 'sub_session_shares' } {
  if (target.kind === 'server') return { table: 'server_shares' };
  if (target.kind === 'main') return { table: 'session_shares' };
  return { table: 'sub_session_shares' };
}

/**
 * The per-device EXECUTE grant lives on the server-level share row (migration 100). It is meaningful only for a `participant` role: a
 * viewer row can never carry it, and a role change away from participant clears it in the same statement.
 */
export async function setServerShareExecGrant(
  db: Database,
  params: { shareId: string; serverId: string; granted: boolean; now: number },
): Promise<void> {
  const share = await getShareById(db, params.serverId, params.shareId);
  if (share?.target.kind === 'server') {
    await updateShare(db, { shareId: params.shareId, serverId: params.serverId, execGranted: params.granted, now: params.now });
  }
}

/** share id -> execute grant for the server-level shares of one device (absent id = no grant). */
export async function listServerShareExecGrants(db: Database, serverId: string): Promise<Map<string, boolean>> {
  const rows = await db.query<{ id: string; exec_granted: boolean }>(
    'SELECT id, exec_granted FROM server_shares WHERE server_id = $1',
    [serverId],
  );
  return new Map(rows.map((row) => [row.id, row.exec_granted === true]));
}
