import type { Database } from './client.js';
import type { SessionIdentityProfile, SessionIdentityScope } from '../../../shared/session-identity.js';

interface IdentityProfileRow {
  scope: SessionIdentityScope;
  scope_key: string;
  content: string;
  content_hash: string;
  revision: number;
  updated_at: number;
  source: 'web' | 'mcp';
  source_file: string | null;
}

function mapRow(row: IdentityProfileRow): SessionIdentityProfile {
  return {
    scope: row.scope,
    scopeKey: row.scope_key,
    content: row.content,
    contentHash: row.content_hash,
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
    source: row.source,
    ...(row.source_file ? { sourceFile: row.source_file } : {}),
  };
}

export async function getSessionIdentityProfile(
  db: Database,
  userId: string,
  scope: SessionIdentityScope,
  scopeKey: string,
): Promise<SessionIdentityProfile | null> {
  const row = await db.queryOne<IdentityProfileRow>(
    `SELECT scope, scope_key, content, content_hash, revision, updated_at, source, source_file
       FROM session_identity_profiles
      WHERE user_id = $1 AND scope = $2 AND scope_key = $3`,
    [userId, scope, scopeKey],
  );
  return row ? mapRow(row) : null;
}

export async function listSessionIdentityProfiles(
  db: Database,
  userId: string,
): Promise<SessionIdentityProfile[]> {
  const rows = await db.query<IdentityProfileRow>(
    `SELECT scope, scope_key, content, content_hash, revision, updated_at, source, source_file
       FROM session_identity_profiles
      WHERE user_id = $1
      ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
               scope_key ASC`,
    [userId],
  );
  return rows.map(mapRow);
}

export async function upsertSessionIdentityProfile(
  db: Database,
  input: {
    userId: string;
    scope: SessionIdentityScope;
    scopeKey: string;
    content: string;
    contentHash: string;
    source: 'web' | 'mcp';
    expectedRevision?: number;
    sourceFile?: string;
  },
): Promise<SessionIdentityProfile | 'revision_conflict'> {
  const now = Date.now();
  const values: unknown[] = [
    input.userId,
    input.scope,
    input.scopeKey,
    input.content,
    input.contentHash,
    input.source,
    now,
    input.expectedRevision ?? null,
    input.sourceFile ?? null,
  ];
  const row = await db.queryOne<IdentityProfileRow>(
    `INSERT INTO session_identity_profiles
       (user_id, scope, scope_key, content, content_hash, source, revision, updated_at, source_file)
     SELECT $1, $2, $3, $4, $5, $6, 1, $7, $9
      WHERE $8::bigint IS NULL OR $8::bigint = 0
     ON CONFLICT (user_id, scope, scope_key) DO UPDATE SET
       content = excluded.content,
       content_hash = excluded.content_hash,
       source = excluded.source,
       source_file = excluded.source_file,
       revision = session_identity_profiles.revision + 1,
       updated_at = excluded.updated_at
      WHERE $8::bigint IS NULL OR session_identity_profiles.revision = $8::bigint
     RETURNING scope, scope_key, content, content_hash, revision, updated_at, source, source_file`,
    values,
  );
  return row ? mapRow(row) : 'revision_conflict';
}

export async function deleteSessionIdentityProfile(
  db: Database,
  userId: string,
  scope: SessionIdentityScope,
  scopeKey: string,
  expectedRevision?: number,
): Promise<'deleted' | 'not_found' | 'revision_conflict'> {
  const result = await db.execute(
    `DELETE FROM session_identity_profiles
      WHERE user_id = $1 AND scope = $2 AND scope_key = $3
        AND ($4::bigint IS NULL OR revision = $4::bigint)`,
    [userId, scope, scopeKey, expectedRevision ?? null],
  );
  if (result.changes > 0) return 'deleted';
  if (expectedRevision === undefined) return 'not_found';
  return await getSessionIdentityProfile(db, userId, scope, scopeKey)
    ? 'revision_conflict'
    : 'not_found';
}
