import type { Database } from './client.js';
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

export async function createOrUpdateShare(
  db: Database,
  params: {
    id: string;
    target: ShareTarget;
    targetUserId: string;
    role: ShareRole;
    createdBy: string;
    expiresAt?: number | null;
    now: number;
  },
): Promise<ShareRow> {
  if (params.target.kind === 'server') {
    await db.execute(
      `INSERT INTO server_shares (id, server_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NULL)
       ON CONFLICT (server_id, target_user_id) DO UPDATE SET
         role = EXCLUDED.role,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at,
         revoked_at = NULL,
         created_at = CASE WHEN server_shares.revoked_at IS NULL THEN server_shares.created_at ELSE EXCLUDED.created_at END,
         created_by = EXCLUDED.created_by`,
      [params.id, params.target.serverId, params.targetUserId, params.role, params.createdBy, params.now, params.expiresAt ?? null],
    );
  } else if (params.target.kind === 'main') {
    await db.execute(
      `INSERT INTO session_shares (id, server_id, session_name, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, NULL)
       ON CONFLICT (server_id, session_name, target_user_id) DO UPDATE SET
         role = EXCLUDED.role,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at,
         revoked_at = NULL,
         created_at = CASE WHEN session_shares.revoked_at IS NULL THEN session_shares.created_at ELSE EXCLUDED.created_at END,
         created_by = EXCLUDED.created_by`,
      [params.id, params.target.serverId, params.target.sessionName, params.targetUserId, params.role, params.createdBy, params.now, params.expiresAt ?? null],
    );
  } else {
    await db.execute(
      `INSERT INTO sub_session_shares (id, server_id, sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, NULL)
       ON CONFLICT (server_id, sub_session_id, target_user_id) DO UPDATE SET
         role = EXCLUDED.role,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at,
         revoked_at = NULL,
         created_at = CASE WHEN sub_session_shares.revoked_at IS NULL THEN sub_session_shares.created_at ELSE EXCLUDED.created_at END,
         created_by = EXCLUDED.created_by`,
      [params.id, params.target.serverId, params.target.subSessionId, params.targetUserId, params.role, params.createdBy, params.now, params.expiresAt ?? null],
    );
  }

  const row = await getShareByTargetAndUser(db, params.target, params.targetUserId);
  if (!row) throw new Error('share_upsert_failed');
  return row;
}

export async function updateShare(
  db: Database,
  params: { shareId: string; serverId: string; role?: ShareRole; expiresAt?: number | null; now: number },
): Promise<ShareRow | null> {
  const current = await getShareById(db, params.serverId, params.shareId);
  if (!current) return null;
  const role = params.role ?? current.role;
  const expiresAt = Object.prototype.hasOwnProperty.call(params, 'expiresAt') ? params.expiresAt ?? null : current.expiresAt;
  const { table } = tableForTarget(current.target);
  await db.execute(
    `UPDATE ${table} SET role = $1, expires_at = $2, updated_at = $3 WHERE id = $4 AND server_id = $5`,
    [role, expiresAt, params.now, params.shareId, params.serverId],
  );
  return getShareById(db, params.serverId, params.shareId);
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

async function getShareByTargetAndUser(db: Database, target: ShareTarget, targetUserId: string): Promise<ShareRow | null> {
  if (target.kind === 'server') {
    const row = await db.queryOne<DbShareRow>(
      `SELECT 'server' AS target_kind, id, server_id, NULL::TEXT AS session_name, NULL::TEXT AS sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
         FROM server_shares WHERE server_id = $1 AND target_user_id = $2`,
      [target.serverId, targetUserId],
    );
    return row ? mapShareRow(row) : null;
  }
  if (target.kind === 'main') {
    const row = await db.queryOne<DbShareRow>(
      `SELECT 'main' AS target_kind, id, server_id, session_name, NULL::TEXT AS sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
         FROM session_shares WHERE server_id = $1 AND session_name = $2 AND target_user_id = $3`,
      [target.serverId, target.sessionName, targetUserId],
    );
    return row ? mapShareRow(row) : null;
  }
  const row = await db.queryOne<DbShareRow>(
    `SELECT 'subsession' AS target_kind, id, server_id, NULL::TEXT AS session_name, sub_session_id, target_user_id, role, created_by, created_at, updated_at, expires_at, revoked_at
       FROM sub_session_shares WHERE server_id = $1 AND sub_session_id = $2 AND target_user_id = $3`,
    [target.serverId, target.subSessionId, targetUserId],
  );
  return row ? mapShareRow(row) : null;
}

export async function resolveEffectiveShareCoverage(
  db: Database,
  params: { userId: string; target: ShareTarget; now: number },
): Promise<EffectiveCoverage | null> {
  if (!await targetExists(db, params.target)) return null;
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
