import { randomUUID } from 'node:crypto';
import type { Database } from './client.js';
import type {
  CloudDocFolder,
  CloudDocItem,
  CloudDocShareMode,
  CloudDocShareRecord,
  CloudDocShareRole,
  CloudDocShareTargetKind,
  CloudDocTeamOption,
  RecentDocumentItem,
  RecentDocumentSourceKind,
  SharedCloudDocItem,
  SharedCloudFolderItem,
} from '../../../shared/cloud-docs.js';
import {
  CLOUD_DOCS_RECENT_DEFAULT_LIMIT,
  CLOUD_DOCS_RECENT_MAX_LIMIT,
  buildRecentDocumentSourceKey,
  normalizeRecentFilePath,
} from '../../../shared/cloud-docs.js';

export interface CloudDocFolderRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  created_at: number | string;
  updated_at: number | string;
}

export interface CloudDocRow {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  ext: string;
  mime_type: string;
  size_bytes: number | string;
  content_sha256: string;
  storage_key: string;
  doc_version: number | string;
  created_at: number | string;
  updated_at: number | string;
  last_opened_at: number | string | null;
}

export interface RecentDocumentRow {
  id: string;
  user_id: string;
  source_kind: RecentDocumentSourceKind;
  source_key: string;
  server_id: string | null;
  server_name: string | null;
  session_name: string | null;
  file_path: string | null;
  cloud_doc_id: string | null;
  title: string;
  mime_type: string;
  open_mode: 'view' | 'edit';
  open_count: number | string;
  last_opened_at: number | string;
  created_at: number | string;
}

function toNum(v: number | string | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function rowToCloudDocFolder(row: CloudDocFolderRow): CloudDocFolder {
  return {
    id: row.id,
    userId: row.user_id,
    parentId: row.parent_id,
    name: row.name,
    createdAt: toNum(row.created_at),
    updatedAt: toNum(row.updated_at),
  };
}

export function rowToCloudDocItem(row: CloudDocRow): CloudDocItem {
  return {
    id: row.id,
    userId: row.user_id,
    folderId: row.folder_id,
    name: row.name,
    ext: row.ext,
    mimeType: row.mime_type,
    sizeBytes: toNum(row.size_bytes),
    docVersion: toNum(row.doc_version, 1),
    createdAt: toNum(row.created_at),
    updatedAt: toNum(row.updated_at),
    lastOpenedAt: row.last_opened_at !== null && row.last_opened_at !== undefined
      ? toNum(row.last_opened_at)
      : null,
  };
}

export function rowToRecentDocumentBase(row: RecentDocumentRow): Omit<RecentDocumentItem, 'accessible' | 'serverOnline' | 'accessReason'> {
  return {
    id: row.id,
    userId: row.user_id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    serverId: row.server_id,
    serverName: row.server_name,
    sessionName: row.session_name,
    filePath: row.file_path,
    cloudDocId: row.cloud_doc_id,
    title: row.title,
    mimeType: row.mime_type,
    openMode: row.open_mode === 'view' ? 'view' : 'edit',
    openCount: toNum(row.open_count, 1),
    lastOpenedAt: toNum(row.last_opened_at),
    createdAt: toNum(row.created_at),
  };
}

async function runInTx<T>(db: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  if (typeof db.transaction === 'function') {
    return db.transaction(fn);
  }
  return fn(db);
}

// ── Folders ───────────────────────────────────────────────────────────────────

export async function listCloudDocFolders(db: Database, userId: string): Promise<CloudDocFolder[]> {
  const rows = await db.query<CloudDocFolderRow>(
    `SELECT id, user_id, parent_id, name, created_at, updated_at
     FROM cloud_doc_folders
     WHERE user_id = $1
     ORDER BY name ASC`,
    [userId],
  );
  return rows.map(rowToCloudDocFolder);
}

export async function getCloudDocFolderById(
  db: Database,
  userId: string,
  folderId: string,
): Promise<CloudDocFolderRow | null> {
  return db.queryOne<CloudDocFolderRow>(
    `SELECT id, user_id, parent_id, name, created_at, updated_at
     FROM cloud_doc_folders
     WHERE id = $1 AND user_id = $2`,
    [folderId, userId],
  );
}

export async function getCloudDocFolderByIdAnyOwner(
  db: Database,
  folderId: string,
): Promise<CloudDocFolderRow | null> {
  return db.queryOne<CloudDocFolderRow>(
    `SELECT id, user_id, parent_id, name, created_at, updated_at
     FROM cloud_doc_folders
     WHERE id = $1`,
    [folderId],
  );
}

export async function createCloudDocFolder(
  db: Database,
  params: { userId: string; name: string; parentId?: string | null },
): Promise<CloudDocFolder> {
  const id = `cdf_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = Date.now();
  const parentId = params.parentId ?? null;
  await db.execute(
    `INSERT INTO cloud_doc_folders (id, user_id, parent_id, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, params.userId, parentId, params.name, now, now],
  );
  return {
    id,
    userId: params.userId,
    parentId,
    name: params.name,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateCloudDocFolder(
  db: Database,
  params: { userId: string; folderId: string; name?: string; parentId?: string | null; hasParentId?: boolean },
): Promise<CloudDocFolder | null> {
  const existing = await getCloudDocFolderById(db, params.userId, params.folderId);
  if (!existing) return null;

  const nextName = params.name ?? existing.name;
  const nextParentId = params.hasParentId ? (params.parentId ?? null) : existing.parent_id;
  const now = Date.now();

  await db.execute(
    `UPDATE cloud_doc_folders
     SET name = $1, parent_id = $2, updated_at = $3
     WHERE id = $4 AND user_id = $5`,
    [nextName, nextParentId, now, params.folderId, params.userId],
  );

  return {
    id: existing.id,
    userId: existing.user_id,
    parentId: nextParentId,
    name: nextName,
    createdAt: toNum(existing.created_at),
    updatedAt: now,
  };
}

export async function isDescendantFolder(
  db: Database,
  userId: string,
  candidateChildId: string,
  ancestorId: string,
): Promise<boolean> {
  if (candidateChildId === ancestorId) return true;
  const all = await listCloudDocFolders(db, userId);
  const byId = new Map(all.map((f) => [f.id, f]));
  let cur: CloudDocFolder | undefined = byId.get(candidateChildId);
  const seen = new Set<string>();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
}

export async function deleteCloudDocFolderTree(
  db: Database,
  userId: string,
  folderId: string,
): Promise<{ deletedFolderIds: string[]; storageKeys: string[] } | null> {
  return runInTx(db, async (tx) => {
    const folders = await tx.query<CloudDocFolderRow>(
      `SELECT id, user_id, parent_id, name, created_at, updated_at
       FROM cloud_doc_folders
       WHERE user_id = $1`,
      [userId],
    );
    const root = folders.find((f) => f.id === folderId);
    if (!root) return null;

    const toDelete = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of folders) {
        if (f.parent_id && toDelete.has(f.parent_id) && !toDelete.has(f.id)) {
          toDelete.add(f.id);
          changed = true;
        }
      }
    }

    const folderIds = [...toDelete];
    const docs = await tx.query<{ id: string; folder_id: string | null; storage_key: string }>(
      `SELECT id, folder_id, storage_key FROM cloud_docs WHERE user_id = $1`,
      [userId],
    );
    const docsInTree = docs.filter((d) => d.folder_id && toDelete.has(d.folder_id));
    const storageKeys = docsInTree.map((d) => d.storage_key);

    for (const d of docsInTree) {
      await tx.execute(`DELETE FROM recent_documents WHERE cloud_doc_id = $1`, [d.id]);
      await tx.execute(`DELETE FROM cloud_doc_shares WHERE target_kind = 'doc' AND target_id = $1`, [d.id]);
      await tx.execute(`DELETE FROM cloud_docs WHERE id = $1 AND user_id = $2`, [d.id, userId]);
    }
    for (const fid of folderIds) {
      await tx.execute(`DELETE FROM cloud_doc_shares WHERE target_kind = 'folder' AND target_id = $1`, [fid]);
      await tx.execute(`DELETE FROM cloud_doc_folders WHERE id = $1 AND user_id = $2`, [fid, userId]);
    }

    return { deletedFolderIds: folderIds, storageKeys };
  });
}

// ── Cloud Docs ────────────────────────────────────────────────────────────────

export async function listCloudDocs(
  db: Database,
  userId: string,
  options?: { folderId?: string | null; allFolders?: boolean; search?: string },
): Promise<CloudDocItem[]> {
  const rows = await db.query<CloudDocRow>(
    `SELECT id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256,
            storage_key, doc_version, created_at, updated_at, last_opened_at
     FROM cloud_docs
     WHERE user_id = $1
     ORDER BY updated_at DESC, created_at DESC`,
    [userId],
  );
  const search = options?.search?.trim().toLowerCase() ?? '';
  return rows
    .filter((row) => {
      if (!options?.allFolders && options?.folderId !== undefined) {
        if ((row.folder_id ?? null) !== (options.folderId ?? null)) return false;
      }
      if (search && !row.name.toLowerCase().includes(search)) {
        return false;
      }
      return true;
    })
    .map(rowToCloudDocItem);
}

export async function getCloudDocById(
  db: Database,
  docId: string,
  userId?: string,
): Promise<CloudDocRow | null> {
  if (userId) {
    return db.queryOne<CloudDocRow>(
      `SELECT id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256,
              storage_key, doc_version, created_at, updated_at, last_opened_at
       FROM cloud_docs
       WHERE id = $1 AND user_id = $2`,
      [docId, userId],
    );
  }
  return db.queryOne<CloudDocRow>(
    `SELECT id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256,
            storage_key, doc_version, created_at, updated_at, last_opened_at
     FROM cloud_docs
     WHERE id = $1`,
    [docId],
  );
}

const PRE_COMMIT_PG_ERROR_CODES = new Set([
  '22P02', // invalid_text_representation
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23505', // unique_violation
  '23514', // check_violation
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '42703', // undefined_column
  '42P01', // undefined_table
  'PRE_COMMIT_FAILURE',
]);

/**
 * Returns true only when a thrown DB error proves the statement aborted before
 * committing. Ambiguous/network/post-statement errors return false so callers do
 * not delete newly written blobs that the committed row may already reference.
 */
export function isDefinitelyUncommittedDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && PRE_COMMIT_PG_ERROR_CODES.has(code);
}

export async function insertCloudDoc(
  db: Database,
  params: {
    id: string;
    userId: string;
    folderId: string | null;
    name: string;
    ext: string;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
  },
): Promise<CloudDocRow> {
  const now = Date.now();
  const row = await db.queryOne<CloudDocRow>(
    `INSERT INTO cloud_docs (
       id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256,
       storage_key, doc_version, created_at, updated_at, last_opened_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256,
       storage_key, doc_version, created_at, updated_at, last_opened_at`,
    [
      params.id,
      params.userId,
      params.folderId,
      params.name,
      params.ext,
      params.mimeType,
      params.sizeBytes,
      params.contentSha256,
      params.storageKey,
      1,
      now,
      now,
      null,
    ],
  );
  if (!row) {
    throw new Error('cloud_doc_insert_missing_returning_row');
  }
  return row;
}

export async function updateCloudDocMetadata(
  db: Database,
  params: {
    userId: string;
    docId: string;
    name?: string;
    ext?: string;
    mimeType?: string;
    folderId?: string | null;
    hasFolderId?: boolean;
  },
): Promise<CloudDocRow | null> {
  const existing = await getCloudDocById(db, params.docId, params.userId);
  if (!existing) return null;

  const nextName = params.name ?? existing.name;
  const nextExt = params.ext ?? existing.ext;
  const nextMime = params.mimeType ?? existing.mime_type;
  const nextFolderId = params.hasFolderId ? (params.folderId ?? null) : existing.folder_id;
  const now = Date.now();

  await db.execute(
    `UPDATE cloud_docs
     SET name = $1, ext = $2, mime_type = $3, folder_id = $4, updated_at = $5
     WHERE id = $6 AND user_id = $7`,
    [nextName, nextExt, nextMime, nextFolderId, now, params.docId, params.userId],
  );

  return {
    ...existing,
    name: nextName,
    ext: nextExt,
    mime_type: nextMime,
    folder_id: nextFolderId,
    updated_at: now,
  };
}

export type CommitCloudDocResult =
  | { status: 'committed'; doc: CloudDocRow }
  | { status: 'conflict' };

export async function commitCloudDocContent(
  db: Database,
  params: {
    docId: string;
    userId: string;
    expectedVersion: number;
    bumpVersion: boolean;
    newStorageKey: string;
    sizeBytes: number;
    contentSha256: string;
  },
): Promise<CommitCloudDocResult> {
  const nextVersion = params.bumpVersion ? params.expectedVersion + 1 : params.expectedVersion;
  const now = Date.now();
  const row = await db.queryOne<CloudDocRow>(
    `UPDATE cloud_docs
     SET storage_key = $1, size_bytes = $2, content_sha256 = $3, doc_version = $4, updated_at = $5
     WHERE id = $6 AND user_id = $7 AND doc_version = $8
     RETURNING id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256,
       storage_key, doc_version, created_at, updated_at, last_opened_at`,
    [
      params.newStorageKey,
      params.sizeBytes,
      params.contentSha256,
      nextVersion,
      now,
      params.docId,
      params.userId,
      params.expectedVersion,
    ],
  );
  if (!row) return { status: 'conflict' };
  return { status: 'committed', doc: row };
}

export async function touchCloudDocOpened(
  db: Database,
  docId: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `UPDATE cloud_docs SET last_opened_at = $1 WHERE id = $2`,
    [now, docId],
  );
}

export async function deleteCloudDocRecord(
  db: Database,
  docId: string,
  userId: string,
): Promise<CloudDocRow | null> {
  return runInTx(db, async (tx) => {
    const existing = await getCloudDocById(tx, docId, userId);
    if (!existing) return null;
    await tx.execute(`DELETE FROM recent_documents WHERE cloud_doc_id = $1`, [docId]);
    await tx.execute(`DELETE FROM cloud_doc_shares WHERE target_kind = 'doc' AND target_id = $1`, [docId]);
    await tx.execute(`DELETE FROM cloud_docs WHERE id = $1 AND user_id = $2`, [docId, userId]);
    return existing;
  });
}

// ── Recent Documents ──────────────────────────────────────────────────────────

export interface UpsertRecentDocumentParams {
  userId: string;
  sourceKind: RecentDocumentSourceKind;
  serverId?: string | null;
  serverName?: string | null;
  sessionName?: string | null;
  filePath?: string | null;
  cloudDocId?: string | null;
  title: string;
  mimeType: string;
  openMode?: 'view' | 'edit';
}

export async function upsertRecentDocument(
  db: Database,
  params: UpsertRecentDocumentParams,
): Promise<RecentDocumentRow | null> {
  const normFilePath = params.sourceKind === 'server_file'
    ? normalizeRecentFilePath(params.filePath)
    : null;
  const sourceKey = buildRecentDocumentSourceKey({
    sourceKind: params.sourceKind,
    serverId: params.serverId,
    filePath: normFilePath,
    cloudDocId: params.cloudDocId,
  });
  if (!sourceKey) return null;

  const now = Date.now();
  const id = `rdoc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const openMode: 'view' | 'edit' = params.openMode === 'view' ? 'view' : 'edit';

  await db.execute(
    `INSERT INTO recent_documents (
       id, user_id, source_kind, source_key, server_id, server_name, session_name,
       file_path, cloud_doc_id, title, mime_type, open_mode, open_count, last_opened_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $14)
     ON CONFLICT (user_id, source_key) DO UPDATE SET
       server_name = COALESCE(EXCLUDED.server_name, recent_documents.server_name),
       session_name = COALESCE(EXCLUDED.session_name, recent_documents.session_name),
       title = EXCLUDED.title,
       mime_type = EXCLUDED.mime_type,
       open_mode = EXCLUDED.open_mode,
       open_count = recent_documents.open_count + 1,
       last_opened_at = EXCLUDED.last_opened_at`,
    [
      id,
      params.userId,
      params.sourceKind,
      sourceKey,
      params.sourceKind === 'server_file' ? (params.serverId ?? null) : null,
      params.serverName ?? null,
      params.sessionName ?? null,
      normFilePath,
      params.sourceKind === 'cloud_doc' ? (params.cloudDocId ?? null) : null,
      params.title,
      params.mimeType,
      openMode,
      now,
      now,
    ],
  );

  return db.queryOne<RecentDocumentRow>(
    `SELECT id, user_id, source_kind, source_key, server_id, server_name, session_name,
            file_path, cloud_doc_id, title, mime_type, open_mode, open_count, last_opened_at, created_at
     FROM recent_documents
     WHERE user_id = $1 AND source_key = $2`,
    [params.userId, sourceKey],
  );
}

export async function listRecentDocumentsRaw(
  db: Database,
  userId: string,
  limit = CLOUD_DOCS_RECENT_DEFAULT_LIMIT,
): Promise<RecentDocumentRow[]> {
  const clamped = Math.max(1, Math.min(CLOUD_DOCS_RECENT_MAX_LIMIT, Math.floor(limit || CLOUD_DOCS_RECENT_DEFAULT_LIMIT)));
  return db.query<RecentDocumentRow>(
    `SELECT id, user_id, source_kind, source_key, server_id, server_name, session_name,
            file_path, cloud_doc_id, title, mime_type, open_mode, open_count, last_opened_at, created_at
     FROM recent_documents
     WHERE user_id = $1
     ORDER BY last_opened_at DESC, created_at DESC
     LIMIT $2`,
    [userId, clamped],
  );
}

export async function deleteRecentDocument(
  db: Database,
  userId: string,
  recentId: string,
): Promise<boolean> {
  const res = await db.execute(
    `DELETE FROM recent_documents WHERE id = $1 AND user_id = $2`,
    [recentId, userId],
  );
  return res.changes > 0;
}

// ── Cloud Doc Sharing & Real-Time Permission Resolution ───────────────────────

export interface CloudDocShareRow {
  id: string;
  target_kind: CloudDocShareTargetKind;
  target_id: string;
  share_mode: CloudDocShareMode;
  target_team_id: string | null;
  target_user_id: string | null;
  role: CloudDocShareRole;
  allow_download: boolean | number;
  created_by: string;
  created_at: number | string;
  updated_at: number | string;
  revoked_at: number | string | null;
}

interface UserStatusRow {
  id: string;
  status: string;
  username: string | null;
  display_name: string | null;
}

export type CloudDocAccessResult =
  | {
      allowed: true;
      isOwner: boolean;
      canManageShare: boolean;
      role: CloudDocShareRole;
      allowDownload: boolean;
      sharedVia: 'owner' | 'doc' | 'folder';
      sharedTeamName: string | null;
      doc: CloudDocRow;
    }
  | {
      allowed: false;
      reason: 'not_found' | 'access_denied';
    };

export type CloudDocFolderAccessResult =
  | {
      allowed: true;
      isOwner: boolean;
      canManageShare: boolean;
      role: CloudDocShareRole;
      allowDownload: boolean;
      sharedTeamName: string | null;
      folder: CloudDocFolderRow;
    }
  | {
      allowed: false;
      reason: 'not_found' | 'access_denied';
    };

function pickGrantFromShares(
  shares: CloudDocShareRow[],
  userId: string,
  userTeamMap: ReadonlyMap<string, string>,
): { role: CloudDocShareRole; allowDownload: boolean; sharedTeamName: string | null } | null {
  const directUserShares = shares.filter(
    (s) => s.revoked_at === null && s.share_mode === 'user' && s.target_user_id === userId,
  );
  if (directUserShares.length > 0) {
    const role: CloudDocShareRole = directUserShares.some((s) => s.role === 'editor') ? 'editor' : 'viewer';
    const allowDownload = directUserShares.some((s) => Boolean(s.allow_download));
    return { role, allowDownload, sharedTeamName: null };
  }

  const teamShares = shares.filter(
    (s) => s.revoked_at === null && s.share_mode === 'team' && s.target_team_id && userTeamMap.has(s.target_team_id),
  );
  if (teamShares.length > 0) {
    const role: CloudDocShareRole = teamShares.some((s) => s.role === 'editor') ? 'editor' : 'viewer';
    const allowDownload = teamShares.some((s) => Boolean(s.allow_download));
    const firstTeamId = teamShares[0]?.target_team_id ?? null;
    const sharedTeamName = firstTeamId ? (userTeamMap.get(firstTeamId) ?? null) : null;
    return { role, allowDownload, sharedTeamName };
  }

  return null;
}

async function getUserTeamMap(db: Database, userId: string): Promise<Map<string, string>> {
  const teams = await listUserTeamsForCloudDocs(db, userId);
  return new Map(teams.map((t) => [t.id, t.name]));
}

export async function listUserTeamsForCloudDocs(
  db: Database,
  userId: string,
): Promise<CloudDocTeamOption[]> {
  return db.query<CloudDocTeamOption>(
    `SELECT t.id, t.name, tm.role
     FROM teams t
     JOIN team_members tm ON tm.team_id = t.id
     WHERE tm.user_id = $1
     ORDER BY t.name ASC`,
    [userId],
  );
}

async function getActiveSharesByTarget(
  db: Database,
  targetKind: CloudDocShareTargetKind,
  targetId: string,
): Promise<CloudDocShareRow[]> {
  return db.query<CloudDocShareRow>(
    `SELECT id, target_kind, target_id, share_mode, target_team_id, target_user_id,
            role, allow_download, created_by, created_at, updated_at, revoked_at
     FROM cloud_doc_shares
     WHERE target_kind = $1 AND target_id = $2 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [targetKind, targetId],
  );
}

export async function listCloudDocSharesForTarget(
  db: Database,
  targetKind: CloudDocShareTargetKind,
  targetId: string,
): Promise<CloudDocShareRecord[]> {
  const rows = await getActiveSharesByTarget(db, targetKind, targetId);
  const teamNameCache = new Map<string, string | null>();
  const userInfoCache = new Map<string, { name: string | null; username: string | null }>();

  const records: CloudDocShareRecord[] = [];
  for (const row of rows) {
    let targetTeamName: string | null = null;
    if (row.target_team_id) {
      if (!teamNameCache.has(row.target_team_id)) {
        const teamRow = await db.queryOne<{ name: string }>('SELECT name FROM teams WHERE id = $1', [row.target_team_id]);
        teamNameCache.set(row.target_team_id, teamRow?.name ?? null);
      }
      targetTeamName = teamNameCache.get(row.target_team_id) ?? null;
    }

    let targetUserName: string | null = null;
    let targetUserUsername: string | null = null;
    if (row.target_user_id) {
      if (!userInfoCache.has(row.target_user_id)) {
        const userRow = await db.queryOne<UserStatusRow>(
          'SELECT id, status, username, display_name FROM users WHERE id = $1',
          [row.target_user_id],
        );
        userInfoCache.set(row.target_user_id, {
          name: userRow?.display_name ?? userRow?.username ?? null,
          username: userRow?.username ?? null,
        });
      }
      const info = userInfoCache.get(row.target_user_id);
      targetUserName = info?.name ?? null;
      targetUserUsername = info?.username ?? null;
    }

    records.push({
      id: row.id,
      targetKind: row.target_kind,
      targetId: row.target_id,
      shareMode: row.share_mode,
      targetTeamId: row.target_team_id,
      targetTeamName,
      targetUserId: row.target_user_id,
      targetUserName,
      targetUserUsername,
      role: row.role,
      allowDownload: Boolean(row.allow_download),
      createdBy: row.created_by,
      createdAt: toNum(row.created_at),
      updatedAt: toNum(row.updated_at),
    });
  }
  return records;
}

export async function upsertCloudDocShare(
  db: Database,
  params: {
    targetKind: CloudDocShareTargetKind;
    targetId: string;
    shareMode: CloudDocShareMode;
    targetTeamId?: string | null;
    targetUserId?: string | null;
    role: CloudDocShareRole;
    allowDownload: boolean;
    createdBy: string;
  },
): Promise<CloudDocShareRecord> {
  const now = Date.now();
  const targetTeamId = params.shareMode === 'team' ? (params.targetTeamId ?? null) : null;
  const targetUserId = params.shareMode === 'user' ? (params.targetUserId ?? null) : null;

  const existing = params.shareMode === 'team'
    ? await db.queryOne<CloudDocShareRow>(
        `SELECT id, target_kind, target_id, share_mode, target_team_id, target_user_id,
                role, allow_download, created_by, created_at, updated_at, revoked_at
         FROM cloud_doc_shares
         WHERE target_kind = $1 AND target_id = $2 AND share_mode = 'team' AND target_team_id = $3 AND revoked_at IS NULL`,
        [params.targetKind, params.targetId, targetTeamId],
      )
    : await db.queryOne<CloudDocShareRow>(
        `SELECT id, target_kind, target_id, share_mode, target_team_id, target_user_id,
                role, allow_download, created_by, created_at, updated_at, revoked_at
         FROM cloud_doc_shares
         WHERE target_kind = $1 AND target_id = $2 AND share_mode = 'user' AND target_user_id = $3 AND revoked_at IS NULL`,
        [params.targetKind, params.targetId, targetUserId],
      );

  let shareId: string;
  if (existing) {
    shareId = existing.id;
    await db.execute(
      `UPDATE cloud_doc_shares
       SET role = $1, allow_download = $2, updated_at = $3
       WHERE id = $4`,
      [params.role, params.allowDownload, now, shareId],
    );
  } else {
    shareId = `cds_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await db.execute(
      `INSERT INTO cloud_doc_shares (
         id, target_kind, target_id, share_mode, target_team_id, target_user_id,
         role, allow_download, created_by, created_at, updated_at, revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)`,
      [
        shareId,
        params.targetKind,
        params.targetId,
        params.shareMode,
        targetTeamId,
        targetUserId,
        params.role,
        params.allowDownload,
        params.createdBy,
        now,
        now,
      ],
    );
  }

  const all = await listCloudDocSharesForTarget(db, params.targetKind, params.targetId);
  const found = all.find((s) => s.id === shareId);
  if (!found) {
    throw new Error('Failed to load saved cloud_doc_share');
  }
  return found;
}

export async function getCloudDocShareById(
  db: Database,
  shareId: string,
): Promise<CloudDocShareRow | null> {
  return db.queryOne<CloudDocShareRow>(
    `SELECT id, target_kind, target_id, share_mode, target_team_id, target_user_id,
            role, allow_download, created_by, created_at, updated_at, revoked_at
     FROM cloud_doc_shares
     WHERE id = $1`,
    [shareId],
  );
}

export async function revokeCloudDocShare(
  db: Database,
  params: { shareId: string; createdBy: string },
): Promise<boolean> {
  const now = Date.now();
  const res = await db.execute(
    `UPDATE cloud_doc_shares
     SET revoked_at = $1, updated_at = $2
     WHERE id = $3 AND created_by = $4 AND revoked_at IS NULL`,
    [now, now, params.shareId, params.createdBy],
  );
  return res.changes > 0;
}

export async function resolveCloudDocAccess(
  db: Database,
  docId: string,
  userId: string,
): Promise<CloudDocAccessResult> {
  const doc = await getCloudDocById(db, docId);
  if (!doc) return { allowed: false, reason: 'not_found' };

  const actingUser = await db.queryOne<UserStatusRow>(
    'SELECT id, status, username, display_name FROM users WHERE id = $1',
    [userId],
  );
  if (!actingUser || actingUser.status !== 'active') {
    return { allowed: false, reason: 'access_denied' };
  }

  if (doc.user_id === userId) {
    return {
      allowed: true,
      isOwner: true,
      canManageShare: true,
      role: 'editor',
      allowDownload: true,
      sharedVia: 'owner',
      sharedTeamName: null,
      doc,
    };
  }

  const ownerUser = await db.queryOne<UserStatusRow>(
    'SELECT id, status, username, display_name FROM users WHERE id = $1',
    [doc.user_id],
  );
  if (!ownerUser || ownerUser.status !== 'active') {
    return { allowed: false, reason: 'access_denied' };
  }

  const userTeamMap = await getUserTeamMap(db, userId);

  // 1. Doc-level share strictly overrides any ancestor folder share
  const docShares = await getActiveSharesByTarget(db, 'doc', doc.id);
  const docGrant = pickGrantFromShares(docShares, userId, userTeamMap);
  if (docGrant) {
    return {
      allowed: true,
      isOwner: false,
      canManageShare: false,
      role: docGrant.role,
      allowDownload: docGrant.allowDownload,
      sharedVia: 'doc',
      sharedTeamName: docGrant.sharedTeamName,
      doc,
    };
  }

  // 2. Walk ancestor folders (nearest folder wins)
  let curFolderId = doc.folder_id;
  const visited = new Set<string>();
  let depth = 0;
  while (curFolderId && !visited.has(curFolderId) && depth < 64) {
    visited.add(curFolderId);
    depth += 1;
    const folder = await getCloudDocFolderById(db, doc.user_id, curFolderId);
    if (!folder) break;
    const folderShares = await getActiveSharesByTarget(db, 'folder', folder.id);
    const folderGrant = pickGrantFromShares(folderShares, userId, userTeamMap);
    if (folderGrant) {
      return {
        allowed: true,
        isOwner: false,
        canManageShare: false,
        role: folderGrant.role,
        allowDownload: folderGrant.allowDownload,
        sharedVia: 'folder',
        sharedTeamName: folderGrant.sharedTeamName,
        doc,
      };
    }
    curFolderId = folder.parent_id;
  }

  return { allowed: false, reason: 'access_denied' };
}

export async function resolveCloudDocFolderAccess(
  db: Database,
  folderId: string,
  userId: string,
): Promise<CloudDocFolderAccessResult> {
  const targetFolder = await getCloudDocFolderByIdAnyOwner(db, folderId);
  if (!targetFolder) return { allowed: false, reason: 'not_found' };

  const actingUser = await db.queryOne<UserStatusRow>(
    'SELECT id, status, username, display_name FROM users WHERE id = $1',
    [userId],
  );
  if (!actingUser || actingUser.status !== 'active') {
    return { allowed: false, reason: 'access_denied' };
  }

  if (targetFolder.user_id === userId) {
    return {
      allowed: true,
      isOwner: true,
      canManageShare: true,
      role: 'editor',
      allowDownload: true,
      sharedTeamName: null,
      folder: targetFolder,
    };
  }

  const ownerUser = await db.queryOne<UserStatusRow>(
    'SELECT id, status, username, display_name FROM users WHERE id = $1',
    [targetFolder.user_id],
  );
  if (!ownerUser || ownerUser.status !== 'active') {
    return { allowed: false, reason: 'access_denied' };
  }

  const userTeamMap = await getUserTeamMap(db, userId);

  let curId: string | null = targetFolder.id;
  const visited = new Set<string>();
  let depth = 0;
  while (curId && !visited.has(curId) && depth < 64) {
    visited.add(curId);
    depth += 1;
    const folder: CloudDocFolderRow | null = curId === targetFolder.id
      ? targetFolder
      : await getCloudDocFolderById(db, targetFolder.user_id, curId);
    if (!folder) break;
    const shares = await getActiveSharesByTarget(db, 'folder', folder.id);
    const grant = pickGrantFromShares(shares, userId, userTeamMap);
    if (grant) {
      return {
        allowed: true,
        isOwner: false,
        canManageShare: false,
        role: grant.role,
        allowDownload: grant.allowDownload,
        sharedTeamName: grant.sharedTeamName,
        folder: targetFolder,
      };
    }
    curId = folder.parent_id;
  }

  return { allowed: false, reason: 'access_denied' };
}

export async function listSharedCloudItemsForUser(
  db: Database,
  userId: string,
  options?: { search?: string },
): Promise<{ sharedFolders: SharedCloudFolderItem[]; sharedDocs: SharedCloudDocItem[] }> {
  const actingUser = await db.queryOne<UserStatusRow>(
    'SELECT id, status, username, display_name FROM users WHERE id = $1',
    [userId],
  );
  if (!actingUser || actingUser.status !== 'active') {
    return { sharedFolders: [], sharedDocs: [] };
  }

  const userTeamMap = await getUserTeamMap(db, userId);
  const directUserShares = await db.query<CloudDocShareRow>(
    `SELECT id, target_kind, target_id, share_mode, target_team_id, target_user_id,
            role, allow_download, created_by, created_at, updated_at, revoked_at
     FROM cloud_doc_shares
     WHERE revoked_at IS NULL AND share_mode = 'user' AND target_user_id = $1`,
    [userId],
  );

  const teamShareLists = await Promise.all(
    [...userTeamMap.keys()].map((teamId) =>
      db.query<CloudDocShareRow>(
        `SELECT id, target_kind, target_id, share_mode, target_team_id, target_user_id,
                role, allow_download, created_by, created_at, updated_at, revoked_at
         FROM cloud_doc_shares
         WHERE revoked_at IS NULL AND share_mode = 'team' AND target_team_id = $1`,
        [teamId],
      ),
    ),
  );

  const relevantShares = [...directUserShares, ...teamShareLists.flat()];
  if (relevantShares.length === 0) {
    return { sharedFolders: [], sharedDocs: [] };
  }

  const sharesByTargetKey = new Map<string, CloudDocShareRow[]>();
  const directFolderIds = new Set<string>();
  const directDocIds = new Set<string>();
  for (const s of relevantShares) {
    const key = `${s.target_kind}:${s.target_id}`;
    const list = sharesByTargetKey.get(key) ?? [];
    list.push(s);
    sharesByTargetKey.set(key, list);
    if (s.target_kind === 'folder') directFolderIds.add(s.target_id);
    if (s.target_kind === 'doc') directDocIds.add(s.target_id);
  }

  const ownerCache = new Map<string, UserStatusRow | null>();
  const getActiveOwner = async (ownerId: string): Promise<UserStatusRow | null> => {
    if (ownerId === userId) return null; // Never return user's own items in Shared With Me
    if (!ownerCache.has(ownerId)) {
      const row = await db.queryOne<UserStatusRow>(
        'SELECT id, status, username, display_name FROM users WHERE id = $1',
        [ownerId],
      );
      ownerCache.set(ownerId, row && row.status === 'active' ? row : null);
    }
    return ownerCache.get(ownerId) ?? null;
  };

  // Discover all relevant owners from directly shared folders and docs
  const ownerFoldersCache = new Map<string, CloudDocFolderRow[]>();
  const ownerDocsCache = new Map<string, CloudDocRow[]>();
  const ensureOwnerLoaded = async (ownerId: string) => {
    if (!ownerFoldersCache.has(ownerId)) {
      const [fRows, dRows] = await Promise.all([
        db.query<CloudDocFolderRow>(
          `SELECT id, user_id, parent_id, name, created_at, updated_at
           FROM cloud_doc_folders
           WHERE user_id = $1
           ORDER BY name ASC`,
          [ownerId],
        ),
        db.query<CloudDocRow>(
          `SELECT id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256,
                  storage_key, doc_version, created_at, updated_at, last_opened_at
           FROM cloud_docs
           WHERE user_id = $1
           ORDER BY updated_at DESC, created_at DESC`,
          [ownerId],
        ),
      ]);
      ownerFoldersCache.set(ownerId, fRows);
      ownerDocsCache.set(ownerId, dRows);
    }
  };

  const discoveredOwners = new Set<string>();
  for (const folderId of directFolderIds) {
    const f = await getCloudDocFolderByIdAnyOwner(db, folderId);
    if (f && (await getActiveOwner(f.user_id))) {
      discoveredOwners.add(f.user_id);
    }
  }
  for (const docId of directDocIds) {
    const d = await getCloudDocById(db, docId);
    if (d && (await getActiveOwner(d.user_id))) {
      discoveredOwners.add(d.user_id);
    }
  }

  for (const ownerId of discoveredOwners) {
    await ensureOwnerLoaded(ownerId);
  }

  const sharedFolders: SharedCloudFolderItem[] = [];
  const sharedDocs: SharedCloudDocItem[] = [];
  const search = options?.search?.trim().toLowerCase() ?? '';

  for (const ownerId of discoveredOwners) {
    const owner = await getActiveOwner(ownerId);
    if (!owner) continue;
    const ownerName = owner.display_name || owner.username || owner.id;
    const ownerUsername = owner.username ?? null;
    const fRows = ownerFoldersCache.get(ownerId) ?? [];
    const dRows = ownerDocsCache.get(ownerId) ?? [];
    const fById = new Map(fRows.map((f) => [f.id, f]));

    const resolveFolderGrantFromLoaded = (folderId: string) => {
      let curId: string | null = folderId;
      const visited = new Set<string>();
      let depth = 0;
      while (curId && !visited.has(curId) && depth < 64) {
        visited.add(curId);
        depth += 1;
        const shares = sharesByTargetKey.get(`folder:${curId}`) ?? [];
        const grant = pickGrantFromShares(shares, userId, userTeamMap);
        if (grant) return grant;
        curId = fById.get(curId)?.parent_id ?? null;
      }
      return null;
    };

    for (const f of fRows) {
      const grant = resolveFolderGrantFromLoaded(f.id);
      if (!grant) continue;
      if (search && !f.name.toLowerCase().includes(search)) continue;
      sharedFolders.push({
        ...rowToCloudDocFolder(f),
        role: grant.role,
        allowDownload: grant.allowDownload,
        ownerName,
        ownerUsername,
        sharedTeamName: grant.sharedTeamName,
      });
    }

    for (const d of dRows) {
      // Load full active shares on doc in case doc has an explicit override row even for user/team
      // (Note: all user/team shares matching `userId` are already in `sharesByTargetKey`)
      const docGrant = pickGrantFromShares(sharesByTargetKey.get(`doc:${d.id}`) ?? [], userId, userTeamMap);
      const folderGrant = d.folder_id ? resolveFolderGrantFromLoaded(d.folder_id) : null;
      const effectiveGrant = docGrant ?? folderGrant;
      if (!effectiveGrant) continue;
      if (search && !d.name.toLowerCase().includes(search)) continue;
      const folderName = d.folder_id ? (fById.get(d.folder_id)?.name ?? null) : null;
      sharedDocs.push({
        ...rowToCloudDocItem(d),
        role: effectiveGrant.role,
        allowDownload: effectiveGrant.allowDownload,
        ownerName,
        ownerUsername,
        sharedVia: docGrant ? 'doc' : 'folder',
        sharedTeamName: effectiveGrant.sharedTeamName,
        folderName,
      });
    }
  }

  return { sharedFolders, sharedDocs };
}
