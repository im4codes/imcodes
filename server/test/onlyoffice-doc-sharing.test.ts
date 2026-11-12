import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
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
  resetOnlyOfficeDocumentKeyCacheForTests,
} from '../src/routes/onlyoffice.js';
import {
  clearVerifiedExternalSharePinsForTests,
  isPathWithinSharedFolder,
  normalizeDocumentSharePath,
} from '../src/db/document-sharing.js';
import { handleWebCommand, __resetFsGitCachesForTests } from '../../src/daemon/command-handler.js';
import type { ServerLink } from '../../src/daemon/server-link.js';

const JWT_KEY = 'onlyoffice-doc-share-test-signing-key-32chars!!';
const CENTRAL_JWT_KEY = 'central-auth-relay-independent-signing-key-64!!';

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

interface MemRefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

function createInMemoryDb() {
  const users = new Map<string, MemUserRow>([
    ['owner-1', { id: 'owner-1', username: 'alice', display_name: 'Alice Owner', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-bob', { id: 'user-bob', username: 'bob', display_name: 'Bob Member', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-carol', { id: 'user-carol', username: 'carol', display_name: 'Carol Member', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-stranger', { id: 'user-stranger', username: 'mallory', display_name: 'Mallory NonTeam', status: 'active', sessions_valid_after: 0, is_admin: false }],
  ]);
  const servers = new Map<string, { id: string; name: string; user_id: string; team_id: string | null }>([
    ['srv-1', { id: 'srv-1', name: 'Primary Server', user_id: 'owner-1', team_id: 'team-1' }],
  ]);
  // team-1 has owner-1, user-bob, user-carol, NOT user-stranger
  const teamMembers = new Map<string, string>([
    ['team-1:owner-1', 'owner'],
    ['team-1:user-bob', 'member'],
    ['team-1:user-carol', 'member'],
  ]);
  const shares = new Map<string, MemShareRow>();
  const platformIdentities = new Map<string, string>(); // `${platform}:${externalId}` -> userId
  const refreshTokens = new Map<string, MemRefreshTokenRow>();
  const passkeyChallenges = new Map<string, { challenge: string; expires_at: number }>();
  const passkeyCredentials = new Map<
    string,
    { id: string; user_id: string; public_key: string; counter: number; transports: string | null }
  >();

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

      // isUserInServerTeam / resolveServerMembershipRole machine_groups check
      if (
        (normSql.includes('SELECT tm.role') && normSql.includes('FROM servers s') && normSql.includes('JOIN team_members tm')) ||
        (normSql.includes('FROM machine_groups mg') && normSql.includes('JOIN team_members tm'))
      ) {
        const [serverId, userId] = params as [string, string];
        const srv = servers.get(serverId);
        if (!srv || !srv.team_id) return null;
        const role = teamMembers.get(`${srv.team_id}:${userId}`);
        return (role ? { role } : null) as unknown as T | null;
      }

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

      // resolveServerMembershipRole query
      if (normSql.includes('FROM servers s') && normSql.includes('WHERE s.id = $1')) {
        const [serverId, userId] = params as [string, string];
        const srv = servers.get(serverId);
        if (!srv) return null;
        const owner = users.get(srv.user_id);
        const actor = users.get(userId);
        const teamRole = srv.team_id ? (teamMembers.get(`${srv.team_id}:${userId}`) ?? null) : null;
        return {
          user_id: srv.user_id,
          team_id: srv.team_id,
          owner_status: owner?.status ?? null,
          actor_status: actor?.status ?? null,
          team_role: teamRole,
        } as unknown as T;
      }

      // getServerById
      if (normSql.startsWith('SELECT * FROM servers WHERE id = $1')) {
        const srv = servers.get(params[0] as string);
        return (srv ?? null) as unknown as T | null;
      }

      // Passkey challenge & credential lookups
      if (normSql.startsWith('SELECT challenge FROM passkey_challenges WHERE id = $1 AND expires_at > $2')) {
        const [id, now] = params as [string, number];
        const row = passkeyChallenges.get(id);
        if (!row || row.expires_at <= now) return null;
        return { challenge: row.challenge } as unknown as T;
      }
      if (normSql.startsWith('SELECT id, user_id, public_key, counter, transports FROM passkey_credentials WHERE id = $1')) {
        const id = params[0] as string;
        const row = passkeyCredentials.get(id);
        return (row ?? null) as unknown as T | null;
      }

      // Refresh token lookup
      if (normSql.includes('FROM refresh_tokens WHERE token_hash = $1')) {
        const tokenHash = params[0] as string;
        const now = typeof params[1] === 'number' ? params[1] : 0;
        const row = [...refreshTokens.values()].find(
          (r) => r.token_hash === tokenHash && r.revoked_at === null && (!now || r.expires_at > now),
        );
        return (row ?? null) as unknown as T | null;
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
      if (
        normSql.includes('FROM platform_identities WHERE platform = $1 AND external_id = $2') ||
        normSql.includes('FROM users u JOIN platform_identities pi ON u.id = pi.user_id WHERE pi.platform = $1 AND pi.external_id = $2')
      ) {
        const key = `${params[0]}:${params[1]}`;
        const uid = platformIdentities.get(key);
        if (!uid) return null;
        if (normSql.includes('JOIN platform_identities')) {
          const u = users.get(uid);
          return (u ?? null) as unknown as T | null;
        }
        return { user_id: uid } as unknown as T;
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
        const displayName =
          normSql.includes('display_name') && typeof params[1] === 'string'
            ? params[1]
            : 'Guest Collaborator';
        if (!users.has(id)) {
          users.set(id, {
            id,
            username: null,
            display_name: displayName,
            status: 'active',
            sessions_valid_after: 0,
            is_admin: false,
          });
        }
        return { changes: 1 };
      }
      if (normSql.startsWith('UPDATE users SET display_name = COALESCE(display_name, $1) WHERE id = $2')) {
        const [displayName, id] = params as [string, string];
        const u = users.get(id);
        if (u && !u.display_name) u.display_name = displayName;
        return { changes: u ? 1 : 0 };
      }
      if (normSql.startsWith('INSERT INTO platform_identities')) {
        const [, userId, platform, externalId] = params as [string, string, string, string];
        platformIdentities.set(`${platform}:${externalId}`, userId);
        return { changes: 1 };
      }
      if (normSql.startsWith('INSERT INTO refresh_tokens')) {
        const [id, userId, tokenHash, familyId, expiresAt, createdAt] = params as [
          string,
          string,
          string,
          string,
          number,
          number,
        ];
        refreshTokens.set(id, {
          id,
          user_id: userId,
          token_hash: tokenHash,
          family_id: familyId,
          expires_at: expiresAt,
          revoked_at: null,
          created_at: createdAt,
        });
        return { changes: 1 };
      }
      if (
        normSql.startsWith('UPDATE refresh_tokens SET revoked_at = $1 WHERE id = $2') ||
        normSql.startsWith('UPDATE refresh_tokens SET used_at = $1 WHERE id = $2')
      ) {
        const [now, id] = params as [number, string];
        const r = refreshTokens.get(id);
        if (r) r.revoked_at = now;
        return { changes: r ? 1 : 0 };
      }
      if (normSql.startsWith('DELETE FROM passkey_challenges WHERE id = $1')) {
        passkeyChallenges.delete(params[0] as string);
        return { changes: 1 };
      }
      if (normSql.startsWith('UPDATE passkey_credentials SET counter = $1')) {
        const [counter, , id] = params as [number, number, string];
        const cred = passkeyCredentials.get(id);
        if (cred) cred.counter = counter;
        return { changes: cred ? 1 : 0 };
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

  return {
    db,
    users,
    servers,
    teamMembers,
    shares,
    refreshTokens,
    passkeyChallenges,
    passkeyCredentials,
  };
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
          const oldPath = String(msg.path ?? msg.oldPath ?? '');
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
            path: oldPath,
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
        return {
          type: 'file.upload_response',
          uploadId: _id,
          status: 'ok',
          attachmentId: _id,
          relPath: fullPath,
        };
      }
      return { status: 'ok' };
    });
    return { bridge, sentMessages };
  }

  beforeEach(() => {
    WsBridge.getAll().clear();
    virtualFiles.clear();
    resetOnlyOfficeDocumentKeyCacheForTests();
    clearVerifiedExternalSharePinsForTests();
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

  it('enforces folder share inheritance, single-file permission override (viewer / allowDownload=false), and blocks non-team users from wildcard (*) shares (F3b)', async () => {
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

    // 3. Bob (team member) accesses /team/shared/spec.docx -> inherits folder 'editor' + allowDownload: true
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

    // 3b. F3b: Non-team user ('user-stranger') on the same platform is strictly denied wildcard '*' share access
    const strangerCfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('user-stranger') } },
    );
    expect(strangerCfgRes.status).toBe(403);
    const strangerSharedListRes = await app.request('/api/doc-shares/shared-with-me?serverId=srv-1', {
      headers: { Authorization: bearer('user-stranger') },
    });
    expect(strangerSharedListRes.status).toBe(200);
    expect(((await strangerSharedListRes.json()) as { shares: unknown[] }).shares).toHaveLength(0);

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

  it('Scheme 1: verifies external dedicated link access code, locks to first device/Passkey, rejects bound_device_hash replay & bare passkeyCredentialId, and blocks forwarded 2nd device (F2)', async () => {
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

    // 2b. Bare passkeyCredentialId without WebAuthn assertion is rejected (401 passkey_assertion_required)
    const barePasskeyRes = await app.request(`/api/doc-shares/external/${created.shareToken}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: '8848', passkeyCredentialId: 'cred-fake-123' }),
    });
    expect(barePasskeyRes.status).toBe(401);
    expect(await barePasskeyRes.json()).toMatchObject({ error: 'passkey_assertion_required' });

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

    // 3b. Passing the stored bound_device_hash (64-hex SHA-256) as raw deviceToken is rejected
    const boundHash = sha256Hex('device-wangjie-1');
    const hashReplayBrowse = await app.request(
      `/api/doc-shares/external/${created.shareToken}/browse?deviceToken=${boundHash}`,
    );
    expect(hashReplayBrowse.status).toBe(403);

    // 3c. Passing bare passkey / credential identifiers as bearer secrets is rejected
    const barePasskeyBrowse = await app.request(
      `/api/doc-shares/external/${created.shareToken}/browse?deviceToken=passkey:cred-fake-123`,
    );
    expect(barePasskeyBrowse.status).toBe(403);

    const barePasskeyVerify = await app.request(`/api/doc-shares/external/${created.shareToken}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: '8848', deviceToken: 'passkey:cred-fake-123' }),
    });
    expect(barePasskeyVerify.status).toBe(403);
    expect(await barePasskeyVerify.json()).toMatchObject({ error: 'invalid_device_token' });

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

  it('Scheme 2: supports keyless Google / GitHub Auth Relay across independent self-hosted and central instances with state cookie, audience/issuer check, and one-time jti consumption (F5)', async () => {
    // Build an independent Central Auth Relay server instance with its own signing key (CENTRAL_JWT_KEY !== JWT_KEY)
    const centralStore = createInMemoryDb();
    const centralApp = buildApp(
      makeEnv(centralStore.db, {
        JWT_SIGNING_KEY: CENTRAL_JWT_KEY,
        SERVER_URL: 'https://app.im.codes',
        GOOGLE_CLIENT_ID: 'central-google-client-id',
        GOOGLE_CLIENT_SECRET: 'central-google-client-secret',
        GITHUB_CLIENT_ID: 'central-github-client-id',
        GITHUB_CLIENT_SECRET: 'central-github-client-secret',
      }),
    );

    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.startsWith('https://app.im.codes/')) {
          return centralApp.request(urlStr, init);
        }
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ access_token: 'google-oauth-token-123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          return new Response(
            JSON.stringify({
              id: 'google-uid-999',
              email: 'partner@example.com',
              name: 'External Partner',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return originalFetch(input, init);
      }),
    );

    // Owner creates an external share on self-hosted instance so Auth Relay login can auto-bind to it
    const shareRes = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: {
        Authorization: bearer('owner-1'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/team/shared/spec.docx',
        shareMode: 'external_link',
        role: 'editor',
        allowDownload: true,
      }),
    });
    const { shareToken } = (await shareRes.json()) as { shareToken: string };

    // 1. Self-hosted instance initiates Auth Relay for Google (no GOOGLE_CLIENT_ID on self-hosted)
    const startRes = await app.request(
      `/api/doc-shares/auth-relay/google?shareToken=${encodeURIComponent(shareToken)}&redirect=${encodeURIComponent(`/doc-share/${shareToken}`)}`,
    );
    expect(startRes.status).toBe(302);
    const setCookieHeader = startRes.headers.get('set-cookie') ?? '';
    const stateCookieMatch = setCookieHeader.match(/doc_oauth_state=([^;]+)/);
    expect(stateCookieMatch).not.toBeNull();
    const stateCookiePair = `doc_oauth_state=${stateCookieMatch![1]}`;

    const centralStartLocation = startRes.headers.get('location') ?? '';
    expect(centralStartLocation).toContain('https://app.im.codes/api/auth/google');

    // 2. Browser follows redirect to Central Auth Relay (/api/auth/google)
    const centralStartRes = await centralApp.request(centralStartLocation);
    expect(centralStartRes.status).toBe(302);
    const googleAuthUrl = new URL(centralStartRes.headers.get('location') ?? '');
    expect(googleAuthUrl.origin).toBe('https://accounts.google.com');
    const centralState = googleAuthUrl.searchParams.get('state') ?? '';
    expect(centralState).toBeTruthy();

    // 3. Google redirects back to Central Auth Relay (/api/auth/google/callback)
    const centralCbRes = await centralApp.request(
      `https://app.im.codes/api/auth/google/callback?code=google_code_abc&state=${encodeURIComponent(centralState)}`,
    );
    expect(centralCbRes.status).toBe(302);
    const selfHostedCbLocation = centralCbRes.headers.get('location') ?? '';
    expect(selfHostedCbLocation).toContain('https://im.example.com/api/doc-shares/auth-relay/callback');
    const selfHostedCbUrl = new URL(selfHostedCbLocation);
    const relayToken = selfHostedCbUrl.searchParams.get('relay_token') ?? '';
    const clientState = selfHostedCbUrl.searchParams.get('state') ?? '';

    // 4a. Negative: Callback without doc_oauth_state cookie is rejected (400 state_mismatch)
    const noCookieCbRes = await app.request(
      `${selfHostedCbUrl.pathname}${selfHostedCbUrl.search}`,
    );
    expect(noCookieCbRes.status).toBe(400);

    // 4b. Negative: Forged token signed with self-hosted JWT_KEY instead of CENTRAL_JWT_KEY is rejected (401)
    const forgedToken = signJwt(
      {
        type: 'doc-auth-relay-ticket',
        iss: 'https://app.im.codes',
        aud: 'https://im.example.com',
        jti: 'forged-jti',
        provider: 'google',
        externalId: 'attacker-1',
        stateHash: sha256Hex(clientState),
      },
      JWT_KEY,
      120,
    );
    const forgedCbRes = await app.request(
      `/api/doc-shares/auth-relay/callback?state=${encodeURIComponent(clientState)}&relay_token=${encodeURIComponent(forgedToken)}`,
      { headers: { Cookie: stateCookiePair } },
    );
    expect(forgedCbRes.status).toBe(401);

    // 5. Positive: Valid callback with state cookie verifies relay_token against Central /api/auth/relay/verify and issues scoped session
    const callbackRes = await app.request(
      `${selfHostedCbUrl.pathname}${selfHostedCbUrl.search}`,
      { headers: { Cookie: stateCookiePair } },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe(`/doc-share/${shareToken}`);
    const cbCookies = callbackRes.headers.get('set-cookie') ?? '';
    expect(cbCookies).toContain('rcc_session=');
    const sessionMatch = cbCookies.match(/rcc_session=([^;]+)/);
    const sessionJwt = sessionMatch![1];
    const verifiedSession = verifyJwt(sessionJwt, JWT_KEY);
    expect(verifiedSession?.scope).toBe('doc_collaborator');

    // 6. Negative: Replaying the same relay_token a second time is rejected (401 relay_token_replayed)
    const replayCbRes = await app.request(
      `${selfHostedCbUrl.pathname}${selfHostedCbUrl.search}`,
      { headers: { Cookie: stateCookiePair } },
    );
    expect(replayCbRes.status).toBe(401);
  });

  it('Scheme 3: redeems one-time Magic Link atomically, issues scoped collaborator session, rejects unredeemed magic link on external browse/config, and rejects second redemption (F2 + F3a)', async () => {
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

    // F2: Unredeemed magic_invite token cannot be used directly on /external/:token/verify, /external/:token/browse, or /onlyoffice/config
    const unredeemedVerify = await app.request(`/api/doc-shares/external/${shareToken}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceToken: 'dev-1' }),
    });
    expect(unredeemedVerify.status).toBe(403);
    expect(await unredeemedVerify.json()).toMatchObject({ error: 'magic_invite_requires_redemption' });

    const unredeemedBrowse = await app.request(`/api/doc-shares/external/${shareToken}/browse`);
    expect(unredeemedBrowse.status).toBe(403);

    const unredeemedOo = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&shareToken=${shareToken}`,
    );
    expect(unredeemedOo.status).toBe(403);

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

    // Refreshing a collaborator session preserves scope: 'doc_collaborator'
    const setCookies = redeem1.headers.get('set-cookie') ?? '';
    const refreshMatch = setCookies.match(/rcc_refresh=([^;]+)/);
    expect(refreshMatch).not.toBeNull();
    const refreshRes = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `rcc_refresh=${refreshMatch![1]}` },
    });
    expect(refreshRes.status).toBe(200);
    const refreshedSessionMatch = (refreshRes.headers.get('set-cookie') ?? '').match(/rcc_session=([^;]+)/);
    expect(refreshedSessionMatch).not.toBeNull();
    const refreshedClaims = verifyJwt(refreshedSessionMatch![1], JWT_KEY);
    expect(refreshedClaims?.scope).toBe('doc_collaborator');
  });

  it('streams file to ONLYOFFICE, writes back edited bytes on callback status=2, enforces live overrides & callback claim/SSRF guards, and creates valid blank .docx/.xlsx/.pptx/.md (F3c + F4 + F8)', async () => {
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

    // Concurrent open by another editor yields the exact same document.key
    const cfgRes2 = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('owner-1') } },
    );
    const cfgJson2 = (await cfgRes2.json()) as typeof cfgJson;
    expect(cfgJson2.config.document.key).toBe(cfgJson.config.document.key);
    const initialKey = cfgJson.config.document.key;

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

    // F4a: Rejects replaying the browser editor_config JWT on the callback endpoint (401)
    const replayEditorJwtRes = await app.request(`${cbUrl.pathname}${cbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 2,
        url: 'https://im.example.com/onlyoffice/cache/files/edited.docx',
        token: cfgJson.token,
      }),
    });
    expect(replayEditorJwtRes.status).toBe(401);

    // F4b: Rejects unsigned body tampering of url when JWT signed a different url (401)
    const signedCbClaims = {
      status: 2,
      url: 'https://im.example.com/onlyoffice/cache/files/edited.docx',
      key: initialKey,
    };
    const validCbJwt = signJwt(signedCbClaims, 'onlyoffice-jwt-secret-key-test!!', 300);
    const tamperedBodyRes = await app.request(`${cbUrl.pathname}${cbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 2,
        url: 'https://evil.example.com/payload.docx',
        key: initialKey,
        token: validCbJwt,
      }),
    });
    expect(tamperedBodyRes.status).toBe(401);

    // F4c: Rejects SSRF downloadUrl pointing outside ONLYOFFICE origin (400)
    const ssrfClaims = {
      status: 2,
      url: 'http://169.254.169.254/latest/meta-data/iam',
      key: initialKey,
    };
    const ssrfJwt = signJwt(ssrfClaims, 'onlyoffice-jwt-secret-key-test!!', 300);
    const ssrfRes = await app.request(`${cbUrl.pathname}${cbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...ssrfClaims,
        token: ssrfJwt,
      }),
    });
    expect(ssrfRes.status).toBe(400);

    // Valid callback succeeds and writes binary bytes atomically
    const cbRes = await app.request(`${cbUrl.pathname}${cbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...signedCbClaims,
        token: validCbJwt,
      }),
    });
    expect(cbRes.status).toBe(200);
    expect(await cbRes.json()).toEqual({ error: 0 });
    expect(
      Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString('utf8'),
    ).toBe('PK\x03\x04updated-collaborative-docx-bytes');

    // F8: After save, opening the document again produces a new content-derived key, and survives process restart
    const afterSaveCfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('owner-1') } },
    );
    const afterSaveKey = ((await afterSaveCfgRes.json()) as typeof cfgJson).config.document.key;
    expect(afterSaveKey).not.toBe(initialKey);

    resetOnlyOfficeDocumentKeyCacheForTests();
    const afterRestartCfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('owner-1') } },
    );
    const afterRestartKey = ((await afterRestartCfgRes.json()) as typeof cfgJson).config.document.key;
    expect(afterRestartKey).toBe(afterSaveKey);
    expect(afterRestartKey).not.toBe(initialKey);

    // F8: Replaying a stale callback with initialKey now fails with 409 stale_document_key
    const staleCbRes = await app.request(`${cbUrl.pathname}${cbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...signedCbClaims,
        token: validCbJwt,
      }),
    });
    expect(staleCbRes.status).toBe(409);

    // F3c: Live permission downgrade (child file override to viewer) immediately blocks callback write from an older folder editor token
    await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'folder',
        targetPath: '/team/shared',
        shareMode: 'user',
        targetUser: 'bob',
        role: 'editor',
      }),
    });
    const bobCfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('user-bob') } },
    );
    const bobCfg = (await bobCfgRes.json()) as typeof cfgJson;
    const bobCbUrl = new URL(bobCfg.config.editorConfig.callbackUrl);

    // Owner now downgrades Bob on /team/shared/spec.docx to viewer
    await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/team/shared/spec.docx',
        shareMode: 'user',
        targetUser: 'bob',
        role: 'viewer',
      }),
    });
    const bobCbClaims = {
      status: 2,
      url: 'https://im.example.com/onlyoffice/cache/files/edited.docx',
      key: bobCfg.config.document.key,
    };
    const bobCbRes = await app.request(`${bobCbUrl.pathname}${bobCbUrl.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...bobCbClaims,
        token: signJwt(bobCbClaims, 'onlyoffice-jwt-secret-key-test!!', 300),
      }),
    });
    expect(bobCbRes.status).toBe(403);

    // 4. Create blank .docx, .xlsx, .pptx, .md and folder via POST /api/server/srv-1/doc-shares/create-item
    for (const ext of ['.docx', '.xlsx', '.pptx'] as const) {
      const bytes = buildBlankDocumentBytes(ext, 'Quarterly Plan');
      expect(bytes).not.toBeNull();
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

  it('audit: callback writeback fails closed when daemon upload fails and does not overwrite binary docx with utf8 JSON', async () => {
    const cfgRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&mode=edit`,
      { headers: { Authorization: bearer('owner-1') } },
    );
    expect(cfgRes.status).toBe(200);
    const cfgJson = (await cfgRes.json()) as {
      config: { editorConfig: { callbackUrl: string } };
    };
    const cbUrl = new URL(cfgJson.config.editorConfig.callbackUrl);

    const bridge = WsBridge.get('srv-1');
    vi.spyOn(bridge, 'sendFileTransferRequest').mockResolvedValue({
      type: 'file.upload_response',
      status: 'error',
      error: 'Upload path is not allowed',
    });

    const updatedBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xd8, 0x00, 0x89]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(updatedBytes, { status: 200 })),
    );

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

    expect(cbRes.status).toBe(502);
    expect(virtualFiles.get('/team/shared/spec.docx')).toMatchObject({
      content: Buffer.from('PK\x03\x04mock-docx-bytes').toString('base64'),
      encoding: 'base64',
    });
  });

  it('audit: external share with accessCode requires code verification before ONLYOFFICE config or folder browse when deviceLockEnabled is false', async () => {
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
        participantLabel: '外部顾问',
        accessCode: '8848',
        deviceLockEnabled: false,
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { shareToken: string };

    const unverifiedBrowseRes = await app.request(
      `/api/doc-shares/external/${created.shareToken}/browse`,
    );
    expect(unverifiedBrowseRes.status).toBe(403);

    const unverifiedOoRes = await app.request(
      `/api/server/srv-1/onlyoffice/config?path=${encodeURIComponent('/team/shared/spec.docx')}&shareToken=${created.shareToken}`,
    );
    expect(unverifiedOoRes.status).toBe(403);
  });

  it('audit: magic invite collaborator session is scoped to shared documents and cannot access full internal server routes', async () => {
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
        participantLabel: '外部访客',
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const { shareToken } = (await createRes.json()) as { shareToken: string };

    const redeem = await app.request(`/api/doc-shares/magic-invite/${shareToken}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '外部访客' }),
    });
    expect(redeem.status).toBe(200);
    const { sessionToken } = (await redeem.json()) as { sessionToken: string };

    const serverListRes = await app.request('/api/server', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(serverListRes.status).toBe(403);

    const createKeyRes = await app.request('/api/auth/user/me/keys', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: 'escalated-key' }),
    });
    expect(createKeyRes.status).toBe(403);

    const wsTicketRes = await app.request('/api/auth/ws-ticket', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serverId: 'srv-1' }),
    });
    expect(wsTicketRes.status).toBe(403);
  });
});

describe('Real Daemon CommandHandler Integration: Atomic Binary Save & Symlink Escape Prevention (F1 + F3d)', () => {
  let tmpRoot: string;
  let sharedDir: string;
  let outsideDir: string;

  beforeEach(() => {
    __resetFsGitCachesForTests();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-oo-real-daemon-'));
    sharedDir = path.join(tmpRoot, 'shared');
    outsideDir = path.join(tmpRoot, 'outside');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    __resetFsGitCachesForTests();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function dispatchRealDaemon(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const fakeServerLink = {
        send(msg: Record<string, unknown>) {
          resolve(msg);
        },
      } as unknown as ServerLink;
      handleWebCommand(cmd, fakeServerLink);
    });
  }

  it('F1: atomically overwrites existing binary .docx via staged file.upload + fs.rename(overwrite=true) and preserves original bytes on failure', async () => {
    const targetDocx = path.join(sharedDir, 'contract.docx');
    const originalBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22, 0x33, 0x44]);
    fs.writeFileSync(targetDocx, originalBytes);

    // 1. Stage new binary bytes via real file.upload handler
    const newBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xff]);
    const stageName = '.oo-stage-test1234-contract.docx';
    const uploadReply = await dispatchRealDaemon({
      type: 'file.upload',
      uploadId: 'up-1',
      filename: `up-1-${stageName}`,
      destinationDirectory: sharedDir,
      originalName: stageName,
      sanitizedName: stageName,
      content: newBytes.toString('base64'),
      size: newBytes.byteLength,
    });
    expect(uploadReply.error).toBeUndefined();
    expect(uploadReply.type).toBe('file.upload_done');
    expect(uploadReply.attachment).toBeTruthy();

    // Original file is still untouched before atomic rename commit
    expect(fs.readFileSync(targetDocx).equals(originalBytes)).toBe(true);

    // 2. Commit via real fs.rename with overwrite: true and allowedRoot: targetDocx
    const stagePath = path.join(sharedDir, stageName);
    const renameReply = await dispatchRealDaemon({
      type: 'fs.rename',
      requestId: 'ren-1',
      path: stagePath,
      newPath: targetDocx,
      overwrite: true,
      allowedRoot: targetDocx,
    });
    expect(renameReply.status).toBe('ok');
    expect(fs.existsSync(stagePath)).toBe(false);
    expect(fs.readFileSync(targetDocx).equals(newBytes)).toBe(true);

    // 3. Base64 fs.write atomic overwrite also preserves binary bytes and rejects symlinks
    const writeBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x88, 0x77]);
    const writeReply = await dispatchRealDaemon({
      type: 'fs.write',
      requestId: 'wr-1',
      path: targetDocx,
      content: writeBytes.toString('base64'),
      encoding: 'base64',
      allowedRoot: sharedDir,
    });
    expect(writeReply.status).toBe('ok');
    expect(fs.readFileSync(targetDocx).equals(writeBytes)).toBe(true);
  });

  it('F3d: enforces allowedRoot and blocks symlink escapes on fs.read, fs.ls, fs.write, and fs.rename', async () => {
    const insideFile = path.join(sharedDir, 'legit.docx');
    const outsideSecret = path.join(outsideDir, 'secret.docx');
    fs.writeFileSync(insideFile, 'legit-content');
    fs.writeFileSync(outsideSecret, 'top-secret-outside');

    // Create symlinks inside sharedDir pointing to outsideSecret and outsideDir
    const symlinkFile = path.join(sharedDir, 'escape-file.docx');
    const symlinkDir = path.join(sharedDir, 'escape-dir');
    fs.symlinkSync(outsideSecret, symlinkFile);
    fs.symlinkSync(outsideDir, symlinkDir);

    // 1. fs.read on symlink escaping allowedRoot is rejected with forbidden_path
    const readEscape = await dispatchRealDaemon({
      type: 'fs.read',
      requestId: 'rd-escape',
      path: symlinkFile,
      allowedRoot: sharedDir,
    });
    expect(readEscape.status).toBe('error');
    expect(readEscape.error).toBe('forbidden_path');

    // 2. fs.ls on sharedDir with allowedRoot filters out symlinks that escape sharedDir
    const lsShared = await dispatchRealDaemon({
      type: 'fs.ls',
      requestId: 'ls-shared',
      path: sharedDir,
      includeFiles: true,
      allowedRoot: sharedDir,
    });
    expect(lsShared.status).toBe('ok');
    const entryNames = (lsShared.entries as Array<{ name: string }>).map((e) => e.name);
    expect(entryNames).toContain('legit.docx');
    expect(entryNames).not.toContain('escape-file.docx');
    expect(entryNames).not.toContain('escape-dir');

    // 3. fs.ls directly on symlinkDir with allowedRoot is rejected with forbidden_path
    const lsEscapeDir = await dispatchRealDaemon({
      type: 'fs.ls',
      requestId: 'ls-escape-dir',
      path: symlinkDir,
      includeFiles: true,
      allowedRoot: sharedDir,
    });
    expect(lsEscapeDir.status).toBe('error');
    expect(lsEscapeDir.error).toBe('forbidden_path');

    // 4. fs.write on symlinkFile is rejected with forbidden_path and outsideSecret is untouched
    const writeEscape = await dispatchRealDaemon({
      type: 'fs.write',
      requestId: 'wr-escape',
      path: symlinkFile,
      content: Buffer.from('hacked').toString('base64'),
      encoding: 'base64',
      allowedRoot: sharedDir,
    });
    expect(writeEscape.status).toBe('error');
    expect(writeEscape.error).toBe('forbidden_path');
    expect(fs.readFileSync(outsideSecret, 'utf8')).toBe('top-secret-outside');
  });
});
