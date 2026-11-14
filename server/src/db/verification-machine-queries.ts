import type { Database } from './client.js';
import type {
  VerificationMachineKind,
  VerificationMachineProfile,
  VerificationMachineScope,
  VerificationMachineStatus,
} from '../../../shared/verification-machine.js';
import { VERIFICATION_MACHINE_LIMITS } from '../../../shared/verification-machine.js';

interface VerificationMachineRow {
  id: string;
  scope: VerificationMachineScope;
  scope_key: string;
  alias: string;
  kind: VerificationMachineKind;
  target: string;
  enabled: boolean;
  revision: number;
  created_at: number;
  updated_at: number;
  last_verified_at: number | null;
  last_verification_status: VerificationMachineStatus;
  source: 'web' | 'mcp';
}

function mapRow(row: VerificationMachineRow): VerificationMachineProfile {
  return {
    id: row.id,
    scope: row.scope,
    scopeKey: row.scope_key,
    alias: row.alias,
    kind: row.kind,
    target: row.target,
    enabled: row.enabled,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_verified_at === null ? {} : { lastVerifiedAt: Number(row.last_verified_at) }),
    lastVerificationStatus: row.last_verification_status,
    source: row.source,
  };
}

const COLUMNS = `id, scope, scope_key, alias, kind, target, enabled, revision,
  created_at, updated_at, last_verified_at, last_verification_status, source`;

const LIST_COLUMNS = `id, scope, scope_key,
  CASE WHEN kind = 'ssh' THEN COALESCE(
    (SELECT name FROM user_aliases
      WHERE user_id = verification_machine_profiles.user_id
        AND id = verification_machine_profiles.target),
    alias
  ) ELSE alias END AS alias,
  kind, target, enabled, revision, created_at, updated_at,
  last_verified_at, last_verification_status, source`;

export async function listVerificationMachines(
  db: Database,
  userId: string,
  projectKey?: string,
  options?: { includeAllProjects?: boolean },
): Promise<VerificationMachineProfile[]> {
  const includeAllProjects = options?.includeAllProjects === true;
  const rows = await db.query<VerificationMachineRow>(
    includeAllProjects
      ? `SELECT ${LIST_COLUMNS}
           FROM verification_machine_profiles
          WHERE user_id = $1
          ORDER BY
            CASE
              WHEN $2::text IS NOT NULL AND scope = 'project' AND scope_key = $2 THEN 0
              WHEN scope = 'project' THEN 1
              ELSE 2
            END,
            scope_key ASC,
            alias ASC
          LIMIT $3`
      : `SELECT ${LIST_COLUMNS}
           FROM verification_machine_profiles
          WHERE user_id = $1
            AND (scope = 'user' OR ($2::text IS NOT NULL AND scope = 'project' AND scope_key = $2))
          ORDER BY CASE scope WHEN 'project' THEN 0 ELSE 1 END, alias ASC
          LIMIT $3`,
    [userId, projectKey ?? null, VERIFICATION_MACHINE_LIMITS.MAX_ITEMS + 1],
  );
  return rows.map(mapRow);
}

export async function getVerificationMachine(
  db: Database,
  userId: string,
  id: string,
): Promise<VerificationMachineProfile | null> {
  const row = await db.queryOne<VerificationMachineRow>(
    `SELECT ${COLUMNS} FROM verification_machine_profiles WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  return row ? mapRow(row) : null;
}

export async function upsertVerificationMachine(
  db: Database,
  input: {
    id: string;
    userId: string;
    scope: VerificationMachineScope;
    scopeKey: string;
    alias: string;
    kind: VerificationMachineKind;
    target: string;
    enabled: boolean;
    source: 'web' | 'mcp';
    expectedRevision?: number;
  },
): Promise<VerificationMachineProfile | 'revision_conflict' | 'alias_conflict' | 'not_found'> {
  const now = Date.now();
  try {
    if (input.expectedRevision !== undefined && input.expectedRevision > 0) {
      const row = await db.queryOne<VerificationMachineRow>(
        `UPDATE verification_machine_profiles
            SET scope = $3,
                scope_key = $4,
                alias = $5,
                kind = $6,
                target = $7,
                enabled = $8,
                revision = revision + 1,
                updated_at = $9,
                last_verified_at = CASE
                  WHEN kind = $6 AND target = $7
                  THEN last_verified_at ELSE NULL END,
                last_verification_status = CASE
                  WHEN kind = $6 AND target = $7
                  THEN last_verification_status ELSE 'unverified' END,
                source = $10
          WHERE user_id = $1
            AND id = $2
            AND revision = $11::bigint
          RETURNING ${COLUMNS}`,
        [input.userId, input.id, input.scope, input.scopeKey, input.alias, input.kind,
          input.target, input.enabled, now, input.source, input.expectedRevision],
      );
      if (row) return mapRow(row);
      return (await getVerificationMachine(db, input.userId, input.id)) ? 'revision_conflict' : 'not_found';
    }

    const baseParams = [
      input.id,
      input.userId,
      input.scope,
      input.scopeKey,
      input.alias,
      input.kind,
      input.target,
      input.enabled,
      now,
      input.source,
    ];
    const row = input.expectedRevision === 0
      ? await db.queryOne<VerificationMachineRow>(
          `INSERT INTO verification_machine_profiles
            (id, user_id, scope, scope_key, alias, kind, target, enabled, revision,
             created_at, updated_at, last_verified_at, last_verification_status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9, NULL, 'unverified', $10)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${COLUMNS}`,
          baseParams,
        )
      : await db.queryOne<VerificationMachineRow>(
          `INSERT INTO verification_machine_profiles
            (id, user_id, scope, scope_key, alias, kind, target, enabled, revision,
             created_at, updated_at, last_verified_at, last_verification_status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9, NULL, 'unverified', $10)
           ON CONFLICT (id) DO UPDATE SET
             scope = excluded.scope,
             scope_key = excluded.scope_key,
             alias = excluded.alias,
             kind = excluded.kind,
             target = excluded.target,
             enabled = excluded.enabled,
             revision = verification_machine_profiles.revision + 1,
             updated_at = excluded.updated_at,
             last_verified_at = CASE
               WHEN verification_machine_profiles.kind = excluded.kind
                AND verification_machine_profiles.target = excluded.target
               THEN verification_machine_profiles.last_verified_at ELSE NULL END,
             last_verification_status = CASE
               WHEN verification_machine_profiles.kind = excluded.kind
                AND verification_machine_profiles.target = excluded.target
               THEN verification_machine_profiles.last_verification_status ELSE 'unverified' END,
             source = excluded.source
           WHERE verification_machine_profiles.user_id = excluded.user_id
           RETURNING ${COLUMNS}`,
          baseParams,
        );
    if (row) return mapRow(row);
    return 'revision_conflict';
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === '23505') return 'alias_conflict';
    throw err;
  }
}

export async function deleteVerificationMachine(
  db: Database,
  userId: string,
  id: string,
  expectedRevision?: number,
): Promise<'deleted' | 'not_found' | 'revision_conflict'> {
  const result = await db.execute(
    `DELETE FROM verification_machine_profiles
      WHERE user_id = $1 AND id = $2 AND ($3::bigint IS NULL OR revision = $3::bigint)`,
    [userId, id, expectedRevision ?? null],
  );
  if (result.changes > 0) return 'deleted';
  if (expectedRevision === undefined) return 'not_found';
  return await getVerificationMachine(db, userId, id) ? 'revision_conflict' : 'not_found';
}

export async function recordVerificationMachineStatus(
  db: Database,
  userId: string,
  id: string,
  status: VerificationMachineStatus,
): Promise<VerificationMachineProfile | null> {
  const now = Date.now();
  const row = await db.queryOne<VerificationMachineRow>(
    `UPDATE verification_machine_profiles
        SET last_verified_at = $3, last_verification_status = $4,
            revision = revision + 1, updated_at = $3
      WHERE user_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [userId, id, now, status],
  );
  return row ? mapRow(row) : null;
}
