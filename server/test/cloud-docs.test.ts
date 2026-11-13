import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { isMigrationFile } from '../src/db/migrate.js';
import { signJwt, sha256Hex } from '../src/security/crypto.js';
import { resolveOnlyOfficeJwtSecret } from '../src/routes/onlyoffice.js';
import { issueSharedMachineAuthority } from '../src/share/shared-machine-authority.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { SHARED_MACHINE_AUTHORITY_HEADER, SHARED_MACHINE_AUTHORITY_TYPE } from '../../shared/shared-machine-authority.js';
import {
  LocalCloudDocStorage,
  type CloudDocStorage,
} from '../src/storage/cloud-doc-storage.js';
import type {
  CloudDocFolderRow,
  CloudDocRow,
  CloudDocShareRow,
  RecentDocumentRow,
} from '../src/db/cloud-docs.js';
import { CLOUD_DOCS_MAX_UPLOAD_BYTES } from '../../shared/cloud-docs.js';

const JWT_KEY = 'cloud-docs-test-signing-key-32chars-minimum!';
const OO_SECRET = 'cloud-docs-onlyoffice-jwt-secret-32chars!';

function createInMemoryCloudDocsDb() {
  const users = new Map<string, { id: string; username: string; display_name: string; status: string; sessions_valid_after: number; is_admin: boolean }>([
    ['owner-1', { id: 'owner-1', username: 'alice', display_name: 'Alice', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-bob', { id: 'user-bob', username: 'bob', display_name: 'Bob', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-carol', { id: 'user-carol', username: 'carol', display_name: 'Carol', status: 'active', sessions_valid_after: 0, is_admin: false }],
  ]);
  const teams = new Map<string, { id: string; name: string; owner_id: string }>([
    ['team-1', { id: 'team-1', name: 'Ops Group', owner_id: 'owner-1' }],
  ]);
  const servers = new Map<string, { id: string; name: string; user_id: string; team_id: string | null; token_hash?: string; node_role?: string; revoked_at?: number | null }>([
    ['srv-1', { id: 'srv-1', name: 'Build Node 1', user_id: 'owner-1', team_id: 'team-1', token_hash: sha256Hex('srv-1-secret'), node_role: NODE_ROLE.FULL, revoked_at: null }],
    ['srv-ctrl', { id: 'srv-ctrl', name: 'Controlled Node 1', user_id: 'owner-1', team_id: 'team-1', token_hash: sha256Hex('srv-ctrl-secret'), node_role: NODE_ROLE.CONTROLLED, revoked_at: null }],
  ]);
  const sessions = new Map<string, { server_id: string; name: string; project_name: string }>([
    ['srv-1:main-shared', { server_id: 'srv-1', name: 'main-shared', project_name: 'demo-proj' }],
  ]);
  const sessionShares: Array<{
    id: string;
    server_id: string;
    session_name: string;
    target_user_id: string;
    role: 'viewer' | 'participant';
    created_by: string;
    created_at: number;
    updated_at: number;
    expires_at: number | null;
    revoked_at: number | null;
  }> = [];
  const teamMembers = new Map<string, string>([
    ['team-1:owner-1', 'owner'],
    ['team-1:user-bob', 'member'],
  ]);
  const folders = new Map<string, CloudDocFolderRow>();
  const docs = new Map<string, CloudDocRow>();
  const recents = new Map<string, RecentDocumentRow>();
  const shares = new Map<string, CloudDocShareRow>();

  let failNextDocInsertMode: 'none' | 'pre_commit' | 'ambiguous' = 'none';
  let failNextDocCommitMode: 'none' | 'pre_commit' | 'ambiguous' = 'none';

  const db: Database = {
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.includes('FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = $1')) {
        const userId = params[0] as string;
        const result: Array<{ id: string; name: string; role: string }> = [];
        for (const [key, role] of teamMembers.entries()) {
          const [tid, uid] = key.split(':');
          if (uid === userId && tid && teams.has(tid)) {
            result.push({ id: tid, name: teams.get(tid)!.name, role });
          }
        }
        return result.sort((a, b) => a.name.localeCompare(b.name)) as unknown as T[];
      }

      if (s.includes('FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND revoked_at IS NULL')) {
        const [targetKind, targetId] = params as [string, string];
        return [...shares.values()]
          .filter((r) => r.target_kind === targetKind && r.target_id === targetId && r.revoked_at === null)
          .sort((a, b) => Number(b.created_at) - Number(a.created_at)) as unknown as T[];
      }

      if (s.includes("FROM cloud_doc_shares WHERE revoked_at IS NULL AND share_mode = 'user' AND target_user_id = $1")) {
        const userId = params[0] as string;
        return [...shares.values()]
          .filter((r) => r.revoked_at === null && r.share_mode === 'user' && r.target_user_id === userId) as unknown as T[];
      }

      if (s.includes("FROM cloud_doc_shares WHERE revoked_at IS NULL AND share_mode = 'team' AND target_team_id = $1")) {
        const teamId = params[0] as string;
        return [...shares.values()]
          .filter((r) => r.revoked_at === null && r.share_mode === 'team' && r.target_team_id === teamId) as unknown as T[];
      }

      if (s.includes('FROM cloud_doc_folders WHERE user_id = $1')) {
        const userId = params[0] as string;
        return [...folders.values()]
          .filter((f) => f.user_id === userId)
          .sort((a, b) => a.name.localeCompare(b.name)) as unknown as T[];
      }

      if (s.includes('FROM cloud_docs WHERE user_id = $1')) {
        const userId = params[0] as string;
        return [...docs.values()]
          .filter((d) => d.user_id === userId)
          .sort((a, b) => Number(b.updated_at) - Number(a.updated_at)) as unknown as T[];
      }

      if (s.includes('FROM recent_documents WHERE user_id = $1')) {
        const [userId, limit] = params as [string, number];
        return [...recents.values()]
          .filter((r) => r.user_id === userId)
          .sort((a, b) => Number(b.last_opened_at) - Number(a.last_opened_at))
          .slice(0, limit ?? 50) as unknown as T[];
      }

      if (s.includes('FROM session_shares')) {
        const [now, userId, serverId, sessionName] = params as [number, string, string, string];
        return sessionShares
          .filter((r) =>
            r.revoked_at === null &&
            (r.expires_at === null || r.expires_at > now) &&
            r.target_user_id === userId &&
            r.server_id === serverId &&
            r.session_name === sessionName,
          )
          .map((r) => ({ target_kind: 'main', ...r })) as unknown as T[];
      }

      if (s.includes('FROM server_shares') || s.includes('FROM sub_session_shares')) {
        return [] as T[];
      }

      return [] as T[];
    },

    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = sql.replace(/\s+/g, ' ').trim();

      // User lookup (exact match or resolveUserByIdentifier)
      if (s.includes('WHERE id = $1 OR lower(username) = lower($1)')) {
        const ident = String(params[0] ?? '').toLowerCase();
        const byId = users.get(params[0] as string);
        if (byId) return byId as unknown as T | null;
        const byName = [...users.values()].find((row) => (row.username ?? '').toLowerCase() === ident);
        return (byName ?? null) as unknown as T | null;
      }

      if (s.includes('FROM users WHERE id = $1')) {
        const u = users.get(params[0] as string);
        return (u ?? null) as unknown as T | null;
      }

      if (s === 'SELECT name FROM teams WHERE id = $1') {
        const tm = teams.get(params[0] as string);
        return (tm ? { name: tm.name } : null) as unknown as T | null;
      }

      if (s.includes("FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND share_mode = 'team'")) {
        const [targetKind, targetId, teamId] = params as [string, string, string];
        const row = [...shares.values()].find(
          (r) => r.revoked_at === null && r.target_kind === targetKind && r.target_id === targetId && r.share_mode === 'team' && r.target_team_id === teamId,
        );
        return (row ?? null) as unknown as T | null;
      }

      if (s.includes("FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND share_mode = 'user'")) {
        const [targetKind, targetId, userId] = params as [string, string, string];
        const row = [...shares.values()].find(
          (r) => r.revoked_at === null && r.target_kind === targetKind && r.target_id === targetId && r.share_mode === 'user' && r.target_user_id === userId,
        );
        return (row ?? null) as unknown as T | null;
      }

      if (s.includes('FROM cloud_doc_shares WHERE id = $1')) {
        const row = shares.get(params[0] as string);
        return (row ? { ...row } : null) as unknown as T | null;
      }

      // Daemon server bearer token lookup (resolveBearerOutcome)
      if (s.includes('token_hash') && s.includes('node_role') && s.includes('FROM servers WHERE id = $1')) {
        const srv = servers.get(params[0] as string);
        if (!srv) return null;
        const owner = users.get(srv.user_id);
        return {
          token_hash: srv.token_hash ?? '',
          user_id: srv.user_id,
          node_role: srv.node_role ?? NODE_ROLE.FULL,
          revoked_at: srv.revoked_at ?? null,
          owner_status: owner?.status ?? null,
        } as unknown as T;
      }

      // Session existence & project binding (shared-machine-authority / tab-sharing)
      if (s.includes('SELECT EXISTS (SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2)')) {
        const [serverId, name] = params as [string, string];
        return { exists: sessions.has(`${serverId}:${name}`) } as unknown as T;
      }
      if (s === 'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1') {
        const [serverId, name] = params as [string, string];
        const sess = sessions.get(`${serverId}:${name}`);
        return (sess ? { project_name: sess.project_name } : null) as unknown as T | null;
      }
      if (s.includes('AS actor_status') && s.includes('AS owner_status') && !s.includes('FROM servers WHERE id = $1')) {
        const [actorId, serverId] = params as [string, string];
        const actor = users.get(actorId);
        const srv = servers.get(serverId);
        const owner = srv ? users.get(srv.user_id) : undefined;
        return {
          actor_status: actor?.status ?? null,
          owner_status: owner?.status ?? null,
        } as unknown as T;
      }

      // Server name lookup
      if (s === 'SELECT name FROM servers WHERE id = $1') {
        const srv = servers.get(params[0] as string);
        return (srv ? { name: srv.name } : null) as unknown as T | null;
      }

      // resolveEffectiveDocumentAccess server & owner lookup
      if (s.includes('FROM servers WHERE id = $1') && s.includes('owner_status')) {
        const srv = servers.get(params[0] as string);
        if (!srv) return null;
        const owner = users.get(srv.user_id);
        const actor = params[1] ? users.get(params[1] as string) : undefined;
        return {
          id: srv.id,
          user_id: srv.user_id,
          owner_status: owner?.status ?? null,
          actor_status: actor?.status ?? null,
        } as unknown as T;
      }

      // isUserInServerTeam / resolveServerMembershipRole
      if (
        (s.includes('SELECT tm.role') && s.includes('FROM machine_groups mg') && s.includes('JOIN team_members tm')) ||
        (s.includes('SELECT tm.role') && s.includes('FROM servers s') && s.includes('JOIN team_members tm')) ||
        (s.includes('FROM servers s') && s.includes('WHERE s.id = $1'))
      ) {
        const [serverId, userId] = params as [string, string];
        const srv = servers.get(serverId);
        if (!srv) return null;
        const owner = users.get(srv.user_id);
        const actor = users.get(userId);
        const teamRole = srv.team_id ? (teamMembers.get(`${srv.team_id}:${userId}`) ?? null) : null;
        if (s.includes('SELECT tm.role') && !s.includes('team_role')) {
          return (teamRole ? { role: teamRole } : null) as unknown as T | null;
        }
        return {
          user_id: srv.user_id,
          team_id: srv.team_id,
          owner_status: owner?.status ?? null,
          actor_status: actor?.status ?? null,
          team_role: teamRole,
        } as unknown as T;
      }

      if (s.includes('FROM cloud_doc_folders WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const f = folders.get(id);
        return (f && f.user_id === userId ? { ...f } : null) as unknown as T | null;
      }

      if (s.includes('FROM cloud_doc_folders WHERE id = $1') && !s.includes('user_id = $2')) {
        const f = folders.get(params[0] as string);
        return (f ? { ...f } : null) as unknown as T | null;
      }

      if (s.includes('FROM cloud_docs WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const d = docs.get(id);
        return (d && d.user_id === userId ? { ...d } : null) as unknown as T | null;
      }

      if (s.includes('FROM cloud_docs WHERE id = $1') && !s.includes('user_id = $2')) {
        const d = docs.get(params[0] as string);
        return (d ? { ...d } : null) as unknown as T | null;
      }

      if (s.startsWith('INSERT INTO cloud_docs')) {
        const mode = failNextDocInsertMode;
        failNextDocInsertMode = 'none';
        if (mode === 'pre_commit') {
          const err = new Error('simulated_db_pre_commit_failure') as Error & { code: string };
          err.code = '23505';
          throw err;
        }
        const [id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256, storage_key, doc_version, created_at, updated_at, last_opened_at] =
          params as [string, string, string | null, string, string, string, number, string, string, number, number, number, number | null];
        const row: CloudDocRow = { id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256, storage_key, doc_version, created_at, updated_at, last_opened_at };
        docs.set(id, row);
        if (mode === 'ambiguous') {
          throw new Error('simulated_post_commit_connection_drop');
        }
        return { ...row } as unknown as T;
      }

      if (s.startsWith('UPDATE cloud_docs SET storage_key = $1')) {
        const mode = failNextDocCommitMode;
        failNextDocCommitMode = 'none';
        if (mode === 'pre_commit') {
          const err = new Error('simulated_db_pre_commit_failure') as Error & { code: string };
          err.code = '22P02';
          throw err;
        }
        const [
          storage_key,
          size_bytes,
          content_sha256,
          doc_version,
          updated_at,
          id,
          userId,
          expectedVersion,
          nextName,
          nextExt,
          nextMimeType,
          hasFolderId,
          nextFolderId,
        ] = params as [
          string,
          number,
          string,
          number,
          number,
          string,
          string,
          number,
          string | null | undefined,
          string | null | undefined,
          string | null | undefined,
          boolean | undefined,
          string | null | undefined,
        ];
        const row = docs.get(id);
        if (!row || row.user_id !== userId || Number(row.doc_version) !== expectedVersion) {
          return null;
        }
        row.storage_key = storage_key;
        row.size_bytes = size_bytes;
        row.content_sha256 = content_sha256;
        row.doc_version = doc_version;
        row.updated_at = updated_at;
        if (typeof nextName === 'string') row.name = nextName;
        if (typeof nextExt === 'string') row.ext = nextExt;
        if (typeof nextMimeType === 'string') row.mime_type = nextMimeType;
        if (hasFolderId === true) row.folder_id = nextFolderId ?? null;
        if (mode === 'ambiguous') {
          throw new Error('simulated_post_commit_returning_failure');
        }
        return { ...row } as unknown as T;
      }

      if (s.startsWith('UPDATE cloud_docs SET name = $1')) {
        const [name, ext, mime_type, folder_id, updated_at, id, userId, expectedVersion] =
          params as [string, string, string, string | null, number, string, string, number];
        const row = docs.get(id);
        if (!row || row.user_id !== userId || Number(row.doc_version) !== expectedVersion) return null;
        row.name = name;
        row.ext = ext;
        row.mime_type = mime_type;
        row.folder_id = folder_id;
        row.updated_at = updated_at;
        return { ...row } as unknown as T;
      }

      if (s.includes('FROM recent_documents WHERE user_id = $1 AND source_key = $2')) {
        const [userId, sourceKey] = params as [string, string];
        return (recents.get(`${userId}:${sourceKey}`) ?? null) as unknown as T | null;
      }

      return null;
    },

    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('INSERT INTO cloud_doc_folders')) {
        const [id, user_id, parent_id, name, created_at, updated_at] = params as [string, string, string | null, string, number, number];
        folders.set(id, { id, user_id, parent_id, name, created_at, updated_at });
        return { changes: 1 };
      }

      if (s.startsWith('UPDATE cloud_doc_folders')) {
        const [name, parent_id, updated_at, id, userId] = params as [string, string | null, number, string, string];
        const row = folders.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        row.name = name;
        row.parent_id = parent_id;
        row.updated_at = updated_at;
        return { changes: 1 };
      }

      if (s.startsWith('DELETE FROM cloud_doc_folders WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const row = folders.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        folders.delete(id);
        return { changes: 1 };
      }

      if (s.startsWith('INSERT INTO cloud_docs')) {
        if (failNextDocInsert) {
          failNextDocInsert = false;
          throw new Error('simulated_db_insert_failure');
        }
        const [id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256, storage_key, doc_version, created_at, updated_at, last_opened_at] =
          params as [string, string, string | null, string, string, string, number, string, string, number, number, number, number | null];
        docs.set(id, { id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256, storage_key, doc_version, created_at, updated_at, last_opened_at });
        return { changes: 1 };
      }

      if (s.startsWith('UPDATE cloud_docs SET storage_key = $1')) {
        if (failNextDocCommit) {
          failNextDocCommit = false;
          throw new Error('simulated_db_commit_failure');
        }
        const [storage_key, size_bytes, content_sha256, doc_version, updated_at, id, userId, expectedVersion] =
          params as [string, number, string, number, number, string, string, number];
        const row = docs.get(id);
        if (!row || row.user_id !== userId || Number(row.doc_version) !== expectedVersion) {
          return { changes: 0 };
        }
        row.storage_key = storage_key;
        row.size_bytes = size_bytes;
        row.content_sha256 = content_sha256;
        row.doc_version = doc_version;
        row.updated_at = updated_at;
        return { changes: 1 };
      }

      if (s.startsWith('UPDATE cloud_docs SET name = $1')) {
        const [name, ext, mime_type, folder_id, updated_at, id, userId] =
          params as [string, string, string, string | null, number, string, string];
        const row = docs.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        row.name = name;
        row.ext = ext;
        row.mime_type = mime_type;
        row.folder_id = folder_id;
        row.updated_at = updated_at;
        return { changes: 1 };
      }

      if (s.startsWith('UPDATE cloud_docs SET last_opened_at = $1 WHERE id = $2')) {
        const [last_opened_at, id] = params as [number, string];
        const row = docs.get(id);
        if (!row) return { changes: 0 };
        row.last_opened_at = last_opened_at;
        return { changes: 1 };
      }

      if (s.startsWith('DELETE FROM cloud_docs WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const row = docs.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        docs.delete(id);
        return { changes: 1 };
      }

      if (s.startsWith('DELETE FROM recent_documents WHERE cloud_doc_id = $1')) {
        const [docId] = params as [string];
        let changes = 0;
        for (const [k, r] of recents.entries()) {
          if (r.cloud_doc_id === docId) {
            recents.delete(k);
            changes += 1;
          }
        }
        return { changes };
      }

      if (s.startsWith('DELETE FROM cloud_doc_shares WHERE target_kind =')) {
        const isDoc = s.includes("'doc'");
        const targetKind = isDoc ? 'doc' : 'folder';
        const targetId = params[0] as string;
        let changes = 0;
        for (const [k, row] of shares.entries()) {
          if (row.target_kind === targetKind && row.target_id === targetId) {
            shares.delete(k);
            changes += 1;
          }
        }
        return { changes };
      }

      if (s.startsWith('INSERT INTO cloud_doc_shares')) {
        const [id, target_kind, target_id, share_mode, target_team_id, target_user_id, role, allow_download, created_by, created_at, updated_at] =
          params as [string, 'doc' | 'folder', string, 'team' | 'user', string | null, string | null, 'viewer' | 'editor', boolean, string, number, number];
        shares.set(id, {
          id, target_kind, target_id, share_mode, target_team_id, target_user_id,
          role, allow_download, created_by, created_at, updated_at, revoked_at: null,
        });
        return { changes: 1 };
      }

      if (s.startsWith('UPDATE cloud_doc_shares SET role = $1, allow_download = $2, updated_at = $3 WHERE id = $4')) {
        const [role, allow_download, updated_at, id] = params as ['viewer' | 'editor', boolean, number, string];
        const row = shares.get(id);
        if (!row) return { changes: 0 };
        row.role = role;
        row.allow_download = allow_download;
        row.updated_at = updated_at;
        return { changes: 1 };
      }

      if (s.startsWith('UPDATE cloud_doc_shares SET revoked_at = $1, updated_at = $2 WHERE id = $3 AND created_by = $4')) {
        const [revoked_at, updated_at, id, created_by] = params as [number, number, string, string];
        const row = shares.get(id);
        if (!row || row.created_by !== created_by || row.revoked_at !== null) return { changes: 0 };
        row.revoked_at = revoked_at;
        row.updated_at = updated_at;
        return { changes: 1 };
      }

      if (s.startsWith('INSERT INTO recent_documents')) {
        const [id, user_id, source_kind, source_key, server_id, server_name, session_name, file_path, cloud_doc_id, title, mime_type, open_mode, last_opened_at, created_at] =
          params as [string, string, 'server_file' | 'cloud_doc', string, string | null, string | null, string | null, string | null, string | null, string, string, 'view' | 'edit', number, number];
        const compositeKey = `${user_id}:${source_key}`;
        const existing = recents.get(compositeKey);
        if (existing) {
          existing.server_name = server_name ?? existing.server_name;
          existing.session_name = session_name ?? existing.session_name;
          existing.title = title;
          existing.mime_type = mime_type;
          existing.open_mode = open_mode;
          existing.open_count = Number(existing.open_count) + 1;
          existing.last_opened_at = last_opened_at;
        } else {
          recents.set(compositeKey, {
            id, user_id, source_kind, source_key, server_id, server_name, session_name,
            file_path, cloud_doc_id, title, mime_type, open_mode, open_count: 1,
            last_opened_at, created_at,
          });
        }
        return { changes: 1 };
      }

      if (s.startsWith('DELETE FROM recent_documents WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        for (const [k, r] of recents.entries()) {
          if (r.id === id && r.user_id === userId) {
            recents.delete(k);
            return { changes: 1 };
          }
        }
        return { changes: 0 };
      }

      return { changes: 0 };
    },

    exec: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(db),
  } as unknown as Database;

  return {
    db,
    users,
    teams,
    servers,
    teamMembers,
    folders,
    docs,
    recents,
    shares,
    sessions,
    sessionShares,
    setFailNextDocInsert: (v: boolean) => { failNextDocInsertMode = v ? 'pre_commit' : 'none'; },
    setFailNextDocInsertMode: (mode: 'none' | 'pre_commit' | 'ambiguous') => { failNextDocInsertMode = mode; },
    setFailNextDocCommit: (v: boolean) => { failNextDocCommitMode = v ? 'pre_commit' : 'none'; },
    setFailNextDocCommitMode: (mode: 'none' | 'pre_commit' | 'ambiguous') => { failNextDocCommitMode = mode; },
  };
}

function bearerHeader(userId: string, scope?: string) {
  const token = signJwt(
    scope ? { sub: userId, role: 'member', scope } : { sub: userId, role: 'member' },
    JWT_KEY,
    3600,
  );
  return { Authorization: `Bearer ${token}` };
}

describe('cloud docs & recent documents', () => {
  let tmpDir: string;
  let storage: LocalCloudDocStorage;
  let memDb: ReturnType<typeof createInMemoryCloudDocsDb>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-cloud-docs-test-'));
    storage = new LocalCloudDocStorage(tmpDir);
    memDb = createInMemoryCloudDocsDb();
    const env: Env = {
      DB: memDb.db,
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SIGNING_KEY: JWT_KEY,
      BOT_ENCRYPTION_KEY: 'test-bot-key',
      SERVER_URL: 'https://app.im.codes',
      ONLYOFFICE_ENABLED: 'true',
      ONLYOFFICE_JWT_SECRET: OO_SECRET,
      ONLYOFFICE_PUBLIC_URL: 'https://app.im.codes/onlyoffice',
      ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice:80',
      IMCODES_CLOUD_DOCS_DIR: tmpDir,
      NODE_ENV: 'test',
    };
    app = buildApp(env, { cloudDocStorage: storage });
  });

  afterEach(() => {
    const b = WsBridge.get('srv-1') as unknown as { daemonWs: unknown; authenticated: boolean };
    b.daemonWs = null;
    b.authenticated = false;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers migration 105 and configures persistent cloud_docs volume in docker-compose.yml', () => {
    expect(isMigrationFile('105_cloud_docs_and_recent_documents.sql')).toBe(true);
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../src/db/migrations/105_cloud_docs_and_recent_documents.sql'),
      'utf8',
    );
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS cloud_doc_folders');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS cloud_docs');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS recent_documents');
    expect(migrationSql).toContain('UNIQUE (user_id, source_key)');

    const compose = fs.readFileSync(path.resolve(__dirname, '../../docker-compose.yml'), 'utf8');
    expect(compose).toContain('IMCODES_CLOUD_DOCS_DIR: /var/lib/imcodes/cloud-docs');
    expect(compose).toContain('cloud_docs:/var/lib/imcodes/cloud-docs');
  });

  it('LocalCloudDocStorage enforces atomic writes, traversal guards, and size limits', async () => {
    await expect(storage.write('../escape', Buffer.from('bad'))).rejects.toThrow(/invalid_storage_key/);
    await expect(storage.write('owner-1/../../escape', Buffer.from('bad'))).rejects.toThrow(/invalid_storage_key/);
    await expect(storage.read('/etc/passwd')).rejects.toThrow(/invalid_storage_key/);

    const oversized = Buffer.alloc(CLOUD_DOCS_MAX_UPLOAD_BYTES + 1, 1);
    await expect(storage.write('owner-1/too_big', oversized)).rejects.toThrow(/file_too_large/);

    const res = await storage.write('owner-1/doc1', Buffer.from('hello world'));
    expect(res.sizeBytes).toBe(11);
    expect(await storage.exists('owner-1/doc1')).toBe(true);
    expect((await storage.read('owner-1/doc1')).toString('utf8')).toBe('hello world');
    await storage.delete('owner-1/doc1');
    await expect(storage.delete('owner-1/doc1')).resolves.toBeUndefined();
  });

  it('handles folder CRUD, blank docx/xlsx/pptx creation, upload validation, and partial-failure rollback', async () => {
    // 1. Folder create + cycle guard + recursive tree delete
    const f1Res = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Specs' }),
    });
    expect(f1Res.status).toBe(201);
    const { folder: f1 } = (await f1Res.json()) as { folder: { id: string; name: string } };

    const f2Res = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Q1', parentId: f1.id }),
    });
    expect(f2Res.status).toBe(201);
    const { folder: f2 } = (await f2Res.json()) as { folder: { id: string } };

    // Prevent circular move (f1 into child f2)
    const cycleRes = await app.request(`/api/cloud-docs/folders/${f1.id}`, {
      method: 'PATCH',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: f2.id }),
    });
    expect(cycleRes.status).toBe(400);

    // 2. Create blank docx / xlsx / pptx
    for (const type of ['docx', 'xlsx', 'pptx'] as const) {
      const blankRes = await app.request('/api/cloud-docs/blank', {
        method: 'POST',
        headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, name: `Plan.${type}`, folderId: f2.id }),
      });
      expect(blankRes.status).toBe(201);
      const { doc } = (await blankRes.json()) as { doc: { id: string; name: string; ext: string } };
      expect(doc.name).toBe(`Plan.${type}`);
      expect(doc.ext).toBe(`.${type}`);

      const dlRes = await app.request(`/api/cloud-docs/${doc.id}/download`, {
        headers: bearerHeader('owner-1'),
      });
      expect(dlRes.status).toBe(200);
      const buf = Buffer.from(await dlRes.arrayBuffer());
      expect(buf.subarray(0, 2).toString('utf8')).toBe('PK'); // Valid ZIP/OOXML
    }

    // 3. Partial-failure rollback on DB insert failure during blank doc creation
    memDb.setFailNextDocInsert(true);
    const failRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'ShouldRollback.docx' }),
    });
    expect(failRes.status).toBe(500);
    // Ensure no orphan blob left in owner-1 dir beyond the 3 valid docs
    const ownerFiles = fs.readdirSync(path.join(tmpDir, 'owner-1'));
    expect(ownerFiles).toHaveLength(3);

    // 4. Multipart upload + unsupported/invalid rejection + delete folder cleans storage blobs
    const form = new FormData();
    form.append('file', new File([Buffer.from('# Notes')], 'Notes.md', { type: 'text/markdown' }));
    const upRes = await app.request('/api/cloud-docs/upload', {
      method: 'POST',
      headers: bearerHeader('owner-1'),
      body: form,
    });
    expect(upRes.status).toBe(201);
    const { doc: uploaded } = (await upRes.json()) as { doc: { id: string; name: string } };
    expect(uploaded.name).toBe('Notes.md');

    const badForm = new FormData();
    badForm.append('file', new File([Buffer.from('bin')], 'virus.exe', { type: 'application/octet-stream' }));
    const badUp = await app.request('/api/cloud-docs/upload', {
      method: 'POST',
      headers: bearerHeader('owner-1'),
      body: badForm,
    });
    expect(badUp.status).toBe(400);

    // Recursive folder delete should unlink the 3 docs inside f2
    const delFolder = await app.request(`/api/cloud-docs/folders/${f1.id}`, {
      method: 'DELETE',
      headers: bearerHeader('owner-1'),
    });
    expect(delFolder.status).toBe(200);
    expect(fs.readdirSync(path.join(tmpDir, 'owner-1'))).toHaveLength(1);
  });

  it('enforces cross-user isolation and doc_collaborator refusal', async () => {
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'Private.docx' }),
    });
    const { doc } = (await createRes.json()) as { doc: { id: string } };

    // Bob cannot list, config, download, rename, or delete Alice's cloud doc
    const bobList = await app.request('/api/cloud-docs', { headers: bearerHeader('user-bob') });
    expect(bobList.status).toBe(200);
    expect(((await bobList.json()) as { docs: unknown[] }).docs).toHaveLength(0);

    for (const req of [
      app.request(`/api/cloud-docs/${doc.id}/onlyoffice/config`, { headers: bearerHeader('user-bob') }),
      app.request(`/api/cloud-docs/${doc.id}/download`, { headers: bearerHeader('user-bob') }),
      app.request(`/api/cloud-docs/${doc.id}`, {
        method: 'PATCH',
        headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijack.docx' }),
      }),
      app.request(`/api/cloud-docs/${doc.id}`, {
        method: 'DELETE',
        headers: bearerHeader('user-bob'),
      }),
    ]) {
      const r = await req;
      expect(r.status).toBe(404);
    }

    // doc_collaborator token is blocked at middleware boundary (403)
    const collabRes = await app.request('/api/cloud-docs', {
      headers: bearerHeader('user-bob', 'doc_collaborator'),
    });
    expect(collabRes.status).toBe(403);
  });

  it('verifies ONLYOFFICE callback JWT, blocks editor_config replay & SSRF, and performs atomic CAS saves with partial-failure rollback', async () => {
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'Contract.docx' }),
    });
    const { doc } = (await createRes.json()) as { doc: { id: string } };

    const cfgRes = await app.request(`/api/cloud-docs/${doc.id}/onlyoffice/config`, {
      headers: bearerHeader('owner-1'),
    });
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as {
      enabled: boolean;
      token: string;
      config: { document: { key: string }; editorConfig: { callbackUrl: string } };
    };
    expect(cfg.enabled).toBe(true);
    const callbackUrl = new URL(cfg.config.editorConfig.callbackUrl).pathname;
    const docKey = cfg.config.document.key;
    const ooSecret = resolveOnlyOfficeJwtSecret({ ONLYOFFICE_JWT_SECRET: OO_SECRET, JWT_SIGNING_KEY: JWT_KEY });

    // 1. Missing callback JWT -> 401
    const noJwtRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 2, url: 'http://onlyoffice:80/file1', key: docKey }),
    });
    expect(noJwtRes.status).toBe(401);

    // 2. Editor config JWT replay -> 401
    const replayCfgRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 2, url: 'http://onlyoffice:80/file1', key: docKey, token: cfg.token }),
    });
    expect(replayCfgRes.status).toBe(401);

    // 3. Untrusted SSRF download URL -> 400
    const ssrfJwt = signJwt({ status: 2, url: 'http://169.254.169.254/latest/meta-data', key: docKey }, ooSecret, 300);
    const ssrfRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ssrfJwt }),
    });
    expect(ssrfRes.status).toBe(400);

    // 4. DB commit failure rolls back new storage file cleanly without corrupting previous file
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('edited-v2-failed'), { status: 200 }),
    );
    memDb.setFailNextDocCommit(true);
    const validCbJwt = signJwt({ status: 2, url: 'http://onlyoffice:80/cache/edited.docx', key: docKey }, ooSecret, 300);
    const failCommitRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: validCbJwt }),
    });
    expect(failCommitRes.status).toBe(500);
    // Still readable original PK bytes & only 1 file in owner-1 dir!
    const afterFailFiles = fs.readdirSync(path.join(tmpDir, 'owner-1'));
    expect(afterFailFiles).toHaveLength(1);

    // 5. ForceSave (status 6) updates bytes keeping doc_version=1, then FinalSave (status 2) bumps doc_version -> 2
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('force-saved-bytes'), { status: 200 }),
    );
    const forceJwt = signJwt({ status: 6, url: 'http://onlyoffice:80/cache/fs.docx', key: docKey }, ooSecret, 300);
    const forceRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: forceJwt }),
    });
    expect(forceRes.status).toBe(200);

    // Concurrent final saves: one succeeds (200), the stale second sees bumped doc_version (409)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(Buffer.from('final-saved-bytes'), { status: 200 }),
    );
    const finalJwt = signJwt({ status: 2, url: 'http://onlyoffice:80/cache/final.docx', key: docKey }, ooSecret, 300);
    const [cb1, cb2] = await Promise.all([
      app.request(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: finalJwt }),
      }),
      app.request(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: finalJwt }),
      }),
    ]);
    const statuses = [cb1.status, cb2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const dlUpdated = await app.request(`/api/cloud-docs/${doc.id}/download`, {
      headers: bearerHeader('owner-1'),
    });
    expect(await dlUpdated.text()).toBe('final-saved-bytes');
    // Old storage blob was unlinked -> still only 1 blob in owner-1 dir!
    expect(fs.readdirSync(path.join(tmpDir, 'owner-1'))).toHaveLength(1);
  });

  it('auto-records recent documents across cloud docs & server files and enforces real-time permission revocation', async () => {
    memDb.teamMembers.set('team-1:user-bob', 'admin');

    // Attach mock daemon so /api/server/srv-1/onlyoffice/config reads /repo/README.md cleanly
    const bridge = WsBridge.get('srv-1');
    class MockDaemonWs extends EventEmitter {
      readyState = 1;
      send(raw: string, _opts?: unknown, cb?: () => void) {
        cb?.();
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (msg.type === 'fs.read') {
          setTimeout(() => {
            this.emit('message', Buffer.from(JSON.stringify({
              type: 'fs.read_response',
              requestId: msg.requestId,
              status: 'ok',
              path: msg.path,
              content: '# Server Readme',
              encoding: 'utf8',
              mtime: Date.now(),
            })), false);
          }, 1);
        }
      }
      close() {}
      ping() {}
    }
    const mockWs = new MockDaemonWs();
    (bridge as unknown as { daemonWs: MockDaemonWs; authenticated: boolean }).daemonWs = mockWs;
    (bridge as unknown as { authenticated: boolean }).authenticated = true;

    // 1. Bob opens server file via ONLYOFFICE config -> automatically recorded in Bob's recent_documents
    const srvCfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/repo/README.md')}`,
      { headers: bearerHeader('user-bob') },
    );
    expect(srvCfgRes.status).toBe(200);

    // Opening same file again increments openCount rather than duplicating
    await app.request('/api/recent-documents/record', {
      method: 'POST',
      headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceKind: 'server_file',
        serverId: 'srv-1',
        filePath: '/repo/README.md',
        title: 'README.md',
      }),
    });

    // Alice cannot see Bob's recent list
    const aliceRecent = await app.request('/api/recent-documents', { headers: bearerHeader('owner-1') });
    expect(((await aliceRecent.json()) as { items: unknown[] }).items).toHaveLength(0);

    // Bob sees accessible = true
    const bobRecent1 = await app.request('/api/recent-documents', { headers: bearerHeader('user-bob') });
    const body1 = (await bobRecent1.json()) as { items: Array<{ id: string; openCount: number; accessible: boolean; accessReason: string | null }> };
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0]!.openCount).toBe(2);
    expect(body1.items[0]!.accessible).toBe(true);

    // 2. Owner removes Bob from team -> real-time access immediately flips accessible=false!
    memDb.teamMembers.delete('team-1:user-bob');
    const bobRecent2 = await app.request('/api/recent-documents', { headers: bearerHeader('user-bob') });
    const body2 = (await bobRecent2.json()) as { items: Array<{ id: string; accessible: boolean; accessReason: string | null }> };
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0]!.accessible).toBe(false);
    expect(body2.items[0]!.accessReason).toBe('access_denied');

    // Bob cannot record unauthorized server file
    const unauthRec = await app.request('/api/recent-documents/record', {
      method: 'POST',
      headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceKind: 'server_file', serverId: 'srv-1', filePath: '/repo/secret.docx' }),
    });
    expect(unauthRec.status).toBe(403);

    // Bob can remove his recent entry, Alice cannot delete Bob's recent entry
    const aliceDelBob = await app.request(`/api/recent-documents/${body2.items[0]!.id}`, {
      method: 'DELETE',
      headers: bearerHeader('owner-1'),
    });
    expect(aliceDelBob.status).toBe(404);

    const bobDel = await app.request(`/api/recent-documents/${body2.items[0]!.id}`, {
      method: 'DELETE',
      headers: bearerHeader('user-bob'),
    });
    expect(bobDel.status).toBe(200);
  });

  it('rejects internal upload/pasted-text temp paths from Recent recording (POSIX & Windows) while recording created & shared Cloud Docs', async () => {
    const bridge = WsBridge.get('srv-1');
    class MockDaemonWs extends EventEmitter {
      readyState = 1;
      send(raw: string, _opts?: unknown, cb?: () => void) {
        cb?.();
        const msg = JSON.parse(raw) as Record<string, unknown>;
        if (msg.type === 'fs.read') {
          setTimeout(() => {
            this.emit('message', Buffer.from(JSON.stringify({
              type: 'fs.read_response',
              requestId: msg.requestId,
              status: 'ok',
              path: msg.path,
              content: 'doc-content',
              encoding: 'utf8',
              mtime: Date.now(),
            })), false);
          }, 1);
        }
      }
      close() {}
      ping() {}
    }
    const mockWs = new MockDaemonWs();
    (bridge as unknown as { daemonWs: MockDaemonWs; authenticated: boolean }).daemonWs = mockWs;
    (bridge as unknown as { authenticated: boolean }).authenticated = true;

    const uploadTempPaths = [
      '/home/k/.imcodes/uploads/237d57beb/pasted-text-2026-11-13T14-12-56-645Z.txt',
      'C:\\Users\\k\\.imcodes\\uploads\\237d57beb\\pasted-text-2026-11-13T14-12-56-645Z.txt',
      '/home/k/.imcodes/uploads/abc/spec.docx',
      '~/.imcodes/uploads/abc/report.pdf',
      '/tmp/pasted-text-2026-11-13T14-12-56-645Z.txt',
    ];

    for (const filePath of uploadTempPaths) {
      const recRes = await app.request('/api/recent-documents/record', {
        method: 'POST',
        headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceKind: 'server_file',
          serverId: 'srv-1',
          filePath,
          title: 'temp',
        }),
      });
      expect(recRes.status, `expected 400 rejection for ${filePath}`).toBe(400);

      const ooRes = await app.request(
        `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent(filePath)}`,
        { headers: bearerHeader('owner-1') },
      );
      expect([200, 400]).toContain(ooRes.status);
    }

    // Still zero recent documents for owner-1 after upload-temp opens
    const ownerRecentEmpty = await app.request('/api/recent-documents', { headers: bearerHeader('owner-1') });
    expect(((await ownerRecentEmpty.json()) as { items: unknown[] }).items).toHaveLength(0);

    // Non-upload Office/PDF server file opened via ONLYOFFICE config DOES record
    const validOoRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/repo/report.pdf')}`,
      { headers: bearerHeader('owner-1') },
    );
    expect(validOoRes.status).toBe(200);
    const ownerRecentServer = await app.request('/api/recent-documents', { headers: bearerHeader('owner-1') });
    const ownerServerItems = ((await ownerRecentServer.json()) as { items: Array<{ sourceKind: string; filePath?: string | null }> }).items;
    expect(ownerServerItems).toHaveLength(1);
    expect(ownerServerItems[0]).toMatchObject({ sourceKind: 'server_file', filePath: '/repo/report.pdf' });

    // User/agent-created Cloud Doc + shared Cloud Doc open DOES record in recent_documents
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'Agent Spec.docx' }),
    });
    expect(createRes.status).toBe(201);
    const { doc } = (await createRes.json()) as { doc: { id: string } };

    // Share with Bob and open as both owner and shared collaborator
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: doc.id,
        shareMode: 'user',
        targetUserId: 'user-bob',
        role: 'editor',
      }),
    });

    const ownerOpen = await app.request(`/api/cloud-docs/${doc.id}/onlyoffice/config`, {
      headers: bearerHeader('owner-1'),
    });
    expect(ownerOpen.status).toBe(200);

    const bobOpen = await app.request(`/api/cloud-docs/${doc.id}/onlyoffice/config`, {
      headers: bearerHeader('user-bob'),
    });
    expect(bobOpen.status).toBe(200);

    const ownerRecent = await app.request('/api/recent-documents', { headers: bearerHeader('owner-1') });
    const ownerItems = ((await ownerRecent.json()) as { items: Array<{ sourceKind: string; cloudDocId?: string | null; title: string }> }).items;
    expect(ownerItems).toHaveLength(2);
    expect(ownerItems.some((it) => it.sourceKind === 'cloud_doc' && it.cloudDocId === doc.id && it.title === 'Agent Spec.docx')).toBe(true);

    const bobRecent = await app.request('/api/recent-documents', { headers: bearerHeader('user-bob') });
    const bobItems = ((await bobRecent.json()) as { items: Array<{ sourceKind: string; cloudDocId?: string | null; title: string }> }).items;
    expect(bobItems).toHaveLength(1);
    expect(bobItems[0]).toMatchObject({ sourceKind: 'cloud_doc', cloudDocId: doc.id, title: 'Agent Spec.docx' });
  });

  it('reuses teams/team_members for sharing, overrides folder grants with doc grants, enforces viewer/allowDownload, and revokes live on callback/member removal/disable', async () => {
    const sqlPath = path.resolve(__dirname, '../src/db/migrations/105_cloud_docs_and_recent_documents.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cloud_doc_shares');
    expect(sql).toContain('REFERENCES teams(id) ON DELETE CASCADE');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS cloud_doc_teams');

    // Create parent folder -> child folder -> doc1 & doc2
    const f1Res = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team Workspace' }),
    });
    const { folder: f1 } = (await f1Res.json()) as { folder: { id: string } };

    const d1Res = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'InheritedEdit.docx', folderId: f1.id }),
    });
    const { doc: d1 } = (await d1Res.json()) as { doc: { id: string } };

    const d2Res = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'xlsx', name: 'RestrictedViewer.xlsx', folderId: f1.id }),
    });
    const { doc: d2 } = (await d2Res.json()) as { doc: { id: string } };

    // Bob lists global controlled-node groups (teams)
    const teamsRes = await app.request('/api/cloud-docs/teams', { headers: bearerHeader('user-bob') });
    expect(teamsRes.status).toBe(200);
    const teamsJson = (await teamsRes.json()) as { teams: Array<{ id: string; name: string }> };
    expect(teamsJson.teams.map((t) => t.id)).toEqual(['team-1']);

    // Alice shares parent folder f1 to team-1 as editor + allowDownload=true
    const fShareRes = await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'folder',
        targetId: f1.id,
        shareMode: 'team',
        targetTeamId: 'team-1',
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(fShareRes.status).toBe(201);

    // Alice overrides d2 inside f1 to team-1 as viewer + allowDownload=false
    const d2ShareRes = await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: d2.id,
        shareMode: 'team',
        targetTeamId: 'team-1',
        role: 'viewer',
        allowDownload: false,
      }),
    });
    expect(d2ShareRes.status).toBe(201);

    // Bob sees both in sharedDocs, Carol (non-member) sees neither
    const bobList = (await (await app.request('/api/cloud-docs', { headers: bearerHeader('user-bob') })).json()) as {
      sharedFolders: Array<{ id: string; role: string }>;
      sharedDocs: Array<{ id: string; role: string; allowDownload: boolean; sharedVia: string }>;
    };
    expect(bobList.sharedFolders.find((f) => f.id === f1.id)?.role).toBe('editor');
    const bobD1 = bobList.sharedDocs.find((d) => d.id === d1.id);
    const bobD2 = bobList.sharedDocs.find((d) => d.id === d2.id);
    expect(bobD1?.role).toBe('editor');
    expect(bobD1?.allowDownload).toBe(true);
    expect(bobD2?.role).toBe('viewer');
    expect(bobD2?.allowDownload).toBe(false);
    expect(bobD2?.sharedVia).toBe('doc');

    const carolList = (await (await app.request('/api/cloud-docs', { headers: bearerHeader('user-carol') })).json()) as {
      sharedFolders: unknown[];
      sharedDocs: unknown[];
    };
    expect(carolList.sharedFolders).toHaveLength(0);
    expect(carolList.sharedDocs).toHaveLength(0);

    // Viewer write-protection & allowDownload=false enforcement on d2:
    const d2CfgRes = await app.request(`/api/cloud-docs/${d2.id}/onlyoffice/config?mode=edit`, {
      headers: bearerHeader('user-bob'),
    });
    expect(d2CfgRes.status).toBe(200);
    const d2Cfg = (await d2CfgRes.json()) as {
      role: string;
      allowDownload: boolean;
      mode: string;
      config: {
        document: { key: string; permissions: { edit: boolean; download: boolean; print: boolean; copy: boolean } };
        editorConfig: { callbackUrl: string };
      };
    };
    expect(d2Cfg.role).toBe('viewer');
    expect(d2Cfg.allowDownload).toBe(false);
    expect(d2Cfg.mode).toBe('view'); // ?mode=edit ignored!
    expect(d2Cfg.config.document.permissions.edit).toBe(false);
    expect(d2Cfg.config.document.permissions.download).toBe(false);
    expect(d2Cfg.config.document.permissions.print).toBe(false);

    const d2DlForbidden = await app.request(`/api/cloud-docs/${d2.id}/download`, {
      headers: bearerHeader('user-bob'),
    });
    expect(d2DlForbidden.status).toBe(403);

    const d2PatchForbidden = await app.request(`/api/cloud-docs/${d2.id}`, {
      method: 'PATCH',
      headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tamper.xlsx' }),
    });
    expect(d2PatchForbidden.status).toBe(403);

    // Bob opens d1 as editor -> gets ONLYOFFICE config with edit=true + docToken/callbackUrl
    const d1CfgRes = await app.request(`/api/cloud-docs/${d1.id}/onlyoffice/config?mode=edit`, {
      headers: bearerHeader('user-bob'),
    });
    expect(d1CfgRes.status).toBe(200);
    const d1Cfg = (await d1CfgRes.json()) as {
      role: string;
      config: { document: { key: string; url: string }; editorConfig: { callbackUrl: string } };
    };
    expect(d1Cfg.role).toBe('editor');
    const d1CallbackPath = new URL(d1Cfg.config.editorConfig.callbackUrl).pathname;
    const d1FilePath = new URL(d1Cfg.config.document.url).pathname;
    const d1Key = d1Cfg.config.document.key;
    const ooSecret = resolveOnlyOfficeJwtSecret({ ONLYOFFICE_JWT_SECRET: OO_SECRET, JWT_SIGNING_KEY: JWT_KEY });
    const d1CallbackJwt = signJwt(
      { status: 2, key: d1Key, url: 'http://onlyoffice:80/cache/bob-edit.docx' },
      ooSecret,
      300,
    );

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('bob-collaborative-edit'), { status: 200 })));

    // Pre-check: even if Bob ALREADY received an editor callback token:
    // 1) Downgrade Bob at doc level to viewer -> pre-issued editor callback MUST return 403 and NOT overwrite!
    const downgradeRes = await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: d1.id,
        shareMode: 'user',
        targetUsername: 'bob',
        role: 'viewer',
        allowDownload: true,
      }),
    });
    expect(downgradeRes.status).toBe(201);
    const { share: bobUserShare } = (await downgradeRes.json()) as { share: { id: string } };

    const cbAfterDowngrade = await app.request(d1CallbackPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: d1CallbackJwt }),
    });
    expect(cbAfterDowngrade.status).toBe(403);
    expect(Number(memDb.docs.get(d1.id)?.doc_version)).toBe(1);

    // Revoke user override so Bob is back to folder editor via team-1, then remove Bob from team_members -> live revoke!
    await app.request(`/api/cloud-docs/shares/${bobUserShare.id}`, {
      method: 'DELETE',
      headers: bearerHeader('owner-1'),
    });
    memDb.teamMembers.delete('team-1:user-bob');

    const cbAfterMemberRemoved = await app.request(d1CallbackPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: d1CallbackJwt }),
    });
    expect(cbAfterMemberRemoved.status).toBe(403);

    const fileAfterMemberRemoved = await app.request(d1FilePath);
    expect(fileAfterMemberRemoved.status).toBe(403);

    // Restore membership, then disable Bob's user account (`status = 'disabled'`) -> immediate rejection on callback & file!
    memDb.teamMembers.set('team-1:user-bob', 'member');
    memDb.users.get('user-bob')!.status = 'disabled';

    const cbAfterUserDisabled = await app.request(d1CallbackPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: d1CallbackJwt }),
    });
    expect(cbAfterUserDisabled.status).toBe(403);

    // Re-enable Bob -> now collaborative editor callback succeeds cleanly and bumps doc_version to 2!
    memDb.users.get('user-bob')!.status = 'active';
    const cbValidEditor = await app.request(d1CallbackPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: d1CallbackJwt }),
    });
    expect(cbValidEditor.status).toBe(200);
    expect(Number(memDb.docs.get(d1.id)?.doc_version)).toBe(2);
  });

  it('preserves committed blobs on ambiguous post-commit failures while rolling back proven pre-commit failures (status 2 & 6, blank, upload)', async () => {
    // 1. blank & upload: ambiguous failure leaves committed DB row + blob readable (no 404); pre-commit failure removes blob
    memDb.setFailNextDocInsertMode('ambiguous');
    const ambBlankRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'CommittedDespiteDrop.docx' }),
    });
    expect(ambBlankRes.status).toBe(500);
    const committedDoc = [...memDb.docs.values()].find((d) => d.name === 'CommittedDespiteDrop.docx')!;
    expect(committedDoc).toBeTruthy();
    const dlAmbBlank = await app.request(`/api/cloud-docs/${committedDoc.id}/download`, {
      headers: bearerHeader('owner-1'),
    });
    expect(dlAmbBlank.status).toBe(200);

    memDb.setFailNextDocInsertMode('pre_commit');
    const preUploadForm = new FormData();
    preUploadForm.append('file', new File([Buffer.from('# Should Rollback')], 'Rollback.md', { type: 'text/markdown' }));
    const preUploadRes = await app.request('/api/cloud-docs/files', {
      method: 'POST',
      headers: bearerHeader('owner-1'),
      body: preUploadForm,
    });
    expect(preUploadRes.status).toBe(500);
    expect(fs.readdirSync(path.join(tmpDir, 'owner-1'))).toHaveLength(1);

    memDb.setFailNextDocInsertMode('ambiguous');
    const ambUploadForm = new FormData();
    ambUploadForm.append('file', new File([Buffer.from('# Committed Upload')], 'Kept.md', { type: 'text/markdown' }));
    const ambUploadRes = await app.request('/api/cloud-docs/files', {
      method: 'POST',
      headers: bearerHeader('owner-1'),
      body: ambUploadForm,
    });
    expect(ambUploadRes.status).toBe(500);
    const keptDoc = [...memDb.docs.values()].find((d) => d.name === 'Kept.md')!;
    const dlKept = await app.request(`/api/cloud-docs/${keptDoc.id}/download`, {
      headers: bearerHeader('owner-1'),
    });
    expect(dlKept.status).toBe(200);
    expect(await dlKept.text()).toBe('# Committed Upload');

    // 2. callback status 6 & status 2: ambiguous post-commit failure NEVER deletes live blob
    const cfgRes = await app.request(`/api/cloud-docs/${committedDoc.id}/onlyoffice/config`, {
      headers: bearerHeader('owner-1'),
    });
    const cfg = (await cfgRes.json()) as {
      config: { document: { key: string }; editorConfig: { callbackUrl: string } };
    };
    const callbackUrl = new URL(cfg.config.editorConfig.callbackUrl).pathname;
    const docKey = cfg.config.document.key;
    const ooSecret = resolveOnlyOfficeJwtSecret({ ONLYOFFICE_JWT_SECRET: OO_SECRET, JWT_SIGNING_KEY: JWT_KEY });

    // Status 6 with pre_commit error must NOT delete existing v1 file because newStorageKey === current.storage_key
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('force-save-attempt'), { status: 200 }),
    );
    memDb.setFailNextDocCommitMode('pre_commit');
    const preForceJwt = signJwt({ status: 6, url: 'http://onlyoffice:80/cache/fs1.docx', key: docKey }, ooSecret, 300);
    const preForceRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: preForceJwt }),
    });
    expect(preForceRes.status).toBe(500);
    expect(await storage.exists(committedDoc.storage_key)).toBe(true);

    // Status 6 with ambiguous post-commit error -> row & blob stay readable
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('force-save-ambiguous'), { status: 200 }),
    );
    memDb.setFailNextDocCommitMode('ambiguous');
    const ambForceJwt = signJwt({ status: 6, url: 'http://onlyoffice:80/cache/fs2.docx', key: docKey }, ooSecret, 300);
    const ambForceRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ambForceJwt }),
    });
    expect(ambForceRes.status).toBe(500);
    const dlAfterForce = await app.request(`/api/cloud-docs/${committedDoc.id}/download`, {
      headers: bearerHeader('owner-1'),
    });
    expect(dlAfterForce.status).toBe(200);
    expect(await dlAfterForce.text()).toBe('force-save-ambiguous');

    // Status 2 with ambiguous post-commit error: DB already moved to v2/storage_key=v2 -> v2 blob MUST NOT be deleted!
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('final-v2-committed'), { status: 200 }),
    );
    memDb.setFailNextDocCommitMode('ambiguous');
    const ambFinalJwt = signJwt({ status: 2, url: 'http://onlyoffice:80/cache/final.docx', key: docKey }, ooSecret, 300);
    const ambFinalRes = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ambFinalJwt }),
    });
    expect(ambFinalRes.status).toBe(500);
    expect(Number(memDb.docs.get(committedDoc.id)?.doc_version)).toBe(2);
    const dlAfterAmbFinal = await app.request(`/api/cloud-docs/${committedDoc.id}/download`, {
      headers: bearerHeader('owner-1'),
    });
    expect(dlAfterAmbFinal.status).toBe(200);
    expect(await dlAfterAmbFinal.text()).toBe('final-v2-committed');
  });

  it('mints short-lived download tickets for cookie-less native downloads and enforces live access & allowDownload & token isolation', async () => {
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'NativeDownload.docx' }),
    });
    const { doc } = (await createRes.json()) as { doc: { id: string } };

    // Share with Bob via team-1 (allowDownload = true initially)
    const shareRes = await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: doc.id,
        shareMode: 'team',
        targetTeamId: 'team-1',
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(shareRes.status).toBe(201);
    const { share } = (await shareRes.json()) as { share: { id: string } };

    // 1. Mint ticket with Bearer auth (no Cookie), redeem WITHOUT Authorization or Cookie headers!
    const mintRes = await app.request(`/api/cloud-docs/${doc.id}/download-ticket`, {
      method: 'POST',
      headers: { ...bearerHeader('user-bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ inline: false }),
    });
    expect(mintRes.status).toBe(200);
    const { ticket, downloadPath } = (await mintRes.json()) as { ticket: string; downloadPath: string };
    expect(downloadPath).toBe(`/api/cloud-docs/download/${encodeURIComponent(ticket)}`);

    const redeemNoAuth = await app.request(downloadPath);
    expect(redeemNoAuth.status).toBe(200);
    expect(redeemNoAuth.headers.get('content-disposition')).toContain('attachment');
    expect((await redeemNoAuth.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // 2. Download ticket MUST NOT work as Bearer session token; ONLYOFFICE preview token MUST NOT work on download ticket route
    const ticketAsBearer = await app.request('/api/cloud-docs', {
      headers: { Authorization: `Bearer ${ticket}` },
    });
    expect(ticketAsBearer.status).toBe(401);

    const cfgRes = await app.request(`/api/cloud-docs/${doc.id}/onlyoffice/config`, {
      headers: bearerHeader('user-bob'),
    });
    const cfg = (await cfgRes.json()) as { docToken: string };
    const ooAsTicket = await app.request(`/api/cloud-docs/download/${encodeURIComponent(cfg.docToken)}`);
    expect(ooAsTicket.status).toBe(401);

    // 3. Downgrade allowDownload=false AFTER mint -> existing unredeemed ticket MUST fail 403 on redeem, and new mint fails 403!
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: doc.id,
        shareMode: 'team',
        targetTeamId: 'team-1',
        role: 'viewer',
        allowDownload: false,
      }),
    });
    expect((await app.request(downloadPath)).status).toBe(403);
    expect(
      (
        await app.request(`/api/cloud-docs/${doc.id}/download-ticket`, {
          method: 'POST',
          headers: bearerHeader('user-bob'),
        })
      ).status,
    ).toBe(403);

    // 4. Re-allow download, mint a new ticket, then remove Bob from team & disable Bob -> redeem MUST fail 403!
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'doc',
        targetId: doc.id,
        shareMode: 'team',
        targetTeamId: 'team-1',
        role: 'viewer',
        allowDownload: true,
      }),
    });
    const mintRes2 = await app.request(`/api/cloud-docs/${doc.id}/download-ticket`, {
      method: 'POST',
      headers: bearerHeader('user-bob'),
    });
    const { downloadPath: dp2 } = (await mintRes2.json()) as { downloadPath: string };

    memDb.teamMembers.delete('team-1:user-bob');
    expect((await app.request(dp2)).status).toBe(403);

    memDb.teamMembers.set('team-1:user-bob', 'member');
    memDb.users.get('user-bob')!.status = 'disabled';
    expect((await app.request(dp2)).status).toBe(403);

    // Cleanup revoke check
    await app.request(`/api/cloud-docs/shares/${share.id}`, {
      method: 'DELETE',
      headers: bearerHeader('owner-1'),
    });
  });

  it('aborts oversized streams early without full buffering on callback & upload (exact bounds, spoofed Content-Length, mid-stream error)', async () => {
    const createRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'docx', name: 'StreamLimit.docx' }),
    });
    const { doc } = (await createRes.json()) as { doc: { id: string } };
    const cfgRes = await app.request(`/api/cloud-docs/${doc.id}/onlyoffice/config`, {
      headers: bearerHeader('owner-1'),
    });
    const cfg = (await cfgRes.json()) as {
      config: { document: { key: string }; editorConfig: { callbackUrl: string } };
    };
    const callbackUrl = new URL(cfg.config.editorConfig.callbackUrl).pathname;
    const docKey = cfg.config.document.key;
    const ooSecret = resolveOnlyOfficeJwtSecret({ ONLYOFFICE_JWT_SECRET: OO_SECRET, JWT_SIGNING_KEY: JWT_KEY });
    const cbJwt = signJwt({ status: 2, url: 'http://onlyoffice:80/cache/big.docx', key: docKey }, ooSecret, 300);

    // 1. Declared Content-Length > limit aborts before pulling stream chunks
    let declaredCancelled = false;
    let declaredPulls = 0;
    const declaredBigStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        declaredPulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        declaredCancelled = true;
      },
    });
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(declaredBigStream, {
        status: 200,
        headers: { 'Content-Length': String(CLOUD_DOCS_MAX_UPLOAD_BYTES + 1) },
      });
    });
    const resDeclared = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cbJwt }),
    });
    expect(resDeclared.status).toBe(413);
    expect(declaredCancelled).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(declaredPulls).toBeLessThanOrEqual(1);

    // 2. Spoofed tiny Content-Length (128 bytes) while streaming 1 MiB chunks past 50 MiB -> cancels & aborts early!
    const chunkSize = 4 * 1024 * 1024;
    const totalChunks = 20; // 80 MiB total if unstopped; cap is 50 MiB (crosses at chunk 13)
    let pulled = 0;
    let cancelledEarly = false;
    const spoofedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkSize));
      },
      cancel() {
        cancelledEarly = true;
      },
    });
    let spoofSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
      spoofSignal = init?.signal ?? undefined;
      return new Response(spoofedStream, {
        status: 200,
        headers: { 'Content-Length': '128' },
      });
    });
    const resSpoofed = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cbJwt }),
    });
    expect(resSpoofed.status).toBe(413);
    expect(cancelledEarly).toBe(true);
    expect(spoofSignal?.aborted).toBe(true);
    expect(pulled).toBeLessThan(totalChunks);

    // 3. Exact max-1 bytes succeeds; mid-stream error returns 502 and leaves existing content intact
    const midErrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.error(new Error('socket_reset_mid_transfer'));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(midErrStream, { status: 200 }));
    const resMidErr = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cbJwt }),
    });
    expect(resMidErr.status).toBe(502);
    expect(Number(memDb.docs.get(doc.id)?.doc_version)).toBe(1);

    // Exact max bytes succeeds (v1 -> v2)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new Uint8Array(CLOUD_DOCS_MAX_UPLOAD_BYTES), { status: 200 }),
    );
    const resExact = await app.request(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cbJwt }),
    });
    expect(resExact.status).toBe(200);
    expect(Number(memDb.docs.get(doc.id)?.doc_version)).toBe(2);

    // 4. Chunked multipart upload with spoofed tiny Content-Length exceeding ceiling aborts early -> 413 & no DB/blob created
    const docCountBefore = memDb.docs.size;
    let uploadPulled = 0;
    let uploadCancelled = false;
    const hugeUploadStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        uploadPulled += 1;
        if (uploadPulled > 18) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      },
      cancel() {
        uploadCancelled = true;
      },
    });
    const reqInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        ...bearerHeader('owner-1'),
        'Content-Type': 'multipart/form-data; boundary=----imcodesBoundary',
        'Content-Length': '64',
      },
      body: hugeUploadStream,
      duplex: 'half',
    };
    const hugeUploadRes = await app.request(new Request('http://localhost/api/cloud-docs/files', reqInit));
    expect(hugeUploadRes.status).toBe(413);
    expect(uploadCancelled).toBe(true);
    expect(uploadPulled).toBeLessThan(18);
    expect(memDb.docs.size).toBe(docCountBefore);
  });

  function daemonHeaders(serverId = 'srv-1', secret = 'srv-1-secret', sharedAuthority?: string): Record<string, string> {
    const h: Record<string, string> = {
      [SERVER_ID_HEADER]: serverId,
      Authorization: `Bearer ${secret}`,
    };
    if (sharedAuthority) h[SHARED_MACHINE_AUTHORITY_HEADER] = sharedAuthority;
    return h;
  }

  function mintParticipantAuthority(actorUserId = 'user-bob', serverId = 'srv-1') {
    const now = Date.now();
    memDb.sessionShares.push({
      id: `ss-${actorUserId}-${now}`,
      server_id: serverId,
      session_name: 'main-shared',
      target_user_id: actorUserId,
      role: 'participant',
      created_by: 'owner-1',
      created_at: now - 1000,
      updated_at: now - 1000,
      expires_at: now + 3600_000,
      revoked_at: null,
    });
    return issueSharedMachineAuthority(
      {
        type: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: actorUserId,
        sourceServerId: serverId,
        sessionName: 'main-shared',
        projectName: 'demo-proj',
        shareTarget: { kind: 'main', serverId, sessionName: 'main-shared' },
        actionId: `act-${now}`,
      },
      JWT_KEY,
    );
  }

  it('enforces FULL vs controlled-node gating and fail-closed delegated authority parity', async () => {
    // 1. Owner creates an unshared private doc via FULL daemon token
    const createPrivateRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...daemonHeaders('srv-1', 'srv-1-secret'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'owner-secret', type: 'docx', content: 'Confidential line' }),
    });
    expect(createPrivateRes.status).toBe(201);
    const privateDoc = (await createPrivateRes.json()).doc as { id: string; docVersion: number };

    // 2. Non-FULL (controlled) node daemon token is denied on every cloud-docs endpoint
    const ctrlHeaders = daemonHeaders('srv-ctrl', 'srv-ctrl-secret');
    expect((await app.request('/api/cloud-docs', { headers: ctrlHeaders })).status).toBe(403);
    expect(
      (
        await app.request('/api/cloud-docs/blank', {
          method: 'POST',
          headers: { ...ctrlHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'x', type: 'txt' }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request(`/api/cloud-docs/${privateDoc.id}/content`, { headers: ctrlHeaders })).status).toBe(403);
    expect(
      (
        await app.request(`/api/cloud-docs/${privateDoc.id}/content`, {
          method: 'PUT',
          headers: { ...ctrlHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'hack', mode: 'replace' }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request(`/api/cloud-docs/${privateDoc.id}`, { method: 'DELETE', headers: ctrlHeaders })).status).toBe(403);

    // 3. Valid participant authority acts strictly as user-bob (cannot see/edit/delete owner's unshared doc)
    const bobAuthority = mintParticipantAuthority('user-bob');
    const bobListRes = await app.request('/api/cloud-docs', {
      headers: daemonHeaders('srv-1', 'srv-1-secret', bobAuthority),
    });
    expect(bobListRes.status).toBe(200);
    const bobList = await bobListRes.json();
    expect(bobList.docs.map((d: { id: string }) => d.id)).not.toContain(privateDoc.id);
    expect(bobList.sharedDocs.map((d: { id: string }) => d.id)).not.toContain(privateDoc.id);

    const bobReadPrivate = await app.request(`/api/cloud-docs/${privateDoc.id}/content`, {
      headers: daemonHeaders('srv-1', 'srv-1-secret', bobAuthority),
    });
    expect(bobReadPrivate.status).toBe(404);

    // 4. Tampered, wrong-server, or revoked delegated authority FAILS CLOSED (never falls back to host owner-1)
    const invalidAuthorities = [
      'not-a-jwt',
      issueSharedMachineAuthority(
        {
          type: SHARED_MACHINE_AUTHORITY_TYPE,
          sub: 'user-bob',
          sourceServerId: 'srv-other',
          sessionName: 'main-shared',
          projectName: 'demo-proj',
          shareTarget: { kind: 'main', serverId: 'srv-other', sessionName: 'main-shared' },
          actionId: 'bad-srv',
        },
        JWT_KEY,
      ),
    ];
    for (const badAuth of invalidAuthorities) {
      const r = await app.request(`/api/cloud-docs/${privateDoc.id}/content`, {
        headers: daemonHeaders('srv-1', 'srv-1-secret', badAuth),
      });
      expect(r.status).toBe(403);
      const rList = await app.request('/api/cloud-docs', {
        headers: daemonHeaders('srv-1', 'srv-1-secret', badAuth),
      });
      expect(rList.status).toBe(403);
    }

    // Revoking the live session share immediately invalidates the already-minted authority
    memDb.sessionShares[0]!.revoked_at = Date.now();
    const afterRevokeRes = await app.request('/api/cloud-docs', {
      headers: daemonHeaders('srv-1', 'srv-1-secret', bobAuthority),
    });
    expect(afterRevokeRes.status).toBe(403);
  });

  it('enforces exact owner / shared editor / shared viewer ACL matrix across folders, docs, content, and shares', async () => {
    const bobAuthority = mintParticipantAuthority('user-bob');
    const bobAgentHeaders = daemonHeaders('srv-1', 'srv-1-secret', bobAuthority);

    // Owner creates shared editor folder + sibling editor folder + viewer doc + owner-only doc
    const f1Res = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SharedWork' }),
    });
    const f1 = (await f1Res.json()).folder as { id: string };
    const f2Res = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SharedArchive' }),
    });
    const f2 = (await f2Res.json()).folder as { id: string };

    // Share f1 & f2 as editor with bob, plus create a doc in f1 and a separate viewer doc shared with carol
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareMode: 'user', targetKind: 'folder', targetId: f1.id, targetUsername: 'bob', role: 'editor', allowDownload: true }),
    });
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareMode: 'user', targetKind: 'folder', targetId: f2.id, targetUsername: 'bob', role: 'editor', allowDownload: true }),
    });

    const viewerDocRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ReadonlyNotice', type: 'md', content: 'View only' }),
    });
    const viewerDoc = (await viewerDocRes.json()).doc as { id: string; docVersion: number };
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...bearerHeader('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareMode: 'user', targetKind: 'doc', targetId: viewerDoc.id, targetUsername: 'bob', role: 'viewer', allowDownload: true }),
    });

    // Editor (bob agent): CAN create doc + subfolder inside shared editor folder f1
    const bobDocRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CollabSpec', type: 'docx', folderId: f1.id, content: 'Draft 1' }),
    });
    expect(bobDocRes.status).toBe(201);
    const bobDoc = (await bobDocRes.json()).doc as { id: string; docVersion: number };

    const bobSubfolderRes = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Subdir', parentId: f1.id }),
    });
    expect(bobSubfolderRes.status).toBe(201);
    const bobSubfolder = (await bobSubfolderRes.json()).folder as { id: string };

    // Owner sees doc created inside shared folder too (inherited under owner's tree)
    const ownerListRes = await app.request('/api/cloud-docs', { headers: bearerHeader('owner-1') });
    const ownerList = await ownerListRes.json();
    expect(ownerList.docs.some((d: { id: string }) => d.id === bobDoc.id)).toBe(true);

    // Editor CAN edit content, rename, and move within shared editor folders (f1 -> f2)
    const editRes = await app.request(`/api/cloud-docs/${bobDoc.id}/content`, {
      method: 'PUT',
      headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Draft 2', mode: 'append', expectedVersion: 1 }),
    });
    expect(editRes.status).toBe(200);
    expect((await editRes.json()).doc.docVersion).toBe(2);

    const renameMoveRes = await app.request(`/api/cloud-docs/${bobDoc.id}`, {
      method: 'PATCH',
      headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CollabSpecRenamed', folderId: f2.id }),
    });
    expect(renameMoveRes.status).toBe(200);
    expect((await renameMoveRes.json()).doc.folderId).toBe(f2.id);

    // Editor CANNOT move shared doc to root (folderId: null), delete doc/folder, or inspect/manage shares
    expect(
      (
        await app.request(`/api/cloud-docs/${bobDoc.id}`, {
          method: 'PATCH',
          headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId: null }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request(`/api/cloud-docs/${bobDoc.id}`, { method: 'DELETE', headers: bobAgentHeaders })).status).toBe(403);
    expect((await app.request(`/api/cloud-docs/folders/${bobSubfolder.id}`, { method: 'DELETE', headers: bobAgentHeaders })).status).toBe(403);
    expect((await app.request(`/api/cloud-docs/shares/doc/${bobDoc.id}`, { headers: bobAgentHeaders })).status).toBe(403);
    expect(
      (
        await app.request('/api/cloud-docs/shares', {
          method: 'POST',
          headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareMode: 'user', targetKind: 'doc', targetId: bobDoc.id, targetUsername: 'carol', role: 'viewer' }),
        })
      ).status,
    ).toBe(403);

    // Viewer (bob on viewerDoc): CAN read/content, CANNOT edit/rename/delete/share
    const viewReadRes = await app.request(`/api/cloud-docs/${viewerDoc.id}/content`, { headers: bobAgentHeaders });
    expect(viewReadRes.status).toBe(200);
    expect((await viewReadRes.json()).content).toBe('View only');

    expect(
      (
        await app.request(`/api/cloud-docs/${viewerDoc.id}/content`, {
          method: 'PUT',
          headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'overwrite', mode: 'replace' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/cloud-docs/${viewerDoc.id}`, {
          method: 'PATCH',
          headers: { ...bobAgentHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'tamper' }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request(`/api/cloud-docs/${viewerDoc.id}`, { method: 'DELETE', headers: bobAgentHeaders })).status).toBe(403);
  });

  it('supports OOXML & text content read/write, optimistic CAS, unsupported format error, and storage/DB rollback', async () => {
    const ownerDaemon = daemonHeaders('srv-1', 'srv-1-secret');

    // Create docx, xlsx, pptx, txt with initial content and verify round-trips
    const xlsxRes = await app.request('/api/cloud-docs/blank', {
      method: 'POST',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Budget', type: 'xlsx', content: 'Item\tCost\nHost\t42' }),
    });
    expect(xlsxRes.status).toBe(201);
    const xlsxDoc = (await xlsxRes.json()).doc as { id: string; docVersion: number };

    const xlsxRead = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, { headers: ownerDaemon });
    expect(xlsxRead.status).toBe(200);
    const xlsxBody = await xlsxRead.json();
    expect(xlsxBody.format).toBe('xlsx');
    expect(xlsxBody.sheets).toEqual([{ name: 'Sheet1', rows: [['Item', 'Cost'], ['Host', '42']] }]);

    // Append row + verify version 1 -> 2
    const appendRes = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, {
      method: 'PUT',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Domain\t15', mode: 'append', expectedVersion: 1 }),
    });
    expect(appendRes.status).toBe(200);
    const afterAppend = await appendRes.json();
    expect(afterAppend.doc.docVersion).toBe(2);

    // Stale expectedVersion -> 409 conflict & version stays 2
    const conflictRes = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, {
      method: 'PUT',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'stale', mode: 'replace', expectedVersion: 1 }),
    });
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).error).toBe('version_conflict');
    expect(Number(memDb.docs.get(xlsxDoc.id)?.doc_version)).toBe(2);

    // Pre-commit DB failure rolls back orphan blob and leaves v2 intact
    const filesBefore = fs.readdirSync(tmpDir, { recursive: true }).length;
    memDb.setFailNextDocCommitMode('pre_commit');
    const failedWriteRes = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, {
      method: 'PUT',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'should-rollback', mode: 'replace', expectedVersion: 2 }),
    });
    expect(failedWriteRes.status).toBe(500);
    expect(Number(memDb.docs.get(xlsxDoc.id)?.doc_version)).toBe(2);
    expect(fs.readdirSync(tmpDir, { recursive: true }).length).toBe(filesBefore);
    const verifyIntact = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, { headers: ownerDaemon });
    expect((await verifyIntact.json()).content).toContain('Domain\t15');

    // Unsupported format (.pdf) returns 400 unsupported_document_type on read & unsupported_content_edit on write
    const form = new FormData();
    form.set('file', new File([Buffer.from('%PDF-1.4\n')], 'manual.pdf', { type: 'application/pdf' }));
    const pdfRes = await app.request('/api/cloud-docs/files', {
      method: 'POST',
      headers: ownerDaemon,
      body: form,
    });
    const pdfDoc = (await pdfRes.json()).doc as { id: string };
    const readPdfRes = await app.request(`/api/cloud-docs/${pdfDoc.id}/content`, { headers: ownerDaemon });
    expect(readPdfRes.status).toBe(400);
    expect((await readPdfRes.json()).error).toBe('unsupported_document_type');
    const writePdfRes = await app.request(`/api/cloud-docs/${pdfDoc.id}/content`, {
      method: 'PUT',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x', mode: 'replace' }),
    });
    expect(writePdfRes.status).toBe(400);
    expect((await writePdfRes.json()).error).toBe('unsupported_content_edit');

    // F1 causal test: DB rows returning string doc_version (e.g. pg driver numeric/bigint coercion)
    // normalize cleanly without string concatenation ('1' + 1 -> '11') or false 409 conflicts.
    const rawRow = memDb.docs.get(xlsxDoc.id)!;
    (rawRow as unknown as { doc_version: string | number }).doc_version = '2';
    const staleWithStringRow = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, {
      method: 'PUT',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'conflict', mode: 'replace', expectedVersion: 1 }),
    });
    expect(staleWithStringRow.status).toBe(409);
    expect(await staleWithStringRow.json()).toEqual({ error: 'version_conflict', currentVersion: 2 });

    const validWithStringRow = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, {
      method: 'PUT',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'UpdatedRow\t99', mode: 'replace', expectedVersion: 2 }),
    });
    expect(validWithStringRow.status).toBe(200);
    expect((await validWithStringRow.json()).doc.docVersion).toBe(3);

    // F4 causal test: combined PUT /content + metadata rejects atomically when metadata/ACL fails
    const folderRes = await app.request('/api/cloud-docs/folders', {
      method: 'POST',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TargetFolder' }),
    });
    const targetFolderId = (await folderRes.json()).folder.id as string;
    await app.request('/api/cloud-docs/shares', {
      method: 'POST',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetKind: 'doc', targetId: xlsxDoc.id, granteeType: 'user', granteeId: 'u-alice', role: 'editor' }),
    });
    const aliceShared = {
      ...ownerDaemon,
      [SHARED_MACHINE_AUTHORITY_HEADER]: mintParticipantAuthority('u-alice'),
    };

    // Participant editor attempts combined content append + move to root (folderId: null, forbidden to non-owner)
    const filesCountBeforeReject = fs.readdirSync(tmpDir, { recursive: true }).length;
    const forbiddenCombo = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, {
      method: 'PUT',
      headers: { ...aliceShared, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'SHOULD_NOT_WRITE',
        mode: 'append',
        name: 'HijackedName',
        folderId: null,
        expectedVersion: 3,
      }),
    });
    expect(forbiddenCombo.status).toBe(403);
    expect(Number(memDb.docs.get(xlsxDoc.id)?.doc_version)).toBe(3);
    expect(memDb.docs.get(xlsxDoc.id)?.name).toBe('Budget.xlsx');
    expect(fs.readdirSync(tmpDir, { recursive: true }).length).toBe(filesCountBeforeReject);
    const readAfterReject = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, { headers: ownerDaemon });
    expect((await readAfterReject.json()).content).not.toContain('SHOULD_NOT_WRITE');

    // Owner combined edit updates content + name + folderId atomically with one version bump
    const okCombo = await app.request(`/api/cloud-docs/${xlsxDoc.id}/content`, {
      method: 'PUT',
      headers: { ...ownerDaemon, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'CombinedRow\t55',
        mode: 'append',
        name: 'BudgetFinal',
        folderId: targetFolderId,
        expectedVersion: 3,
      }),
    });
    expect(okCombo.status).toBe(200);
    expect((await okCombo.json()).doc).toMatchObject({
      docVersion: 4,
      name: 'BudgetFinal.xlsx',
      folderId: targetFolderId,
    });
  });
});
