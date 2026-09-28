import type { Database } from './client.js';
import {
  SESSION_IDENTITY_SYNC_MAX_BYTES,
  SESSION_IDENTITY_SYNC_MAX_PROFILES,
  SESSION_IDENTITY_SYNC_STATEMENT_TIMEOUT_MS,
  type SessionIdentityProfile,
  type SessionIdentityScope,
} from '../../../shared/session-identity.js';

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
  serverId?: string,
): Promise<SessionIdentityProfile[]> {
  const params: unknown[] = [userId];
  const relevant = serverId
    ? `(
         scope = 'user'
         OR (scope = 'project' AND EXISTS (
           SELECT 1
             FROM sessions AS live_project
             JOIN servers AS owner_server ON owner_server.id = live_project.server_id
            WHERE live_project.server_id = $2
              AND owner_server.user_id = $1
              AND live_project.state <> 'stopped'
              AND live_project.project_name = session_identity_profiles.scope_key
         ))
         OR (scope = 'session' AND EXISTS (
           SELECT 1
             FROM sessions AS live_session
             JOIN servers AS owner_server ON owner_server.id = live_session.server_id
            WHERE live_session.server_id = $2
              AND owner_server.user_id = $1
              AND live_session.state <> 'stopped'
              AND live_session.server_id || ':' || live_session.name = session_identity_profiles.scope_key
         ))
       )`
    : `scope = 'user'`;
  if (serverId) params.push(serverId);
  params.push(SESSION_IDENTITY_SYNC_MAX_PROFILES, SESSION_IDENTITY_SYNC_MAX_BYTES);
  const query = async (queryDb: Database): Promise<IdentityProfileRow[]> => queryDb.query<IdentityProfileRow>(
    `WITH candidates AS (
       SELECT scope, scope_key, octet_length(content) AS content_bytes,
              ROW_NUMBER() OVER (
                ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, scope_key ASC
              ) AS profile_rank
         FROM session_identity_profiles
        WHERE user_id = $1 AND ${relevant}
        ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, scope_key ASC
        LIMIT $${serverId ? 3 : 2}
     ), bounded AS (
       SELECT scope, scope_key, profile_rank,
              SUM(content_bytes) OVER (
                ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, scope_key ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS bytes_so_far
         FROM candidates
     )
     SELECT profile.scope, profile.scope_key, profile.content, profile.content_hash,
            profile.revision, profile.updated_at, profile.source, profile.source_file
       FROM bounded
       JOIN session_identity_profiles AS profile
         ON profile.user_id = $1 AND profile.scope = bounded.scope AND profile.scope_key = bounded.scope_key
      WHERE profile_rank <= $${serverId ? 3 : 2}
        AND (bytes_so_far <= $${serverId ? 4 : 3} OR profile_rank = 1)
      ORDER BY profile_rank ASC`,
    params,
  );
  let rows: IdentityProfileRow[];
  // Keep the timeout local to the pooled connection. Test doubles from the
  // route unit tests do not implement transactions, so retain their direct
  // query path while production PostgreSQL always gets the bound.
  if (typeof (db as Database & { transaction?: unknown }).transaction === 'function') {
    rows = await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL statement_timeout = '${SESSION_IDENTITY_SYNC_STATEMENT_TIMEOUT_MS}ms'`);
      return query(tx);
    });
  } else {
    rows = await query(db);
  }
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
