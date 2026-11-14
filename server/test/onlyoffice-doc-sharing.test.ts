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
  createDocumentShare,
  isPathWithinSharedFolder,
  normalizeDocumentSharePath,
  resolveEffectiveDocumentAccess,
  claimOnlyOfficeCommitOwner,
  commitOnlyOfficeRoom,
  type OnlyOfficeRoomRow,
  type OnlyOfficeCommitJournalRow,
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
  const teams = new Map<string, { id: string; name: string; owner_id: string }>([
    ['team-1', { id: 'team-1', name: 'Primary Team', owner_id: 'owner-1' }],
  ]);
  const machineGroups = new Set<string>(); // `${serverId}:${teamId}`
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
  const rooms = new Map<string, OnlyOfficeRoomRow>();
  const commitJournals = new Map<string, OnlyOfficeCommitJournalRow>();

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
              r.target_user_id === '*' ||
              r.target_user_id.startsWith('team:')
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
            (r.target_user_id === userId ||
              r.redeemed_by_user_id === userId ||
              r.target_user_id === '*' ||
              r.target_user_id.startsWith('team:')),
        );
        return list as unknown as T[];
      }

      // listServerDocumentGroups: machine_groups bound teams
      if (normSql.includes('FROM machine_groups mg') && normSql.includes('JOIN teams t ON t.id = mg.team_id')) {
        const serverId = params[0] as string;
        const rows: Array<{ id: string; name: string }> = [];
        for (const key of machineGroups) {
          const [sid, tid] = key.split(':');
          if (sid === serverId && tid) {
            const t = teams.get(tid);
            if (t) rows.push({ id: t.id, name: t.name });
          }
        }
        return rows as unknown as T[];
      }

      // listServerDocumentGroups: legacy servers.team_id bound team
      if (normSql.includes('FROM servers s') && normSql.includes('JOIN teams t ON t.id = s.team_id')) {
        const serverId = params[0] as string;
        const srv = servers.get(serverId);
        if (!srv?.team_id) return [] as T[];
        const t = teams.get(srv.team_id);
        return (t ? [{ id: t.id, name: t.name }] : []) as unknown as T[];
      }

      // listServerDocumentGroups: caller's global groups (owner or member)
      if (normSql.includes('FROM teams t') && normSql.includes('WHERE t.owner_id = $1')) {
        const actorUserId = params[0] as string;
        const rows: Array<{ id: string; name: string }> = [];
        for (const t of teams.values()) {
          if (t.owner_id === actorUserId || teamMembers.has(`${t.id}:${actorUserId}`)) {
            rows.push({ id: t.id, name: t.name });
          }
        }
        return rows as unknown as T[];
      }

      // listServerDocumentGroups: active member counts for teamIds
      if (normSql.includes('FROM team_members tm') && normSql.includes('JOIN users u ON u.id = tm.user_id')) {
        const [teamIds, activeStatus] = params as [string[], string];
        const teamSet = new Set(teamIds);
        const rows: Array<{ team_id: string; user_id: string }> = [];
        for (const key of teamMembers.keys()) {
          const idx = key.indexOf(':');
          const tid = key.slice(0, idx);
          const uid = key.slice(idx + 1);
          const u = users.get(uid);
          if (teamSet.has(tid) && u && u.status === activeStatus) {
            rows.push({ team_id: tid, user_id: uid });
          }
        }
        return rows as unknown as T[];
      }

      // listDocumentsSharedWithUser: user's team memberships with names
      if (normSql.includes('SELECT tm.team_id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = $1')) {
        const userId = params[0] as string;
        const rows: Array<{ team_id: string; name: string }> = [];
        for (const key of teamMembers.keys()) {
          const idx = key.indexOf(':');
          const tid = key.slice(0, idx);
          const uid = key.slice(idx + 1);
          if (uid === userId) {
            const t = teams.get(tid);
            if (t) rows.push({ team_id: tid, name: t.name });
          }
        }
        return rows as unknown as T[];
      }

      // resolveEffectiveDocumentAccess: user's team_ids
      if (normSql.startsWith('SELECT team_id FROM team_members WHERE user_id = $1')) {
        const userId = params[0] as string;
        const rows: Array<{ team_id: string }> = [];
        for (const key of teamMembers.keys()) {
          const idx = key.indexOf(':');
          const tid = key.slice(0, idx);
          const uid = key.slice(idx + 1);
          if (uid === userId) {
            rows.push({ team_id: tid });
          }
        }
        return rows as unknown as T[];
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
        if (!srv) return null;
        if (normSql.includes('FROM machine_groups mg')) {
          let bestRole: string | null = null;
          for (const key of machineGroups) {
            const [sid, tid] = key.split(':');
            if (sid === serverId && tid) {
              const r = teamMembers.get(`${tid}:${userId}`);
              if (r === 'owner') bestRole = 'owner';
              else if (r === 'admin' && bestRole !== 'owner') bestRole = 'admin';
              else if (r && !bestRole) bestRole = r;
            }
          }
          if (bestRole) return { role: bestRole } as unknown as T;
        }
        if (!srv.team_id) return null;
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

      if (normSql.includes('FROM onlyoffice_rooms') && normSql.includes('WHERE server_id = $1 AND normalized_path = $2')) {
        const [serverId, normalizedPath] = params as [string, string];
        const row = rooms.get(`${serverId}:${normalizedPath}`);
        return (row ?? null) as unknown as T | null;
      }

      if (normSql.includes('FROM onlyoffice_commit_journal') && normSql.includes('WHERE server_id = $1 AND normalized_path = $2')) {
        const [serverId, normalizedPath] = params as [string, string];
        const row = commitJournals.get(`${serverId}:${normalizedPath}`);
        return (row ?? null) as unknown as T | null;
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
      if (normSql.startsWith('INSERT INTO onlyoffice_rooms')) {
        const [
          serverId,
          normalizedPath,
          currentConfirmedHash,
          committedHash,
          lastForceSavedHash,
          activeKey,
          sessionEpoch,
          commitSeq,
          active,
          updatedAt,
        ] = params as [string, string, string, string, string | null, string, number, number, boolean, number];
        const key = `${serverId}:${normalizedPath}`;
        const existing = rooms.get(key);
        if (
          !existing ||
          Number(sessionEpoch) > existing.session_epoch ||
          (Number(sessionEpoch) === existing.session_epoch && Number(commitSeq) >= existing.commit_seq)
        ) {
          const row: OnlyOfficeRoomRow = {
            server_id: serverId,
            normalized_path: normalizedPath,
            current_confirmed_hash: currentConfirmedHash,
            committed_hash: committedHash,
            last_force_saved_hash: lastForceSavedHash,
            active_key: activeKey,
            session_epoch: Number(sessionEpoch),
            commit_seq: Number(commitSeq),
            active: Boolean(active),
            updated_at: Number(updatedAt),
          };
          rooms.set(key, row);
          return { changes: 1 };
        }
        return { changes: 0 };
      }

      if (normSql.startsWith('UPDATE onlyoffice_rooms SET')) {
        const [
          serverId,
          normalizedPath,
          currentConfirmedHash,
          committedHash,
          lastForceSavedHash,
          activeKey,
          sessionEpoch,
          commitSeq,
          active,
          updatedAt,
          expectedSeq,
          expectedEpoch,
          ownerToken,
        ] = params as [
          string,
          string,
          string,
          string,
          string | null,
          string,
          number,
          number,
          boolean,
          number,
          number,
          number,
          string | undefined,
        ];
        const key = `${serverId}:${normalizedPath}`;
        const existing = rooms.get(key);
        if (existing) {
          if (existing.commit_seq !== Number(expectedSeq) || existing.session_epoch !== Number(expectedEpoch)) {
            return { changes: 0 };
          }
          if (ownerToken) {
            const jRow = commitJournals.get(key);
            if (!jRow) return { changes: 0 };
            const jOwner =
              jRow.owner_token ||
              (jRow.phase?.startsWith('intent:')
                ? jRow.phase.slice(7)
                : jRow.phase?.startsWith('terminal:')
                  ? jRow.phase.slice(9)
                  : '');
            if (jOwner !== ownerToken && !jRow.phase.includes(ownerToken)) {
              return { changes: 0 };
            }
          }
          const row: OnlyOfficeRoomRow = {
            server_id: serverId,
            normalized_path: normalizedPath,
            current_confirmed_hash: currentConfirmedHash,
            committed_hash: committedHash,
            last_force_saved_hash: lastForceSavedHash,
            active_key: activeKey,
            session_epoch: Number(sessionEpoch),
            commit_seq: Number(commitSeq),
            active: Boolean(active),
            updated_at: Number(updatedAt),
          };
          rooms.set(key, row);
          return { changes: 1 };
        }
        return { changes: 0 };
      }

      if (normSql.startsWith('DELETE FROM onlyoffice_rooms WHERE server_id = $1 AND normalized_path = $2')) {
        const [serverId, normalizedPath] = params as [string, string];
        rooms.delete(`${serverId}:${normalizedPath}`);
        return { changes: 1 };
      }

      if (normSql.startsWith('INSERT INTO onlyoffice_commit_journal')) {
        const [
          serverId,
          normalizedPath,
          roomKey,
          targetHash,
          sessionEpoch,
          phase,
          ownerTokenOrUpdated,
          expectedSeq,
          updatedAtParam,
        ] = params as [string, string, string, string, number, string, string | number, number | undefined, number | undefined];
        const ownerToken = typeof ownerTokenOrUpdated === 'string' ? ownerTokenOrUpdated : '';
        const updatedAt = typeof ownerTokenOrUpdated === 'number' ? ownerTokenOrUpdated : (updatedAtParam ?? Date.now());
        const row: OnlyOfficeCommitJournalRow = {
          server_id: serverId,
          normalized_path: normalizedPath,
          room_key: roomKey,
          target_hash: targetHash,
          session_epoch: Number(sessionEpoch),
          phase: phase || 'intent',
          owner_token:
            ownerToken ||
            (phase?.startsWith('intent:')
              ? phase.slice(7)
              : phase?.startsWith('terminal:')
                ? phase.slice(9)
                : ''),
          expected_seq: expectedSeq !== undefined ? Number(expectedSeq) : 0,
          updated_at: Number(updatedAt),
        };
        commitJournals.set(`${serverId}:${normalizedPath}`, row);
        return { changes: 1 };
      }

      if (normSql.startsWith('DELETE FROM onlyoffice_commit_journal WHERE server_id = $1 AND normalized_path = $2')) {
        const [serverId, normalizedPath, ownerTokenOrExpiry] = params as [string, string, string | number | undefined];
        const key = `${serverId}:${normalizedPath}`;
        const existing = commitJournals.get(key);
        if (existing) {
          if (typeof ownerTokenOrExpiry === 'string' && ownerTokenOrExpiry) {
            const jOwner =
              existing.owner_token ||
              (existing.phase?.startsWith('intent:')
                ? existing.phase.slice(7)
                : existing.phase?.startsWith('terminal:')
                  ? existing.phase.slice(9)
                  : '');
            if (jOwner && jOwner !== ownerTokenOrExpiry && !existing.phase.includes(ownerTokenOrExpiry)) {
              return { changes: 0 };
            }
            commitJournals.delete(key);
            return { changes: 1 };
          }
          // No owner token passed: only delete if expired or ownerless
          const cutoff = typeof ownerTokenOrExpiry === 'number' ? ownerTokenOrExpiry : Date.now() - 30000;
          const isExpired = Number(existing.updated_at) <= cutoff;
          const hasOwner = Boolean(
            existing.owner_token ||
              (existing.phase?.startsWith('intent:') && existing.phase.length > 7) ||
              (existing.phase?.startsWith('terminal:') && existing.phase.length > 9),
          );
          if (hasOwner && !isExpired) {
            return { changes: 0 };
          }
          commitJournals.delete(key);
          return { changes: 1 };
        }
        return { changes: 0 };
      }

      return { changes: 1 };
    },
    exec: async () => undefined,
    close: async () => undefined,
    transaction: async (fn: (tx: Database) => Promise<any>) => fn(db),
  } as unknown as Database;

  return {
    db,
    users,
    servers,
    teams,
    machineGroups,
    teamMembers,
    shares,
    refreshTokens,
    passkeyChallenges,
    passkeyCredentials,
    rooms,
    commitJournals,
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
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS onlyoffice_rooms');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS onlyoffice_commit_journal');
    expect(sql).toContain('PRIMARY KEY (server_id, normalized_path)');
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

  it('persists collaborative room state in PostgreSQL and retains key across in-memory cache resets (F8)', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const key = cfg.config.document.key;

    // Verify room was persisted into PostgreSQL
    const roomInDb = store.rooms.get('srv-1:/team/shared/spec.docx');
    expect(roomInDb).toBeDefined();
    expect(roomInDb?.active_key).toBe(key);
    expect(roomInDb?.session_epoch).toBe(0);
    expect(roomInDb?.active).toBe(true);

    // Reset in-memory cache completely to simulate service restart or separate pod
    resetOnlyOfficeDocumentKeyCacheForTests();

    // Query config again: must recover exactly the same key from PostgreSQL
    const res2 = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res2.status).toBe(200);
    const cfg2 = (await res2.json()) as any;
    expect(cfg2.config.document.key).toBe(key);
  });

  it('aborts callback without modifying daemon binary if PostgreSQL WAL intent write fails (F8)', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const key = cfg.config.document.key;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);

    const originalContent = virtualFiles.get('/team/shared/spec.docx')!.content;

    // Mock fetch for ONLYOFFICE document download
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('new-content-blocked-by-wal', { status: 200 }),
    );

    // Cause DB WAL write to fail
    const origExecute = store.db.execute.bind(store.db);
    let walAttempted = 0;
    const execSpy = vi.spyOn(store.db, 'execute').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO onlyoffice_commit_journal')) {
        walAttempted++;
        throw new Error('PostgreSQL WAL disk full / connection closed');
      }
      return origExecute(sql, params);
    });

    const data = { status: 6, key, url: 'https://im.example.com/onlyoffice/cache/force-save.docx' };
    const saveRes = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, token: signJwt(data, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });

    expect(walAttempted).toBeGreaterThan(0);
    expect(saveRes.status).toBe(500);
    const saveBody = (await saveRes.json()) as any;
    expect(saveBody.message).toBe('durable_room_state_failed');

    // Invariant: If WAL cannot be recorded in PG, the daemon binary MUST NOT be modified
    expect(virtualFiles.get('/team/shared/spec.docx')!.content).toBe(originalContent);

    execSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('invalidates PostgreSQL room on external restore and rejects stale room callback with 409 (F8)', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const originalKey = cfg.config.document.key;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);
    const originalFile = { ...virtualFiles.get('/team/shared/spec.docx')! };

    // Force-save creates revision B on disk and in PG
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('revision-B-content', { status: 200 }),
    );
    const forced = { status: 6, key: originalKey, url: 'https://im.example.com/onlyoffice/cache/rev-b.docx' };
    const forceRes = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...forced, token: signJwt(forced, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    expect(forceRes.status).toBe(200);

    const roomAfterForce = store.rooms.get('srv-1:/team/shared/spec.docx');
    expect(roomAfterForce?.active_key).toBe(originalKey);
    expect(roomAfterForce?.current_confirmed_hash).not.toBe(sha256Hex(originalFile.content));

    // External actor restores file back to original A content
    virtualFiles.set('/team/shared/spec.docx', { ...originalFile, mtime: Date.now() });

    // Next GET config detects external restore: current hash (A) != confirmed hash (B)
    // Must advance to a new sessionEpoch and generate a new key
    const resAfterRestore = await app.request(
      '/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit',
      {
        headers: { Authorization: bearer('owner-1') },
      },
    );
    expect(resAfterRestore.status).toBe(200);
    const cfgAfterRestore = (await resAfterRestore.json()) as any;
    const newKey = cfgAfterRestore.config.document.key;
    expect(newKey).not.toBe(originalKey);

    // Old room callback attempting late save with originalKey must be rejected with 409
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response('stale-overwrite-attempt', { status: 200 }),
    );
    const staleData = { status: 2, key: originalKey, url: 'https://im.example.com/onlyoffice/cache/stale.docx' };
    const staleRes = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...staleData, token: signJwt(staleData, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    expect(staleRes.status).toBe(409);
    expect(virtualFiles.get('/team/shared/spec.docx')!.content).toBe(originalFile.content);

    vi.restoreAllMocks();
  });

  it('updates PostgreSQL authoritative hash on force-save and marks inactive on status 2 final save (F8)', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const key = cfg.config.document.key;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);

    // Status 6: force-save
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('force-saved-bytes', { status: 200 }),
    );
    const forceData = { status: 6, key, url: 'https://im.example.com/onlyoffice/cache/force.docx' };
    const forceRes = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...forceData, token: signJwt(forceData, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    expect(forceRes.status).toBe(200);

    const roomAfterForce = store.rooms.get('srv-1:/team/shared/spec.docx');
    expect(roomAfterForce?.active).toBe(true);
    expect(roomAfterForce?.current_confirmed_hash).toBe(sha256Hex('force-saved-bytes'));
    expect(store.commitJournals.has('srv-1:/team/shared/spec.docx')).toBe(false);

    // Status 2: final save
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response('final-saved-bytes', { status: 200 }),
    );
    const finalData = { status: 2, key, url: 'https://im.example.com/onlyoffice/cache/final.docx' };
    const finalRes = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...finalData, token: signJwt(finalData, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    expect(finalRes.status).toBe(200);

    const roomAfterFinal = store.rooms.get('srv-1:/team/shared/spec.docx');
    expect(roomAfterFinal?.active).toBe(false);
    expect(roomAfterFinal?.current_confirmed_hash).toBe(sha256Hex('final-saved-bytes'));
    expect(store.commitJournals.has('srv-1:/team/shared/spec.docx')).toBe(false);

    vi.restoreAllMocks();
  });

  it('audit-r8: the first direct callback after restart must load PG commit sequence before comparing CAS', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const key = cfg.config.document.key;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('first-force-save', { status: 200 }));
    const save = () => {
      const data = { status: 6, key, url: 'https://im.example.com/onlyoffice/cache/recover-direct.docx' };
      return app.request(cb.pathname + cb.search, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, token: signJwt(data, 'onlyoffice-jwt-secret-key-test!!', 300) }),
      });
    };
    expect((await save()).status).toBe(200);
    expect(store.rooms.get('srv-1:/team/shared/spec.docx')!.commit_seq).toBeGreaterThan(0);
    resetOnlyOfficeDocumentKeyCacheForTests();
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('second-force-save-after-restart', { status: 200 }));
    const after = await save();
    expect.soft(after.status, 'valid Document Server callback must recover directly without a prior browser config request').toBe(200);
    expect.soft(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString()).toBe('second-force-save-after-restart');
  });

  it('audit-r8: a transient PG room read error must not become absent state and reset a committed room epoch', async () => {
    const get = () =>
      app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
        headers: { Authorization: bearer('owner-1') },
      });
    const first = await get();
    expect(first.status).toBe(200);
    const cfg = (await first.json()) as any;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('final-durable-revision', { status: 200 }));
    const data = { status: 2, key: cfg.config.document.key, url: 'https://im.example.com/onlyoffice/cache/final-durable.docx' };
    const saved = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, token: signJwt(data, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    expect(saved.status).toBe(200);
    const row = { ...store.rooms.get('srv-1:/team/shared/spec.docx')! };
    expect(row.session_epoch).toBeGreaterThan(0);
    resetOnlyOfficeDocumentKeyCacheForTests();
    const query = store.db.queryOne.bind(store.db);
    let injected = 0;
    vi.spyOn(store.db, 'queryOne').mockImplementation(async (sql, params) => {
      if (sql.includes('FROM onlyoffice_rooms') && injected++ === 0) throw new Error('audit transient PG room SELECT connection failure');
      return query(sql, params);
    });
    const res = await get();
    expect(injected).toBeGreaterThan(0);
    expect.soft(res.status, 'failed authoritative read must fail closed, never return a fabricated editing config').toBeGreaterThanOrEqual(500);
    const after = store.rooms.get('srv-1:/team/shared/spec.docx')!;
    expect.soft(after.session_epoch, 'PG epoch must not be reset to zero after a read error').toBe(row.session_epoch);
    expect.soft(after.active_key, 'PG active key must not be replaced with a fabricated initial key').toBe(row.active_key);
  });

  it('audit-r9: a warm cache must not fork or overwrite a room force-saved by another PG-authoritative instance', async () => {
    const get = () =>
      app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
        headers: { Authorization: bearer('owner-1') },
      });
    const first = await get();
    expect(first.status).toBe(200);
    const cfg = (await first.json()) as any;
    const mapKey = 'srv-1:/team/shared/spec.docx';
    const prior = { ...store.rooms.get(mapKey)! };
    // Model a successful status-6 commit by a different instance sharing the same PG authority.
    // A force-save advances confirmed hash/seq but deliberately retains the active room key.
    const bytes = 'force-save-from-another-authoritative-instance';
    const digest = sha256Hex(bytes);
    const authoritative = {
      ...prior,
      current_confirmed_hash: digest,
      committed_hash: digest,
      last_force_saved_hash: digest,
      commit_seq: prior.commit_seq + 1,
      active: true,
      updated_at: Date.now(),
    };
    store.rooms.set(mapKey, authoritative);
    virtualFiles.set('/team/shared/spec.docx', {
      content: Buffer.from(bytes).toString('base64'),
      encoding: 'base64',
      mtime: Date.now(),
    });
    expect(store.commitJournals.size).toBe(0);
    const next = await get();
    expect(next.status).toBe(200);
    const nextCfg = (await next.json()) as any;
    expect.soft(nextCfg.config.document.key, 'a joining participant must stay in the PG-confirmed active editing room').toBe(cfg.config.document.key);
    expect.soft(store.rooms.get(mapKey)!.session_epoch, 'stale local cache must not advance/overwrite authoritative room epoch').toBe(authoritative.session_epoch);
    expect.soft(store.rooms.get(mapKey)!.commit_seq, 'stale local cache must not overwrite the PG-confirmed commit revision').toBe(authoritative.commit_seq);
  });

  it('audit-r10: a callback delayed on download must compare its expected sequence to PG before overwriting another instance commit', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);
    const mapKey = 'srv-1:/team/shared/spec.docx';
    const prior = { ...store.rooms.get(mapKey)! };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered();
      await hold;
      return new Response('older-delayed-callback-content', { status: 200 });
    });
    const data = { status: 6, key: cfg.config.document.key, url: 'https://im.example.com/onlyoffice/cache/delayed-cross-instance.docx' };
    const request = app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, token: signJwt(data, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    await started;
    // Model a newer successful status-6 commit from a different process during the old fetch.
    // Its confirmed room remains active with the same key; only hash and commit_seq advance.
    const newer = 'newer-confirmed-content-from-another-instance';
    const digest = sha256Hex(newer);
    const authoritative = {
      ...prior,
      current_confirmed_hash: digest,
      committed_hash: digest,
      last_force_saved_hash: digest,
      commit_seq: prior.commit_seq + 1,
      active: true,
      updated_at: Date.now(),
    };
    store.rooms.set(mapKey, authoritative);
    virtualFiles.set('/team/shared/spec.docx', {
      content: Buffer.from(newer).toString('base64'),
      encoding: 'base64',
      mtime: Date.now(),
    });
    release();
    const response = await request;
    expect.soft(response.status, 'old callback must lose authority when PG commit_seq changed during download').toBe(409);
    expect.soft(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString(), 'newer confirmed binary must not be overwritten by the stale callback').toBe(newer);
    expect.soft(store.rooms.get(mapKey)!.commit_seq, 'rejected stale callback must not publish another commit').toBe(authoritative.commit_seq);
  });

  it('audit-r11: PG expected-version validation and intent acquisition must be atomic, not SELECT then unconditional WAL', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);
    const mapKey = 'srv-1:/team/shared/spec.docx';
    const prior = { ...store.rooms.get(mapKey)! };
    const newer = 'newer-commit-between-select-and-wal';
    const digest = sha256Hex(newer);
    let injected = 0;
    const execute = store.db.execute.bind(store.db);
    vi.spyOn(store.db, 'execute').mockImplementation(async (sql, params) => {
      // Schedule another writer AFTER this callback read/checked expected PG state,
      // but BEFORE its independent WAL INSERT acquires any durable write right.
      if (sql.includes('INSERT INTO onlyoffice_commit_journal') && injected++ === 0) {
        store.rooms.set(mapKey, {
          ...prior,
          current_confirmed_hash: digest,
          committed_hash: digest,
          last_force_saved_hash: digest,
          commit_seq: prior.commit_seq + 1,
          active: true,
          updated_at: Date.now(),
        });
        virtualFiles.set('/team/shared/spec.docx', {
          content: Buffer.from(newer).toString('base64'),
          encoding: 'base64',
          mtime: Date.now(),
        });
      }
      return execute(sql, params);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('old-racing-callback-content', { status: 200 }));
    const data = { status: 6, key: cfg.config.document.key, url: 'https://im.example.com/onlyoffice/cache/toctou.docx' };
    const out = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, token: signJwt(data, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    expect(injected).toBeGreaterThan(0);
    expect.soft(out.status, 'another writer winning before WAL must invalidate this old expected version before file overwrite').toBe(409);
    expect.soft(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString(), 'newer winning bytes must survive').toBe(newer);
  });

  it('audit-r11: external disk changes while a callback downloads must still invalidate the old save', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entered();
      await hold;
      return new Response('old-office-content-before-external-edit', { status: 200 });
    });
    const data = { status: 6, key: cfg.config.document.key, url: 'https://im.example.com/onlyoffice/cache/external-during-download.docx' };
    const pending = app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, token: signJwt(data, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    await started;
    const external = 'external-authoritative-disk-change-during-download';
    virtualFiles.set('/team/shared/spec.docx', {
      content: Buffer.from(external).toString('base64'),
      encoding: 'base64',
      mtime: Date.now(),
    });
    release();
    const out = await pending;
    expect.soft(out.status, 'disk version changed while downloading: the old room must lose write authority').toBe(409);
    expect.soft(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString(), 'external edits must not be overwritten by the old callback').toBe(external);
  });

  it('audit-r12: repeating SELECT after WAL is not an atomic owner claim and cannot protect the winning committed bytes', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const cb = new URL(cfg.config.editorConfig.callbackUrl);
    const mapKey = 'srv-1:/team/shared/spec.docx';
    const prior = { ...store.rooms.get(mapKey)! };
    const newer = 'newer-writer-commit-after-last-read-snapshot';
    const digest = sha256Hex(newer);
    const query = store.db.queryOne.bind(store.db);
    let injected = 0;
    vi.spyOn(store.db, 'queryOne').mockImplementation(async (sql, params) => {
      const snapshot = await query(sql, params);
      // The post-WAL SELECT has observed old seq0. Another process can commit
      // before this read returns to the application because no PG ownership lock exists.
      if (sql.includes('FROM onlyoffice_rooms') && store.commitJournals.has(mapKey) && injected++ === 0) {
        store.rooms.set(mapKey, {
          ...prior,
          current_confirmed_hash: digest,
          committed_hash: digest,
          last_force_saved_hash: digest,
          commit_seq: prior.commit_seq + 1,
          active: true,
          updated_at: Date.now(),
        });
        store.commitJournals.delete(mapKey); // Winning writer completed its durable commit.
        virtualFiles.set('/team/shared/spec.docx', {
          content: Buffer.from(newer).toString('base64'),
          encoding: 'base64',
          mtime: Date.now(),
        });
      }
      return snapshot;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('old-callback-after-last-select', { status: 200 }));
    const data = { status: 6, key: cfg.config.document.key, url: 'https://im.example.com/onlyoffice/cache/post-wal-toctou.docx' };
    const out = await app.request(cb.pathname + cb.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, token: signJwt(data, 'onlyoffice-jwt-secret-key-test!!', 300) }),
    });
    expect(injected).toBeGreaterThan(0);
    expect.soft(out.status, 'old expected-version callback must not retain write permission after another PG writer wins').toBe(409);
    expect.soft(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString(), 'a last SELECT without an owner cannot allow older callback bytes to overwrite the winner').toBe(newer);
  });

  it('audit-r13: config during an owner-written but unacknowledged save must not release the live claim to another writer', async () => {
    const get = () => app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', { headers: { Authorization: bearer('owner-1') } });
    const res = await get();
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const mapKey = 'srv-1:/team/shared/spec.docx';
    const row = { ...store.rooms.get(mapKey)! };
    let transactions = 0;
    (store.db as any).transaction = async (fn: any) => {
      transactions++;
      return fn(store.db);
    };
    const bytes = 'owner-a-new-bytes-written-before-ack';
    const base = {
      serverId: 'srv-1',
      normalizedPath: '/team/shared/spec.docx',
      expectedKey: cfg.config.document.key,
      expectedEpoch: row.session_epoch,
      expectedSeq: row.commit_seq,
    };
    const claimed = await claimOnlyOfficeCommitOwner(store.db, {
      ...base,
      targetHash: sha256Hex(bytes),
      ownerToken: 'claim_owner_a',
    });
    expect(claimed.ok).toBe(true);
    expect(transactions).toBeGreaterThan(0);
    // Exact intermediate state after the owner's atomic file rename, before its ACK / PG final commit.
    virtualFiles.set('/team/shared/spec.docx', { content: Buffer.from(bytes).toString('base64'), encoding: 'base64', mtime: Date.now() });
    const config = await get();
    expect(config.status).toBe(200);
    expect.soft(store.commitJournals.get(mapKey)?.owner_token, 'a reader must not delete an unexpired live owner while the write awaits acknowledgment').toBe('claim_owner_a');
    const second = await claimOnlyOfficeCommitOwner(store.db, {
      ...base,
      targetHash: sha256Hex('competing-writer'),
      ownerToken: 'claim_owner_b',
    });
    expect.soft(second.ok, 'second writer must be denied while the first owner is active').toBe(false);
  });

  it('audit-r13: room commit must reject a different owner even when expected epoch and sequence match', async () => {
    const res = await app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', { headers: { Authorization: bearer('owner-1') } });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as any;
    const mapKey = 'srv-1:/team/shared/spec.docx';
    const row = { ...store.rooms.get(mapKey)! };
    (store.db as any).transaction = async (fn: any) => fn(store.db);
    const base = {
      serverId: 'srv-1',
      normalizedPath: '/team/shared/spec.docx',
      expectedKey: cfg.config.document.key,
      expectedEpoch: row.session_epoch,
      expectedSeq: row.commit_seq,
    };
    expect((await claimOnlyOfficeCommitOwner(store.db, { ...base, targetHash: sha256Hex('legitimate-owner-content'), ownerToken: 'claim_legitimate_owner' })).ok).toBe(true);
    const out = await commitOnlyOfficeRoom(store.db, {
      serverId: base.serverId,
      normalizedPath: base.normalizedPath,
      ownerToken: 'claim_lost_or_wrong_owner',
      expectedSeq: row.commit_seq,
      expectedEpoch: row.session_epoch,
      newState: {
        currentConfirmedHash: sha256Hex('stale-owner-content'),
        committedHash: sha256Hex('stale-owner-content'),
        lastForceSavedHash: sha256Hex('stale-owner-content'),
        activeKey: row.active_key,
        sessionEpoch: row.session_epoch,
        commitSeq: row.commit_seq + 1,
        active: true,
        updatedAt: Date.now(),
      },
    });
    expect.soft(out.ok, 'ownerToken must guard the UPDATE itself, not merely qualify the later journal DELETE').toBe(false);
    expect.soft(store.rooms.get(mapKey)!.commit_seq, 'wrong owner must not publish a new authoritative sequence').toBe(row.commit_seq);
    expect.soft(store.commitJournals.get(mapKey)?.owner_token).toBe('claim_legitimate_owner');
  });

  it('audit-r14: expired WAL recovery of a written final save must close the old room and reject its stale callback', async () => {
    const get = () => app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', { headers: { Authorization: bearer('owner-1') } });
    const first = await get(); expect(first.status).toBe(200); const cfg = await first.json() as any;
    const key = cfg.config.document.key; const cb = new URL(cfg.config.editorConfig.callbackUrl); const mapKey = 'srv-1:/team/shared/spec.docx';
    const before = { ...store.rooms.get(mapKey)! };
    const execute = store.db.execute.bind(store.db); let failed = 0;
    const writeFault = vi.spyOn(store.db, 'execute').mockImplementation(async (sql, params) => {
      if (sql.replace(/\s+/g, ' ').startsWith('UPDATE onlyoffice_rooms SET') && failed++ === 0) throw new Error('audit PG commit failure AFTER final file rename');
      return execute(sql, params);
    });
    const finalBytes = 'terminal-status-2-bytes-already-written';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(finalBytes, { status: 200 }));
    const send = (status: number) => {
      const payload = { status, key, url: 'https://im.example.com/onlyoffice/cache/final-wal-recovery.docx' };
      return app.request(cb.pathname + cb.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, token: signJwt(payload, 'onlyoffice-jwt-secret-key-test!!', 300) }) });
    };
    const broken = await send(2); expect(broken.status).toBe(500); expect(failed).toBeGreaterThan(0);
    expect(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString()).toBe(finalBytes);
    expect(store.commitJournals.has(mapKey), 'write-ahead final-save intent must survive the failed PG room commit').toBe(true);
    writeFault.mockRestore();
    resetOnlyOfficeDocumentKeyCacheForTests();
    const later = Date.now() + 31_000; vi.spyOn(Date, 'now').mockReturnValue(later);
    const recovered = await get(); expect(recovered.status).toBe(200); const next = await recovered.json() as any;
    expect.soft(next.config.document.key, 'recovery must finish status-2 room closure, not silently convert it to force-save on the old key').not.toBe(key);
    expect.soft(store.rooms.get(mapKey)!.session_epoch, 'terminal intent recovery must advance session epoch').toBeGreaterThan(before.session_epoch);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('stale-old-room-callback-bytes', { status: 200 }));
    const stale = await send(6);
    expect.soft(stale.status, 'the old closed room must not regain write permission after PG crash recovery').toBe(409);
    expect.soft(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString(), 'final written bytes must survive a delayed callback from the recovered closed room').toBe(finalBytes);
  });

  it('audit-r14: force-save crash recovery advances seq without changing room key and is idempotent', async () => {
    const get = () => app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', { headers: { Authorization: bearer('owner-1') } });
    const first = await get(); expect(first.status).toBe(200); const cfg = await first.json() as any;
    const key = cfg.config.document.key; const cb = new URL(cfg.config.editorConfig.callbackUrl); const mapKey = 'srv-1:/team/shared/spec.docx';
    const before = { ...store.rooms.get(mapKey)! };
    const execute = store.db.execute.bind(store.db); let failed = 0;
    const writeFault = vi.spyOn(store.db, 'execute').mockImplementation(async (sql, params) => {
      if (sql.replace(/\s+/g, ' ').startsWith('UPDATE onlyoffice_rooms SET') && failed++ === 0) throw new Error('audit PG commit failure AFTER force-save rename');
      return execute(sql, params);
    });
    const forceBytes = 'force-save-status-6-bytes-written';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(forceBytes, { status: 200 }));
    const send = (status: number) => {
      const payload = { status, key, url: 'https://im.example.com/onlyoffice/cache/force-save-recovery.docx' };
      return app.request(cb.pathname + cb.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, token: signJwt(payload, 'onlyoffice-jwt-secret-key-test!!', 300) }) });
    };
    const broken = await send(6); expect(broken.status).toBe(500); expect(failed).toBeGreaterThan(0);
    expect(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString()).toBe(forceBytes);
    expect(store.commitJournals.has(mapKey)).toBe(true);
    writeFault.mockRestore();
    resetOnlyOfficeDocumentKeyCacheForTests();
    const later = Date.now() + 31_000; vi.spyOn(Date, 'now').mockReturnValue(later);
    const recovered = await get(); expect(recovered.status).toBe(200); const recJson = await recovered.json() as any;
    // Force save recovery preserves activeKey and sessionEpoch, but increments commitSeq
    expect.soft(recJson.config.document.key).toBe(key);
    expect.soft(store.rooms.get(mapKey)!.session_epoch).toBe(before.session_epoch);
    expect.soft(store.rooms.get(mapKey)!.commit_seq).toBe(before.commit_seq + 1);
    expect.soft(store.commitJournals.has(mapKey)).toBe(false);

    // Repeat GET config: must be idempotent and not bump epoch or seq
    const second = await get(); expect(second.status).toBe(200); const secondJson = await second.json() as any;
    expect.soft(secondJson.config.document.key).toBe(key);
    expect.soft(store.rooms.get(mapKey)!.session_epoch).toBe(before.session_epoch);
    expect.soft(store.rooms.get(mapKey)!.commit_seq).toBe(before.commit_seq + 1);
  });

  it('audit-r15: recovery retry after room persistence succeeds but WAL cleanup fails must not apply the same intent twice', async () => {
    const get = () => app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', { headers: { Authorization: bearer('owner-1') } });
    const res = await get(); expect(res.status).toBe(200); const cfg = await res.json() as any; const cb = new URL(cfg.config.editorConfig.callbackUrl);
    const mapKey = 'srv-1:/team/shared/spec.docx'; const prior = { ...store.rooms.get(mapKey)! };
    const execute = store.db.execute.bind(store.db); let commitFaults = 0;
    const commitFault = vi.spyOn(store.db, 'execute').mockImplementation(async (sql, params) => {
      if (sql.replace(/\s+/g, ' ').startsWith('UPDATE onlyoffice_rooms SET') && commitFaults++ === 0) throw new Error('audit fail initial room commit after force-save binary write');
      return execute(sql, params);
    });
    const forceBytes = 'force-save-bytes-for-partial-recovery-retry';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(forceBytes, { status: 200 }));
    const payload = { status: 6, key: cfg.config.document.key, url: 'https://im.example.com/onlyoffice/cache/retry-recovery.docx' };
    const saved = await app.request(cb.pathname + cb.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, token: signJwt(payload, 'onlyoffice-jwt-secret-key-test!!', 300) }) });
    expect(saved.status).toBe(500); expect(commitFaults).toBeGreaterThan(0); expect(store.commitJournals.has(mapKey)).toBe(true);
    commitFault.mockRestore(); resetOnlyOfficeDocumentKeyCacheForTests();
    const now = Date.now() + 31_000; vi.spyOn(Date, 'now').mockReturnValue(now);
    let cleanupFaults = 0;
    const cleanupFault = vi.spyOn(store.db, 'execute').mockImplementation(async (sql, params) => {
      if (sql.replace(/\s+/g, ' ').startsWith('DELETE FROM onlyoffice_commit_journal') && cleanupFaults++ === 0) throw new Error('audit cleanup fails AFTER recovery room state is durably stored');
      return execute(sql, params);
    });
    const firstRecovery = await get(); expect(firstRecovery.status).toBe(500); expect(cleanupFaults).toBeGreaterThan(0);
    expect(store.rooms.get(mapKey)!.commit_seq).toBe(prior.commit_seq + 1);
    expect(store.commitJournals.has(mapKey)).toBe(true);
    cleanupFault.mockRestore(); resetOnlyOfficeDocumentKeyCacheForTests();
    const retried = await get(); expect(retried.status).toBe(200);
    expect.soft(store.rooms.get(mapKey)!.commit_seq, 'the same WAL intent already applied before cleanup failure must be consumed idempotently, not applied as another commit').toBe(prior.commit_seq + 1);
    expect.soft(store.commitJournals.has(mapKey)).toBe(false);
    expect.soft(Buffer.from(virtualFiles.get('/team/shared/spec.docx')!.content, 'base64').toString()).toBe(forceBytes);
  });

  it('audit-r16: obsolete WAL post-state cleanup must not hide a new external restore that matches an old intent target', async () => {
    const get = () => app.request('/api/server/srv-1/onlyoffice/config?path=%2Fteam%2Fshared%2Fspec.docx&mode=edit', { headers: { Authorization: bearer('owner-1') } });
    const res = await get(); expect(res.status).toBe(200); const cfg = await res.json() as any;
    const mapKey = 'srv-1:/team/shared/spec.docx'; const initial = { ...store.rooms.get(mapKey)! };
    const historicalTarget = 'historical-old-intent-target-A';
    expect((await claimOnlyOfficeCommitOwner(store.db, { serverId: 'srv-1', normalizedPath: '/team/shared/spec.docx', expectedKey: cfg.config.document.key, expectedEpoch: initial.session_epoch, expectedSeq: initial.commit_seq, targetHash: sha256Hex(historicalTarget), ownerToken: 'claim_old_intent_for_restore' })).ok).toBe(true);
    const later = Date.now() + 31_000; vi.spyOn(Date, 'now').mockReturnValue(later);
    // External B advances the authoritative room while one cleanup fault leaves the expired A intent.
    const newer = 'external-current-confirmed-version-B';
    virtualFiles.set('/team/shared/spec.docx', { content: Buffer.from(newer).toString('base64'), encoding: 'base64', mtime: later });
    const execute = store.db.execute.bind(store.db); let cleanupFaults = 0;
    const fault = vi.spyOn(store.db, 'execute').mockImplementation(async (sql, params) => {
      if (sql.replace(/\s+/g, ' ').startsWith('DELETE FROM onlyoffice_commit_journal') && cleanupFaults++ === 0) throw new Error('audit retain old expired intent after new external room is saved');
      return execute(sql, params);
    });
    const advanced = await get(); expect(advanced.status).toBe(500); expect(cleanupFaults).toBeGreaterThan(0);
    const confirmed = { ...store.rooms.get(mapKey)! }; expect(confirmed.current_confirmed_hash).toBe(sha256Hex(newer)); expect(store.commitJournals.has(mapKey)).toBe(true);
    fault.mockRestore(); resetOnlyOfficeDocumentKeyCacheForTests();
    // A is a fresh external disk change even though its bytes happen to match old WAL target A.
    virtualFiles.set('/team/shared/spec.docx', { content: Buffer.from(historicalTarget).toString('base64'), encoding: 'base64', mtime: later + 1 });
    const restored = await get(); expect(restored.status).toBe(200); const next = await restored.json() as any;
    expect.soft(next.config.document.key, 'obsolete post-state shortcut must not reuse version B room key for restored A bytes').not.toBe(confirmed.active_key);
    expect.soft(store.rooms.get(mapKey)!.current_confirmed_hash, 'PG authority must recognize restored A, not pretend disk still contains B').toBe(sha256Hex(historicalTarget));
    expect.soft(store.rooms.get(mapKey)!.session_epoch, 'external restore is a fresh version regardless of an obsolete target hash').toBeGreaterThan(confirmed.session_epoch);
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

describe('Document sharing: Controlled Node Groups (team:<teamId>) isolation, live membership & priority', () => {
  let store: ReturnType<typeof createInMemoryDb>;
  let app: ReturnType<typeof buildApp>;
  const bearer = (userId: string) =>
    `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}`;

  beforeEach(() => {
    store = createInMemoryDb();
    // Add users for Group A, Group B, inactive user, and private third-party Group C
    store.users.set('user-group-b', {
      id: 'user-group-b',
      username: 'dave',
      display_name: 'Dave GroupB',
      status: 'active',
      sessions_valid_after: 0,
      is_admin: false,
    });
    store.users.set('user-inactive', {
      id: 'user-inactive',
      username: 'eve',
      display_name: 'Eve Disabled',
      status: 'disabled',
      sessions_valid_after: 0,
      is_admin: false,
    });

    // Global groups:
    // team-1 ("Primary Team"): bound to srv-1 (owner-1, user-bob, user-carol)
    // team-global-b ("Design Group"): NOT bound to srv-1; owner-1 is only a 'member', user-group-b is 'owner', user-inactive is 'member'
    // team-private-c ("Private Third Party"): unrelated third-party group owned by user-stranger
    store.teams.set('team-global-b', { id: 'team-global-b', name: 'Design Group', owner_id: 'user-group-b' });
    store.teams.set('team-private-c', { id: 'team-private-c', name: 'Secret Third Party', owner_id: 'user-stranger' });
    store.machineGroups.add('srv-1:team-1');

    store.teamMembers.set('team-global-b:user-group-b', 'owner');
    store.teamMembers.set('team-global-b:owner-1', 'member');
    store.teamMembers.set('team-global-b:user-inactive', 'member');
    store.teamMembers.set('team-private-c:user-stranger', 'owner');

    WsBridge.getAll().clear();
    app = buildApp(makeEnv(store.db));
  });

  afterEach(() => {
    WsBridge.getAll().clear();
    vi.restoreAllMocks();
  });

  it('returns bound & caller-eligible global groups (with memberCount & boundToServer), hides private third-party teams, and enforces 403 on unauthorized teamId', async () => {
    // Unauthorized non-owner/non-admin user cannot list shares or groups
    const bobListRes = await app.request('/api/server/srv-1/doc-shares', {
      headers: { Authorization: bearer('user-bob') },
    });
    expect(bobListRes.status).toBe(403);

    // Owner sees deduped bound group (team-1) + caller's unbound global group (team-global-b), never team-private-c
    const listRes = await app.request('/api/server/srv-1/doc-shares', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      shares: unknown[];
      groups: Array<{ id: string; name: string; memberCount: number; boundToServer: boolean }>;
    };
    expect(listBody.groups.map((g) => g.id)).toEqual(['team-1', 'team-global-b']);
    const team1 = listBody.groups.find((g) => g.id === 'team-1')!;
    const groupB = listBody.groups.find((g) => g.id === 'team-global-b')!;
    expect(team1).toEqual({ id: 'team-1', name: 'Primary Team', memberCount: 3, boundToServer: true });
    // Active members only: user-group-b + owner-1 = 2 (user-inactive disabled excluded)
    expect(groupB).toEqual({ id: 'team-global-b', name: 'Design Group', memberCount: 2, boundToServer: false });

    // Third-party private teamId and unknown teamId both return identical 403 without leaking team existence or name
    const privateCreate = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/a.docx',
        shareMode: 'team',
        targetTeamId: 'team-private-c',
        role: 'viewer',
      }),
    });
    const missingCreate = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/a.docx',
        shareMode: 'team',
        targetTeamId: 'team-nonexistent',
        role: 'viewer',
      }),
    });
    expect(privateCreate.status).toBe(403);
    expect(missingCreate.status).toBe(403);
    const privateBody = await privateCreate.json();
    const missingBody = await missingCreate.json();
    expect(privateBody).toEqual({ error: 'target_team_forbidden' });
    expect(missingBody).toEqual({ error: 'target_team_forbidden' });
    expect(JSON.stringify(privateBody)).not.toContain('Secret Third Party');
  });

  it('isolates Group A vs Group B shares, enforces live team_members + active status, allows independent PATCH/DELETE, and preserves legacy * compat', async () => {
    // 1. Share /docs/spec.docx to Group A (team-1) as viewer, and separately to unbound global Group B (team-global-b) as editor
    const resA = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/spec.docx',
        shareMode: 'team',
        targetTeamId: 'team-1',
        role: 'viewer',
        allowDownload: false,
      }),
    });
    expect(resA.status).toBe(201);
    const bodyA = (await resA.json()) as { share: { id: string; targetUserId: string; targetTeamId: string; targetTeamName: string } };
    expect(bodyA.share.targetUserId).toBe('team:team-1');
    expect(bodyA.share.targetTeamId).toBe('team-1');
    expect(bodyA.share.targetTeamName).toBe('Primary Team');

    // Share /docs/only-a.docx ONLY with team-1
    const resOnlyA = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/only-a.docx',
        shareMode: 'team',
        targetTeamId: 'team-1',
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(resOnlyA.status).toBe(201);

    // 2. Group B user-group-b can access neither /docs/only-a.docx nor /docs/spec.docx yet
    expect(
      (await resolveEffectiveDocumentAccess(store.db, { serverId: 'srv-1', filePath: '/docs/only-a.docx', userId: 'user-group-b' })).allowed,
    ).toBe(false);
    expect(
      (await resolveEffectiveDocumentAccess(store.db, { serverId: 'srv-1', filePath: '/docs/spec.docx', userId: 'user-group-b' })).allowed,
    ).toBe(false);

    // 3. Grant unbound global Group B editor on /docs/spec.docx
    const resB = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/spec.docx',
        shareMode: 'team',
        targetTeamId: 'team-global-b',
        role: 'editor',
        allowDownload: true,
      }),
    });
    expect(resB.status).toBe(201);
    const bodyB = (await resB.json()) as { share: { id: string; targetTeamId: string; targetTeamName: string } };
    expect(bodyB.share.targetTeamId).toBe('team-global-b');
    expect(bodyB.share.targetTeamName).toBe('Design Group');

    // Group B user now gets editor on /docs/spec.docx, still denied on /docs/only-a.docx
    const accessSpecB = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/docs/spec.docx',
      userId: 'user-group-b',
    });
    expect(accessSpecB.allowed).toBe(true);
    expect(accessSpecB.role).toBe('editor');
    expect(accessSpecB.allowDownload).toBe(true);
    expect(
      (await resolveEffectiveDocumentAccess(store.db, { serverId: 'srv-1', filePath: '/docs/only-a.docx', userId: 'user-group-b' })).allowed,
    ).toBe(false);

    // Inactive member in Group B is denied immediately
    const accessInactive = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/docs/spec.docx',
      userId: 'user-inactive',
    });
    expect(accessInactive.allowed).toBe(false);
    expect(accessInactive.reason).toBe('user_inactive');

    // Group A user (user-bob) sees only team-1 shares with targetTeamName populated in shared-with-me
    const bobSharedRes = await app.request('/api/doc-shares/shared-with-me', {
      headers: { Authorization: bearer('user-bob') },
    });
    expect(bobSharedRes.status).toBe(200);
    const bobSharedBody = (await bobSharedRes.json()) as {
      shares: Array<{ id: string; targetPath: string; targetTeamId?: string | null; targetTeamName?: string | null }>;
    };
    expect(bobSharedBody.shares.map((s) => s.targetPath).sort()).toEqual(['/docs/only-a.docx', '/docs/spec.docx']);
    expect(bobSharedBody.shares.every((s) => s.targetTeamId === 'team-1' && s.targetTeamName === 'Primary Team')).toBe(true);

    // Live team_members removal: removing user-bob from team-1 revokes access & shared-with-me immediately
    store.teamMembers.delete('team-1:user-bob');
    expect(
      (await resolveEffectiveDocumentAccess(store.db, { serverId: 'srv-1', filePath: '/docs/only-a.docx', userId: 'user-bob' })).allowed,
    ).toBe(false);
    const bobAfterRemove = await app.request('/api/doc-shares/shared-with-me', {
      headers: { Authorization: bearer('user-bob') },
    });
    const bobAfterBody = (await bobAfterRemove.json()) as { shares: unknown[] };
    expect(bobAfterBody.shares).toHaveLength(0);

    // Re-adding user-bob immediately restores access
    store.teamMembers.set('team-1:user-bob', 'member');
    expect(
      (await resolveEffectiveDocumentAccess(store.db, { serverId: 'srv-1', filePath: '/docs/only-a.docx', userId: 'user-bob' })).allowed,
    ).toBe(true);

    // Independent PATCH & DELETE on Group B rule does not alter Group A rule
    const patchB = await app.request(`/api/server/srv-1/doc-shares/${bodyB.share.id}`, {
      method: 'PATCH',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer', allowDownload: false }),
    });
    expect(patchB.status).toBe(200);
    const accessSpecBAfterPatch = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/docs/spec.docx',
      userId: 'user-group-b',
    });
    expect(accessSpecBAfterPatch.role).toBe('viewer');
    expect(accessSpecBAfterPatch.allowDownload).toBe(false);

    const delB = await app.request(`/api/server/srv-1/doc-shares/${bodyB.share.id}`, {
      method: 'DELETE',
      headers: { Authorization: bearer('owner-1') },
    });
    expect(delB.status).toBe(200);
    expect(
      (await resolveEffectiveDocumentAccess(store.db, { serverId: 'srv-1', filePath: '/docs/spec.docx', userId: 'user-group-b' })).allowed,
    ).toBe(false);
    // Group A still holds /docs/spec.docx viewer access
    const accessSpecA = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/docs/spec.docx',
      userId: 'user-bob',
    });
    expect(accessSpecA.allowed).toBe(true);
    expect(accessSpecA.role).toBe('viewer');
  });

  it('preserves precedence: exact file > deeper folder > shallower folder AND specific user > team:<id> > legacy *', async () => {
    const baseNow = 1700000000000;
    // Legacy wildcard '*' on /repo (editor, allowDownload: true)
    await createDocumentShare(store.db, {
      serverId: 'srv-1',
      targetKind: 'folder',
      targetPath: '/repo',
      shareMode: 'team',
      role: 'editor',
      allowDownload: true,
      createdBy: 'owner-1',
      now: baseNow,
    });
    // Group share team:team-1 on shallower /repo (viewer, allowDownload: false) -> beats '*' at same folder depth!
    await createDocumentShare(store.db, {
      serverId: 'srv-1',
      targetKind: 'folder',
      targetPath: '/repo',
      shareMode: 'team',
      targetTeamId: 'team-1',
      role: 'viewer',
      allowDownload: false,
      createdBy: 'owner-1',
      now: baseNow + 1,
    });
    const atShallow = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/repo/readme.docx',
      userId: 'user-bob',
    });
    expect(atShallow.allowed).toBe(true);
    expect(atShallow.role).toBe('viewer');
    expect(atShallow.allowDownload).toBe(false);

    // Deeper folder /repo/sub for team-1 (editor, allowDownload: true) beats shallower /repo
    await createDocumentShare(store.db, {
      serverId: 'srv-1',
      targetKind: 'folder',
      targetPath: '/repo/sub',
      shareMode: 'team',
      targetTeamId: 'team-1',
      role: 'editor',
      allowDownload: true,
      createdBy: 'owner-1',
      now: baseNow + 2,
    });
    const atDeep = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/repo/sub/plan.docx',
      userId: 'user-bob',
    });
    expect(atDeep.role).toBe('editor');
    expect(atDeep.allowDownload).toBe(true);

    // Exact file override for team-1 (viewer, allowDownload: false) beats deeper folder
    await createDocumentShare(store.db, {
      serverId: 'srv-1',
      targetKind: 'file',
      targetPath: '/repo/sub/plan.docx',
      shareMode: 'team',
      targetTeamId: 'team-1',
      role: 'viewer',
      allowDownload: false,
      createdBy: 'owner-1',
      now: baseNow + 3,
    });
    const atExactFileGroup = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/repo/sub/plan.docx',
      userId: 'user-bob',
    });
    expect(atExactFileGroup.role).toBe('viewer');
    expect(atExactFileGroup.allowDownload).toBe(false);

    // Specific user override on /repo/sub/plan.docx beats group rule on exact file
    await createDocumentShare(store.db, {
      serverId: 'srv-1',
      targetKind: 'file',
      targetPath: '/repo/sub/plan.docx',
      shareMode: 'user',
      targetUserId: 'user-bob',
      role: 'editor',
      allowDownload: true,
      createdBy: 'owner-1',
      now: baseNow + 4,
    });
    const atExactFileUser = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/repo/sub/plan.docx',
      userId: 'user-bob',
    });
    expect(atExactFileUser.role).toBe('editor');
    expect(atExactFileUser.allowDownload).toBe(true);
    // Another member of team-1 (user-carol) still gets the group viewer rule
    const atExactFileCarol = await resolveEffectiveDocumentAccess(store.db, {
      serverId: 'srv-1',
      filePath: '/repo/sub/plan.docx',
      userId: 'user-carol',
    });
    expect(atExactFileCarol.role).toBe('viewer');
    expect(atExactFileCarol.allowDownload).toBe(false);
  });

  it('F1 counterexamples: hides bound foreign-private teams (machine_groups and legacy servers.team_id), rejects POST 403 including team:<id> alias, preserves historical shares without leaking name, and rejects mismatched targetTeamId/targetUserId', async () => {
    // Bind srv-1 to third-party foreign-private team via machine_groups
    store.machineGroups.add('srv-1:team-private-c');
    // Also add legacy server owned by owner-1 whose legacy servers.team_id points to foreign-private team
    store.servers.set('srv-legacy', {
      id: 'srv-legacy',
      user_id: 'owner-1',
      team_id: 'team-private-c',
      name: 'Legacy Server',
    });

    // Historical share referencing team-private-c already exists in DB (e.g. from before owner-1 was removed from that group)
    store.shares.set('hist-foreign-1', {
      id: 'hist-foreign-1',
      server_id: 'srv-1',
      target_kind: 'file',
      target_path: '/docs/legacy-shared.docx',
      label: null,
      share_mode: 'team',
      target_user_id: 'team:team-private-c',
      participant_label: null,
      share_token_hash: null,
      access_code_hash: null,
      device_lock_enabled: false,
      bound_device_hash: null,
      redeemed_by_user_id: null,
      redeemed_at: null,
      role: 'viewer',
      allow_download: true,
      created_by: 'owner-1',
      created_at: 1700000000100,
      updated_at: 1700000000100,
      expires_at: null,
      revoked_at: null,
    });

    // Removable group that owner-1 initially belongs to, creates a share for, then gets removed from
    store.teams.set('team-removable', { id: 'team-removable', name: 'Removable Bound Group', owner_id: 'user-stranger' });
    store.teamMembers.set('team-removable:user-stranger', 'owner');
    store.teamMembers.set('team-removable:owner-1', 'member');
    store.machineGroups.add('srv-1:team-removable');

    const createRemovableRes = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/removable.docx',
        shareMode: 'team',
        targetTeamId: 'team-removable',
        role: 'viewer',
      }),
    });
    expect(createRemovableRes.status).toBe(201);

    // Now remove owner-1 from team-removable while owner-1 remains owner of srv-1
    store.teamMembers.delete('team-removable:owner-1');

    // GET on srv-1: must omit BOTH team-private-c and team-removable from groups, must NOT leak either team name,
    // and must preserve both existing shares with targetTeamName: null
    const getSrv1 = await app.request('/api/server/srv-1/doc-shares', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(getSrv1.status).toBe(200);
    const bodySrv1Text = await getSrv1.text();
    expect(bodySrv1Text).not.toContain('Secret Third Party');
    expect(bodySrv1Text).not.toContain('Removable Bound Group');
    const bodySrv1 = JSON.parse(bodySrv1Text) as {
      groups: Array<{ id: string; name: string; boundToServer: boolean }>;
      shares: Array<{ id: string; targetTeamId?: string | null; targetTeamName?: string | null }>;
    };
    expect(bodySrv1.groups.map((g) => g.id)).toEqual(['team-1', 'team-global-b']);
    const histShare = bodySrv1.shares.find((s) => s.id === 'hist-foreign-1');
    const remShare = bodySrv1.shares.find((s) => s.targetTeamId === 'team-removable');
    expect(histShare).toBeDefined();
    expect(histShare?.targetTeamName).toBeNull();
    expect(remShare).toBeDefined();
    expect(remShare?.targetTeamName).toBeNull();
    expect(store.shares.has('hist-foreign-1')).toBe(true);

    // GET on legacy server (servers.team_id = team-private-c): must not include team-private-c or leak its name
    const getLegacy = await app.request('/api/server/srv-legacy/doc-shares', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(getLegacy.status).toBe(200);
    const bodyLegacyText = await getLegacy.text();
    expect(bodyLegacyText).not.toContain('Secret Third Party');
    const bodyLegacy = JSON.parse(bodyLegacyText) as {
      groups: Array<{ id: string; boundToServer: boolean }>;
    };
    expect(bodyLegacy.groups.map((g) => g.id)).toEqual(['team-global-b', 'team-1']);
    expect(bodyLegacy.groups.every((g) => g.boundToServer === false)).toBe(true);

    // POST attempts to bound foreign-private / removed team (via targetTeamId OR targetUserId: 'team:<id>') must return 403 target_team_forbidden
    for (const [serverPath, payload] of [
      ['/api/server/srv-1/doc-shares', { targetTeamId: 'team-private-c' }],
      ['/api/server/srv-1/doc-shares', { targetUserId: 'team:team-private-c' }],
      ['/api/server/srv-1/doc-shares', { targetTeamId: 'team-removable' }],
      ['/api/server/srv-legacy/doc-shares', { targetTeamId: 'team-private-c' }],
      ['/api/server/srv-legacy/doc-shares', { targetUserId: 'team:team-private-c' }],
    ] as const) {
      const forbiddenRes = await app.request(serverPath, {
        method: 'POST',
        headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetKind: 'file',
          targetPath: '/docs/blocked.docx',
          shareMode: 'team',
          role: 'viewer',
          ...payload,
        }),
      });
      expect(forbiddenRes.status).toBe(403);
      expect(await forbiddenRes.json()).toEqual({ error: 'target_team_forbidden' });
    }

    // Mismatched targetTeamId vs targetUserId: 'team:<other>' is rejected with 400 invalid_target_team
    const mismatchRes = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/mismatch.docx',
        shareMode: 'team',
        targetTeamId: 'team-1',
        targetUserId: 'team:team-global-b',
        role: 'viewer',
      }),
    });
    expect(mismatchRes.status).toBe(400);
    expect(await mismatchRes.json()).toEqual({ error: 'invalid_target_team' });

    // Admin via Group A (team-1) cannot inspect or grant shares to foreign-private Group B bound on the same server
    store.users.set('user-admin-a', {
      id: 'user-admin-a',
      username: 'admin-a',
      display_name: 'Admin A',
      status: 'active',
      sessions_valid_after: 0,
      is_admin: false,
    });
    store.teamMembers.set('team-1:user-admin-a', 'admin');
    const adminGet = await app.request('/api/server/srv-1/doc-shares', {
      headers: { Authorization: bearer('user-admin-a') },
    });
    expect(adminGet.status).toBe(200);
    const adminGetText = await adminGet.text();
    expect(adminGetText).not.toContain('Secret Third Party');
    const adminBody = JSON.parse(adminGetText) as { groups: Array<{ id: string }> };
    expect(adminBody.groups.map((g) => g.id)).toEqual(['team-1']);

    const adminPostForeign = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('user-admin-a'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/admin-blocked.docx',
        shareMode: 'team',
        targetTeamId: 'team-private-c',
        role: 'viewer',
      }),
    });
    expect(adminPostForeign.status).toBe(403);
    expect(await adminPostForeign.json()).toEqual({ error: 'target_team_forbidden' });

    // Plain 'member' of unbound global group (owner-1 is member of team-global-b) sees boundToServer=false and succeeds 201
    const unboundCreate = await app.request('/api/server/srv-1/doc-shares', {
      method: 'POST',
      headers: { Authorization: bearer('owner-1'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'file',
        targetPath: '/docs/unbound-ok.docx',
        shareMode: 'team',
        targetTeamId: 'team-global-b',
        role: 'viewer',
      }),
    });
    expect(unboundCreate.status).toBe(201);
  });
});

describe('GET /api/onlyoffice/status', () => {
  const bearer = (userId: string) =>
    `Bearer ${signJwt({ sub: userId, role: 'member' }, JWT_KEY, 3600)}`;

  it('requires authentication and rejects anonymous callers with 401', async () => {
    const store = createInMemoryDb();
    const app = buildApp(makeEnv(store.db));
    const res = await app.request('/api/onlyoffice/status');
    expect(res.status).toBe(401);
  });

  it('returns enabled:false without publicUrl/scriptUrl or secrets when ONLYOFFICE is disabled', async () => {
    const store = createInMemoryDb();
    const app = buildApp(makeEnv(store.db, {
      ONLYOFFICE_ENABLED: 'false',
      ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com/onlyoffice',
      ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice-secret:80',
      ONLYOFFICE_JWT_SECRET: 'super-secret-jwt',
    }));
    const res = await app.request('/api/onlyoffice/status', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: false });
    expect(JSON.stringify(body)).not.toContain('onlyoffice-secret');
    expect(JSON.stringify(body)).not.toContain('super-secret-jwt');
  });

  it('returns derived publicUrl and scriptUrl from SERVER_URL by default without internal secrets', async () => {
    const store = createInMemoryDb();
    const app = buildApp(makeEnv(store.db, {
      ONLYOFFICE_ENABLED: 'true',
      SERVER_URL: 'https://im.example.com/',
      ONLYOFFICE_PUBLIC_URL: '',
      ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice-internal:80',
      ONLYOFFICE_JWT_SECRET: 'super-secret-jwt',
    }));
    const res = await app.request('/api/onlyoffice/status', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      publicUrl: 'https://im.example.com/onlyoffice',
      scriptUrl: 'https://im.example.com/onlyoffice/web-apps/apps/api/documents/api.js',
    });
    expect(JSON.stringify(body)).not.toContain('onlyoffice-internal');
    expect(JSON.stringify(body)).not.toContain('super-secret-jwt');
  });

  it('honors custom ONLYOFFICE_PUBLIC_URL when configured', async () => {
    const store = createInMemoryDb();
    const app = buildApp(makeEnv(store.db, {
      ONLYOFFICE_ENABLED: 'true',
      SERVER_URL: 'https://im.example.com',
      ONLYOFFICE_PUBLIC_URL: 'https://cdn-docs.example.com/ds/',
    }));
    const res = await app.request('/api/onlyoffice/status', {
      headers: { Authorization: bearer('owner-1') },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      publicUrl: 'https://cdn-docs.example.com/ds',
      scriptUrl: 'https://cdn-docs.example.com/ds/web-apps/apps/api/documents/api.js',
    });
  });
});
