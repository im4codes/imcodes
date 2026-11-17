import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.js';
import { randomHex, sha256Hex, signJwt, verifyJwt } from '../security/crypto.js';
import { requireAuth, resolveAuthOutcome, resolveServerMembershipRole } from '../security/authorization.js';
import { resolveUserByIdentifier } from '../db/user-lookup.js';
import { createUser, getUserByPlatformId, upsertPlatformIdentity } from '../db/queries.js';
import { ACCOUNT_SESSION_JWT_TYPE } from '../../../shared/auth-token-types.js';
import { FS_READ_ERROR_CODES } from '../../../shared/fs-read-error-codes.js';
import {
  createDocumentShare,
  enrichDocumentShareTeamNames,
  getDocumentShareByToken,
  isPathWithinSharedFolder,
  listDocumentSharesForServer,
  listDocumentsSharedWithUser,
  listServerDocumentGroups,
  normalizeDocumentSharePath,
  parseTeamShareTargetUserId,
  recordVerifiedExternalSharePin,
  redeemMagicInviteShare,
  resolveEffectiveDocumentAccess,
  revokeDocumentShare,
  updateDocumentShare,
  verifyAndBindExternalShareDevice,
  type DocumentShareMode,
  type DocumentShareRole,
  type DocumentShareRow,
  type DocumentShareTargetKind,
  type ServerDocumentGroup,
} from '../db/document-sharing.js';
import {
  buildBlankDocumentBytes,
  DOC_DEVICE_COOKIE,
  sendDaemonFsCommand,
  writeFileToDaemon,
} from './onlyoffice.js';

export const documentSharingRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

type RouteContext = Context<{ Bindings: Env; Variables: { userId: string; role: string } }>;

function sanitizeExternalShareView(share: DocumentShareRow) {
  return {
    id: share.id,
    serverId: share.serverId,
    targetKind: share.targetKind,
    targetPath: share.targetPath,
    label: share.label || path.posix.basename(share.targetPath) || share.targetPath,
    shareMode: share.shareMode,
    participantLabel: share.participantLabel,
    hasAccessCode: share.hasAccessCode,
    deviceLockEnabled: share.deviceLockEnabled,
    isDeviceBound: share.isDeviceBound,
    redeemedAt: share.redeemedAt,
    role: share.role,
    allowDownload: share.allowDownload,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
  };
}

function extractDeviceToken(c: RouteContext): string | null {
  return (
    c.req.query('deviceToken')?.trim() ||
    c.req.header('x-doc-device-token')?.trim() ||
    getCookie(c, DOC_DEVICE_COOKIE)?.trim() ||
    null
  );
}

function extractShareToken(c: RouteContext): string | null {
  return (
    c.req.query('shareToken')?.trim() ||
    c.req.header('x-doc-share-token')?.trim() ||
    null
  );
}

async function issueAccountSessionCookies(
  c: RouteContext,
  userId: string,
  extraClaims: Record<string, unknown> = {},
): Promise<string> {
  const isSecure = c.env.NODE_ENV === 'production';
  const isDocCollab = extraClaims.scope === 'doc_collaborator';
  const accessToken = signJwt(
    { sub: userId, type: ACCOUNT_SESSION_JWT_TYPE, ...extraClaims },
    c.env.JWT_SIGNING_KEY,
    4 * 3600,
  );
  const refreshRaw = randomHex(32);
  const refreshHash = sha256Hex(refreshRaw);
  const familyId = isDocCollab ? `doc_collab:${randomHex(16)}` : randomHex(16);
  const refreshId = randomHex(16);
  await c.env.DB.execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [refreshId, userId, refreshHash, familyId, Date.now() + 30 * 24 * 3600 * 1000, Date.now()],
  );

  setCookie(c, 'rcc_session', accessToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 4 * 3600,
  });
  setCookie(c, 'rcc_refresh', refreshRaw, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 86400,
  });
  setCookie(c, 'rcc_csrf', randomHex(32), {
    httpOnly: false,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 86400,
  });

  return accessToken;
}

// ── 1. Internal & External Share CRUD (Owner / Admin) ─────────────────────────

// GET /api/server/:id/doc-shares?path=<optionalPath>
documentSharingRoutes.get('/server/:id/doc-shares', requireAuth(), async (c): Promise<Response> => {
  const serverId = c.req.param('id') ?? '';
  const userId = c.get('userId');
  const memberRole = await resolveServerMembershipRole(c.env.DB, serverId, userId);
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const targetPath = c.req.query('path')?.trim() || undefined;
  const includeRevoked = c.req.query('includeRevoked') === 'true';
  const [shares, groups] = await Promise.all([
    listDocumentSharesForServer(c.env.DB, serverId, {
      targetPath,
      includeRevoked,
    }),
    listServerDocumentGroups(c.env.DB, serverId, userId),
  ]);

  return c.json({
    shares: enrichDocumentShareTeamNames(shares, groups),
    groups,
  });
});

// POST /api/server/:id/doc-shares
documentSharingRoutes.post('/server/:id/doc-shares', requireAuth(), async (c): Promise<Response> => {
  const serverId = c.req.param('id') ?? '';
  const userId = c.get('userId');
  const memberRole = await resolveServerMembershipRole(c.env.DB, serverId, userId);
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const targetKind: DocumentShareTargetKind =
    body.targetKind === 'folder' ? 'folder' : 'file';
  const rawPath = typeof body.targetPath === 'string' ? body.targetPath : '';
  const normPath = normalizeDocumentSharePath(rawPath);
  if (!normPath) {
    return c.json({ error: 'invalid_target_path' }, 400);
  }

  const role: DocumentShareRole = body.role === 'editor' ? 'editor' : 'viewer';
  const allowDownload = body.allowDownload !== undefined ? Boolean(body.allowDownload) : true;
  const deviceLockEnabled = Boolean(body.deviceLockEnabled);
  const accessCode = typeof body.accessCode === 'string' ? body.accessCode : null;
  const participantLabel = typeof body.participantLabel === 'string' ? body.participantLabel : null;
  const label = typeof body.label === 'string' ? body.label : null;
  const expiresAt = typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
    ? body.expiresAt
    : null;

  const rawTargetTeamId =
    typeof body.targetTeamId === 'string' ? body.targetTeamId.trim() : null;
  if (typeof body.targetTeamId === 'string' && !rawTargetTeamId) {
    return c.json({ error: 'invalid_target_team' }, 400);
  }
  const rawUserField =
    (typeof body.targetUserId === 'string' && body.targetUserId.trim()) ||
    (typeof body.targetUser === 'string' && body.targetUser.trim()) ||
    '';
  const rawTeamFromUserField = rawUserField ? parseTeamShareTargetUserId(rawUserField) : null;
  if (rawUserField.startsWith('team:') && !rawTeamFromUserField) {
    return c.json({ error: 'invalid_target_team' }, 400);
  }
  if (rawTargetTeamId && rawTeamFromUserField && rawTargetTeamId !== rawTeamFromUserField) {
    return c.json({ error: 'invalid_target_team' }, 400);
  }
  const requestedTeamId = rawTargetTeamId || rawTeamFromUserField;

  let shareMode: DocumentShareMode =
    body.shareMode === 'team' ||
    body.shareMode === 'external_link' ||
    body.shareMode === 'magic_invite' ||
    body.shareMode === 'user'
      ? body.shareMode
      : requestedTeamId || body.targetUserId === '*' || body.targetUser === '*'
        ? 'team'
        : 'user';

  if (requestedTeamId && shareMode !== 'team') {
    return c.json({ error: 'invalid_share_mode' }, 400);
  }

  let matchedGroup: ServerDocumentGroup | undefined;
  if (shareMode === 'team' && requestedTeamId) {
    const groups = await listServerDocumentGroups(c.env.DB, serverId, userId);
    matchedGroup = groups.find((g) => g.id === requestedTeamId);
    if (!matchedGroup) {
      return c.json({ error: 'target_team_forbidden' }, 403);
    }
  }

  let resolvedTargetUserId: string | undefined;
  if (shareMode === 'user') {
    const rawUser = rawUserField;
    if (!rawUser) {
      return c.json({ error: 'missing_target_user' }, 400);
    }
    if (rawUser === '*') {
      shareMode = 'team';
    } else {
      const found = await resolveUserByIdentifier(c.env.DB, rawUser);
      if (!found) {
        return c.json({ error: 'target_user_not_found' }, 404);
      }
      resolvedTargetUserId = found.id;
    }
  }

  try {
    const { share: createdShare, rawShareToken } = await createDocumentShare(c.env.DB, {
      serverId,
      targetKind,
      targetPath: normPath,
      label,
      shareMode,
      targetUserId: resolvedTargetUserId,
      targetTeamId: matchedGroup?.id ?? null,
      participantLabel,
      accessCode,
      deviceLockEnabled,
      role,
      allowDownload,
      createdBy: userId,
      expiresAt,
    });
    const share = matchedGroup
      ? { ...createdShare, targetTeamId: matchedGroup.id, targetTeamName: matchedGroup.name }
      : createdShare;

    const serverBaseUrl = (c.env.SERVER_URL || '').replace(/\/$/, '');
    const sharePath = rawShareToken ? `/doc-share/${rawShareToken}` : null;
    const shareUrl = rawShareToken ? `${serverBaseUrl}${sharePath}` : null;

    return c.json(
      {
        share,
        shareToken: rawShareToken,
        sharePath,
        shareUrl,
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

// PATCH /api/server/:id/doc-shares/:shareId
documentSharingRoutes.patch('/server/:id/doc-shares/:shareId', requireAuth(), async (c): Promise<Response> => {
  const serverId = c.req.param('id') ?? '';
  const shareId = c.req.param('shareId') ?? '';
  const userId = c.get('userId');
  const memberRole = await resolveServerMembershipRole(c.env.DB, serverId, userId);
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const updated = await updateDocumentShare(c.env.DB, shareId, serverId, {
    role: body.role === 'editor' ? 'editor' : body.role === 'viewer' ? 'viewer' : undefined,
    allowDownload: typeof body.allowDownload === 'boolean' ? body.allowDownload : undefined,
    participantLabel:
      body.participantLabel === null || typeof body.participantLabel === 'string'
        ? (body.participantLabel as string | null)
        : undefined,
    label:
      body.label === null || typeof body.label === 'string'
        ? (body.label as string | null)
        : undefined,
    deviceLockEnabled: typeof body.deviceLockEnabled === 'boolean' ? body.deviceLockEnabled : undefined,
    resetDeviceLock: Boolean(body.resetDeviceLock),
    accessCode:
      body.accessCode === null || typeof body.accessCode === 'string'
        ? (body.accessCode as string | null)
        : undefined,
    ...(Object.prototype.hasOwnProperty.call(body, 'expiresAt')
      ? {
          expiresAt:
            typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
              ? body.expiresAt
              : null,
        }
      : {}),
  });

  if (!updated) {
    return c.json({ error: 'share_not_found' }, 404);
  }

  const enriched = updated.targetTeamId
    ? enrichDocumentShareTeamNames([updated], await listServerDocumentGroups(c.env.DB, serverId, userId))[0]!
    : updated;
  return c.json({ share: enriched });
});

// DELETE /api/server/:id/doc-shares/:shareId
documentSharingRoutes.delete('/server/:id/doc-shares/:shareId', requireAuth(), async (c): Promise<Response> => {
  const serverId = c.req.param('id') ?? '';
  const shareId = c.req.param('shareId') ?? '';
  const userId = c.get('userId');
  const memberRole = await resolveServerMembershipRole(c.env.DB, serverId, userId);
  if (memberRole !== 'owner' && memberRole !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const revoked = await revokeDocumentShare(c.env.DB, shareId, serverId);
  if (!revoked) {
    return c.json({ error: 'share_not_found' }, 404);
  }

  const enriched = revoked.targetTeamId
    ? enrichDocumentShareTeamNames([revoked], await listServerDocumentGroups(c.env.DB, serverId, userId))[0]!
    : revoked;
  return c.json({ ok: true, share: enriched });
});

// ── 2. Scheme 1: External Dedicated Link Verify + Access Code + Device/Passkey Lock ──

// POST /api/doc-shares/external/:token/verify
documentSharingRoutes.post('/doc-shares/external/:token/verify', async (c): Promise<Response> => {
  const rawToken = c.req.param('token') ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    // Allow empty body when no access code is needed
  }

  const { auth } = await resolveAuthOutcome(c);
  const existingDeviceToken =
    (typeof body.deviceToken === 'string' && body.deviceToken.trim()) ||
    extractDeviceToken(c);

  const resolvedHost = (c.get('resolvedHost' as never) as string | null) ?? 'localhost';
  const isSecure = c.env.NODE_ENV === 'production';
  const rpId = c.env.WEBAUTHN_RP_ID ?? resolvedHost.split(':')[0];
  const origin = `${isSecure ? 'https' : 'http'}://${resolvedHost}`;

  const result = await verifyAndBindExternalShareDevice(c.env.DB, {
    rawToken,
    accessCode: typeof body.accessCode === 'string' ? body.accessCode : null,
    deviceToken: existingDeviceToken,
    passkeyCredentialId: typeof body.passkeyCredentialId === 'string' ? body.passkeyCredentialId : null,
    passkeyChallengeId: typeof body.passkeyChallengeId === 'string' ? body.passkeyChallengeId : null,
    passkeyResponse:
      body.passkeyResponse && typeof body.passkeyResponse === 'object'
        ? (body.passkeyResponse as Record<string, unknown>)
        : null,
    rpId,
    origin,
    userId: auth?.userId ?? null,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }

  setCookie(c, DOC_DEVICE_COOKIE, result.deviceToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 86400,
  });

  return c.json({
    ok: true,
    share: sanitizeExternalShareView(result.share),
    deviceToken: result.deviceToken,
    deviceBound: result.deviceBound,
  });
});

// GET /api/doc-shares/external/:token/browse?path=<optionalSubpath>
documentSharingRoutes.get('/doc-shares/external/:token/browse', async (c): Promise<Response> => {
  const rawToken = c.req.param('token') ?? '';
  const share = await getDocumentShareByToken(c.env.DB, rawToken);
  if (!share) {
    return c.json({ error: 'share_not_found' }, 404);
  }
  if (share.revokedAt !== null) {
    return c.json({ error: 'share_revoked' }, 410);
  }
  if (share.expiresAt !== null && share.expiresAt <= Date.now()) {
    return c.json({ error: 'share_expired' }, 410);
  }

  const { auth } = await resolveAuthOutcome(c);
  if (share.shareMode === 'magic_invite') {
    if (!share.redeemedByUserId) {
      return c.json({ error: 'magic_invite_requires_redemption' }, 403);
    }
    if (auth?.userId !== share.redeemedByUserId) {
      return c.json({ error: 'magic_invite_already_redeemed' }, 403);
    }
  }

  let deviceToken = extractDeviceToken(c);

  // If access code is configured on an external_link, require either verified deviceToken or matching accessCode param/header
  if (share.shareMode !== 'magic_invite' && share.accessCodeHash) {
    const suppliedCode = c.req.query('accessCode')?.trim() || c.req.header('x-doc-access-code')?.trim() || '';
    const codeMatches = Boolean(suppliedCode && sha256Hex(suppliedCode) === share.accessCodeHash);
    if (codeMatches) {
      if (!deviceToken) {
        deviceToken = `dpin_inline.${sha256Hex(`doc-pin-proof:v1:${share.id}:${share.accessCodeHash}:inline`)}`;
      }
      recordVerifiedExternalSharePin(share.id, share.accessCodeHash, deviceToken);
    }
  }

  const requestedPath = c.req.query('path')?.trim() || share.targetPath;
  const normPath = normalizeDocumentSharePath(requestedPath);
  if (!normPath) {
    return c.json({ error: 'invalid_path' }, 400);
  }

  const access = await resolveEffectiveDocumentAccess(c.env.DB, {
    serverId: share.serverId,
    userId: auth?.userId ?? null,
    externalShareToken: rawToken,
    deviceToken,
    filePath: normPath,
  });

  if (!access.allowed || !access.role) {
    return c.json({ error: 'forbidden', reason: access.reason ?? 'access_denied' }, 403);
  }

  if (share.targetKind === 'file') {
    return c.json({
      share: sanitizeExternalShareView(share),
      serverId: share.serverId,
      targetKind: 'file',
      rootPath: share.targetPath,
      path: normPath,
      role: access.role,
      allowDownload: access.allowDownload,
      entries: [
        {
          name: path.posix.basename(normPath),
          path: normPath,
          isDir: false,
          role: access.role,
          allowDownload: access.allowDownload,
        },
      ],
    });
  }

  // Folder share: list directory entries from daemon, strictly scoped within share.targetPath
  try {
    const lsRes = await sendDaemonFsCommand<{
      type: string;
      requestId: string;
      status?: 'ok' | 'error';
      entries?: Array<{ name: string; isDir: boolean; hidden?: boolean; size?: number; mtime?: number }>;
      error?: string;
    }>(share.serverId, 'ls', {
      type: 'fs.ls',
      requestId: `ext-ls-${randomHex(8)}`,
      path: normPath,
      includeFiles: true,
      allowedRoot: share.targetPath,
    });

    if (lsRes.status === 'error') {
      const status = lsRes.error === FS_READ_ERROR_CODES.FORBIDDEN_PATH ? 403 : 502;
      return c.json({ error: lsRes.error || 'daemon_ls_failed' }, status);
    }

    const rawEntries = Array.isArray(lsRes.entries) ? lsRes.entries : [];
    const annotatedEntries = [];
    for (const entry of rawEntries) {
      if (
        !entry ||
        typeof entry.name !== 'string' ||
        entry.name.startsWith('.oo-bak-') ||
        entry.name.startsWith('.oo-stage-') ||
        entry.name.startsWith('.imcodes-write-')
      ) {
        continue;
      }
      const entryPath = path.posix.join(normPath, entry.name);
      if (!isPathWithinSharedFolder(entryPath, share.targetPath)) continue;
      const entryAccess = await resolveEffectiveDocumentAccess(c.env.DB, {
        serverId: share.serverId,
        userId: auth?.userId ?? null,
        externalShareToken: rawToken,
        deviceToken,
        filePath: entryPath,
      });
      if (!entryAccess.allowed) continue;
      annotatedEntries.push({
        ...entry,
        path: entryPath,
        role: entryAccess.role,
        allowDownload: entryAccess.allowDownload,
      });
    }

    return c.json({
      share: sanitizeExternalShareView(share),
      serverId: share.serverId,
      targetKind: 'folder',
      rootPath: share.targetPath,
      path: normPath,
      role: access.role,
      allowDownload: access.allowDownload,
      entries: annotatedEntries,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'daemon_offline' ? 503 : 502;
    return c.json({ error: msg }, status);
  }
});

// ── 3. Scheme 2: Central Auth Relay Key-Free Google / GitHub Login ────────────

function normalizeSafeRedirectPath(raw: string | undefined, shareToken?: string): string {
  const candidate = raw?.trim() || (shareToken ? `/doc-share/${encodeURIComponent(shareToken)}` : '/');
  if (!candidate.startsWith('/') || candidate.startsWith('//')) {
    return '/';
  }
  return candidate;
}

// GET /api/doc-shares/auth-relay/callback (registered before :provider so 'callback' is not matched as a provider param)
documentSharingRoutes.get('/doc-shares/auth-relay/callback', async (c): Promise<Response> => {
  const relayToken = c.req.query('relay_token')?.trim();
  const code = c.req.query('code')?.trim();
  const stateParam = c.req.query('state')?.trim();

  if (!stateParam) {
    return c.json({ error: 'missing_state' }, 400);
  }
  const verifiedState = verifyJwt(stateParam, c.env.JWT_SIGNING_KEY);
  if (!verifiedState || verifiedState.type !== 'doc-auth-relay-state') {
    return c.json({ error: 'invalid_state' }, 400);
  }
  const expectedNonce = typeof verifiedState.nonce === 'string' ? verifiedState.nonce : '';
  const cookieNonce = getCookie(c, 'doc_oauth_state')?.trim() || '';
  if (!expectedNonce || !cookieNonce || cookieNonce !== expectedNonce) {
    return c.json({ error: 'state_mismatch' }, 400);
  }
  deleteCookie(c, 'doc_oauth_state', { path: '/' });

  const stateClaims: Record<string, unknown> = verifiedState;
  const serverBaseUrl = (c.env.SERVER_URL || 'http://localhost:19138').replace(/\/$/, '');

  let userId = '';
  const provider = (typeof stateClaims.provider === 'string' ? stateClaims.provider : 'github') as string;
  if (c.req.query('provider') && c.req.query('provider') !== provider) {
    return c.json({ error: 'provider_mismatch' }, 400);
  }
  let shareToken = (typeof stateClaims.shareToken === 'string' ? stateClaims.shareToken : c.req.query('shareToken')?.trim() || '') as string;
  let redirectPath = normalizeSafeRedirectPath(
    typeof stateClaims.redirectPath === 'string' ? stateClaims.redirectPath : c.req.query('redirect'),
    shareToken,
  );

  if (relayToken) {
    const relayBase = (c.env.AUTH_RELAY_URL || 'https://app.im.codes').replace(/\/$/, '');
    let verifyRes: Response;
    try {
      verifyRes = await fetch(`${relayBase}/api/auth/relay/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          relayToken,
          expectedAudience: serverBaseUrl,
          expectedProvider: provider,
          expectedStateHash: sha256Hex(stateParam),
        }),
      });
    } catch {
      return c.json({ error: 'relay_verification_unavailable' }, 502);
    }
    if (!verifyRes.ok) {
      return c.json({ error: 'invalid_relay_token' }, 401);
    }
    const verifiedData = (await verifyRes.json()) as {
      ok?: boolean;
      issuer?: string;
      profile?: {
        provider?: string;
        externalId?: string;
        username?: string;
        email?: string | null;
        displayName?: string;
      };
    };
    if (
      !verifiedData.ok ||
      verifiedData.issuer !== relayBase ||
      !verifiedData.profile ||
      verifiedData.profile.provider !== provider ||
      !verifiedData.profile.externalId
    ) {
      return c.json({ error: 'invalid_relay_token' }, 401);
    }
    const platformId = String(verifiedData.profile.externalId).trim();
    const displayName =
      verifiedData.profile.displayName?.trim() ||
      verifiedData.profile.username?.trim() ||
      verifiedData.profile.email?.trim() ||
      `${provider}:${platformId}`;

    let user = await getUserByPlatformId(c.env.DB, provider, platformId);
    if (!user) {
      const existingById = await c.env.DB.queryOne<{ id: string }>('SELECT id FROM users WHERE id = $1', [platformId]);
      if (existingById) {
        userId = existingById.id;
      } else {
        user = await createUser(c.env.DB, randomHex(16));
        await c.env.DB.execute('UPDATE users SET display_name = COALESCE(display_name, $1) WHERE id = $2', [
          displayName,
          user.id,
        ]);
        userId = user.id;
      }
      await upsertPlatformIdentity(c.env.DB, randomHex(16), userId, provider, platformId);
    } else {
      userId = user.id;
    }
  } else if (code && stateClaims) {
    const callbackUrl = `${serverBaseUrl}/api/doc-shares/auth-relay/callback`;

    if (provider === 'github') {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: callbackUrl,
        }),
      });
      if (!tokenRes.ok) return c.json({ error: 'token_exchange_failed' }, 502);
      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) return c.json({ error: 'no_access_token' }, 502);

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'User-Agent': 'imcodes',
          Accept: 'application/vnd.github+json',
        },
      });
      if (!userRes.ok) return c.json({ error: 'github_user_fetch_failed' }, 502);
      const ghUser = (await userRes.json()) as { id: number | string; login?: string; name?: string };
      const platformId = String(ghUser.id);
      let user = await getUserByPlatformId(c.env.DB, 'github', platformId);
      if (!user) {
        user = await createUser(c.env.DB, randomHex(16));
        await c.env.DB.execute('UPDATE users SET display_name = COALESCE(display_name, $1) WHERE id = $2', [
          ghUser.name || ghUser.login || `github:${platformId}`,
          user.id,
        ]);
        await upsertPlatformIdentity(c.env.DB, randomHex(16), user.id, 'github', platformId);
      }
      userId = user.id;
    } else if (provider === 'google') {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: c.env.GOOGLE_CLIENT_ID ?? '',
          client_secret: c.env.GOOGLE_CLIENT_SECRET ?? '',
          code,
          grant_type: 'authorization_code',
          redirect_uri: callbackUrl,
        }).toString(),
      });
      if (!tokenRes.ok) return c.json({ error: 'token_exchange_failed' }, 502);
      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) return c.json({ error: 'no_access_token' }, 502);

      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!userRes.ok) return c.json({ error: 'google_user_fetch_failed' }, 502);
      const gUser = (await userRes.json()) as { sub: string; name?: string; email?: string };
      const platformId = String(gUser.sub);
      let user = await getUserByPlatformId(c.env.DB, 'google', platformId);
      if (!user) {
        user = await createUser(c.env.DB, randomHex(16));
        await c.env.DB.execute('UPDATE users SET display_name = COALESCE(display_name, $1) WHERE id = $2', [
          gUser.name || gUser.email || `google:${platformId}`,
          user.id,
        ]);
        await upsertPlatformIdentity(c.env.DB, randomHex(16), user.id, 'google', platformId);
      }
      userId = user.id;
    } else {
      return c.json({ error: 'unsupported_provider' }, 400);
    }
  } else {
    return c.json({ error: 'missing_callback_params' }, 400);
  }

  await issueAccountSessionCookies(c, userId, {
    scope: 'doc_collaborator',
  });

  // If logging in from an external share link, bind/verify the user's identity as the device credential when unlocked
  if (shareToken) {
    const userDeviceToken = `user:${userId}`;
    await verifyAndBindExternalShareDevice(c.env.DB, {
      rawToken: shareToken,
      deviceToken: userDeviceToken,
      userId,
    }).catch(() => {});
    setCookie(c, DOC_DEVICE_COOKIE, userDeviceToken, {
      httpOnly: true,
      secure: c.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 86400,
    });
  }

  if (c.req.query('format') === 'json' || c.req.header('Accept')?.includes('application/json')) {
    return c.json({ ok: true, userId, provider, redirectTo: redirectPath });
  }

  return c.redirect(redirectPath);
});

// GET /api/doc-shares/auth-relay/:provider
documentSharingRoutes.get('/doc-shares/auth-relay/:provider', async (c): Promise<Response> => {
  const provider = c.req.param('provider');
  if (provider !== 'google' && provider !== 'github') {
    return c.json({ error: 'unsupported_provider' }, 400);
  }

  const shareToken = c.req.query('shareToken')?.trim() || '';
  const redirectPath = normalizeSafeRedirectPath(c.req.query('redirect'), shareToken);
  const nonce = randomHex(16);
  const serverBaseUrl = (c.env.SERVER_URL || 'http://localhost:19138').replace(/\/$/, '');

  const stateJwt = signJwt(
    {
      type: 'doc-auth-relay-state',
      nonce,
      provider,
      origin: serverBaseUrl,
      redirectPath,
      shareToken: shareToken || null,
    },
    c.env.JWT_SIGNING_KEY,
    600,
  );

  const isSecure = c.env.NODE_ENV === 'production';
  setCookie(c, 'doc_oauth_state', nonce, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });

  const callbackUrl = `${serverBaseUrl}/api/doc-shares/auth-relay/callback`;

  // Direct OAuth when local keys are configured
  if (provider === 'github' && c.env.GITHUB_CLIENT_ID?.trim()) {
    const params = new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID.trim(),
      redirect_uri: callbackUrl,
      scope: 'read:user',
      state: stateJwt,
    });
    return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  }

  if (provider === 'google' && c.env.GOOGLE_CLIENT_ID?.trim()) {
    const params = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID.trim(),
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: stateJwt,
    });
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  }

  // Key-free self-hosted mode: redirect through central AUTH_RELAY_URL (default https://app.im.codes)
  const relayBase = (c.env.AUTH_RELAY_URL || 'https://app.im.codes').replace(/\/$/, '');
  const relayParams = new URLSearchParams({
    origin: serverBaseUrl,
    callback_path: '/api/doc-shares/auth-relay/callback',
    state: stateJwt,
  });
  return c.redirect(`${relayBase}/api/auth/${provider}?${relayParams.toString()}`);
});

// ── 4. Scheme 3: One-Time Magic Invite Link Redemption ────────────────────────

// POST /api/doc-shares/magic-invite/:token/redeem
documentSharingRoutes.post('/doc-shares/magic-invite/:token/redeem', async (c): Promise<Response> => {
  const rawToken = c.req.param('token') ?? '';
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const accessCode = typeof body.accessCode === 'string' ? body.accessCode : null;
  const { auth } = await resolveAuthOutcome(c);

  const result = await redeemMagicInviteShare(c.env.DB, {
    rawToken,
    displayName,
    existingUserId: auth?.userId ?? null,
    accessCode,
  });

  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }

  const sessionToken = await issueAccountSessionCookies(c, result.userId, {
    scope: 'doc_collaborator',
  });

  return c.json({
    ok: true,
    userId: result.userId,
    displayName: result.displayName,
    share: result.share,
    sessionToken,
  });
});

// ── 5. Shared-With-Me, Internal Browse & Create Blank Document / Folder ───────

// GET /api/doc-shares/shared-with-me
documentSharingRoutes.get('/doc-shares/shared-with-me', requireAuth({ allowDocCollaborator: true }), async (c): Promise<Response> => {
  const userId = c.get('userId');
  const serverId = c.req.query('serverId')?.trim();
  const allShares = await listDocumentsSharedWithUser(c.env.DB, userId);
  const shares = serverId ? allShares.filter((s) => s.serverId === serverId) : allShares;
  return c.json({ shares });
});

// GET /api/server/:id/doc-shares/browse?path=<encodedPath>
documentSharingRoutes.get('/server/:id/doc-shares/browse', async (c): Promise<Response> => {
  const serverId = c.req.param('id') ?? '';
  const rawPath = c.req.query('path') ?? '';
  const normPath = normalizeDocumentSharePath(rawPath);
  if (!normPath) {
    return c.json({ error: 'invalid_path' }, 400);
  }

  const { auth } = await resolveAuthOutcome(c);
  const shareToken = extractShareToken(c);
  const deviceToken = extractDeviceToken(c);

  const access = await resolveEffectiveDocumentAccess(c.env.DB, {
    serverId,
    userId: auth?.userId ?? null,
    externalShareToken: shareToken,
    deviceToken,
    filePath: normPath,
  });

  if (!access.allowed || !access.role) {
    const status = access.reason === 'unauthenticated' ? 401 : 403;
    return c.json({ error: 'forbidden', reason: access.reason ?? 'access_denied' }, status);
  }

  const allowedRoot = access.isOwner ? undefined : (access.targetPath ?? normPath);

  try {
    const lsRes = await sendDaemonFsCommand<{
      type: string;
      requestId: string;
      status?: 'ok' | 'error';
      entries?: Array<{ name: string; isDir: boolean; hidden?: boolean; size?: number; mtime?: number }>;
      error?: string;
    }>(serverId, 'ls', {
      type: 'fs.ls',
      requestId: `shr-ls-${randomHex(8)}`,
      path: normPath,
      includeFiles: true,
      ...(allowedRoot ? { allowedRoot } : {}),
    });

    if (lsRes.status === 'error') {
      const status = lsRes.error === FS_READ_ERROR_CODES.FORBIDDEN_PATH ? 403 : 502;
      return c.json({ error: lsRes.error || 'daemon_ls_failed' }, status);
    }

    const rawEntries = Array.isArray(lsRes.entries) ? lsRes.entries : [];
    const entries = [];
    for (const entry of rawEntries) {
      if (
        !entry ||
        typeof entry.name !== 'string' ||
        entry.name.startsWith('.oo-bak-') ||
        entry.name.startsWith('.oo-stage-') ||
        entry.name.startsWith('.imcodes-write-')
      ) {
        continue;
      }
      const entryPath = path.posix.join(normPath, entry.name);
      const entryAccess = await resolveEffectiveDocumentAccess(c.env.DB, {
        serverId,
        userId: auth?.userId ?? null,
        externalShareToken: shareToken,
        deviceToken,
        filePath: entryPath,
      });
      if (!entryAccess.allowed) continue;
      entries.push({
        ...entry,
        path: entryPath,
        role: entryAccess.role,
        allowDownload: entryAccess.allowDownload,
      });
    }

    return c.json({
      path: normPath,
      role: access.role,
      allowDownload: access.allowDownload,
      canManageShare: access.canManageShare,
      isOwner: access.isOwner,
      entries,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'daemon_offline' ? 503 : 502;
    return c.json({ error: msg }, status);
  }
});

// POST /api/server/:id/doc-shares/create-item
documentSharingRoutes.post('/server/:id/doc-shares/create-item', async (c): Promise<Response> => {
  const serverId = c.req.param('id') ?? '';
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const rawKind = String(body.kind ?? body.type ?? 'file').toLowerCase();
  const isFolder = rawKind === 'folder' || rawKind === 'mkdir' || rawKind === 'directory';

  let targetPath = '';
  if (typeof body.path === 'string' && body.path.trim()) {
    targetPath = body.path.trim();
  } else if (typeof body.parentDir === 'string' && typeof body.name === 'string') {
    const parentNorm = normalizeDocumentSharePath(body.parentDir);
    const cleanName = body.name.trim();
    if (!parentNorm || !cleanName || cleanName.includes('/') || cleanName.includes('\\') || cleanName === '..' || cleanName === '.') {
      return c.json({ error: 'invalid_path' }, 400);
    }
    targetPath = path.posix.join(parentNorm, cleanName);
  }

  const normPath = normalizeDocumentSharePath(targetPath);
  if (!normPath || normPath === '/') {
    return c.json({ error: 'invalid_path' }, 400);
  }

  const { auth } = await resolveAuthOutcome(c);
  const shareToken =
    (typeof body.shareToken === 'string' && body.shareToken.trim()) ||
    extractShareToken(c);
  const deviceToken =
    (typeof body.deviceToken === 'string' && body.deviceToken.trim()) ||
    extractDeviceToken(c);

  // Check write permission on targetPath (or its parent folder)
  const access = await resolveEffectiveDocumentAccess(c.env.DB, {
    serverId,
    userId: auth?.userId ?? null,
    externalShareToken: shareToken,
    deviceToken,
    filePath: normPath,
  });

  if (!access.allowed) {
    const status = access.reason === 'unauthenticated' ? 401 : 403;
    return c.json({ error: 'forbidden', reason: access.reason ?? 'access_denied' }, status);
  }
  if (access.role !== 'editor') {
    return c.json({ error: 'forbidden', reason: 'editor_role_required' }, 403);
  }

  const allowedRoot = access.isOwner ? undefined : (access.targetPath ?? normPath);

  if (isFolder) {
    try {
      const mkdirRes = await sendDaemonFsCommand<{
        type: string;
        requestId: string;
        status?: 'ok' | 'error';
        path?: string;
        error?: string;
      }>(serverId, 'mkdir', {
        type: 'fs.mkdir',
        requestId: `oo-mkdir-${randomHex(8)}`,
        path: normPath,
        ...(allowedRoot ? { allowedRoot } : {}),
      });

      if (mkdirRes.status === 'error') {
        const status = mkdirRes.error === FS_READ_ERROR_CODES.FORBIDDEN_PATH ? 403 : 400;
        return c.json({ error: mkdirRes.error || 'mkdir_failed' }, status);
      }

      return c.json({ ok: true, kind: 'folder', path: normPath }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg === 'daemon_offline' ? 503 : 502;
      return c.json({ error: msg }, status);
    }
  }

  const ext = path.posix.extname(normPath).toLowerCase();
  if (!['.docx', '.xlsx', '.pptx', '.md'].includes(ext)) {
    return c.json({ error: 'unsupported_document_extension' }, 400);
  }

  try {
    const bytes = buildBlankDocumentBytes(ext);
    await writeFileToDaemon(serverId, normPath, bytes, {
      createOnly: true,
      isBinary: ext !== '.md',
      ...(allowedRoot ? { allowedRoot } : {}),
    });
    return c.json(
      {
        ok: true,
        kind: 'file',
        path: normPath,
        ext,
        size: bytes.length,
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'EEXIST' ? 409 : msg === 'daemon_offline' ? 503 : 502;
    return c.json({ error: msg }, status);
  }
});
