import path from 'node:path';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { Database } from './client.js';
import { randomHex, sha256Hex } from '../security/crypto.js';
import { resolveServerMembershipRole } from '../security/authorization.js';
import { USER_STATUS, isUserStatusActive } from '../../../shared/user-status.js';

/**
 * Tracks `(shareId, accessCodeHash, deviceTokenHash) -> expiresAt` for external links
 * that have passed mandatory PIN verification (`verifyAndBindExternalShareDevice`),
 * ensuring PIN-protected links cannot be bypassed even when `device_lock_enabled` is false.
 */
const verifiedExternalPinTokens = new Map<string, number>();

function makeVerifiedPinKey(shareId: string, accessCodeHash: string, deviceTokenHash: string): string {
  return `${shareId}:${accessCodeHash}:${deviceTokenHash}`;
}

export function recordVerifiedExternalSharePin(
  shareId: string,
  accessCodeHash: string,
  deviceToken: string,
  ttlMs = 30 * 24 * 3600 * 1000,
): void {
  const tokenHash = sha256Hex(deviceToken.trim());
  verifiedExternalPinTokens.set(
    makeVerifiedPinKey(shareId, accessCodeHash, tokenHash),
    Date.now() + ttlMs,
  );
}

export function hasVerifiedExternalSharePin(
  shareId: string,
  accessCodeHash: string,
  deviceToken: string | null | undefined,
  now = Date.now(),
): boolean {
  const trimmed = deviceToken?.trim() ?? '';
  if (!trimmed) return false;
  // Also support self-verifying dpin_ tokens minted by verifyAndBindExternalShareDevice
  if (trimmed.startsWith('dpin_')) {
    const dot = trimmed.indexOf('.');
    if (dot > 5) {
      const nonce = trimmed.slice(5, dot);
      const sig = trimmed.slice(dot + 1);
      if (sig === sha256Hex(`doc-pin-proof:v1:${shareId}:${accessCodeHash}:${nonce}`)) {
        return true;
      }
    }
  }
  const key = makeVerifiedPinKey(shareId, accessCodeHash, sha256Hex(trimmed));
  const exp = verifiedExternalPinTokens.get(key);
  if (!exp) return false;
  if (exp <= now) {
    verifiedExternalPinTokens.delete(key);
    return false;
  }
  return true;
}

export function clearVerifiedExternalSharePinsForTests(): void {
  verifiedExternalPinTokens.clear();
}

/**
 * Checks whether `userId` is a member of the team associated with `serverId`
 * (or the server's owner/admin/member via `machine_groups` or `servers.team_id`).
 * Used to restrict `target_user_id = '*'` (team-wide shares) to genuine members
 * of that server's team rather than arbitrary active accounts on the site.
 */
export async function isUserInServerTeam(
  db: Database,
  serverId: string,
  userId: string,
): Promise<boolean> {
  const memberRole = await resolveServerMembershipRole(db, serverId, userId);
  return memberRole !== 'none';
}

export type DocumentShareTargetKind = 'file' | 'folder';
export type DocumentShareMode = 'user' | 'team' | 'external_link' | 'magic_invite';
export type DocumentShareRole = 'viewer' | 'editor';

export interface DocumentShareRow {
  id: string;
  serverId: string;
  targetKind: DocumentShareTargetKind;
  targetPath: string;
  label: string | null;
  shareMode: DocumentShareMode;
  targetUserId: string;
  targetUsername?: string | null;
  targetDisplayName?: string | null;
  participantLabel: string | null;
  shareTokenHash: string | null;
  hasAccessCode: boolean;
  deviceLockEnabled: boolean;
  boundDeviceHash: string | null;
  isDeviceBound: boolean;
  redeemedByUserId: string | null;
  redeemedAt: number | null;
  role: DocumentShareRole;
  allowDownload: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface DbDocumentShareRow {
  id: string;
  server_id: string;
  target_kind: DocumentShareTargetKind;
  target_path: string;
  label: string | null;
  share_mode: DocumentShareMode;
  target_user_id: string;
  target_username?: string | null;
  target_display_name?: string | null;
  participant_label: string | null;
  share_token_hash: string | null;
  access_code_hash: string | null;
  device_lock_enabled: boolean;
  bound_device_hash: string | null;
  redeemed_by_user_id: string | null;
  redeemed_at: number | null | string;
  role: DocumentShareRole;
  allow_download: boolean;
  created_by: string;
  created_at: number | string;
  updated_at: number | string;
  expires_at: number | null | string;
  revoked_at: number | null | string;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapDbRow(row: DbDocumentShareRow): DocumentShareRow {
  return {
    id: row.id,
    serverId: row.server_id,
    targetKind: row.target_kind,
    targetPath: row.target_path,
    label: row.label,
    shareMode: row.share_mode,
    targetUserId: row.target_user_id,
    targetUsername: row.target_username ?? null,
    targetDisplayName: row.target_display_name ?? null,
    participantLabel: row.participant_label,
    shareTokenHash: row.share_token_hash,
    hasAccessCode: Boolean(row.access_code_hash),
    deviceLockEnabled: Boolean(row.device_lock_enabled),
    boundDeviceHash: row.bound_device_hash,
    isDeviceBound: Boolean(row.bound_device_hash),
    redeemedByUserId: row.redeemed_by_user_id,
    redeemedAt: toNum(row.redeemed_at),
    role: row.role,
    allowDownload: Boolean(row.allow_download),
    createdBy: row.created_by,
    createdAt: toNum(row.created_at) ?? 0,
    updatedAt: toNum(row.updated_at) ?? 0,
    expiresAt: toNum(row.expires_at),
    revokedAt: toNum(row.revoked_at),
  };
}

/**
 * Normalize and validate a POSIX document/folder path.
 * Rejects non-absolute paths, null bytes, or any `..` traversal segment.
 */
export function normalizeDocumentSharePath(rawPath: string): string | null {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return null;
  if (!trimmed.startsWith('/')) return null;

  const rawSegments = trimmed.split('/');
  if (rawSegments.some((seg) => seg === '..')) return null;

  const normalized = path.posix.normalize(trimmed);
  if (!normalized.startsWith('/') || normalized.includes('..')) return null;

  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Strictly checks whether `filePath` is equal to `folderPath` or inside `folderPath/`.
 * Prevents prefix collisions like `/team/doc` matching `/team/doc-secret`.
 */
export function isPathWithinSharedFolder(filePath: string, folderPath: string): boolean {
  const normFile = normalizeDocumentSharePath(filePath);
  const normFolder = normalizeDocumentSharePath(folderPath);
  if (!normFile || !normFolder) return false;
  if (normFile === normFolder) return true;
  const prefix = normFolder.endsWith('/') ? normFolder : `${normFolder}/`;
  return normFile.startsWith(prefix);
}

export function isActiveDocumentShare(
  row: { revokedAt?: number | null; expiresAt?: number | null },
  now = Date.now(),
): boolean {
  if (row.revokedAt !== null && row.revokedAt !== undefined) return false;
  if (row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt <= now) return false;
  return true;
}

export interface CreateDocumentShareInput {
  serverId: string;
  targetKind: DocumentShareTargetKind;
  targetPath: string;
  label?: string | null;
  shareMode: DocumentShareMode;
  /** Required for `user` mode; ignored for `team` (`*`), `external_link`, and `magic_invite`. */
  targetUserId?: string;
  participantLabel?: string | null;
  accessCode?: string | null;
  deviceLockEnabled?: boolean;
  role: DocumentShareRole;
  allowDownload?: boolean;
  createdBy: string;
  expiresAt?: number | null;
  now?: number;
}

export interface CreateDocumentShareResult {
  share: DocumentShareRow;
  /** Raw token returned only at creation time for `external_link` and `magic_invite`. */
  rawShareToken: string | null;
}

export async function createDocumentShare(
  db: Database,
  input: CreateDocumentShareInput,
): Promise<CreateDocumentShareResult> {
  const normPath = normalizeDocumentSharePath(input.targetPath);
  if (!normPath) {
    throw new Error('invalid_target_path');
  }
  const now = input.now ?? Date.now();
  const id = `dsh_${randomHex(12)}`;
  const defaultLabel = path.posix.basename(normPath) || normPath;
  const label = input.label?.trim() || defaultLabel;
  const allowDownload = input.allowDownload ?? true;
  const deviceLockEnabled = Boolean(input.deviceLockEnabled);
  const accessCodeHash = input.accessCode?.trim() ? sha256Hex(input.accessCode.trim()) : null;

  let targetUserId: string;
  let rawShareToken: string | null = null;
  let shareTokenHash: string | null = null;

  if (input.shareMode === 'team') {
    targetUserId = '*';
  } else if (input.shareMode === 'user') {
    const uid = input.targetUserId?.trim();
    if (!uid || uid === '*') throw new Error('invalid_target_user');
    targetUserId = uid;
  } else if (input.shareMode === 'external_link' || input.shareMode === 'magic_invite') {
    rawShareToken = randomHex(24);
    shareTokenHash = sha256Hex(rawShareToken);
    targetUserId = `ext:${id}`;
  } else {
    throw new Error('invalid_share_mode');
  }

  const row = await db.queryOne<DbDocumentShareRow>(
    `INSERT INTO document_shares (
       id, server_id, target_kind, target_path, label, share_mode, target_user_id,
       participant_label, share_token_hash, access_code_hash, device_lock_enabled,
       bound_device_hash, redeemed_by_user_id, redeemed_at,
       role, allow_download, created_by, created_at, updated_at, expires_at, revoked_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       NULL, NULL, NULL,
       $12, $13, $14, $15, $15, $16, NULL
     )
     ON CONFLICT (server_id, target_path, target_user_id)
     DO UPDATE SET
       target_kind = EXCLUDED.target_kind,
       label = EXCLUDED.label,
       share_mode = EXCLUDED.share_mode,
       participant_label = EXCLUDED.participant_label,
       share_token_hash = EXCLUDED.share_token_hash,
       access_code_hash = EXCLUDED.access_code_hash,
       device_lock_enabled = EXCLUDED.device_lock_enabled,
       bound_device_hash = NULL,
       redeemed_by_user_id = NULL,
       redeemed_at = NULL,
       role = EXCLUDED.role,
       allow_download = EXCLUDED.allow_download,
       updated_at = EXCLUDED.updated_at,
       expires_at = EXCLUDED.expires_at,
       revoked_at = NULL
     RETURNING *`,
    [
      id,
      input.serverId,
      input.targetKind,
      normPath,
      label,
      input.shareMode,
      targetUserId,
      input.participantLabel?.trim() || null,
      shareTokenHash,
      accessCodeHash,
      deviceLockEnabled,
      input.role,
      allowDownload,
      input.createdBy,
      now,
      input.expiresAt ?? null,
    ],
  );

  if (!row) throw new Error('failed_to_create_document_share');
  return { share: mapDbRow(row), rawShareToken };
}

export async function getDocumentShareById(
  db: Database,
  shareId: string,
  serverId?: string,
): Promise<DocumentShareRow | null> {
  const row = serverId
    ? await db.queryOne<DbDocumentShareRow>(
        `SELECT ds.*, u.username AS target_username, u.display_name AS target_display_name
           FROM document_shares ds
           LEFT JOIN users u ON u.id = ds.target_user_id
          WHERE ds.id = $1 AND ds.server_id = $2`,
        [shareId, serverId],
      )
    : await db.queryOne<DbDocumentShareRow>(
        `SELECT ds.*, u.username AS target_username, u.display_name AS target_display_name
           FROM document_shares ds
           LEFT JOIN users u ON u.id = ds.target_user_id
          WHERE ds.id = $1`,
        [shareId],
      );
  return row ? mapDbRow(row) : null;
}

export async function getDocumentShareByToken(
  db: Database,
  rawToken: string,
): Promise<(DocumentShareRow & { accessCodeHash: string | null }) | null> {
  const trimmed = rawToken.trim();
  if (!trimmed) return null;
  const tokenHash = sha256Hex(trimmed);
  const row = await db.queryOne<DbDocumentShareRow>(
    `SELECT ds.*, u.username AS target_username, u.display_name AS target_display_name
       FROM document_shares ds
       LEFT JOIN users u ON u.id = ds.target_user_id
      WHERE ds.share_token_hash = $1`,
    [tokenHash],
  );
  if (!row) return null;
  return {
    ...mapDbRow(row),
    accessCodeHash: row.access_code_hash,
  };
}

export async function listDocumentSharesForServer(
  db: Database,
  serverId: string,
  options?: { targetPath?: string; includeRevoked?: boolean },
): Promise<DocumentShareRow[]> {
  const params: unknown[] = [serverId];
  const clauses = ['ds.server_id = $1'];
  if (!options?.includeRevoked) {
    clauses.push('ds.revoked_at IS NULL');
  }
  if (options?.targetPath) {
    const norm = normalizeDocumentSharePath(options.targetPath);
    if (norm) {
      params.push(norm);
      clauses.push(`ds.target_path = $${params.length}`);
    }
  }
  const rows = await db.query<DbDocumentShareRow>(
    `SELECT ds.*, u.username AS target_username, u.display_name AS target_display_name
       FROM document_shares ds
       LEFT JOIN users u ON u.id = ds.target_user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY ds.created_at DESC`,
    params,
  );
  return rows.map(mapDbRow);
}

export interface SharedWithMeItem extends DocumentShareRow {
  serverName: string | null;
}

export async function listDocumentsSharedWithUser(
  db: Database,
  userId: string,
  now = Date.now(),
): Promise<SharedWithMeItem[]> {
  const rows = await db.query<DbDocumentShareRow & { server_name: string | null }>(
    `SELECT ds.*, s.name AS server_name
       FROM document_shares ds
       JOIN servers s ON s.id = ds.server_id
       JOIN users owner ON owner.id = s.user_id
      WHERE ds.revoked_at IS NULL
        AND (ds.expires_at IS NULL OR ds.expires_at > $1)
        AND owner.status = 'active'
        AND (
          ds.target_user_id = $2
          OR ds.redeemed_by_user_id = $2
          OR ds.target_user_id = '*'
        )
      ORDER BY ds.updated_at DESC`,
    [now, userId],
  );
  const teamMembershipByServer = new Map<string, boolean>();
  const filtered: Array<DbDocumentShareRow & { server_name: string | null }> = [];
  for (const r of rows) {
    if (r.target_user_id === userId || r.redeemed_by_user_id === userId) {
      filtered.push(r);
      continue;
    }
    if (r.target_user_id === '*') {
      let inTeam = teamMembershipByServer.get(r.server_id);
      if (inTeam === undefined) {
        inTeam = await isUserInServerTeam(db, r.server_id, userId);
        teamMembershipByServer.set(r.server_id, inTeam);
      }
      if (inTeam) {
        filtered.push(r);
      }
    }
  }
  return filtered.map((r) => ({
    ...mapDbRow(r),
    serverName: r.server_name ?? null,
  }));
}

export interface UpdateDocumentSharePatch {
  role?: DocumentShareRole;
  allowDownload?: boolean;
  participantLabel?: string | null;
  label?: string | null;
  deviceLockEnabled?: boolean;
  resetDeviceLock?: boolean;
  accessCode?: string | null;
  expiresAt?: number | null;
  now?: number;
}

export async function updateDocumentShare(
  db: Database,
  shareId: string,
  serverId: string,
  patch: UpdateDocumentSharePatch,
): Promise<DocumentShareRow | null> {
  const existing = await db.queryOne<DbDocumentShareRow>(
    'SELECT * FROM document_shares WHERE id = $1 AND server_id = $2',
    [shareId, serverId],
  );
  if (!existing) return null;

  const now = patch.now ?? Date.now();
  const role = patch.role ?? existing.role;
  const allowDownload = patch.allowDownload ?? existing.allow_download;
  const participantLabel = patch.participantLabel !== undefined
    ? (patch.participantLabel?.trim() || null)
    : existing.participant_label;
  const label = patch.label !== undefined
    ? (patch.label?.trim() || existing.label)
    : existing.label;
  const deviceLockEnabled = patch.deviceLockEnabled !== undefined
    ? patch.deviceLockEnabled
    : existing.device_lock_enabled;
  const boundDeviceHash = (patch.resetDeviceLock || patch.deviceLockEnabled === false)
    ? null
    : existing.bound_device_hash;
  const accessCodeHash = patch.accessCode !== undefined
    ? (patch.accessCode?.trim() ? sha256Hex(patch.accessCode.trim()) : null)
    : existing.access_code_hash;
  const expiresAt = Object.prototype.hasOwnProperty.call(patch, 'expiresAt')
    ? (patch.expiresAt ?? null)
    : toNum(existing.expires_at);

  const updated = await db.queryOne<DbDocumentShareRow>(
    `UPDATE document_shares
        SET role = $1,
            allow_download = $2,
            participant_label = $3,
            label = $4,
            device_lock_enabled = $5,
            bound_device_hash = $6,
            access_code_hash = $7,
            expires_at = $8,
            updated_at = $9
      WHERE id = $10 AND server_id = $11
      RETURNING *`,
    [
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
    ],
  );
  return updated ? mapDbRow(updated) : null;
}

export async function revokeDocumentShare(
  db: Database,
  shareId: string,
  serverId: string,
  now = Date.now(),
): Promise<DocumentShareRow | null> {
  const row = await db.queryOne<DbDocumentShareRow>(
    `UPDATE document_shares
        SET revoked_at = COALESCE(revoked_at, $1),
            updated_at = $1
      WHERE id = $2 AND server_id = $3
      RETURNING *`,
    [now, shareId, serverId],
  );
  return row ? mapDbRow(row) : null;
}

export interface VerifyExternalShareInput {
  rawToken: string;
  accessCode?: string | null;
  deviceToken?: string | null;
  passkeyCredentialId?: string | null;
  passkeyChallengeId?: string | null;
  passkeyResponse?: Record<string, unknown> | null;
  rpId?: string;
  origin?: string;
  userId?: string | null;
  now?: number;
}

export type VerifyExternalShareResult =
  | {
      ok: true;
      share: DocumentShareRow;
      deviceToken: string;
      deviceBound: boolean;
    }
  | {
      ok: false;
      status: 401 | 403 | 404 | 410;
      error: string;
    };

/**
 * Scheme 1: Verify external link token + optional accessCode + bind or verify first-device / Passkey lock.
 */
export async function verifyAndBindExternalShareDevice(
  db: Database,
  input: VerifyExternalShareInput,
): Promise<VerifyExternalShareResult> {
  const now = input.now ?? Date.now();
  const share = await getDocumentShareByToken(db, input.rawToken);
  if (!share) {
    return { ok: false, status: 404, error: 'share_not_found' };
  }
  if (share.revokedAt !== null) {
    return { ok: false, status: 410, error: 'share_revoked' };
  }
  if (share.expiresAt !== null && share.expiresAt <= now) {
    return { ok: false, status: 410, error: 'share_expired' };
  }
  if (share.shareMode === 'magic_invite') {
    return { ok: false, status: 403, error: 'magic_invite_requires_redemption' };
  }

  // Verify access code when configured
  if (share.accessCodeHash) {
    const supplied = input.accessCode?.trim() ?? '';
    if (!supplied || sha256Hex(supplied) !== share.accessCodeHash) {
      return { ok: false, status: 401, error: 'invalid_access_code' };
    }
  }

  // Never trust a bare passkeyCredentialId string without cryptographic WebAuthn assertion verification
  let verifiedPasskeyToken: string | null = null;
  if (input.passkeyCredentialId?.trim() || input.passkeyResponse) {
    if (!input.passkeyChallengeId?.trim() || !input.passkeyResponse || typeof input.passkeyResponse !== 'object') {
      return { ok: false, status: 401, error: 'passkey_assertion_required' };
    }
    const challengeRow = await db.queryOne<{ challenge: string }>(
      'SELECT challenge FROM passkey_challenges WHERE id = $1 AND expires_at > $2',
      [input.passkeyChallengeId.trim(), now],
    );
    if (!challengeRow) {
      return { ok: false, status: 401, error: 'passkey_challenge_expired' };
    }
    await db.execute('DELETE FROM passkey_challenges WHERE id = $1', [input.passkeyChallengeId.trim()]);

    const respId = typeof input.passkeyResponse.id === 'string'
      ? input.passkeyResponse.id
      : (input.passkeyCredentialId?.trim() ?? '');
    if (!respId) {
      return { ok: false, status: 401, error: 'invalid_passkey_response' };
    }
    const storedCred = await db.queryOne<{
      id: string;
      user_id: string;
      public_key: string;
      counter: number;
      transports: string | null;
    }>(
      'SELECT id, user_id, public_key, counter, transports FROM passkey_credentials WHERE id = $1',
      [respId],
    );
    if (!storedCred) {
      return { ok: false, status: 403, error: 'wrong_passkey' };
    }
    try {
      const verification = await verifyAuthenticationResponse({
        response: input.passkeyResponse as unknown as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: input.origin ?? 'http://localhost',
        expectedRPID: input.rpId ?? 'localhost',
        authenticator: {
          credentialID: storedCred.id,
          credentialPublicKey: Uint8Array.from(Buffer.from(storedCred.public_key, 'base64')),
          counter: storedCred.counter,
          transports: storedCred.transports ? JSON.parse(storedCred.transports) : undefined,
        },
      });
      if (!verification.verified) {
        return { ok: false, status: 401, error: 'passkey_verification_failed' };
      }
      await db.execute(
        'UPDATE passkey_credentials SET counter = $1, last_used_at = $2 WHERE id = $3',
        [verification.authenticationInfo.newCounter, now, storedCred.id],
      );
      const nonce = randomHex(16);
      const proofSig = sha256Hex(`doc-passkey-proof:v1:${share.id}:${storedCred.id}:${nonce}`);
      verifiedPasskeyToken = `pkey_${nonce}.${proofSig}`;
    } catch {
      return { ok: false, status: 401, error: 'passkey_verification_failed' };
    }
  }

  // Reject attempts to pass the stored boundDeviceHash itself as the raw deviceToken
  const rawSuppliedDevice = input.deviceToken?.trim() ?? '';
  if (rawSuppliedDevice && share.boundDeviceHash && rawSuppliedDevice === share.boundDeviceHash) {
    return { ok: false, status: 403, error: 'device_locked_to_another_device' };
  }
  // Reject bare passkey / credential identifiers supplied directly as deviceToken
  if (rawSuppliedDevice && (rawSuppliedDevice.startsWith('passkey:') || rawSuppliedDevice.startsWith('cred_'))) {
    return { ok: false, status: 403, error: 'invalid_device_token' };
  }

  const defaultGeneratedToken = share.accessCodeHash
    ? (() => {
        const nonce = randomHex(16);
        return `dpin_${nonce}.${sha256Hex(`doc-pin-proof:v1:${share.id}:${share.accessCodeHash}:${nonce}`)}`;
      })()
    : `dev_${randomHex(24)}`;

  // Determine candidate device credential token
  const candidateToken =
    verifiedPasskeyToken
      ? verifiedPasskeyToken
      : rawSuppliedDevice
        ? rawSuppliedDevice
        : input.userId?.trim()
          ? `user:${input.userId.trim()}`
          : defaultGeneratedToken;

  const candidateHash = sha256Hex(candidateToken);

  if (share.deviceLockEnabled) {
    if (!share.boundDeviceHash) {
      // First device/Passkey opens link: atomically bind when bound_device_hash IS NULL
      const updated = await db.queryOne<DbDocumentShareRow>(
        `UPDATE document_shares
            SET bound_device_hash = $1,
                updated_at = $2
          WHERE id = $3 AND bound_device_hash IS NULL
          RETURNING *`,
        [candidateHash, now, share.id],
      );
      if (updated) {
        if (share.accessCodeHash) {
          recordVerifiedExternalSharePin(share.id, share.accessCodeHash, candidateToken);
        }
        return {
          ok: true,
          share: mapDbRow(updated),
          deviceToken: candidateToken,
          deviceBound: true,
        };
      }
      // Race condition: re-read to verify if bound to same hash
      const recheck = await getDocumentShareById(db, share.id);
      if (!recheck || recheck.boundDeviceHash !== candidateHash) {
        return { ok: false, status: 403, error: 'device_locked_to_another_device' };
      }
      if (share.accessCodeHash) {
        recordVerifiedExternalSharePin(share.id, share.accessCodeHash, candidateToken);
      }
      return {
        ok: true,
        share: recheck,
        deviceToken: candidateToken,
        deviceBound: true,
      };
    }

    if (share.boundDeviceHash !== candidateHash) {
      return { ok: false, status: 403, error: 'device_locked_to_another_device' };
    }
  }

  if (share.accessCodeHash) {
    recordVerifiedExternalSharePin(share.id, share.accessCodeHash, candidateToken);
  }

  return {
    ok: true,
    share,
    deviceToken: candidateToken,
    deviceBound: Boolean(share.deviceLockEnabled),
  };
}

export interface RedeemMagicInviteInput {
  rawToken: string;
  displayName: string;
  existingUserId?: string | null;
  accessCode?: string | null;
  now?: number;
}

export type RedeemMagicInviteResult =
  | {
      ok: true;
      share: DocumentShareRow;
      userId: string;
      displayName: string;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 410;
      error: string;
    };

/**
 * Scheme 3: One-time Magic Link redemption.
 * Atomically marks `redeemed_at` and binds the share rule to a newly created (or existing) collaborator user.
 */
export async function redeemMagicInviteShare(
  db: Database,
  input: RedeemMagicInviteInput,
): Promise<RedeemMagicInviteResult> {
  const now = input.now ?? Date.now();
  const displayName = input.displayName.trim();
  if (!displayName) {
    return { ok: false, status: 400, error: 'missing_display_name' };
  }

  const share = await getDocumentShareByToken(db, input.rawToken);
  if (!share || share.shareMode !== 'magic_invite') {
    return { ok: false, status: 404, error: 'magic_invite_not_found' };
  }
  if (share.revokedAt !== null) {
    return { ok: false, status: 410, error: 'share_revoked' };
  }
  if (share.expiresAt !== null && share.expiresAt <= now) {
    return { ok: false, status: 410, error: 'share_expired' };
  }
  if (share.accessCodeHash) {
    const supplied = input.accessCode?.trim() ?? '';
    if (!supplied || sha256Hex(supplied) !== share.accessCodeHash) {
      return { ok: false, status: 401, error: 'invalid_access_code' };
    }
  }

  // If already redeemed, refuse re-redemption unless it's the exact same user
  if (share.redeemedAt !== null) {
    if (input.existingUserId && share.redeemedByUserId === input.existingUserId) {
      return {
        ok: true,
        share,
        userId: share.redeemedByUserId,
        displayName: share.participantLabel || displayName,
      };
    }
    return { ok: false, status: 409, error: 'magic_invite_already_redeemed' };
  }

  let userId = input.existingUserId?.trim() || '';
  if (!userId) {
    userId = `extusr_${randomHex(12)}`;
    await db.execute(
      `INSERT INTO users (id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [userId, displayName, USER_STATUS.ACTIVE, now],
    );
  }

  const updated = await db.queryOne<DbDocumentShareRow>(
    `UPDATE document_shares
        SET redeemed_by_user_id = $1,
            redeemed_at = $2,
            target_user_id = $1,
            participant_label = COALESCE(participant_label, $3),
            updated_at = $2
      WHERE id = $4 AND redeemed_at IS NULL AND revoked_at IS NULL
      RETURNING *`,
    [userId, now, displayName, share.id],
  );

  if (!updated) {
    return { ok: false, status: 409, error: 'magic_invite_already_redeemed' };
  }

  return {
    ok: true,
    share: mapDbRow(updated),
    userId,
    displayName,
  };
}

export interface ResolveDocumentAccessInput {
  serverId: string;
  userId?: string | null;
  externalShareToken?: string | null;
  deviceToken?: string | null;
  filePath: string;
  now?: number;
}

export interface EffectiveDocumentAccess {
  allowed: boolean;
  role: DocumentShareRole | null;
  allowDownload: boolean;
  isOwner: boolean;
  canManageShare: boolean;
  shareId?: string | null;
  shareMode?: DocumentShareMode | null;
  participantLabel?: string | null;
  targetPath?: string | null;
  targetKind?: DocumentShareTargetKind | null;
  reason?: string;
}

/**
 * Core permission resolver for documents & folders across:
 * 1. Path normalization & anti-traversal
 * 2. Server Owner / Admin full authority
 * 3. Internal user / redeemed Magic Link / team (`*`) grants (exact file override > deepest folder inheritance, specific user > `*`)
 * 4. External link (`external_link`) & Magic Link (`magic_invite`) token + first-device/Passkey lock + child file override
 */
export async function resolveEffectiveDocumentAccess(
  db: Database,
  input: ResolveDocumentAccessInput,
): Promise<EffectiveDocumentAccess> {
  const denied = (reason: string): EffectiveDocumentAccess => ({
    allowed: false,
    role: null,
    allowDownload: false,
    isOwner: false,
    canManageShare: false,
    reason,
  });

  // 1. Path normalization & anti-traversal
  const normPath = normalizeDocumentSharePath(input.filePath);
  if (!normPath) {
    return denied('invalid_path');
  }

  const now = input.now ?? Date.now();

  // Check server & owner status
  const server = await db.queryOne<{ id: string; user_id: string; owner_status: string | null }>(
    `SELECT id, user_id,
            (SELECT u.status FROM users u WHERE u.id = servers.user_id) AS owner_status
       FROM servers WHERE id = $1`,
    [input.serverId],
  );
  if (!server || !isUserStatusActive(server.owner_status)) {
    return denied('server_not_found');
  }

  const userId = input.userId?.trim() || null;

  // 2. Server Owner / Admin directly holds highest permission
  if (userId) {
    const memberRole = await resolveServerMembershipRole(db, input.serverId, userId);
    if (memberRole === 'owner' || memberRole === 'admin') {
      return {
        allowed: true,
        role: 'editor',
        allowDownload: true,
        isOwner: memberRole === 'owner',
        canManageShare: true,
        targetPath: normPath,
      };
    }
  }

  // 4. External Share Token (`external_link` / `magic_invite`) validation
  const rawToken = input.externalShareToken?.trim() || null;
  if (rawToken) {
    const tokenHash = sha256Hex(rawToken);
    const extRow = await db.queryOne<DbDocumentShareRow>(
      'SELECT * FROM document_shares WHERE server_id = $1 AND share_token_hash = $2',
      [input.serverId, tokenHash],
    );
    if (!extRow) return denied('share_not_found');
    if (extRow.revoked_at !== null) return denied('share_revoked');
    const exp = toNum(extRow.expires_at);
    if (exp !== null && exp <= now) return denied('share_expired');

    // Magic Invite tokens MUST be redeemed first via redeemMagicInviteShare;
    // unredeemed magic_invite raw tokens or tokens redeemed by a different user are never accepted directly.
    if (extRow.share_mode === 'magic_invite') {
      if (!extRow.redeemed_at || !extRow.redeemed_by_user_id) {
        return denied('magic_invite_requires_redemption');
      }
      if (userId !== extRow.redeemed_by_user_id) {
        return denied('magic_invite_already_redeemed');
      }
    }

    // Scope check
    if (extRow.target_kind === 'file') {
      if (normPath !== extRow.target_path) return denied('path_out_of_scope');
    } else {
      if (!isPathWithinSharedFolder(normPath, extRow.target_path)) {
        return denied('path_out_of_scope');
      }
    }

    const suppliedDeviceToken = input.deviceToken?.trim()
      || (userId ? `user:${userId}` : '');

    // Reject bare passkey / credential identifiers supplied directly as deviceToken
    if (suppliedDeviceToken && (suppliedDeviceToken.startsWith('passkey:') || suppliedDeviceToken.startsWith('cred_'))) {
      return denied('device_locked');
    }

    // Reject attempts to pass the stored bound_device_hash itself as raw deviceToken
    if (suppliedDeviceToken && extRow.bound_device_hash && suppliedDeviceToken === extRow.bound_device_hash) {
      return denied('device_locked');
    }

    // Mandatory PIN check: when access_code_hash is configured on an external_link,
    // the caller MUST have completed verifyAndBindExternalShareDevice for this deviceToken
    if (extRow.share_mode === 'external_link' && extRow.access_code_hash) {
      if (!hasVerifiedExternalSharePin(extRow.id, extRow.access_code_hash, suppliedDeviceToken, now)) {
        return denied('access_code_verification_required');
      }
    }

    // Device / Passkey lock verification
    if (extRow.device_lock_enabled) {
      if (!suppliedDeviceToken) {
        return denied('device_locked');
      }
      const suppliedHash = sha256Hex(suppliedDeviceToken);
      if (extRow.bound_device_hash) {
        if (suppliedHash !== extRow.bound_device_hash) {
          return denied('device_locked');
        }
      } else if (!extRow.access_code_hash) {
        // Bind on first access when no access code gate is configured, using atomic CAS + re-read
        const updated = await db.queryOne<DbDocumentShareRow>(
          `UPDATE document_shares
              SET bound_device_hash = $1,
                  updated_at = $2
            WHERE id = $3 AND bound_device_hash IS NULL
            RETURNING *`,
          [suppliedHash, now, extRow.id],
        );
        if (!updated) {
          const recheck = await getDocumentShareById(db, extRow.id);
          if (!recheck || recheck.boundDeviceHash !== suppliedHash) {
            return denied('device_locked');
          }
        }
      } else {
        return denied('device_locked');
      }
    }

    let effectiveRole: DocumentShareRole = extRow.role;
    let effectiveAllowDownload = Boolean(extRow.allow_download);

    // Check child file override when folder is shared via external link
    if (extRow.target_kind === 'folder' && normPath !== extRow.target_path) {
      const childOverrides = await db.query<DbDocumentShareRow>(
        `SELECT * FROM document_shares
          WHERE server_id = $1
            AND target_kind = 'file'
            AND target_path = $2
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > $3)`,
        [input.serverId, normPath, now],
      );
      if (childOverrides.length > 0) {
        // Prefer specific override for this share/user, else wildcard '*' or file-level restriction
        const specific = childOverrides.find(
          (c) =>
            c.target_user_id === extRow.target_user_id ||
            (userId && c.target_user_id === userId),
        );
        const rule = specific ?? childOverrides.find((c) => c.target_user_id === '*') ?? childOverrides[0];
        if (rule) {
          if (specific) {
            effectiveRole = rule.role;
            effectiveAllowDownload = Boolean(rule.allow_download);
          } else {
            if (rule.role === 'viewer') effectiveRole = 'viewer';
            if (!rule.allow_download) effectiveAllowDownload = false;
          }
        }
      }
    }

    return {
      allowed: true,
      role: effectiveRole,
      allowDownload: effectiveAllowDownload,
      isOwner: false,
      canManageShare: false,
      shareId: extRow.id,
      shareMode: extRow.share_mode,
      participantLabel: extRow.participant_label,
      targetPath: extRow.target_path,
      targetKind: extRow.target_kind,
    };
  }

  // 3. Internal user / redeemed Magic Link / team ('*') share check
  if (!userId) {
    return denied('unauthenticated');
  }

  const actor = await db.queryOne<{ status: string | null }>(
    'SELECT status FROM users WHERE id = $1',
    [userId],
  );
  if (!actor || !isUserStatusActive(actor.status)) {
    return denied('user_inactive');
  }

  const activeSharesRaw = await db.query<DbDocumentShareRow>(
    `SELECT * FROM document_shares
      WHERE server_id = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > $2)
        AND (
          target_user_id = $3
          OR redeemed_by_user_id = $3
          OR target_user_id = '*'
        )`,
    [input.serverId, now, userId],
  );

  // Team wildcard ('*') shares only apply if the user is a member of this server's team
  const hasWildcardCandidate = activeSharesRaw.some(
    (r) => r.target_user_id === '*' && r.target_user_id !== userId && r.redeemed_by_user_id !== userId,
  );
  const userInServerTeam = hasWildcardCandidate
    ? await isUserInServerTeam(db, input.serverId, userId)
    : false;
  const activeShares = activeSharesRaw.filter(
    (r) =>
      r.target_user_id === userId ||
      r.redeemed_by_user_id === userId ||
      (r.target_user_id === '*' && userInServerTeam),
  );

  if (activeShares.length === 0) {
    return denied('no_active_share');
  }

  const isSpecificUserMatch = (r: DbDocumentShareRow): boolean =>
    r.target_user_id === userId || r.redeemed_by_user_id === userId;

  // Priority 3a: Exact single-file match (`target_kind = 'file'`) overrides folder inheritance!
  // Specific user (`userId`) takes priority over team wildcard (`'*'`).
  const exactFileMatches = activeShares
    .filter((r) => r.target_kind === 'file' && r.target_path === normPath)
    .sort((a, b) => {
      const aSpec = isSpecificUserMatch(a) ? 0 : 1;
      const bSpec = isSpecificUserMatch(b) ? 0 : 1;
      if (aSpec !== bSpec) return aSpec - bSpec;
      return (toNum(b.updated_at) ?? 0) - (toNum(a.updated_at) ?? 0);
    });

  if (exactFileMatches.length > 0) {
    const match = exactFileMatches[0]!;
    return {
      allowed: true,
      role: match.role,
      allowDownload: Boolean(match.allow_download),
      isOwner: false,
      canManageShare: false,
      shareId: match.id,
      shareMode: match.share_mode,
      participantLabel: match.participant_label,
      targetPath: match.target_path,
      targetKind: match.target_kind,
    };
  }

  // Priority 3b: Ancestor folder match (`target_kind = 'folder'`), deepest folder path first,
  // then specific user (`userId`) before wildcard (`'*'`).
  const folderMatches = activeShares
    .filter((r) => r.target_kind === 'folder' && isPathWithinSharedFolder(normPath, r.target_path))
    .sort((a, b) => {
      if (b.target_path.length !== a.target_path.length) {
        return b.target_path.length - a.target_path.length;
      }
      const aSpec = isSpecificUserMatch(a) ? 0 : 1;
      const bSpec = isSpecificUserMatch(b) ? 0 : 1;
      if (aSpec !== bSpec) return aSpec - bSpec;
      return (toNum(b.updated_at) ?? 0) - (toNum(a.updated_at) ?? 0);
    });

  if (folderMatches.length > 0) {
    const match = folderMatches[0]!;
    return {
      allowed: true,
      role: match.role,
      allowDownload: Boolean(match.allow_download),
      isOwner: false,
      canManageShare: false,
      shareId: match.id,
      shareMode: match.share_mode,
      participantLabel: match.participant_label,
      targetPath: match.target_path,
      targetKind: match.target_kind,
    };
  }

  return denied('path_not_shared');
}

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative PostgreSQL ONLYOFFICE Collaborative Room & Commit WAL
// ─────────────────────────────────────────────────────────────────────────────

export interface OnlyOfficeRoomRow {
  server_id: string;
  normalized_path: string;
  current_confirmed_hash: string;
  committed_hash: string;
  last_force_saved_hash: string | null;
  active_key: string;
  session_epoch: number;
  commit_seq: number;
  active: boolean;
  updated_at: number;
}

export interface OnlyOfficeCommitJournalRow {
  server_id: string;
  normalized_path: string;
  room_key: string;
  target_hash: string;
  session_epoch: number;
  phase: string;
  updated_at: number;
}

export async function getOnlyOfficeRoomRecord(
  db: Database,
  serverId: string,
  normalizedPath: string,
): Promise<OnlyOfficeRoomRow | null> {
  const row = await db.queryOne<OnlyOfficeRoomRow>(
    `SELECT server_id, normalized_path, current_confirmed_hash, committed_hash, last_force_saved_hash,
            active_key, session_epoch, commit_seq, active, updated_at
     FROM onlyoffice_rooms
     WHERE server_id = $1 AND normalized_path = $2`,
    [serverId, normalizedPath],
  );
  if (!row) return null;
  return {
    ...row,
    session_epoch: Number(row.session_epoch),
    commit_seq: Number(row.commit_seq),
    active: Boolean(row.active),
    updated_at: Number(row.updated_at),
  };
}

export async function upsertOnlyOfficeRoomRecord(
  db: Database,
  room: OnlyOfficeRoomRow,
): Promise<void> {
  await db.execute(
    `INSERT INTO onlyoffice_rooms (
       server_id, normalized_path, current_confirmed_hash, committed_hash,
       last_force_saved_hash, active_key, session_epoch, commit_seq, active, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (server_id, normalized_path) DO UPDATE SET
       current_confirmed_hash = EXCLUDED.current_confirmed_hash,
       committed_hash = EXCLUDED.committed_hash,
       last_force_saved_hash = EXCLUDED.last_force_saved_hash,
       active_key = EXCLUDED.active_key,
       session_epoch = EXCLUDED.session_epoch,
       commit_seq = EXCLUDED.commit_seq,
       active = EXCLUDED.active,
       updated_at = EXCLUDED.updated_at`,
    [
      room.server_id,
      room.normalized_path,
      room.current_confirmed_hash,
      room.committed_hash,
      room.last_force_saved_hash,
      room.active_key,
      room.session_epoch,
      room.commit_seq,
      room.active,
      room.updated_at,
    ],
  );
}

export async function deleteOnlyOfficeRoomRecord(
  db: Database,
  serverId: string,
  normalizedPath: string,
): Promise<void> {
  await db.execute(
    `DELETE FROM onlyoffice_rooms WHERE server_id = $1 AND normalized_path = $2`,
    [serverId, normalizedPath],
  );
}

export async function recordOnlyOfficeCommitJournalRecord(
  db: Database,
  entry: OnlyOfficeCommitJournalRow,
): Promise<void> {
  await db.execute(
    `INSERT INTO onlyoffice_commit_journal (
       server_id, normalized_path, room_key, target_hash, session_epoch, phase, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (server_id, normalized_path) DO UPDATE SET
       room_key = EXCLUDED.room_key,
       target_hash = EXCLUDED.target_hash,
       session_epoch = EXCLUDED.session_epoch,
       phase = EXCLUDED.phase,
       updated_at = EXCLUDED.updated_at`,
    [
      entry.server_id,
      entry.normalized_path,
      entry.room_key,
      entry.target_hash,
      entry.session_epoch,
      entry.phase || 'intent',
      entry.updated_at,
    ],
  );
}

export async function getOnlyOfficeCommitJournalRecord(
  db: Database,
  serverId: string,
  normalizedPath: string,
): Promise<OnlyOfficeCommitJournalRow | null> {
  const row = await db.queryOne<OnlyOfficeCommitJournalRow>(
    `SELECT server_id, normalized_path, room_key, target_hash, session_epoch, phase, updated_at
     FROM onlyoffice_commit_journal
     WHERE server_id = $1 AND normalized_path = $2`,
    [serverId, normalizedPath],
  );
  if (!row) return null;
  return {
    ...row,
    session_epoch: Number(row.session_epoch),
    updated_at: Number(row.updated_at),
  };
}

export async function clearOnlyOfficeCommitJournalRecord(
  db: Database,
  serverId: string,
  normalizedPath: string,
): Promise<void> {
  await db.execute(
    `DELETE FROM onlyoffice_commit_journal WHERE server_id = $1 AND normalized_path = $2`,
    [serverId, normalizedPath],
  );
}

