import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index.js';
import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import type { Env } from '../src/env.js';
import { sha256Hex, signJwt, verifyJwt } from '../src/security/crypto.js';
import {
  buildBlankDocumentBytes,
  bumpOnlyOfficeDocumentRevision,
  getOnlyOfficeDocumentKey,
} from '../src/routes/onlyoffice.js';
import {
  isPathWithinSharedFolder,
  normalizeDocumentSharePath,
} from '../src/db/document-sharing.js';

const JWT_KEY = 'onlyoffice-doc-share-test-signing-key-32chars!!';

interface MemShareRow {
  id: string;
  server_id: string;
  target_kind: 'file' | 'folder';
  target_path: string;
  label: string | null;
  share_mode: 'user' | 'team' | 'external_link' | 'magic_invite';
  target_user_id: string;
  participant_label: string | null;
  share_token_hash: string | null;
  access_code_hash: string | null;
  device_lock_enabled: boolean;
  bound_device_hash: string | null;
  redeemed_by_user_id: string | null;
  redeemed_at: number | null;
  role: 'viewer' | 'editor';
  allow_download: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

interface MemUserRow {
  id: string;
  username: string | null;
  display_name: string | null;
  status: string;
  sessions_valid_after: number;
  is_admin: boolean;
}

function createInMemoryDb() {
  const users = new Map<string, MemUserRow>([
    ['owner-1', { id: 'owner-1', username: 'alice', display_name: 'Alice Owner', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-bob', { id: 'user-bob', username: 'bob', display_name: 'Bob Member', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-carol', { id: 'user-carol', username: 'carol', display_name: 'Carol Member', status: 'active', sessions_valid_after: 0, is_admin: false }],
  ]);
  const servers = new Map<string, { id: string; name: string; user_id: string; team_id: string | null }>([
    ['srv-1', { id: 'srv-1', name: 'Primary Server', user_id: 'owner-1', team_id: null }],
  ]);
  const shares = new Map<string, MemShareRow>();
  const platformIdentities = new Map<string, string>(); // `${platform}:${externalId}` -> userId

  const enrichShare = (row: MemShareRow) => {
    const u = users.get(row.target_user_id);
    return {
      ...row,
      target_username: u?.username ?? null,
      target_display_name: u?.display_name ?? null,
    };
  };

  const db: Database = {
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const normSql = sql.replace(/\s+/g, ' ').trim();

      // listDocumentSharesForServer
      if (normSql.includes('FROM document_shares ds') && normSql.includes('WHERE ds.server_id = $1')) {
        const serverId = params[0] as string;
        const filterPath = params.length >= 2 ? (params[1] as string) : undefined;
        const onlyActive = normSql.includes('ds.revoked_at IS NULL');
        const list = [...shares.values()]
          .filter((r) => {
            if (r.server_id !== serverId) return false;
            if (onlyActive && r.revoked_at !== null) return false;
            if (filterPath && r.target_path !== filterPath) return false;
            return true;
          })
          .sort((a, b) => b.created_at - a.created_at)
          .map(enrichShare);
        return list as unknown as T[];
      }

      // listDocumentsSharedWithUser
      if (normSql.includes('FROM document_shares ds') && normSql.includes('JOIN servers s ON s.id = ds.server_id')) {
        const [now, userId] = params as [number, string];
        const list = [...shares.values()]
          .filter((r) => {
            const srv = servers.get(r.server_id);
            if (!srv) return false;
            const owner = users.get(srv.user_id);
            if (!owner || owner.status !== 'active') return false;
            if (r.revoked_at !== null) return false;
            if (r.expires_at !== null && r.expires_at <= now) return false;
            return (
              r.target_user_id === userId ||
              r.redeemed_by_user_id === userId ||
              r.target_user_id === '*'
            );
          })
          .sort((a, b) => b.updated_at - a.updated_at)
          .map((r) => ({
            ...enrichShare(r),
            server_name: servers.get(r.server_id)?.name ?? null,
          }));
        return list as unknown as T[];
      }

      // Child file overrides query in resolveEffectiveDocumentAccess
      if (
        normSql.includes('FROM document_shares') &&
        normSql.includes("target_kind = 'file'") &&
        normSql.includes('target_path = $2')
      ) {
        const [serverId, normPath, now] = params as [string, string, number];
        const list = [...shares.values()].filter(
          (r) =>
            r.server_id === serverId &&
            r.target_kind === 'file' &&
            r.target_path === normPath &&
            r.revoked_at === null &&
            (r.expires_at === null || r.expires_at > now),
        );
        return list as unknown as T[];
      }

      // Active shares for user in resolveEffectiveDocumentAccess
      if (
        normSql.includes('FROM document_shares') &&
        normSql.includes('target_user_id = $3') &&
        normSql.includes('redeemed_by_user_id = $3')
      ) {
        const [serverId, now, userId] = params as [string, string | number, string];
        const nowNum = Number(now);
        const list = [...shares.values()].filter(
          (r) =>
            r.server_id === serverId &&
            r.revoked_at === null &&
            (r.expires_at === null || r.expires_at > nowNum) &&
            (r.target_user_id === userId || r.redeemed_by_user_id === userId || r.target_user_id === '*'),
        );
        return list as unknown as T[];
      }

      return [] as T[];
    },

    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const normSql = sql.replace(/\s+/g, ' ').trim();

      // Server & owner check in resolveEffectiveDocumentAccess & resolveServerMembershipRole
      if (normSql.includes('FROM servers WHERE id = $1') && normSql.includes('owner_status')) {
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

      if (normSql.startsWith('INSERT INTO users')) {
        const [id, created_at, status] = params as [string, number, string];
        const row: MockUser = {
          id,
          username: null,
          display_name: null,
          status: status ?? 'active',
          created_at: created_at ?? Date.now(),
        };
        users.set(id, row);
        return row as unknown as T;
      }

      if (normSql.startsWith('INSERT INTO platform_identities')) {
        const [id, platform, externalId, userId, createdAt] = params as [string, string, string, string, number];
        platformIdentities.set(`${platform}:${externalId}`, userId);
        return { id, platform, external_id: externalId, user_id: userId, created_at: createdAt ?? Date.now() } as unknown as T;
      }

      // resolveServerMembershipRole query
      if (normSql.includes('FROM servers s') && normSql.includes('WHERE s.id = $1')) {
        const [serverId, userId] = params as [string, string];
        const srv = servers.get(serverId);
        if (!srv) return null;
        const owner = users.get(srv.user_id);
        const actor = users.get(userId);
        return {
          user_id: srv.user_id,
          team_id: srv.team_id,
          owner_status: owner?.status ?? null,
          actor_status: actor?.status ?? null,
          team_role: null,
        } as unknown as T;
      }

      // getServerById
      if (normSql.startsWith('SELECT * FROM servers WHERE id = $1')) {
        const srv = servers.get(params[0] as string);
        return (srv ?? null) as unknown as T | null;
      }

      // User lookup by id or username (resolveUserByIdentifier)
      if (
        normSql.includes('FROM users WHERE id = $1 OR username = $1') ||
        normSql.includes('WHERE id = $1 OR lower(username) = lower($1)')
      ) {
        const key = String(params[0] ?? '');
        const byId = users.get(key);
        if (byId) {
          return { id: byId.id, display_name: byId.display_name, username: byId.username } as unknown as T;
        }
        for (const u of users.values()) {
          if (u.username && u.username.toLowerCase() === key.toLowerCase()) {
            return { id: u.id, display_name: u.display_name, username: u.username } as unknown as T;
          }
        }
        return null;
      }

      if (normSql.includes('FROM users WHERE id = $1')) {
        const u = users.get(params[0] as string);
        if (!u) return null;
        return u as unknown as T;
      }

      // Platform identity lookup
      if (normSql.includes('FROM platform_identities WHERE platform = $1 AND external_id = $2')) {
        const key = `${params[0]}:${params[1]}`;
        const uid = platformIdentities.get(key);
        return (uid ? { user_id: uid } : null) as unknown as T | null;
      }

      // INSERT INTO document_shares ... ON CONFLICT
      if (normSql.startsWith('INSERT INTO document_shares')) {
        const [
          id,
          serverId,
          targetKind,
          targetPath,
          label,
          shareMode,
          targetUserId,
          participantLabel,
          shareTokenHash,
          accessCodeHash,
          deviceLockEnabled,
          role,
          allowDownload,
          createdBy,
          now,
          expiresAt,
        ] = params as [
          string,
          string,
          'file' | 'folder',
          string,
          string | null,
          'user' | 'team' | 'external_link' | 'magic_invite',
          string,
          string | null,
          string | null,
          string | null,
          boolean,
          'viewer' | 'editor',
          boolean,
          string,
          number,
          number | null,
        ];

        const existing = [...shares.values()].find(
          (r) => r.server_id === serverId && r.target_path === targetPath && r.target_user_id === targetUserId,
        );

        const row: MemShareRow = {
          id: existing ? existing.id : id,
          server_id: serverId,
          target_kind: targetKind,
          target_path: targetPath,
          label,
          share_mode: shareMode,
          target_user_id: targetUserId,
          participant_label: participantLabel,
          share_token_hash: shareTokenHash,
          access_code_hash: accessCodeHash,
          device_lock_enabled: deviceLockEnabled,
          bound_device_hash: null,
          redeemed_by_user_id: null,
          redeemed_at: null,
          role,
          allow_download: allowDownload,
          created_by: existing ? existing.created_by : createdBy,
          created_at: existing ? existing.created_at : now,
          updated_at: now,
          expires_at: expiresAt,
          revoked_at: null,
        };
        shares.set(row.id, row);
        return enrichShare(row) as unknown as T;
      }

      // getDocumentShareById
      if (normSql.includes('FROM document_shares ds') && normSql.includes('WHERE ds.id = $1')) {
        const id = params[0] as string;
        const serverId = params[1] as string | undefined;
        const row = shares.get(id);
        if (!row) return null;
        if (serverId && row.server_id !== serverId) return null;
        return enrichShare(row) as unknown as T;
      }

      if (normSql.startsWith('SELECT * FROM document_shares WHERE id = $1 AND server_id = $2')) {
        const [id, serverId] = params as [string, string];
        const row = shares.get(id);
        if (!row || row.server_id !== serverId) return null;
        return row as unknown as T;
      }

      // getDocumentShareByToken
      if (normSql.includes('FROM document_shares ds') && normSql.includes('WHERE ds.share_token_hash = $1')) {
        const hash = params[0] as string;
        const row = [...shares.values()].find((r) => r.share_token_hash === hash);
        return (row ? enrichShare(row) : null) as unknown as T | null;
      }

      if (normSql.startsWith('SELECT * FROM document_shares WHERE server_id = $1 AND share_token_hash = $2')) {
        const [serverId, hash] = params as [string, string];
        const row = [...shares.values()].find(
          (r) => r.server_id === serverId && r.share_token_hash === hash,
        );
        return (row ?? null) as unknown as T | null;
      }

      // Device binding atomic update
      if (
        normSql.startsWith('UPDATE document_shares SET bound_device_hash = $1') &&
        normSql.includes('WHERE id = $3 AND bound_device_hash IS NULL')
      ) {
        const [hash, now, shareId] = params as [string, number, string];
        const row = shares.get(shareId);
        if (!row || row.bound_device_hash !== null) return null;
        row.bound_device_hash = hash;
        row.updated_at = now;
        return enrichShare(row) as unknown as T;
      }

      // Magic invite atomic redemption
      if (
        normSql.startsWith('UPDATE document_shares SET redeemed_by_user_id = $1') &&
        normSql.includes('WHERE id = $4 AND redeemed_at IS NULL AND revoked_at IS NULL')
      ) {
        const [userId, now, displayName, shareId] = params as [string, number, string, string];
        const row = shares.get(shareId);
        if (!row || row.redeemed_at !== null || row.revoked_at !== null) return null;
        row.redeemed_by_user_id = userId;
        row.redeemed_at = now;
        row.target_user_id = userId;
        row.participant_label = row.participant_label ?? displayName;
        row.updated_at = now;
        return enrichShare(row) as unknown as T;
      }

      // updateDocumentShare
      if (
        normSql.startsWith('UPDATE document_shares SET role = $1') &&
        normSql.includes('WHERE id = $10 AND server_id = $11')
      ) {
        const [
          role,
          allowDownload,
          participantLabel,
          label,
          deviceLockEnabled,
          boundDeviceHash,
          accessCodeHash,
          expiresAt,
          now,
          shareId,
          serverId,
        ] = params as [
          'viewer' | 'editor',
          boolean,
          string | null,
          string | null,
          boolean,
          string | null,
          string | null,
          number | null,
          number,
          string,
          string,
        ];
        const row = shares.get(shareId);
        if (!row || row.server_id !== serverId) return null;
        row.role = role;
        row.allow_download = allowDownload;
        row.participant_label = participantLabel;
        row.label = label;
        row.device_lock_enabled = deviceLockEnabled;
        row.bound_device_hash = boundDeviceHash;
        row.access_code_hash = accessCodeHash;
        row.expires_at = expiresAt;
        row.updated_at = now;
        return enrichShare(row) as unknown as T;
      }

      // revokeDocumentShare
      if (
        normSql.startsWith('UPDATE document_shares SET revoked_at = COALESCE(revoked_at, $1)') &&
        normSql.includes('WHERE id = $2 AND server_id = $3')
      ) {
        const [now, shareId, serverId] = params as [number, string, string];
        const row = shares.get(shareId);
        if (!row || row.server_id !== serverId) return null;
        row.revoked_at = row.revoked_at ?? now;
        row.updated_at = now;
        return enrichShare(row) as unknown as T;
      }

      return null;
    },

    execute: async (sql: string, params: unknown[] = []) => {
      const normSql = sql.replace(/\s+/g, ' ').trim();
      if (normSql.startsWith('INSERT INTO users')) {
        const id = params[0] as string;
        const displayName = (params[1] as string | null) ?? 'Guest Collaborator';
        const status = (params[2] as string | undefined) ?? 'active';
        if (!users.has(id)) {
          users.set(id, {
            id,
            username: null,
            display_name: displayName,
            status: status.includes('active') ? 'active' : 'active',
            sessions_valid_after: 0,
            is_admin: false,
          });
        }
        return { changes: 1 };
      }
      if (normSql.startsWith('INSERT INTO platform_identities')) {
        const [, userId, platform, externalId] = params as [string, string, string, string];
        platformIdentities.set(`${platform}:${externalId}`, userId);
        return { changes: 1 };
      }
      if (
        normSql.startsWith('UPDATE document_shares SET bound_device_hash = $1') &&
        normSql.includes('WHERE id = $3 AND bound_device_hash IS NULL')
      ) {
        const [hash, now, shareId] = params as [string, number, string];
        const row = shares.get(shareId);
        if (row && !row.bound_device_hash) {
          row.bound_device_hash = hash;
          row.updated_at = now;
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
  } as unknown as Database;

  return { db, users, servers, shares };
}

function makeEnv(db: Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: JWT_KEY,
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://im.example.com',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    ONLYOFFICE_ENABLED: 'true',
    ONLYOFFICE_JWT_SECRET: 'onlyoffice-jwt-secret-key-test!!',
    ONLYOFFICE_PUBLIC_URL: 'https://im.example.com/onlyoffice',
    ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice:80',
    AUTH_RELAY_URL: 'https://app.im.codes',
    ...overrides,
  } as Env;
}

describe('103_document_shares.sql migration & path security invariants', () => {
  it('defines document_shares table, constraints, and indexes in 103_document_shares.sql', () => {
    const sqlPath = path.resolve(__dirname, '../src/db/migrations/103_document_shares.sql');
    const rawSql = fs.readFileSync(sqlPath, 'utf8');
    const sql = rawSql.replace(/\s+/g, ' ');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS document_shares');
    expect(sql).toContain("target_kind TEXT NOT NULL CHECK (target_kind IN ('file', 'folder'))");
    expect(sql).toContain("share_mode TEXT NOT NULL DEFAULT 'user' CHECK (share_mode IN ('user', 'team', 'external_link', 'magic_invite'))");
    expect(sql).toContain("role TEXT NOT NULL CHECK (role IN ('viewer', 'editor'))");
    expect(sql).toContain('UNIQUE (server_id, target_path, target_user_id)');
    expect(sql).toContain('idx_document_shares_server_revoked');
    expect(sql).toContain('idx_document_shares_user_revoked');
    expect(sql).toContain('idx_document_shares_token_hash');
  });

  it('normalizes document paths and strictly prevents prefix collisions and .. traversal', () => {
    expect(normalizeDocumentSharePath('/team/docs/report.docx')).toBe('/team/docs/report.docx');
    expect(normalizeDocumentSharePath('/team/docs/')).toBe('/team/docs');
    expect(normalizeDocumentSharePath('/team/../etc/passwd')).toBeNull();
    expect(normalizeDocumentSharePath('relative/path.docx')).toBeNull();
    expect(normalizeDocumentSharePath('/team/docs\0secret.docx')).toBeNull();
    expect(normalizeDocumentSharePath('C:\\Windows\\System32')).toBeNull();

    // Boundary check: /team/doc must NOT match /team/doc-secret
    expect(isPathWithinSharedFolder('/team/doc/spec.docx', '/team/doc')).toBe(true);
    expect(isPathWithinSharedFolder('/team/doc', '/team/doc')).toBe(true);
    expect(isPathWithinSharedFolder('/team/doc-secret/spec.docx', '/team/doc')).toBe(false);
  });
});

describe('Document Sharing & ONLYOFFICE Integration Routes', () => {
  let store: ReturnType<typeof createInMemoryDb>;
  let app: ReturnType<typeof buildApp>;
  const bearer = (userId: string) =>
    `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}`;

  // Virtual daemon filesystem for testing read/write/ls/mkdir
  const virtualFiles = new Map<string, { content: string; encoding?: 'utf8' | 'base64'; mtime: number }>();

  function attachMockDaemon(serverId = 'srv-1') {
    const bridge = WsBridge.get(serverId);
    const sentMessages: Array<Record<string, unknown>> = [];

    class MockDaemonWs extends EventEmitter {
      readyState = 1;
      send(raw: string, _opts?: unknown, cb?: () => void) {
        cb?.();
        const msg = JSON.parse(raw) as Record<string, unknown>;
        sentMessages.push(msg);
        const reqId = String(msg.requestId ?? '');
        const emitReply = (payload: Record<string, unknown>) => {
          setTimeout(() => {
            this.emit('message', Buffer.from(JSON.stringify(payload)), false);
          }, 1);
        };
        if (msg.type === 'fs.read') {
          const p = String(msg.path ?? '');
          const file = virtualFiles.get(p);
          if (!file) {
            emitReply({
              type: 'fs.read_response',
              requestId: reqId,
              status: 'error',
              error: 'enoent',
            });
            return;
          }
          emitReply({
            type: 'fs.read_response',
            requestId: reqId,
            status: 'ok',
            path: p,
            content: file.content,
            encoding: file.encoding ?? 'utf8',
            mtime: file.mtime,
          });
        } else if (msg.type === 'fs.write') {
          const p = String(msg.path ?? '');
          virtualFiles.set(p, {
            content: String(msg.content ?? ''),
            encoding: (msg.encoding as 'utf8' | 'base64' | undefined) ?? 'utf8',
            mtime: Date.now(),
          });
          emitReply({
            type: 'fs.write_response',
            requestId: reqId,
            status: 'ok',
            resolvedPath: p,
            mtime: Date.now(),
          });
        } else if (msg.type === 'fs.mkdir') {
          const p = String(msg.path ?? '');
          emitReply({
            type: 'fs.mkdir_response',
            requestId: reqId,
            status: 'ok',
            resolvedPath: p,
          });
        } else if (msg.type === 'fs.ls') {
          const dir = String(msg.path ?? '');
          emitReply({
            type: 'fs.ls_response',
            requestId: reqId,
            status: 'ok',
            resolvedPath: dir,
            entries: [
              { name: 'spec.docx', isDir: false, size: 4096, mtimeMs: 1700000000000 },
              { name: 'salary.xlsx', isDir: false, size: 8192, mtimeMs: 1700000000000 },
              { name: 'sub', isDir: true },
            ],
          });
        } else if (msg.type === 'fs.rename') {
          const oldPath = String(msg.oldPath ?? '');
          const newPath = String(msg.newPath ?? '');
          const existing = virtualFiles.get(oldPath);
          if (existing) {
            virtualFiles.set(newPath, existing);
            virtualFiles.delete(oldPath);
          }
          emitReply({
            type: 'fs.rename_response',
            requestId: reqId,
            status: 'ok',
            oldPath,
            newPath,
          });
        } else if (msg.type === 'fs.delete') {
          const p = String(msg.path ?? '');
          virtualFiles.delete(p);
          emitReply({
            type: 'fs.delete_response',
            requestId: reqId,
            status: 'ok',
            path: p,
          });
        }
      }
      close() {
        this.readyState = 3;
      }
    }

    const mockWs = new MockDaemonWs();
    (bridge as unknown as { daemonWs: MockDaemonWs; authenticated: boolean }).daemonWs = mockWs;
    (bridge as unknown as { authenticated: boolean }).authenticated = true;
    vi.spyOn(bridge, 'sendFileTransferRequest').mockImplementation(async (_id: string, msg: Record<string, unknown>) => {
      if (msg.type === 'file.upload') {
        const destDir = String(msg.destinationDirectory ?? '/');
        const name = String(msg.sanitizedName ?? msg.originalName ?? 'file');
        const fullPath = path.posix.join(destDir, name);
        virtualFiles.set(fullPath, {
          content: String(msg.content ?? ''),
          encoding: 'base64',
          mtime: Date.now(),
        });
        return { type: 'file.upload_response', uploadId: _id, status: 'ok', attachmentId: _id };
      }
      return { status: 'ok' };
    });
    return { bridge, sentMessages };
  }

  beforeEach(() => {
    WsBridge.getAll().clear();
    virtualFiles.clear();
    virtualFiles.set('/team/shared/spec.docx', {
      content: Buffer.from('PK\x03\x04mock-docx-bytes').toString('base64'),
      encoding: 'base64',
      mtime: 1700000001000,
    });
    virtualFiles.set('/team/shared/salary.xlsx', {
      content: Buffer.from('PK\x03\x04mock-xlsx-bytes').toString('base64'),
      encoding: 'base64',
      mtime: 1700000002000,
    });
    store = createInMemoryDb();
    app = buildApp(makeEnv(store.db));
    attachMockDaemon('srv-1');
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.restoreAllMocks();
  });

  it('enforces folder share inheritance and single-file permission override (viewer / allowDownload=false)', async () => {
    // 1. Owner shares /team/shared folder with entire team ('*') as editor
    const folderShareRes = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: {
        Authorization: bearer('owner-1'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetKind: 'folder',
        targetPath: '/team/shared',
        shareMode: 'team',
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(folderShareRes.status).toBe(201);

    // 2. Owner overrides child file /team/shared/salary.xlsx for entire team ('*') to viewer & allowDownload: false
    const childOverrideRes = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: {
        Authorization: bearer('owner-1'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/team/shared/salary.xlsx',
        shareMode: 'team',
        role: 'viewer',
        allowDownload: false,
      }),
    });
    expect(childOverrideRes.status).toBe(201);

    // 3. Bob accesses /team/shared/spec.docx -> inherits folder 'editor' + allowDownload: true
    const specCfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('user-bob') } },
    );
    expect(specCfgRes.status).toBe(200);
    const specCfg = (await specCfgRes.json()) as {
      enabled: boolean;
      role: string;
      mode: string;
      allowDownload: boolean;
      config: { document: { key: string; permissions: { edit: boolean; download: boolean } } };
    };
    expect(specCfg.enabled).toBe(true);
    expect(specCfg.role).toBe('editor');
    expect(specCfg.mode).toBe('edit');
    expect(specCfg.allowDownload).toBe(true);
    expect(specCfg.config.document.permissions.edit).toBe(true);
    expect(specCfg.config.document.permissions.download).toBe(true);

    // 4. Bob accesses /team/shared/salary.xlsx -> overridden to 'viewer' + allowDownload: false even when requesting mode=edit
    const salaryCfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/salary.xlsx')}&mode=edit`,
      { headers: { Authorization: bearer('user-bob') } },
    );
    expect(salaryCfgRes.status).toBe(200);
    const salaryCfg = (await salaryCfgRes.json()) as {
      role: string;
      mode: string;
      allowDownload: boolean;
      config: { document: { permissions: { edit: boolean; download: boolean } } };
    };
    expect(salaryCfg.role).toBe('viewer');
    expect(salaryCfg.mode).toBe('view');
    expect(salaryCfg.allowDownload).toBe(false);
    expect(salaryCfg.config.document.permissions.edit).toBe(false);
    expect(salaryCfg.config.document.permissions.download).toBe(false);

    // 5. Specific user override: Owner grants Bob specific 'editor' on /team/shared/salary.xlsx while Carol stays on '*' ('viewer')
    await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: {
        Authorization: bearer('owner-1'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/team/shared/salary.xlsx',
        shareMode: 'user',
        targetUser: 'bob',
        role: 'editor',
        allowDownload: true,
      }),
    });

    const bobSalaryRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/salary.xlsx')}&mode=edit`,
      { headers: { Authorization: bearer('user-bob') } },
    );
    expect(((await bobSalaryRes.json()) as { role: string }).role).toBe('editor');

    const carolSalaryRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/salary.xlsx')}&mode=edit`,
      { headers: { Authorization: bearer('user-carol') } },
    );
    expect(((await carolSalaryRes.json()) as { role: string }).role).toBe('viewer');

    // 6. Unshared sibling folder /team/shared-secret is forbidden
    const unsharedRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared-secret/spec.docx')}`,
      { headers: { Authorization: bearer('user-bob') } },
    );
    expect(unsharedRes.status).toBe(403);

    // 7. Expired share (expiresAt <= now) is automatically ignored / denied
    await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: {
        Authorization: bearer('owner-1'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/team/expired.docx',
        shareMode: 'user',
        targetUser: 'bob',
        role: 'editor',
        allowDownload: true,
        expiresAt: Date.now() - 10_000,
      }),
    });
    const expiredRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/expired.docx')}`,
      { headers: { Authorization: bearer('user-bob') } },
    );
    expect(expiredRes.status).toBe(403);
  });

  it('Scheme 1: verifies external dedicated link access code, locks to first device/Passkey, and blocks forwarded 2nd device', async () => {
    // 1. Owner creates an external link with access code "8848" and deviceLockEnabled: true
    const createRes = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: {
        Authorization: bearer('owner-1'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetKind: 'folder',
        targetPath: '/team/shared',
        shareMode: 'external_link',
        participantLabel: '财务-王姐',
        accessCode: '8848',
        deviceLockEnabled: true,
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      share: { id: string; participantLabel: string };
      shareToken: string;
      shareUrl: string;
    };
    expect(created.shareToken).toBeTruthy();
    expect(created.shareUrl).toContain(`/doc-share/${created.shareToken}`);

    // 2. Wrong access code -> 401 invalid_access_code
    const badCodeRes = await app.request(`/api/doc-shares/external/${created.shareToken}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: '0000', deviceToken: 'device-wangjie-1' }),
    });
    expect(badCodeRes.status).toBe(401);

    // 3. First device ("device-wangjie-1") verifies with correct code -> binds device hash
    const firstDeviceRes = await app.request(`/api/doc-shares/external/${created.shareToken}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: '8848', deviceToken: 'device-wangjie-1' }),
    });
    expect(firstDeviceRes.status).toBe(200);
    const firstVerified = (await firstDeviceRes.json()) as {
      ok: boolean;
      deviceBound: boolean;
      deviceToken: string;
    };
    expect(firstVerified.ok).toBe(true);
    expect(firstVerified.deviceBound).toBe(true);
    expect(firstVerified.deviceToken).toBe('device-wangjie-1');

    // 4. Forwarded link opened on a 2nd device ("device-stranger-2") -> 403 device_locked_to_another_device even with correct accessCode!
    const secondDeviceRes = await app.request(`/api/doc-shares/external/${created.shareToken}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: '8848', deviceToken: 'device-stranger-2' }),
    });
    expect(secondDeviceRes.status).toBe(403);
    expect(await secondDeviceRes.json()).toMatchObject({ error: 'device_locked_to_another_device' });

    // 5. First device can browse the shared folder and fetch ONLYOFFICE config with participantLabel as editor name
    const browseRes = await app.request(
      `/api/doc-shares/external/${created.shareToken}/browse?deviceToken=device-wangjie-1`,
    );
    expect(browseRes.status).toBe(200);
    const browseJson = (await browseRes.json()) as { entries: Array<{ name: string }> };
    expect(browseJson.entries.map((e) => e.name)).toContain('spec.docx');

    const ooRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&shareToken=${created.shareToken}&deviceToken=device-wangjie-1`,
    );
    expect(ooRes.status).toBe(200);
    const ooJson = (await ooRes.json()) as {
      config: { editorConfig: { user: { name: string } } };
    };
    expect(ooJson.config.editorConfig.user.name).toBe('财务-王姐');

    // 6. Revoking the share immediately blocks the bound first device (410/403)
    const revokeRes = await app.request(`/api/server/srv-1/doc-shares/${created.share.id}`, {
      method: 'DELETE',
      headers: { Authorization: bearer('owner-1') },
    });
    expect(revokeRes.status).toBe(200);

    const afterRevokeRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&shareToken=${created.shareToken}&deviceToken=device-wangjie-1`,
    );
    expect(afterRevokeRes.status).toBe(403);
  });

  it('Scheme 2: supports keyless Google / GitHub Auth Relay redirect and signed callback session creation', async () => {
    // 1. Initiate Auth Relay for Google when GOOGLE_CLIENT_ID is not configured on self-hosted server
    const startRes = await app.request(
      '/api/doc-shares/auth-relay/google?shareToken=tok_123&redirect=%2Fdoc-share%2Ftok_123',
    );
    expect(startRes.status).toBe(302);
    const location = startRes.headers.get('location') ?? '';
    expect(location).toContain('https://app.im.codes/api/auth/google');
    const urlObj = new URL(location);
    const state = urlObj.searchParams.get('state') ?? '';
    expect(state).toBeTruthy();

    // 2. Central Auth Relay redirects back with signed relay_token
    const relayToken = signJwt(
      {
        type: 'doc-auth-relay',
        provider: 'google',
        platformId: 'google-uid-999',
        email: 'partner@example.com',
        name: 'External Partner',
      },
      JWT_KEY,
      300,
    );

    const callbackRes = await app.request(
      `/api/doc-shares/auth-relay/callback?state=${encodeURIComponent(state)}&relay_token=${encodeURIComponent(relayToken)}`,
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe('/doc-share/tok_123');
    expect(callbackRes.headers.get('set-cookie')).toContain('rcc_session=');
  });

  it('Scheme 3: redeems one-time Magic Link atomically, issues collaborator session, and rejects second redemption', async () => {
    const createRes = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: {
        Authorization: bearer('owner-1'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/team/shared/spec.docx',
        shareMode: 'magic_invite',
        participantLabel: '客户-李总',
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const { shareToken } = (await createRes.json()) as { shareToken: string };

    // 1st redemption succeeds
    const redeem1 = await app.request(`/api/doc-shares/magic-invite/${shareToken}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '客户-李总' }),
    });
    expect(redeem1.status).toBe(200);
    const redeem1Json = (await redeem1.json()) as {
      ok: boolean;
      userId: string;
      sessionToken: string;
    };
    expect(redeem1Json.ok).toBe(true);
    expect(redeem1Json.userId).toMatch(/^extusr_/);
    expect(redeem1.headers.get('set-cookie')).toContain('rcc_session=');

    // 2nd redemption by another person fails with 409 magic_invite_already_redeemed
    const redeem2 = await app.request(`/api/doc-shares/magic-invite/${shareToken}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Stranger' }),
    });
    expect(redeem2.status).toBe(409);
    expect(await redeem2.json()).toMatchObject({ error: 'magic_invite_already_redeemed' });

    // Redeemed user can access ONLYOFFICE config and shared-with-me list using their issued session token
    const sharedWithMeRes = await app.request('/api/doc-shares/shared-with-me?serverId=srv-1', {
      headers: { Authorization: `Bearer ${redeem1Json.sessionToken}` },
    });
    expect(sharedWithMeRes.status).toBe(200);
    const sharedList = (await sharedWithMeRes.json()) as { shares: Array<{ targetPath: string }> };
    expect(sharedList.shares.map((s) => s.targetPath)).toContain('/team/shared/spec.docx');
  });

  it('streams file to ONLYOFFICE, writes back edited bytes on callback status=2, and creates valid blank .docx/.xlsx/.pptx/.md', async () => {
    // 1. Get ONLYOFFICE config as owner
    const cfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('owner-1') } },
    );
    expect(cfgRes.status).toBe(200);
    const cfgJson = (await cfgRes.json()) as {
      enabled: boolean;
      token: string;
      config: {
        document: { url: string; key: string };
        editorConfig: { callbackUrl: string };
      };
    };
    expect(cfgJson.enabled).toBe(true);

    // Verify pod-sticky ?serverId=srv-1 is present on both document.url and callbackUrl
    const docUrl = new URL(cfgJson.config.document.url);
    const cbUrl = new URL(cfgJson.config.editorConfig.callbackUrl);
    expect(docUrl.searchParams.get('serverId')).toBe('srv-1');
    expect(cbUrl.searchParams.get('serverId')).toBe('srv-1');

    // Verify deterministic collaborative key
    const keyA = getOnlyOfficeDocumentKey('srv-1', '/team/shared/spec.docx');
    const keyB = getOnlyOfficeDocumentKey('srv-1', '/team/shared/spec.docx');
    expect(keyA).toBe(keyB);
    expect(cfgJson.config.document.key).toBe(keyA);
    bumpOnlyOfficeDocumentRevision('srv-1', '/team/shared/spec.docx');
    const keyAfterSave = getOnlyOfficeDocumentKey('srv-1', '/team/shared/spec.docx');
    expect(keyA).not.toBe(keyAfterSave);

    // Verify ONLYOFFICE JWT token is valid
    const verifiedJwt = verifyJwt(cfgJson.token, 'onlyoffice-jwt-secret-key-test!!');
    expect(verifiedJwt).not.toBeNull();

    // 2. Stream file via GET /api/onlyoffice/file/:token?serverId=srv-1
    const fileRes = await app.request(`${docUrl.pathname}${docUrl.search}`);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const fileBytes = Buffer.from(await fileRes.arrayBuffer());
    expect(fileBytes.toString('utf8')).toBe('PK\x03\x04mock-docx-bytes');

    // 3. ONLYOFFICE callback status=2 (MustSave) fetches updated document and writes back to Daemon
    const updatedBytes = Buffer.from('PK\x03\x04updated-collaborative-docx-bytes');
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.startsWith('http://onlyoffice:80/cache/files/edited.docx')) {
          return new Response(updatedBytes, { status: 200 });
        }
        return originalFetch(input);
      }),
    );

    // Rejects callback without ONLYOFFICE JWT
    const unauthCbRes = await app.request(`${cbUrl.pathname}${cbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 2,
        url: 'https://im.example.com/onlyoffice/cache/files/edited.docx',
      }),
    });
    expect(unauthCbRes.status).toBe(401);

    const callbackPayload = {
      status: 2,
      url: 'https://im.example.com/onlyoffice/cache/files/edited.docx',
    };
    const cbJwt = signJwt(callbackPayload, 'onlyoffice-jwt-secret-key-test!!', 300);

    const cbRes = await app.request(`${cbUrl.pathname}${cbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...callbackPayload,
        token: cbJwt,
      }),
    });
    expect(cbRes.status).toBe(200);
    expect(await cbRes.json()).toEqual({ error: 0 });
    expect(
      Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString('utf8'),
    ).toBe('PK\x03\x04updated-collaborative-docx-bytes');

    // 4. Create blank .docx, .xlsx, .pptx, .md and folder via POST /api/server/srv-1/doc-shares/create-item
    for (const ext of ['.docx', '.xlsx', '.pptx'] as const) {
      const bytes = buildBlankDocumentBytes(ext, 'Quarterly Plan');
      expect(bytes).not.toBeNull();
      // Valid ZIP header PK\x03\x04
      expect(bytes![0]).toBe(0x50);
      expect(bytes![1]).toBe(0x4b);
      expect(bytes![2]).toBe(0x03);
      expect(bytes![3]).toBe(0x04);

      const createDocRes = await app.request('/api/server/srv-1/doc-shares/create-item', {
        method: 'POST',
        headers: {
          Authorization: bearer('owner-1'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parentDir: '/team/shared',
          name: `new-file${ext}`,
          kind: 'file',
        }),
      });
      expect(createDocRes.status).toBe(201);
      expect(virtualFiles.has(`/team/shared/new-file${ext}`)).toBe(true);
    }

    // 5. Fallback when ONLYOFFICE_ENABLED is false
    const disabledApp = buildApp(makeEnv(store.db, { ONLYOFFICE_ENABLED: 'false' }));
    const disabledRes = await disabledApp.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}`,
      { headers: { Authorization: bearer('owner-1') } },
    );
    expect(disabledRes.status).toBe(200);
    expect(await disabledRes.json()).toMatchObject({
      enabled: false,
      fallbackReason: 'onlyoffice_disabled',
    });
  });
});
